// ============================================================================
// SupportFlow AI — Phase 3: automation event processor (Worker B)
//
// processAutomationEvent() handles one automation_events row. Only
// 'customer.message.created' is ever processed; every other event type is
// skipped. LOOP PREVENTION: the triggering message is loaded by id WITH
// workspace_id = event.workspace_id (never trust the payload alone), and
// only sender_type 'customer' proceeds — agent/system messages (including
// AI replies) never trigger AI, and AI replies never record a new
// customer.message.created outbox event.
//
// Every AI path writes an ai_executions row — the audit trail is never
// lost. Provider failure ALWAYS escalates (never silently drops).
// ============================================================================

import type { SupabaseClient } from '@supabase/supabase-js';
import {
  generateCompletion,
  aiConfigFromEnv,
  selectProviders,
  AiUnavailableError,
  type AiConfig,
  type CompletionResult,
} from './ai.js';
import { buildPromptMessages, containsUnsafePromise } from './prompts.js';
import { retrieveKnowledge, type RetrievedChunk } from './rag.js';
import { escalateConversation } from './handoff.js';
import { logger } from '../logger.js';

export interface AutomationEvent {
  id: string;
  event_type: string;
  workspace_id: string;
  entity_type: string;
  entity_id: string;
  payload: Record<string, unknown>;
}

export type ProcessorOutcome =
  | 'skipped'
  | 'suggestion_created'
  | 'auto_replied'
  | 'escalated';

export interface ProcessorResult {
  outcome: ProcessorOutcome;
  /** Execution row id when one was written. */
  executionId?: string;
  /** Suggestion id (suggestion mode) or auto-reply message id (auto mode). */
  id?: string;
}

export interface ProcessorOptions {
  /** AI config; defaults to process.env (see aiConfigFromEnv). */
  config?: AiConfig;
  /** Injectable completion function (tests stub this; production uses generateCompletion). */
  generate?: (input: Parameters<typeof generateCompletion>[0], config: AiConfig) => Promise<CompletionResult>;
  /** Workspace display name override (tests); otherwise loaded from workspaces. */
  workspaceName?: string;
}

interface AiSettingsRow {
  enabled: boolean;
  mode: 'disabled' | 'suggestion' | 'auto' | 'human_only';
  provider_order: string[];
  auto_reply_require_grounding: boolean;
  escalation_on_low_confidence: boolean;
}

const DEFAULT_SETTINGS: AiSettingsRow = {
  enabled: false,
  mode: 'suggestion',
  provider_order: ['groq', 'gemini'],
  auto_reply_require_grounding: true,
  escalation_on_low_confidence: true,
};

function configFromProcessEnv(): AiConfig {
  return aiConfigFromEnv({
    AI_PROVIDER_ORDER: process.env.AI_PROVIDER_ORDER ?? 'groq,gemini',
    GROQ_API_KEY: process.env.GROQ_API_KEY,
    GEMINI_API_KEY: process.env.GEMINI_API_KEY,
    AI_MODEL_GROQ: process.env.AI_MODEL_GROQ ?? 'openai/gpt-oss-20b',
    AI_MODEL_GROQ_QUALITY: process.env.AI_MODEL_GROQ_QUALITY ?? 'openai/gpt-oss-120b',
    AI_MODEL_GEMINI: process.env.AI_MODEL_GEMINI ?? 'gemini-3.8-flash',
    AI_MODEL_GEMINI_FALLBACKS:
      process.env.AI_MODEL_GEMINI_FALLBACKS ?? 'gemini-3.6-flash,gemini-3.5-flash-lite,gemini-3.1-flash-lite',
    AI_REQUEST_TIMEOUT_MS: Number(process.env.AI_REQUEST_TIMEOUT_MS ?? 30000),
  });
}

