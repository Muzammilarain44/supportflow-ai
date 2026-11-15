/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, it, expect, vi } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import {
  claimEvents,
  ackEvent,
  reclaimStaleEvents,
  resetEventToPending,
  processBatch,
  startDispatcher,
  MAX_ATTEMPTS,
  type AutomationEventRow,
  type DispatcherConfig,
} from '../dispatcher.js';
import { verifyWebhook } from '../../../api/src/lib/webhookAuth.js';

// ---- In-memory mock Supabase client ----
// Mirrors the SQL contract of migration 0009 (claim/ack/reclaim):
// claim sets processing + attempts+1 + claimed_at; ack 'processed'
// sets processed_at; ack 'failed' returns to pending with a future
// next_attempt_at; ack 'dead' is terminal; reclaim resets stale
// 'processing' rows to pending, keeping attempts.

const SECRET = 'test-webhook-secret';

function makeEvent(overrides: Partial<AutomationEventRow> = {}): AutomationEventRow {
  return {
    id: `evt-${Math.random().toString(36).slice(2, 10)}`,
    workspace_id: 'ws-1',
    event_type: 'customer.message.created',
    entity_type: 'message',
    entity_id: '00000000-0000-4000-8000-000000000001',
    payload: { workspace_id: 'ws-1', message_id: '00000000-0000-4000-8000-000000000001' },
    status: 'pending',
    attempts: 0,
    created_at: new Date().toISOString(),
    ...overrides,
  };
}

function makeMockClient(seed: AutomationEventRow[]) {
  const events = seed.map((e) => ({ ...e }));
  const ackCalls: Array<{ eventId: string; status: string }> = [];
  const rpcCalls: Array<{ fn: string; params: Record<string, unknown> }> = [];
  const resetCalls: Array<{ eventId: string; patch: Record<string, unknown> }> = [];

  const rpc = async (fn: string, params: Record<string, unknown>) => {
    rpcCalls.push({ fn, params });
    if (fn === 'claim_automation_events') {
      const now = Date.now();
      const due = events
        .filter(
          (e) =>
            e.status === 'pending' &&
            (!e.next_attempt_at || new Date(e.next_attempt_at).getTime() <= now),
        )
        .sort((a, b) => a.created_at.localeCompare(b.created_at))
        .slice(0, (params.p_limit as number) ?? 10);
      for (const e of due) {
        e.status = 'processing';
        e.attempts += 1;
        e.claimed_at = new Date().toISOString();
      }
      return { data: due.map((e) => ({ ...e })), error: null };
    }
    if (fn === 'ack_automation_event') {
      const e = events.find((x) => x.id === params.p_event_id);
      if (!e) return { data: null, error: { message: 'event not found' } };
      ackCalls.push({ eventId: e.id, status: params.p_status as string });
      if (params.p_status === 'processed') {
        e.status = 'processed';
        e.processed_at = new Date().toISOString();
      } else if (params.p_status === 'failed') {
        e.status = 'pending';
        e.next_attempt_at = new Date(Date.now() + 60_000).toISOString();
      } else if (params.p_status === 'dead') {
        e.status = 'dead';
        e.processed_at = new Date().toISOString();
      } else {
        return { data: null, error: { message: 'Invalid ack status' } };
      }
      return { data: null, error: null };
    }
    if (fn === 'reclaim_stale_automation_events') {
      const timeoutMs = ((params.p_timeout_seconds as number) ?? 300) * 1000;
      let count = 0;
      for (const e of events) {
        if (
          e.status === 'processing' &&
          e.claimed_at &&
          new Date(e.claimed_at).getTime() < Date.now() - timeoutMs
        ) {
          e.status = 'pending';
          e.claimed_at = null;
          count += 1;
        }
      }
      return { data: count, error: null };
    }
    return { data: null, error: { message: `unknown rpc ${fn}` } };
  };

  const from = () => ({
    update: (patch: Record<string, unknown>) => ({
      eq: async (_col: string, val: unknown) => {
        const e = events.find((x) => x.id === val);
        if (e) {
          Object.assign(e, patch);
          resetCalls.push({ eventId: e.id, patch });
        }
        return { error: null };
      },
    }),
  });

  const client = { rpc, from } as unknown as SupabaseClient;
  return { client, events, ackCalls, rpcCalls, resetCalls };
}

function baseConfig(overrides: Partial<DispatcherConfig> = {}): DispatcherConfig {
  return {
    n8nWebhookUrl: 'https://n8n.example/hooks/test',
    webhookSecret: SECRET,
    apiBaseUrl: 'http://localhost:4000',
    aiDirectProcessing: false,
    batchSize: 10,
    pollMs: 60_000,
    staleTimeoutSeconds: 300,
    fetchTimeoutMs: 1000,
    ...overrides,
  };
}

