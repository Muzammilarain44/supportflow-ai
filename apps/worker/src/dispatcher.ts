import type { SupabaseClient } from '@supabase/supabase-js';
import { postSignedJson, type DeliveryResult, type FetchFn } from './n8nClient.js';

/**
 * Outbox dispatcher (Worker A, Phase 3).
 *
 * Polls the transactional outbox (public.automation_events) via the
 * service-role RPCs from migration 0009:
 *   claim_automation_events(p_limit)      — atomic claim (SKIP LOCKED)
 *   ack_automation_event(id, status)      — 'processed' | 'failed' | 'dead'
 *   reclaim_stale_automation_events(secs) — crash recovery on startup
 *
 * Delivery contract:
 *   * 2xx from the destination  -> ack 'processed'
 *   * any other status / network error / timeout -> ack 'failed'
 *     (the RPC applies exponential backoff; attempts were already
 *     incremented by the claim)
 *   * attempts >= MAX_ATTEMPTS (8) on a failed delivery -> ack 'dead'
 *   * NO destination configured (no N8N_WEBHOOK_URL and
 *     AI_DIRECT_PROCESSING is not 'true') -> the event is reset to
 *     'pending' WITHOUT acking 'failed' and WITHOUT incrementing
 *     attempts further: resetEventToPending() updates the row directly
 *     through the service-role client (service role bypasses RLS, so
 *     this needs no RPC). The event is simply left for a later run
 *     when a destination exists. Nothing is lost, nothing is
 *     duplicated, and a missing destination never consumes retries.
 *
 * Logging: every delivery attempt is logged with event id + outcome
 * only. Payload bodies, emails and message text are NEVER logged
 * (the outbox payload itself is ids-only by the DB CHECK).
 *
 * The Supabase client is injected (constructor param / function arg)
 * so tests can pass a mock; production passes the service-role client
 * from apps/api/src/lib/serviceSupabase.ts.
 */

export interface AutomationEventRow {
  id: string;
  workspace_id: string;
  event_type: string;
  entity_type: string;
  entity_id: string;
  payload: Record<string, unknown>;
  status: string;
  attempts: number;
  created_at: string;
  processed_at?: string | null;
  claimed_at?: string | null;
  next_attempt_at?: string | null;
}

export type AckStatus = 'processed' | 'failed' | 'dead';

/** After this many failed attempts (counted at claim time) an event is dead-lettered. */
export const MAX_ATTEMPTS = 8;

export interface DispatcherConfig {
  n8nWebhookUrl?: string;
  webhookSecret?: string;
  apiBaseUrl: string;
  aiDirectProcessing: boolean;
  batchSize: number;
  pollMs: number;
  staleTimeoutSeconds: number;
  fetchTimeoutMs: number;
}

export type LogFn = (msg: string, meta?: Record<string, unknown>) => void;

export interface DeliveryOutcome {
  eventId: string;
  outcome: 'processed' | 'failed' | 'dead' | 'no-destination' | 'skipped-duplicate';
  status: number | null;
}

/** Claim up to `limit` due pending events. Throws on RPC error. */
export async function claimEvents(
  client: SupabaseClient,
  limit: number,
): Promise<AutomationEventRow[]> {
  const { data, error } = await client.rpc('claim_automation_events', { p_limit: limit });
  if (error) throw new Error(`claim_automation_events failed: ${error.message}`);
  return (data ?? []) as AutomationEventRow[];
}

/** Final disposition for a claimed event. Throws on RPC error. */
export async function ackEvent(
  client: SupabaseClient,
  eventId: string,
  status: AckStatus,
): Promise<void> {
  const { error } = await client.rpc('ack_automation_event', {
    p_event_id: eventId,
    p_status: status,
  });
  if (error) throw new Error(`ack_automation_event failed: ${error.message}`);
}

/** Crash recovery: reset stale 'processing' rows to 'pending'. Returns the count. */
export async function reclaimStaleEvents(
  client: SupabaseClient,
  timeoutSeconds: number,
): Promise<number> {
  const { data, error } = await client.rpc('reclaim_stale_automation_events', {
    p_timeout_seconds: timeoutSeconds,
  });
  if (error) throw new Error(`reclaim_stale_automation_events failed: ${error.message}`);
  return (data ?? 0) as number;
}

/**
 * No-destination reset: put a claimed event back to 'pending' WITHOUT
 * incrementing attempts and WITHOUT scheduling backoff, so a later run
 * (once a destination is configured) picks it up as if never claimed.
 * Direct service-role table update — no RPC exists for this on purpose:
 * ack 'failed' would be wrong here (the event was never attempted).
 */