async function recordExecution(
  supabase: SupabaseClient,
  row: {
    workspace_id: string;
    conversation_id: string | null;
    message_id: string | null;
    event_id: string | null;
    provider?: string | null;
    model?: string | null;
    mode?: string | null;
    status: 'pending' | 'success' | 'failed' | 'escalated' | 'skipped';
    prompt_tokens?: number | null;
    completion_tokens?: number | null;
    latency_ms?: number | null;
    error?: string | null;
    suggestion?: string | null;
  },
): Promise<string | undefined> {
  try {
    const { data, error } = await supabase.from('ai_executions').insert(row).select('id').single();
    if (error) {
      logger.error('Failed to record ai_execution', { error: error.message });
      return undefined;
    }
    return (data as { id: string } | null)?.id;
  } catch (e) {
    logger.error('Failed to record ai_execution', { error: e instanceof Error ? e.message : String(e) });
    return undefined;
  }
}

export async function processAutomationEvent(
  supabase: SupabaseClient,
  event: AutomationEvent,
  opts: ProcessorOptions = {},
): Promise<ProcessorResult> {
  // Only customer messages are processed; everything else is skipped
  // without an execution row (there is no conversation to audit against).
  if (event.event_type !== 'customer.message.created') {
    return { outcome: 'skipped' };
  }
  const config = opts.config ?? configFromProcessEnv();
  const generate = opts.generate ?? generateCompletion;

  // Load the message by id WITH the workspace id — never trust the payload.
  const { data: message, error: messageError } = await supabase
    .from('messages')
    .select('*')
    .eq('workspace_id', event.workspace_id)
    .eq('id', event.entity_id)
    .maybeSingle();
  if (messageError || !message) {
    return { outcome: 'skipped' };
  }
  const msg = message as {
    id: string;
    workspace_id: string;
    conversation_id: string;
    customer_id: string | null;
    sender_type: string;
    body: string;
  };
  // LOOP PREVENTION: agent/system messages never trigger AI.
  if (msg.sender_type !== 'customer') {
    await recordExecution(supabase, {
      workspace_id: event.workspace_id,
      conversation_id: msg.conversation_id,
      message_id: msg.id,
      event_id: event.id,
      mode: null,
      status: 'skipped',
      error: 'Non-customer message does not trigger AI',
    });
    return { outcome: 'skipped' };
  }

  // Load the conversation: an AI-paused (handed-off) conversation stays paused.
  const { data: conversation } = await supabase
    .from('conversations')
    .select('id,workspace_id,customer_id,ai_paused')
    .eq('workspace_id', event.workspace_id)
    .eq('id', msg.conversation_id)
    .maybeSingle();
  const conv = conversation as { id: string; customer_id: string | null; ai_paused?: boolean | null } | null;
  if (conv?.ai_paused) {
    const executionId = await recordExecution(supabase, {
      workspace_id: event.workspace_id,
      conversation_id: msg.conversation_id,
      message_id: msg.id,
      event_id: event.id,
      mode: null,
      status: 'skipped',
      error: 'AI is paused on this conversation (handed off to a human)',
    });
    return { outcome: 'skipped', executionId };
  }

  // Settings (defaults: disabled).
  const { data: settingsRow } = await supabase
    .from('ai_settings')
    .select('*')
    .eq('workspace_id', event.workspace_id)
    .maybeSingle();
  const settings: AiSettingsRow = settingsRow
    ? {
        enabled: Boolean((settingsRow as AiSettingsRow).enabled),
        mode: (settingsRow as AiSettingsRow).mode ?? 'suggestion',
        provider_order: (settingsRow as AiSettingsRow).provider_order ?? ['groq', 'gemini'],
        auto_reply_require_grounding:
          (settingsRow as AiSettingsRow).auto_reply_require_grounding ?? true,
        escalation_on_low_confidence:
          (settingsRow as AiSettingsRow).escalation_on_low_confidence ?? true,
      }
    : DEFAULT_SETTINGS;
  const mode = settings.mode;

  if (!settings.enabled || mode === 'disabled' || mode === 'human_only') {
    const executionId = await recordExecution(supabase, {
      workspace_id: event.workspace_id,
      conversation_id: msg.conversation_id,
      message_id: msg.id,
      event_id: event.id,
      mode,
      status: 'skipped',
      error: !settings.enabled ? 'AI is not enabled for this workspace' : `AI mode is ${mode}`,
    });
    return { outcome: 'skipped', executionId };
  }

  // Per-workspace provider order wins over the environment default: the
  // workspace's ai_settings.provider_order is the order generation
  // actually uses. An unset/empty row order falls back to the env config
  // (AI_PROVIDER_ORDER, default groq,gemini). selectProviders() drops
  // unknown names and defaults when nothing usable remains.
  const settingsOrder = (settingsRow as AiSettingsRow | null)?.provider_order;
  const effectiveConfig: AiConfig =
    Array.isArray(settingsOrder) && settingsOrder.length > 0
      ? { ...config, providerOrder: selectProviders(settingsOrder) }
      : config;

  // SUGGESTION IDEMPOTENCY: a redelivered event must not create a second
  // suggestion (or a second provider call) for the same message. The auto
  // branch dedupes via client_message_id `ai-<event id>`; the suggestion
  // branch had no equivalent, so a duplicate process-event created a
  // second suggestion and a second success execution. Check first and
  // return the existing draft when one is already stored for this
  // message — no provider call, no new execution row.
  if (mode === 'suggestion') {
    const { data: existingSuggestion } = await supabase
      .from('ai_suggestions')
      .select('id')
      .eq('workspace_id', event.workspace_id)
      .eq('conversation_id', msg.conversation_id)
      .eq('message_id', msg.id)
      .maybeSingle();
    const existingId = (existingSuggestion as { id: string } | null)?.id;
    if (existingId) {
      return { outcome: 'suggestion_created', id: existingId };
    }
  }

  const escalate = async (reason: string, executionStatus: 'escalated' | 'failed'): Promise<ProcessorResult> => {
    try {
      await escalateConversation(supabase, {
        workspaceId: event.workspace_id,
        conversationId: msg.conversation_id,
        reason,
        triggeredBy: 'ai',
      });
    } catch (e) {
      logger.error('Escalation failed', { error: e instanceof Error ? e.message : String(e) });
    }
    const executionId = await recordExecution(supabase, {
      workspace_id: event.workspace_id,
      conversation_id: msg.conversation_id,
      message_id: msg.id,
      event_id: event.id,
      mode,
      status: executionStatus,
      error: reason,
    });
    return { outcome: 'escalated', executionId };
  };

  // Recent messages (last 10, chronological) for context.
  const { data: recentRows } = await supabase
    .from('messages')
    .select('sender_type,body,created_at')
    .eq('workspace_id', event.workspace_id)
    .eq('conversation_id', msg.conversation_id)
    .order('created_at', { ascending: false })
    .limit(10);
  const recentMessages = ((recentRows ?? []) as Array<{ sender_type: string; body: string }>)
    .reverse()
    .map((m) => ({ senderType: m.sender_type, body: m.body }));

  // Lexical knowledge retrieval.
  let knowledge: RetrievedChunk[] = [];
  try {
    knowledge = await retrieveKnowledge(supabase, event.workspace_id, msg.body, 5);
  } catch (e) {
    logger.error('Knowledge retrieval failed', { error: e instanceof Error ? e.message : String(e) });
    knowledge = [];
  }

  // Auto mode with grounding required and nothing retrieved -> escalate.
  if (mode === 'auto' && settings.auto_reply_require_grounding && knowledge.length === 0) {
    return escalate(
      'Insufficient knowledge to answer automatically; no relevant knowledge-base excerpt was found.',
      'escalated',
    );
  }

  // Workspace display name for the system prompt.
  let workspaceName = opts.workspaceName ?? 'Support';
  if (!opts.workspaceName) {
    const { data: ws } = await supabase
      .from('workspaces')
      .select('name')
      .eq('id', event.workspace_id)
      .maybeSingle();
    if ((ws as { name?: string } | null)?.name) workspaceName = (ws as { name: string }).name;
  }

  const promptMessages = buildPromptMessages({
    workspaceName,
    mode,
    question: msg.body,
    knowledgeContext: knowledge.map((k) => ({ documentTitle: k.documentTitle, chunk: k.chunk })),
    recentMessages,
  });
  const sources = knowledge.map((k) => ({ documentId: k.documentId, documentTitle: k.documentTitle }));

  let completion: CompletionResult;
  try {
    completion = await generate({ messages: promptMessages }, effectiveConfig);
  } catch (e) {
    // Provider failure ALWAYS escalates — never silently drops the message.
    const detail =
      e instanceof AiUnavailableError
        ? `AI provider unavailable (${e.provider}${e.status ? `, HTTP ${e.status}` : ''}${e.quotaExceeded ? ', quota exceeded' : ''}).`
        : `AI generation failed: ${e instanceof Error ? e.message : String(e)}`;
    return escalate(`${detail} The conversation was escalated to a human instead.`, 'failed');
  }

  if (mode === 'suggestion') {
    const { data: suggestion, error: suggestionError } = await supabase
      .from('ai_suggestions')
      .insert({
        workspace_id: event.workspace_id,
        conversation_id: msg.conversation_id,
        message_id: msg.id,
        suggestion: completion.text,
        sources,
        status: 'pending',
      })
      .select('id')
      .single();
    if (suggestionError || !suggestion) {
      return escalate('AI suggestion could not be saved; escalated to a human.', 'failed');
    }
    const executionId = await recordExecution(supabase, {
      workspace_id: event.workspace_id,
      conversation_id: msg.conversation_id,
      message_id: msg.id,
      event_id: event.id,
      provider: completion.provider,
      model: completion.model,
      mode,
      status: 'success',
      prompt_tokens: completion.promptTokens,
      completion_tokens: completion.completionTokens,
      latency_ms: completion.latencyMs,
      suggestion: completion.text,
    });
    return { outcome: 'suggestion_created', executionId, id: (suggestion as { id: string }).id };
  }

  // Auto mode: validate the response before sending it.
  if (containsUnsafePromise(completion.text)) {
    return escalate(
      'unsafe_response: the AI draft promised a refund, discount, payment or account change and was not sent.',
      'escalated',
    );
  }

  // Idempotent auto-reply: client_message_id `ai-<event id>`.
  const clientMessageId = `ai-${event.id}`;
  const { data: existing } = await supabase
    .from('messages')
    .select('id')
    .eq('workspace_id', event.workspace_id)
    .eq('conversation_id', msg.conversation_id)
    .eq('client_message_id', clientMessageId)
    .maybeSingle();
  let replyId: string | undefined = (existing as { id: string } | null)?.id;
  if (!replyId) {
    const { data: inserted, error: insertError } = await supabase
      .from('messages')
      .insert({
        workspace_id: event.workspace_id,
        conversation_id: msg.conversation_id,
        customer_id: conv?.customer_id ?? msg.customer_id,
        sender_type: 'agent',
        sender_id: null,
        body: completion.text,
        client_message_id: clientMessageId,
      })
      .select('id')
      .single();
    if (insertError || !inserted) {
      // Unique-index race: re-check for the existing row before failing.
      if ((insertError as { code?: string } | null)?.code === '23505') {
        const { data: raced } = await supabase
          .from('messages')
          .select('id')
          .eq('workspace_id', event.workspace_id)
          .eq('conversation_id', msg.conversation_id)
          .eq('client_message_id', clientMessageId)
          .maybeSingle();
        replyId = (raced as { id: string } | null)?.id;
      }
      if (!replyId) {
        return escalate('AI auto-reply could not be saved; escalated to a human.', 'failed');
      }
    } else {
      replyId = (inserted as { id: string }).id;
    }
    await supabase
      .from('conversations')
      .update({ last_message_at: new Date().toISOString() })
      .eq('workspace_id', event.workspace_id)
      .eq('id', msg.conversation_id);
  }

  // Record the auto-reply as an accepted suggestion for the audit trail.
  // NOTE: no customer.message.created outbox event is recorded for AI
  // replies — that would loop the AI back onto its own message.
  await supabase.from('ai_suggestions').insert({
    workspace_id: event.workspace_id,
    conversation_id: msg.conversation_id,
    message_id: msg.id,
    suggestion: completion.text,
    sources,
    status: 'accepted',
  });
  const executionId = await recordExecution(supabase, {
    workspace_id: event.workspace_id,
    conversation_id: msg.conversation_id,
    message_id: msg.id,
    event_id: event.id,
    provider: completion.provider,
    model: completion.model,
    mode,
    status: 'success',
    prompt_tokens: completion.promptTokens,
    completion_tokens: completion.completionTokens,
    latency_ms: completion.latencyMs,
    suggestion: completion.text,
  });
  return { outcome: 'auto_replied', executionId, id: replyId };
}
