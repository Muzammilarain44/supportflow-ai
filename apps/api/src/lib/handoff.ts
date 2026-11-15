import type { SupabaseClient } from '@supabase/supabase-js';
import { ApiError } from '../errors.js';

export type HandoffTriggeredBy = 'ai' | 'agent' | 'system';

const OPEN_TICKET_STATUSES = ['open', 'in_progress', 'waiting_for_customer'] as const;

export interface EscalateConversationInput {
  workspaceId: string;
  conversationId: string;
  reason: string;
  triggeredBy: HandoffTriggeredBy;
}

export interface ResumeAiInput {
  workspaceId: string;
  conversationId: string;
  resumedBy: string;
}

/**
 * Escalate a conversation to a human: reuse an existing open ticket for the
 * same conversation when one exists, otherwise create one, record the
 * handoff, and pause AI on the conversation. The ticket's assignment is
 * never touched here — a reused ticket keeps its assignee.
 */
export async function escalateConversation(
  supabase: SupabaseClient,
  { workspaceId, conversationId, reason, triggeredBy }: EscalateConversationInput,
): Promise<{ ticket: { id: string }; handoff: { id: string }; reused: boolean }> {
  const { data: conversation, error: convError } = await supabase
    .from('conversations')
    .select('*')
    .eq('workspace_id', workspaceId)
    .eq('id', conversationId)
    .single();
  if (convError || !conversation) throw new ApiError(404, 'Conversation not found');
  const conv = conversation as { id: string; customer_id: string | null };

  const now = new Date().toISOString();

  const { data: existingTickets, error: ticketError } = await supabase
    .from('tickets')
    .select('*')
    .eq('workspace_id', workspaceId)
    .eq('conversation_id', conversationId)
    .in('status', [...OPEN_TICKET_STATUSES])
    .order('created_at', { ascending: false })
    .limit(1);
  if (ticketError) throw new ApiError(500, 'Failed to check existing tickets');

  let ticket: { id: string };
  let reused = false;
  const existing = (existingTickets ?? [])[0] as { id: string } | undefined;
  if (existing) {
    const { data, error } = await supabase
      .from('tickets')
      .update({ escalation_reason: reason, escalated_at: now })
      .eq('workspace_id', workspaceId)
      .eq('id', existing.id)
      .select()
      .single();
    if (error || !data) throw new ApiError(500, 'Failed to update ticket');
    ticket = data as { id: string };
    reused = true;
  } else {
    // Subject from the conversation's first customer message (max 120 chars).
    const { data: firstMessages } = await supabase
      .from('messages')
      .select('body')
      .eq('workspace_id', workspaceId)
      .eq('conversation_id', conversationId)
      .eq('sender_type', 'customer')
      .order('created_at', { ascending: true })
      .limit(1);
    const firstBody = ((firstMessages ?? [])[0] as { body?: string } | undefined)?.body?.trim();
    const subject = firstBody ? firstBody.slice(0, 120) : 'Escalated conversation';
    const { data, error } = await supabase
      .from('tickets')
      .insert({
        workspace_id: workspaceId,
        customer_id: conv.customer_id ?? null,
        conversation_id: conv.id,
        subject,
        description: null,
        category: 'general',
        priority: 'medium',
        status: 'open',
        escalation_reason: reason,
        escalated_at: now,
      })
      .select()
      .single();
    if (error || !data) throw new ApiError(500, 'Failed to create ticket');
    ticket = data as { id: string };
  }

  const { data: handoff, error: handoffError } = await supabase
    .from('handoffs')
    .insert({
      workspace_id: workspaceId,
      conversation_id: conversationId,
      ticket_id: ticket.id,
      reason,
      triggered_by: triggeredBy,
      ai_paused: true,
    })
    .select()
    .single();
  if (handoffError || !handoff) throw new ApiError(500, 'Failed to record handoff');

  const { error: convUpdateError } = await supabase
    .from('conversations')
    .update({ ai_paused: true, handoff_reason: reason, handed_off_at: now })
    .eq('workspace_id', workspaceId)
    .eq('id', conversationId);
  if (convUpdateError) throw new ApiError(500, 'Failed to pause AI on conversation');

  return { ticket: { id: ticket.id }, handoff: { id: (handoff as { id: string }).id }, reused };
}

/**
 * Resume AI on a conversation after a human handoff. Clears the pause on
 * the conversation and stamps resumed_at on the latest handoff row.
 * Callers must check the workspace AI policy first — this function never
 * auto-resumes AI on its own.
 */
export async function resumeAi(
  supabase: SupabaseClient,
  { workspaceId, conversationId, resumedBy }: ResumeAiInput,
): Promise<void> {
  // resumedBy is the agent who resumed; the schema records the resume on
  // the handoff row (resumed_at), not the actor, so it is intentionally
  // not persisted anywhere else.
  void resumedBy;
  const { data: conversation, error: convError } = await supabase
    .from('conversations')
    .select('id')
    .eq('workspace_id', workspaceId)
    .eq('id', conversationId)
    .maybeSingle();
  if (convError || !conversation) throw new ApiError(404, 'Conversation not found');

  const { error: convUpdateError } = await supabase
    .from('conversations')
    .update({ ai_paused: false, handoff_reason: null, handed_off_at: null })
    .eq('workspace_id', workspaceId)
    .eq('id', conversationId);
  if (convUpdateError) throw new ApiError(500, 'Failed to resume AI on conversation');

  const { data: latest } = await supabase
    .from('handoffs')
    .select('id')
    .eq('workspace_id', workspaceId)
    .eq('conversation_id', conversationId)
    .order('created_at', { ascending: false })
    .limit(1);
  const latestHandoff = (latest ?? [])[0] as { id: string } | undefined;
  if (latestHandoff) {
    await supabase
      .from('handoffs')
      .update({ resumed_at: new Date().toISOString(), ai_paused: false })
      .eq('workspace_id', workspaceId)
      .eq('id', latestHandoff.id);
  }
}