describe('outbox RPC contract (mocked Supabase client)', () => {
  it('claim returns due pending rows and marks them processing with attempts+1', async () => {
    const { client, events } = makeMockClient([
      makeEvent({ id: 'evt-a', status: 'pending', attempts: 2 }),
      makeEvent({ id: 'evt-b', status: 'pending' }),
      makeEvent({ id: 'evt-c', status: 'processed' }),
      makeEvent({ id: 'evt-d', status: 'pending', next_attempt_at: new Date(Date.now() + 600_000).toISOString() }),
    ]);
    const claimed = await claimEvents(client, 10);
    expect(claimed.map((e) => e.id).sort()).toEqual(['evt-a', 'evt-b']);
    expect(claimed.every((e) => e.status === 'processing')).toBe(true);
    expect(events.find((e) => e.id === 'evt-a')!.attempts).toBe(3);
    expect(events.find((e) => e.id === 'evt-d')!.status).toBe('pending');
  });

  it('ack processed / failed / dead transitions match the SQL contract', async () => {
    const { client, events } = makeMockClient([
      makeEvent({ id: 'evt-a', status: 'processing', attempts: 1 }),
      makeEvent({ id: 'evt-b', status: 'processing', attempts: 1 }),
      makeEvent({ id: 'evt-c', status: 'processing', attempts: 8 }),
    ]);
    await ackEvent(client, 'evt-a', 'processed');
    await ackEvent(client, 'evt-b', 'failed');
    await ackEvent(client, 'evt-c', 'dead');
    expect(events.find((e) => e.id === 'evt-a')!.status).toBe('processed');
    expect(events.find((e) => e.id === 'evt-a')!.processed_at).toBeTruthy();
    const b = events.find((e) => e.id === 'evt-b')!;
    expect(b.status).toBe('pending');
    expect(new Date(b.next_attempt_at!).getTime()).toBeGreaterThan(Date.now());
    expect(b.attempts).toBe(1); // ack does not increment attempts
    expect(events.find((e) => e.id === 'evt-c')!.status).toBe('dead');
  });

  it('reclaim resets stale processing rows to pending and keeps attempts', async () => {
    const { client, events } = makeMockClient([
      makeEvent({
        id: 'evt-stale',
        status: 'processing',
        attempts: 2,
        claimed_at: new Date(Date.now() - 600_000).toISOString(),
      }),
      makeEvent({
        id: 'evt-fresh',
        status: 'processing',
        attempts: 1,
        claimed_at: new Date().toISOString(),
      }),
    ]);
    const count = await reclaimStaleEvents(client, 300);
    expect(count).toBe(1);
    expect(events.find((e) => e.id === 'evt-stale')!.status).toBe('pending');
    expect(events.find((e) => e.id === 'evt-stale')!.attempts).toBe(2);
    expect(events.find((e) => e.id === 'evt-fresh')!.status).toBe('processing');
  });
});

