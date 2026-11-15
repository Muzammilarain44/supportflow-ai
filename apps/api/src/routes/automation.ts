// ============================================================================
// SupportFlow AI — Phase 3: automation routes (Worker B)
//
// Two routers are exported because their auth differs:
//
//   automationRouter(env) — POST /process-event ONLY, no user auth.
//     Mounted by the coordinator at /api/automation BEFORE the global
//     express.json() parser, with express.raw({ type: 'application/json' })
//     so the handler below sees the exact request bytes. HMAC-verified
//     via Worker A's apps/api/src/lib/webhookAuth.ts. Missing or invalid
//     signature -> 401; AUTOMATION_WEBHOOK_SECRET unset -> 503.
//     Processing uses the service-role client (Worker A's
//     getServiceSupabase). The sender (dispatcher / n8n) MUST sign the
//     exact raw request bytes it sends; verification runs over those
//     bytes, never over a re-serialized form.
//
//   aiWorkspaceRouter(env) — workspace-scoped AI endpoints (overview,
//     executions, suggestions review, resume). Mounted by the coordinator
//     at /api/workspaces/:workspaceId with the usual authed middleware
//     (auth + rate limit + requireWorkspaceMember); this router does not
//     add its own auth.
//
// List responses are {items,total,page,pageSize}; errors are {error}.
// ============================================================================

import { Router, type Response } from 'express';
import {
  acceptSuggestionSchema,
  automationEventSchema,
  DEFAULT_AI_SETTINGS,
} from '@supportflow/shared';
import type { Env } from '../env.js';
import { ApiError } from '../errors.js';
import { getUserSupabase } from '../lib/supabase.js';
import { getServiceSupabase } from '../lib/serviceSupabase.js';
import { verifyWebhook } from '../lib/webhookAuth.js';
import { processAutomationEvent } from '../lib/aiProcessor.js';
import { pageOffset, parseListQuery } from '../lib/pagination.js';
import { validateBody } from '../middleware/validate.js';
import type { AuthedRequest } from '../middleware/auth.js';
import { logger } from '../logger.js';

// ---------------------------------------------------------------------------
// Unauthenticated: POST /process-event
// ---------------------------------------------------------------------------

export function automationRouter(env: Env) {
  const router = Router();

  router.post('/process-event', async (req, res: Response, next) => {
    try {
      const secret = env.AUTOMATION_WEBHOOK_SECRET;
      if (!secret) {
        return res.status(503).json({ error: 'Automation webhook is not configured' });
      }
      // Raw request bytes (the router is mounted with express.raw() —
      // see app.ts). Fall back to re-serializing only when the body was
      // already parsed (e.g. in tests that mount with express.json()).
      let rawBody: string;
      let bodyJson: unknown;
      if (Buffer.isBuffer(req.body)) {
        rawBody = req.body.toString('utf8');
        try {
          bodyJson = JSON.parse(rawBody) as unknown;
        } catch {
          return res.status(400).json({ error: 'Invalid JSON body' });
        }
      } else {
        bodyJson = req.body ?? {};
        rawBody = JSON.stringify(bodyJson);
      }
      const signature = req.headers['x-sf-signature'] as string | undefined;
      const timestamp = req.headers['x-sf-timestamp'] as string | undefined;
      if (!verifyWebhook(secret, rawBody, signature, timestamp)) {
        return res.status(401).json({ error: 'Invalid webhook signature' });
      }
      const parsed = automationEventSchema.safeParse(bodyJson);
      if (!parsed.success) {
        return res.status(400).json({
          error: parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; '),
        });
      }
      let serviceClient;
      try {
        serviceClient = getServiceSupabase(env);
      } catch {
        return res.status(503).json({ error: 'Automation service is not configured' });
      }
      const result = await processAutomationEvent(serviceClient, parsed.data);
      // 202 when accepted for async handling is not used here: processing
      // is synchronous, so a handled or skipped event is 200 {outcome}.
      return res.status(200).json({ outcome: result.outcome });
    } catch (e) {
      logger.error('Automation process-event failed', {
        error: e instanceof Error ? e.message : String(e),
      });
      return next(new ApiError(500, 'Failed to process automation event'));
    }
  });

  return router;
}

// ---------------------------------------------------------------------------
// Workspace-scoped: overview, executions, suggestions, resume
// (coordinator mounts with auth + requireWorkspaceMember)
// ---------------------------------------------------------------------------