export async function resetEventToPending(
  client: SupabaseClient,
  eventId: string,
): Promise<void> {
  const { error } = await client
    .from('automation_events')
    .update({ status: 'pending', claimed_at: null, next_attempt_at: null })
    .eq('id', eventId);
  if (error) throw new Error(`resetEventToPending failed: ${error.message}`);
}

/** Delivery payload: ids + event metadata only, never message bodies. */
export function buildDeliveryPayload(event: AutomationEventRow): Record<string, unknown> {
  return {
    event_id: event.id,
    event_type: event.event_type,
    workspace_id: event.workspace_id,
    entity_type: event.entity_type,
    entity_id: event.entity_id,
    payload: event.payload ?? {},
    correlation_id: event.id,
  };
}

/** Decide the ack from the delivery result and the claim-time attempt count. */
export function decideAck(event: AutomationEventRow, delivery: DeliveryResult): AckStatus {
  if (delivery.ok) return 'processed';
  return event.attempts >= MAX_ATTEMPTS ? 'dead' : 'failed';
}

function destinationUrl(config: DispatcherConfig): string | null {
  if (config.n8nWebhookUrl) return config.n8nWebhookUrl;
  if (config.aiDirectProcessing) {
    return `${config.apiBaseUrl.replace(/\/$/, '')}/api/automation/process-event`;
  }
  return null;
}

/** Deliver one claimed event and ack it. Never throws for delivery failures. */
export async function deliverEvent(
  client: SupabaseClient,
  event: AutomationEventRow,
  config: DispatcherConfig,
  fetchFn: FetchFn = fetch,
  log: LogFn = () => {},
): Promise<DeliveryOutcome> {
  const url = destinationUrl(config);
  if (!url) {
    await resetEventToPending(client, event.id);
    log('No delivery destination configured; event left pending', { event_id: event.id });
    return { eventId: event.id, outcome: 'no-destination', status: null };
  }
  const secret = config.webhookSecret ?? '';
  const delivery = await postSignedJson(
    url,
    buildDeliveryPayload(event),
    secret,
    config.fetchTimeoutMs,
    fetchFn,
  );
  const ack = decideAck(event, delivery);
  await ackEvent(client, event.id, ack);
  log('Delivery attempt', {
    event_id: event.id,
    event_type: event.event_type,
    outcome: ack,
    http_status: delivery.status,
    attempts: event.attempts,
  });
  return { eventId: event.id, outcome: ack, status: delivery.status };
}

/**
 * Claim one batch and deliver each event. A claimed event id that
 * appears twice in the same batch is delivered (and acked) only once —
 * the duplicate is skipped, so a double-claim can never double-ack.
 */
export async function processBatch(
  client: SupabaseClient,
  config: DispatcherConfig,
  fetchFn: FetchFn = fetch,
  log: LogFn = () => {},
): Promise<DeliveryOutcome[]> {
  const events = await claimEvents(client, config.batchSize);
  const outcomes: DeliveryOutcome[] = [];
  const seen = new Set<string>();
  for (const event of events) {
    if (seen.has(event.id)) {
      log('Skipping duplicate event id in batch', { event_id: event.id });
      outcomes.push({ eventId: event.id, outcome: 'skipped-duplicate', status: null });
      continue;
    }
    seen.add(event.id);
    outcomes.push(await deliverEvent(client, event, config, fetchFn, log));
  }
  return outcomes;
}

/**
 * Start the polling loop. Reclaims stale events once on startup (crash
 * recovery), then claims + delivers a batch every `pollMs`. Returns a
 * stop function; in-flight work is allowed to finish, the next poll is
 * cancelled. The caller owns SIGINT/SIGTERM handling (see index.ts).
 */
export function startDispatcher(
  client: SupabaseClient,
  config: DispatcherConfig,
  fetchFn: FetchFn = fetch,
  log: LogFn = () => {},
): { stop: () => void; ready: Promise<void> } {
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let inFlight: Promise<unknown> | null = null;

  const tick = async (): Promise<void> => {
    if (stopped) return;
    try {
      inFlight = processBatch(client, config, fetchFn, log);
      await inFlight;
    } catch (e) {
      log('Dispatcher batch failed', {
        error: e instanceof Error ? e.message : String(e),
      });
    } finally {
      inFlight = null;
      if (!stopped) timer = setTimeout(() => void tick(), config.pollMs);
    }
  };

  const ready = (async () => {
    try {
      const reclaimed = await reclaimStaleEvents(client, config.staleTimeoutSeconds);
      log('Reclaimed stale automation events on startup', { count: reclaimed });
    } catch (e) {
      log('Startup reclaim failed (continuing)', {
        error: e instanceof Error ? e.message : String(e),
      });
    }
    if (!stopped) timer = setTimeout(() => void tick(), 0);
  })();

  return {
    stop: () => {
      stopped = true;
      if (timer) clearTimeout(timer);
      timer = null;
    },
    ready,
  };
}