describe('dispatcher delivery', () => {
  it('2xx -> ack processed, and the delivery is HMAC-signed', async () => {
    const { client, events, ackCalls } = makeMockClient([makeEvent({ id: 'evt-1' })]);
    let captured: { headers: any; body: string } | null = null;
    const fetchOk = vi.fn(async (_url: string, opts: any) => {
      captured = { headers: opts.headers, body: opts.body as string };
      return { status: 200 };
    });
    const outcomes = await processBatch(client, baseConfig(), fetchOk as any);
    expect(outcomes).toEqual([{ eventId: 'evt-1', outcome: 'processed', status: 200 }]);
    expect(ackCalls).toEqual([{ eventId: 'evt-1', status: 'processed' }]);
    expect(events[0].status).toBe('processed');
    expect(captured).not.toBeNull();
    const { headers, body } = captured!;
    expect(
      verifyWebhook(SECRET, body, headers['x-sf-signature'], headers['x-sf-timestamp']),
    ).toBe(true);
    const parsed = JSON.parse(body);
    expect(parsed.correlation_id).toBe('evt-1');
    expect(parsed.event_id).toBe('evt-1');
  });

  it('500 -> ack failed (backoff applies via the RPC)', async () => {
    const { client, events, ackCalls } = makeMockClient([makeEvent({ id: 'evt-1', attempts: 0 })]);
    const fetch500 = vi.fn(async () => ({ status: 500 }));
    const outcomes = await processBatch(client, baseConfig(), fetch500 as any);
    expect(outcomes[0].outcome).toBe('failed');
    expect(ackCalls).toEqual([{ eventId: 'evt-1', status: 'failed' }]);
    expect(events[0].status).toBe('pending'); // retried later, not lost
    expect(events[0].attempts).toBe(1); // incremented once, by the claim
  });

  it('timeout -> ack failed', async () => {
    const { client, ackCalls } = makeMockClient([makeEvent({ id: 'evt-1' })]);
    const fetchTimeout = vi.fn(
      (_url: string, opts: any) =>
        new Promise((_resolve, reject) => {
          opts.signal?.addEventListener('abort', () =>
            reject(new DOMException('Aborted', 'AbortError')),
          );
        }),
    );
    const outcomes = await processBatch(
      client,
      baseConfig({ fetchTimeoutMs: 50 }),
      fetchTimeout as any,
    );
    expect(outcomes[0].outcome).toBe('failed');
    expect(ackCalls).toEqual([{ eventId: 'evt-1', status: 'failed' }]);
  });

  it('8th attempt + failure -> ack dead, not failed', async () => {
    expect(MAX_ATTEMPTS).toBe(8);
    const { client, events, ackCalls } = makeMockClient([
      makeEvent({ id: 'evt-1', attempts: 7 }),
    ]);
    const fetch500 = vi.fn(async () => ({ status: 500 }));
    const outcomes = await processBatch(client, baseConfig(), fetch500 as any);
    // Claim bumps attempts 7 -> 8, then the failed delivery dead-letters it.
    expect(events[0].attempts).toBe(8);
    expect(outcomes[0].outcome).toBe('dead');
    expect(ackCalls).toEqual([{ eventId: 'evt-1', status: 'dead' }]);
    expect(events[0].status).toBe('dead');
  });

  it('duplicate event id in one claimed batch is delivered and acked only once', async () => {
    const evt = makeEvent({ id: 'evt-1' });
    const { client, ackCalls } = makeMockClient([evt]);
    // Force the claim to return the same row twice.
    const origRpc = (client as any).rpc;
    (client as any).rpc = async (fn: string, params: any) => {
      const res = await origRpc(fn, params);
      if (fn === 'claim_automation_events') {
        return { data: [res.data[0], res.data[0]], error: null };
      }
      return res;
    };
    const fetchOk = vi.fn(async () => ({ status: 200 }));
    const outcomes = await processBatch(client, baseConfig(), fetchOk as any);
    expect(fetchOk).toHaveBeenCalledTimes(1);
    expect(ackCalls).toEqual([{ eventId: 'evt-1', status: 'processed' }]);
    expect(outcomes.map((o) => o.outcome)).toEqual(['processed', 'skipped-duplicate']);
  });

  it('no destination configured -> event reset to pending, attempts untouched, no fetch', async () => {
    const { client, events, ackCalls, resetCalls } = makeMockClient([
      makeEvent({ id: 'evt-1', attempts: 0 }),
    ]);
    const fetchSpy = vi.fn(async () => ({ status: 200 }));
    const outcomes = await processBatch(
      client,
      baseConfig({ n8nWebhookUrl: undefined, aiDirectProcessing: false }),
      fetchSpy as any,
    );
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(ackCalls).toEqual([]);
    expect(outcomes).toEqual([{ eventId: 'evt-1', outcome: 'no-destination', status: null }]);
    expect(resetCalls).toEqual([
      { eventId: 'evt-1', patch: { status: 'pending', claimed_at: null, next_attempt_at: null } },
    ]);
    expect(events[0].status).toBe('pending');
    expect(events[0].attempts).toBe(1); // claim bumped once; the reset adds nothing
  });

  it('AI direct processing posts to the API endpoint when n8n is unset', async () => {
    const { client, ackCalls } = makeMockClient([makeEvent({ id: 'evt-1' })]);
    let seenUrl = '';
    const fetchOk = vi.fn(async (url: string) => {
      seenUrl = url;
      return { status: 200 };
    });
    await processBatch(
      client,
      baseConfig({
        n8nWebhookUrl: undefined,
        aiDirectProcessing: true,
        apiBaseUrl: 'https://api.example',
      }),
      fetchOk as any,
    );
    expect(seenUrl).toBe('https://api.example/api/automation/process-event');
    expect(ackCalls).toEqual([{ eventId: 'evt-1', status: 'processed' }]);
  });

  it('crash recovery: reclaim is called on dispatcher start, before polling', async () => {
    const { client, rpcCalls } = makeMockClient([
      makeEvent({
        id: 'evt-stale',
        status: 'processing',
        claimed_at: new Date(Date.now() - 600_000).toISOString(),
      }),
    ]);
    const { stop, ready } = startDispatcher(client, baseConfig({ pollMs: 60_000 }));
    await ready;
    expect(rpcCalls[0].fn).toBe('reclaim_stale_automation_events');
    expect(rpcCalls[0].params).toEqual({ p_timeout_seconds: 300 });
    stop();
  });

  it('resetEventToPending does not ack and does not consume retries', async () => {
    const { client, events, ackCalls } = makeMockClient([
      makeEvent({ id: 'evt-1', status: 'processing', attempts: 3 }),
    ]);
    await resetEventToPending(client, 'evt-1');
    expect(ackCalls).toEqual([]);
    expect(events[0].status).toBe('pending');
    expect(events[0].attempts).toBe(3);
  });
});