export function aiWorkspaceRouter(env: Env) {
  const router = Router({ mergeParams: true });

  // GET /ai-overview — settings + automation queue + AI totals, all from
  // real tables (no invented numbers).
  router.get('/ai-overview', async (req: AuthedRequest, res: Response, next) => {
    try {
      const workspaceId = req.params.workspaceId as string;
      const supabase = getUserSupabase(env, req.token!);

      const { data: settings } = await supabase
        .from('ai_settings')
        .select('enabled,mode')
        .eq('workspace_id', workspaceId)
        .maybeSingle();
      const aiEnabled = (settings as { enabled?: boolean } | null)?.enabled ?? DEFAULT_AI_SETTINGS.enabled;
      const mode = (settings as { mode?: string } | null)?.mode ?? DEFAULT_AI_SETTINGS.mode;

      const { data: events } = await supabase
        .from('automation_events')
        .select('status,processed_at')
        .eq('workspace_id', workspaceId);
      const automation = { pending: 0, processing: 0, failed: 0, dead: 0, last_processed_at: null as string | null };
      for (const ev of (events ?? []) as Array<{ status: string; processed_at: string | null }>) {
        if (ev.status === 'pending') automation.pending += 1;
        else if (ev.status === 'processing') automation.processing += 1;
        else if (ev.status === 'failed') automation.failed += 1;
        else if (ev.status === 'dead') automation.dead += 1;
        if (ev.processed_at && (!automation.last_processed_at || ev.processed_at > automation.last_processed_at)) {
          automation.last_processed_at = ev.processed_at;
        }
      }

      const { data: executions } = await supabase
        .from('ai_executions')
        .select('conversation_id,status')
        .eq('workspace_id', workspaceId);
      const assisted = new Set<string>();
      let failedExecutions = 0;
      for (const ex of (executions ?? []) as Array<{ conversation_id: string | null; status: string }>) {
        if (ex.status === 'success' && ex.conversation_id) assisted.add(ex.conversation_id);
        if (ex.status === 'failed') failedExecutions += 1;
      }

      const { count: suggestionCount } = await supabase
        .from('ai_suggestions')
        .select('id', { count: 'exact', head: true })
        .eq('workspace_id', workspaceId);
      const { count: autoReplyCount } = await supabase
        .from('messages')
        .select('id', { count: 'exact', head: true })
        .eq('workspace_id', workspaceId)
        .eq('sender_type', 'agent')
        .like('client_message_id', 'ai-%');
      const { count: handoffCount } = await supabase
        .from('handoffs')
        .select('id', { count: 'exact', head: true })
        .eq('workspace_id', workspaceId);

      return res.json({
        ai_enabled: aiEnabled,
        mode,
        automation,
        totals: {
          assisted_conversations: assisted.size,
          suggestions: suggestionCount ?? 0,
          auto_replies: autoReplyCount ?? 0,
          handoffs: handoffCount ?? 0,
          failed_executions: failedExecutions,
        },
      });
    } catch (e) {
      return next(e);
    }
  });

  // GET /ai-executions — ?status= filter, paginated {items,total,page,pageSize}.
  router.get('/ai-executions', async (req: AuthedRequest, res: Response, next) => {
    try {
      const workspaceId = req.params.workspaceId as string;
      const { page, pageSize } = parseListQuery(req);
      const status = typeof req.query.status === 'string' ? req.query.status : undefined;
      if (status && !['pending', 'success', 'failed', 'escalated', 'skipped'].includes(status)) {
        throw new ApiError(400, `Invalid status filter: ${status}`);
      }
      const supabase = getUserSupabase(env, req.token!);
      let query = supabase
        .from('ai_executions')
        .select('*', { count: 'exact' })
        .eq('workspace_id', workspaceId);
      if (status) query = query.eq('status', status);
      const offset = pageOffset(page, pageSize);
      const { data, count, error } = await query
        .order('created_at', { ascending: false })
        .range(offset, offset + pageSize - 1);
      if (error) throw new ApiError(500, 'Failed to list AI executions');
      return res.json({ items: data ?? [], total: count ?? 0, page, pageSize });
    } catch (e) {
      return next(e);
    }
  });

  // GET /conversations/:conversationId/suggestions — pending first, then reviewed.
  router.get('/conversations/:conversationId/suggestions', async (req: AuthedRequest, res: Response, next) => {
    try {
      const workspaceId = req.params.workspaceId as string;
      const { page, pageSize } = parseListQuery(req);
      const supabase = getUserSupabase(env, req.token!);
      const { data: conversation, error: convError } = await supabase
        .from('conversations')
        .select('id')
        .eq('workspace_id', workspaceId)
        .eq('id', req.params.conversationId)
        .maybeSingle();
      if (convError || !conversation) throw new ApiError(404, 'Conversation not found');
      const offset = pageOffset(page, pageSize);
      const { data, count, error } = await supabase
        .from('ai_suggestions')
        .select('*', { count: 'exact' })
        .eq('workspace_id', workspaceId)
        .eq('conversation_id', req.params.conversationId)
        .order('created_at', { ascending: false })
        .range(offset, offset + pageSize - 1);
      if (error) throw new ApiError(500, 'Failed to list AI suggestions');
      // Pending first within the returned page (stable sort).
      const items = [...(data ?? [])].sort((a, b) => {
        const rank = (s: string) => (s === 'pending' ? 0 : 1);
        return rank((a as { status: string }).status) - rank((b as { status: string }).status);
      });
      return res.json({ items, total: count ?? 0, page, pageSize });
    } catch (e) {
      return next(e);
    }
  });

  // POST /conversations/:conversationId/suggestions/:suggestionId/accept —
  // inserts the (possibly edited) text as an agent reply, idempotent on
  // client_message_id `sugg-<suggestion id>`, marks the suggestion
  // accepted/edited, records reviewed_by.
  router.post(
    '/conversations/:conversationId/suggestions/:suggestionId/accept',
    validateBody(acceptSuggestionSchema),
    async (req: AuthedRequest, res: Response, next) => {
      try {
        const workspaceId = req.params.workspaceId as string;
        const supabase = getUserSupabase(env, req.token!);
        const { data: suggestion, error } = await supabase
          .from('ai_suggestions')
          .select('*')
          .eq('workspace_id', workspaceId)
          .eq('conversation_id', req.params.conversationId)
          .eq('id', req.params.suggestionId)
          .single();
        if (error || !suggestion) throw new ApiError(404, 'Suggestion not found');
        const sugg = suggestion as { id: string; suggestion: string; status: string; conversation_id: string };
        if (sugg.status !== 'pending') {
          throw new ApiError(409, `Suggestion has already been ${sugg.status}`);
        }
        const text = (req.body.edited_text as string | undefined) ?? sugg.suggestion;
        const edited = req.body.edited_text !== undefined;
        const clientMessageId = `sugg-${sugg.id}`;
        const { data: conversation } = await supabase
          .from('conversations')
          .select('customer_id')
          .eq('workspace_id', workspaceId)
          .eq('id', req.params.conversationId)
          .maybeSingle();

        const { data: existing } = await supabase
          .from('messages')
          .select('*')
          .eq('workspace_id', workspaceId)
          .eq('conversation_id', req.params.conversationId)
          .eq('client_message_id', clientMessageId)
          .maybeSingle();
        let message = existing;
        if (!message) {
          const { data: inserted, error: insertError } = await supabase
            .from('messages')
            .insert({
              workspace_id: workspaceId,
              conversation_id: req.params.conversationId,
              customer_id: (conversation as { customer_id: string | null } | null)?.customer_id ?? null,
              sender_type: 'agent',
              sender_id: req.user!.id,
              body: text,
              client_message_id: clientMessageId,
            })
            .select()
            .single();
          if (insertError) {
            if ((insertError as { code?: string }).code === '23505') {
              const { data: raced } = await supabase
                .from('messages')
                .select('*')
                .eq('conversation_id', req.params.conversationId)
                .eq('client_message_id', clientMessageId)
                .maybeSingle();
              message = raced;
            }
            if (!message) throw new ApiError(500, 'Failed to send reply');
          } else {
            message = inserted;
          }
          await supabase
            .from('conversations')
            .update({ last_message_at: new Date().toISOString() })
            .eq('workspace_id', workspaceId)
            .eq('id', req.params.conversationId);
        }
        const { data: updated, error: updateError } = await supabase
          .from('ai_suggestions')
          .update({
            status: edited ? 'edited' : 'accepted',
            suggestion: text,
            reviewed_by: req.user!.id,
          })
          .eq('workspace_id', workspaceId)
          .eq('id', sugg.id)
          .select()
          .single();
        if (updateError || !updated) throw new ApiError(500, 'Failed to update suggestion');
        return res.json({ suggestion: updated, message });
      } catch (e) {
        return next(e);
      }
    },
  );

  // POST /conversations/:conversationId/suggestions/:suggestionId/reject
  router.post(
    '/conversations/:conversationId/suggestions/:suggestionId/reject',
    async (req: AuthedRequest, res: Response, next) => {
      try {
        const workspaceId = req.params.workspaceId as string;
        const supabase = getUserSupabase(env, req.token!);
        const { data: suggestion, error } = await supabase
          .from('ai_suggestions')
          .select('*')
          .eq('workspace_id', workspaceId)
          .eq('conversation_id', req.params.conversationId)
          .eq('id', req.params.suggestionId)
          .single();
        if (error || !suggestion) throw new ApiError(404, 'Suggestion not found');
        const sugg = suggestion as { id: string; status: string };
        if (sugg.status !== 'pending') {
          throw new ApiError(409, `Suggestion has already been ${sugg.status}`);
        }
        const { data: updated, error: updateError } = await supabase
          .from('ai_suggestions')
          .update({ status: 'rejected', reviewed_by: req.user!.id })
          .eq('workspace_id', workspaceId)
          .eq('id', sugg.id)
          .select()
          .single();
        if (updateError || !updated) throw new ApiError(500, 'Failed to update suggestion');
        return res.json({ suggestion: updated });
      } catch (e) {
        return next(e);
      }
    },
  );

  // POST /conversations/:conversationId/resume-ai is NOT defined here:
  // the gated version lives in routes/handoffs.ts (POST /ai-resume),
  // which refuses to resume when the workspace policy forbids it.
  // An ungated resume endpoint here would bypass that policy gate.

  return router;
}
