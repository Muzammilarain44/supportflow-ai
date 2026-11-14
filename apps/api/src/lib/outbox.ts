import type { SupabaseClient } from '@supabase/supabase-js';
import { logger } from '../logger.js';

/**
 * Transactional outbox writer. Records one automation_events row via the
 * SECURITY DEFINER RPC `record_automation_event` (ids-only payloads —
 * never message bodies, emails or phone numbers; the DB CHECK enforces
 * this). A failure to record must NEVER fail the main operation: the
 * error is logged and the caller continues.
 */
export async function recordOutbox(
  supabase: SupabaseClient,
  workspaceId: string,
  eventType:
    | 'customer.message.created'
    | 'conversation.created'
    | 'ticket.created'
    | 'ticket.priority.changed'
    | 'ticket.assigned'
    | 'ticket.resolved',
  entityType: string,
  entityId: string,
  payload: Record<string, unknown>,
): Promise<void> {
  try {
    const { error } = await supabase.rpc('record_automation_event', {
      p_workspace_id: workspaceId,
      p_event_type: eventType,
      p_entity_type: entityType,
      p_entity_id: entityId,
      p_payload: payload,
    });
    if (error) {
      logger.error('Failed to record automation event', {
        eventType,
        entityType,
        error: error.message,
      });
    }
  } catch (e) {
    logger.error('Failed to record automation event', {
      eventType,
      entityType,
      error: e instanceof Error ? e.message : String(e),
    });
  }
}
