/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import request from 'supertest';
import express from 'express';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

// ---- Mock Supabase client (offline tests) ----
// Covers the automation-events list route (workspace_members +
// automation_events tables) and the 0009 outbox RPC contract
// (claim / ack / reclaim), which the mock implements with the same
// semantics as the SQL: claim sets processing + attempts+1, ack
// 'processed' sets processed_at, ack 'failed' returns to pending with
// a future next_attempt_at, ack 'dead' is terminal, reclaim resets
// stale 'processing' rows to pending keeping attempts.

const mockState = vi.hoisted(() => {
  let seq = 0;
  const ts = () => new Date(Date.now() + ++seq * 1000).toISOString();
  return {
    seq: 0,
    ts,
    userIds: {
      user1: '11111111-1111-4111-8111-111111111111',
      user2: '22222222-2222-4222-8222-222222222222',
    },
    members: [
      { workspace_id: 'ws-1', user_id: '11111111-1111-4111-8111-111111111111', role: 'owner' },
    ] as Array<Record<string, any>>,
    automationEvents: [] as Array<Record<string, any>>,
    ackCalls: [] as Array<{ eventId: string; status: string }>,
  };
});

function seedEvents() {
  mockState.automationEvents.length = 0;
  mockState.ackCalls.length = 0;
  const base = (id: string, status: string, workspaceId = 'ws-1', attempts = 0) => ({
    id,
    workspace_id: workspaceId,
    event_type: 'customer.message.created',
    entity_type: 'message',
    entity_id: '00000000-0000-4000-8000-000000000001',
    payload: { workspace_id: workspaceId, message_id: '00000000-0000-4000-8000-000000000001' },
    status,
    attempts,
    created_at: mockState.ts(),
    processed_at: null,
    claimed_at: null,
    next_attempt_at: null,
  });
  mockState.automationEvents.push(
    base('evt-pending-1', 'pending'),
    base('evt-pending-2', 'pending'),
    base('evt-processed-1', 'processed'),
    base('evt-failed-1', 'failed'),
    base('evt-other-ws', 'pending', 'ws-2'),
  );
}

vi.mock('../lib/supabase.js', () => {
  const tableRows = (table: string): Array<Record<string, any>> => {
    switch (table) {
      case 'workspace_members': return mockState.members;
      case 'automation_events': return mockState.automationEvents;
      default: return [];
    }
  };

  const makeBuilder = (table: string) => {
    const filters: Array<(r: Record<string, any>) => boolean> = [];
    const orders: Array<{ col: string; asc: boolean }> = [];
    let range: [number, number] | null = null;
    let countMode: string | null = null;

    const execute = () => {
      const rows = tableRows(table);
      const filtered = rows.filter((r) => filters.every((f) => f(r)));
      const total = filtered.length;
      let out = [...filtered];
      for (const o of orders) {
        out.sort((a, b) => {
          if (a[o.col] < b[o.col]) return o.asc ? -1 : 1;
          if (a[o.col] > b[o.col]) return o.asc ? 1 : -1;
          return 0;
        });
      }
      if (range) out = out.slice(range[0], range[1] + 1);
      return { data: out.map((r) => ({ ...r })), count: countMode === 'exact' ? total : null, error: null };
    };

    const b: any = {
      select: (_cols?: string, opts?: { count?: string }) => {
        if (opts?.count) countMode = opts.count;
        return b;
      },
      eq: (col: string, val: unknown) => { filters.push((r) => r[col] === val); return b; },
      order: (col: string, opts?: { ascending?: boolean }) => {
        orders.push({ col, asc: opts?.ascending ?? true });
        return b;
      },
      range: (from: number, to: number) => { range = [from, to]; return b; },
      update: (patch: Record<string, any>) => ({
        eq: async (_col: string, val: unknown) => {
          const rows = tableRows(table);
          const row = rows.find((r) => r.id === val);
          if (row) Object.assign(row, patch);
          return { error: null };
        },
      }),
      maybeSingle: async () => {
        const res = execute();
        return { data: res.data[0] ?? null, error: null };
      },
      single: async () => {
        const res = execute();
        if (!res.data[0]) return { data: null, error: { message: 'not found' } };
        return { data: res.data[0], error: null };
      },
      then: (resolve: (v: unknown) => void, reject?: (e: unknown) => void) => {
        try { resolve(execute()); } catch (e) { if (reject) reject(e); }
      },
    };
    return b;
  };

  const rpc = async (fn: string, params: Record<string, any>) => {
    if (fn === 'claim_automation_events') {
      const now = Date.now();
      const due = mockState.automationEvents
        .filter(
          (e) =>
            e.status === 'pending' &&
            (!e.next_attempt_at || new Date(e.next_attempt_at).getTime() <= now),
        )
        .sort((a, b) => a.created_at.localeCompare(b.created_at))
        .slice(0, params.p_limit ?? 10);
      for (const e of due) {
        e.status = 'processing';
        e.attempts += 1;
        e.claimed_at = new Date().toISOString();
      }
      return { data: due.map((e) => ({ ...e })), error: null };
    }
    if (fn === 'ack_automation_event') {
      const e = mockState.automationEvents.find((x) => x.id === params.p_event_id);
      if (!e) return { data: null, error: { message: 'event not found' } };
      mockState.ackCalls.push({ eventId: e.id, status: params.p_status });
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
      const timeoutMs = (params.p_timeout_seconds ?? 300) * 1000;
      let count = 0;
      for (const e of mockState.automationEvents) {
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

  const makeClient = () => ({
    auth: {
      getUser: async (token: string) => {
        const map: Record<string, string> = {
          'valid-token': mockState.userIds.user1,
          'other-token': mockState.userIds.user2,
        };
        const id = map[token];
        return id
          ? { data: { user: { id, email: `${id}@example.com` } }, error: null }
          : { data: { user: null }, error: { message: 'bad token' } };
      },
    },
    from: (table: string) => makeBuilder(table),
    rpc,
  });

  return {
    getSupabase: () => makeClient(),
    getUserSupabase: () => makeClient(),
  };
});

import { automationEventsRouter } from '../routes/automationEvents.js';
import { authMiddleware } from '../middleware/auth.js';
import { requireWorkspaceMember } from '../middleware/workspaceAuth.js';
import { errorHandler } from '../errors.js';
import { signWebhook, verifyWebhook, verifyWebhookRequest } from '../lib/webhookAuth.js';
import { getServiceSupabase } from '../lib/serviceSupabase.js';
import { getSupabase } from '../lib/supabase.js';
import type { Env } from '../env.js';

const env: Env = {
  PORT: 4000,
  FRONTEND_URL: 'http://localhost:5173',
  SUPABASE_URL: 'https://example.supabase.co',
  SUPABASE_ANON_KEY: 'anon-key',
  NODE_ENV: 'test',
  AI_PROVIDER_ORDER: 'groq,gemini',
  AI_MODEL_GROQ: 'openai/gpt-oss-20b',
  AI_MODEL_GROQ_QUALITY: 'openai/gpt-oss-120b',
  AI_MODEL_GEMINI: 'gemini-3.8-flash',
  AI_MODEL_GEMINI_FALLBACKS: 'gemini-3.6-flash,gemini-3.5-flash-lite,gemini-3.1-flash-lite',
  AI_REQUEST_TIMEOUT_MS: 30000,
  AI_DIRECT_PROCESSING: false,
  API_BASE_URL: 'http://localhost:4000',
};

// The route is NOT mounted in app.ts yet (Worker A must not touch
// app.ts), so the test mounts it the same way app.ts will: auth +
// requireWorkspaceMember + router under the workspace path.
function buildTestApp() {
  const app = express();
  app.use(express.json());
  app.use(
    '/api/workspaces/:workspaceId/automation-events',
    authMiddleware(env),
    requireWorkspaceMember(env),
    automationEventsRouter(env),
  );
  app.use(errorHandler);
  return app;
}

const SECRET = 'test-webhook-secret';
const BODY = JSON.stringify({ event_id: 'evt-1', event_type: 'customer.message.created' });

describe('webhookAuth (HMAC signing)', () => {
  it('valid signature verifies', () => {
    const timestamp = Math.floor(Date.now() / 1000);
    const signature = signWebhook(SECRET, BODY, timestamp);
    expect(signature).toMatch(/^sha256=[0-9a-f]{64}$/);
    expect(verifyWebhook(SECRET, BODY, signature, timestamp)).toBe(true);
  });

  it('tampered body fails verification', () => {
    const timestamp = Math.floor(Date.now() / 1000);
    const signature = signWebhook(SECRET, BODY, timestamp);
    expect(verifyWebhook(SECRET, BODY + ' ', signature, timestamp)).toBe(false);
  });

  it('expired timestamp fails verification', () => {
    const old = Math.floor(Date.now() / 1000) - 3600;
    const signature = signWebhook(SECRET, BODY, old);
    expect(verifyWebhook(SECRET, BODY, signature, old)).toBe(false);
  });

  it('replayed signature against a different body fails verification', () => {
    const timestamp = Math.floor(Date.now() / 1000);
    const signature = signWebhook(SECRET, BODY, timestamp);
    const otherBody = JSON.stringify({ event_id: 'evt-2', event_type: 'ticket.created' });
    expect(verifyWebhook(SECRET, otherBody, signature, timestamp)).toBe(false);
  });

  it('malformed input never throws and returns false', () => {
    expect(verifyWebhook(SECRET, BODY, null, null)).toBe(false);
    expect(verifyWebhook(SECRET, BODY, 'not-hex', 'not-a-timestamp')).toBe(false);
    expect(verifyWebhook(SECRET, BODY, 'aa', 99999999999)).toBe(false);
  });

  it('verifyWebhookRequest rejects unauthorized requests', () => {
    const timestamp = Math.floor(Date.now() / 1000);
    const signature = signWebhook(SECRET, BODY, timestamp);
    const good = { 'x-sf-signature': signature, 'x-sf-timestamp': String(timestamp) };
    expect(verifyWebhookRequest(good, BODY, SECRET)).toBe(true);
    // Missing headers.
    expect(verifyWebhookRequest({}, BODY, SECRET)).toBe(false);
    // Wrong secret.
    expect(verifyWebhookRequest(good, BODY, 'wrong-secret')).toBe(false);
    // Tampered body with the original signature.
    expect(verifyWebhookRequest(good, BODY + 'x', SECRET)).toBe(false);
    // Header names are case-insensitive.
    expect(
      verifyWebhookRequest(
        { 'X-SF-Signature': signature, 'X-SF-Timestamp': String(timestamp) },
        BODY,
        SECRET,
      ),
    ).toBe(true);
  });
});

describe('serviceSupabase helper', () => {
  it('throws a clear error when the service-role key is missing', () => {
    expect(() =>
      getServiceSupabase({ SUPABASE_URL: 'https://example.supabase.co' }),
    ).toThrow(/SUPABASE_SERVICE_ROLE_KEY/);
  });

  it('creates a client when the key is present', () => {
    const client = getServiceSupabase({
      SUPABASE_URL: 'https://example.supabase.co',
      SUPABASE_SERVICE_ROLE_KEY: 'service-key',
    });
    expect(client).toBeTruthy();
  });
});

describe('0009 migration SQL shape', () => {
  const migrationPath = path.join(
    path.dirname(fileURLToPath(import.meta.url)),
    '..',
    '..',
    '..',
    '..',
    'supabase',
    'migrations',
    '0009_phase3_ai_platform.sql',
  );
  const sql = readFileSync(migrationPath, 'utf8');
  const optionalPath = path.join(
    path.dirname(fileURLToPath(import.meta.url)),
    '..',
    '..',
    '..',
    '..',
    'supabase',
    'migrations',
    '0010_phase3_vector_optional.sql',
  );
  const optionalSql = readFileSync(optionalPath, 'utf8');

  it('defines the claim/ack/reclaim RPCs, service_role-only', () => {
    expect(sql).toContain('create or replace function public.claim_automation_events');
    expect(sql).toContain('for update skip locked');
    expect(sql).toContain('grant execute on function public.claim_automation_events(int) to service_role');
    expect(sql).toContain('create or replace function public.reclaim_stale_automation_events');
    expect(sql).toContain('grant execute on function public.reclaim_stale_automation_events(int) to service_role');
    expect(sql).toContain('create or replace function public.ack_automation_event');
    expect(sql).toContain('grant execute on function public.ack_automation_event(uuid, text) to service_role');
    expect(sql).toContain("revoke all on function public.claim_automation_events(int) from public");
  });

  it('ack failed uses exponential backoff with jitter, capped at 300s', () => {
    expect(sql).toContain("least(power(2, attempts) * interval '5 seconds', interval '300 seconds')");
    expect(sql).toContain('random()');
  });

  it('creates the 7 new tables with RLS via is_workspace_member and no USING (true)', () => {
    for (const table of [
      'knowledge_documents',
      'knowledge_chunks',
      'knowledge_index_jobs',
      'ai_settings',
      'ai_executions',
      'ai_suggestions',
      'handoffs',
    ]) {
      expect(sql).toContain(`create table if not exists public.${table}`);
      expect(sql).toContain(`alter table public.${table} enable row level security`);
      expect(sql).toContain(`public.is_workspace_member(${table}.workspace_id)`);
    }
    // Negative checks run on comment-stripped SQL: the header comments
    // mention both strings in prose ("no USING (true) policy",
    // "no policy queries workspace_members directly").
    const sqlNoComments = sql.replace(/^--.*$/gm, '');
    expect(sqlNoComments).not.toMatch(/using\s*\(\s*true\s*\)/i);
    expect(sqlNoComments).not.toContain('workspace_members');
  });

  it('adds the Phase 3 columns and the chunk search-vector trigger', () => {
    expect(sql).toContain('add column if not exists ai_paused boolean');
    expect(sql).toContain('add column if not exists escalation_reason text');
    expect(sql).toContain('add column if not exists claimed_at timestamptz');
    expect(sql).toContain('add column if not exists next_attempt_at timestamptz');
    expect(sql).toContain("to_tsvector('english', coalesce(new.content, ''))");
    expect(sql).toContain('knowledge_chunks_workspace_consistency');
  });

  it('search_knowledge_chunks RPC exists with the RAG contract', () => {
    expect(sql).toContain('create or replace function public.search_knowledge_chunks(');
    expect(sql).toContain('p_workspace_id uuid');
    expect(sql).toContain('p_query text');
    expect(sql).toContain('p_limit int default 5');
    expect(sql).toContain("plainto_tsquery('english', p_query)");
    expect(sql).toContain('ts_rank(c.search_vector');
    expect(sql).toContain('order by rank desc');
    expect(sql).toContain('d.enabled = true');
    expect(sql).toContain('d.archived = false');
    expect(sql).toContain('c.workspace_id = p_workspace_id');
    expect(sql).toContain(
      'grant execute on function public.search_knowledge_chunks(uuid, text, int) to authenticated, service_role',
    );
    expect(sql).toContain(
      'revoke all on function public.search_knowledge_chunks(uuid, text, int) from public',
    );
  });

  it('0010 is optional: halfvec column, explicitly not wired in Phase 3', () => {
    expect(optionalSql).toContain('add column if not exists embedding halfvec(3072)');
    expect(optionalSql).toMatch(/NOT wired in Phase 3/i);
  });
});

describe('0011 migration SQL shape', () => {
  const migrationPath = path.join(
    path.dirname(fileURLToPath(import.meta.url)),
    '..',
    '..',
    '..',
    '..',
    'supabase',
    'migrations',
    '0011_phase3_kb_retrieval_or_fallback.sql',
  );
  const sql = readFileSync(migrationPath, 'utf8');

  it('replaces search_knowledge_chunks with the same signature and grants', () => {
    expect(sql).toContain('create or replace function public.search_knowledge_chunks(');
    expect(sql).toContain('p_workspace_id uuid');
    expect(sql).toContain('p_query text');
    expect(sql).toContain('p_limit int default 5');
    expect(sql).toContain(
      'grant execute on function public.search_knowledge_chunks(uuid, text, int) to authenticated, service_role',
    );
    expect(sql).toContain(
      'revoke all on function public.search_knowledge_chunks(uuid, text, int) from public',
    );
  });

  it('two tiers: strict AND first, websearch OR fallback, tier 1 never repeated', () => {
    expect(sql).toContain("plainto_tsquery('english', p_query) as q_and");
    expect(sql).toContain("websearch_to_tsquery('english', p_query) as q_or");
    expect(sql).toContain('ts_rank(c.search_vector, p.q_and)');
    expect(sql).toContain('ts_rank(c.search_vector, p.q_or)');
    expect(sql).toContain('and c.search_vector @@ p.q_and');
    expect(sql).toContain('and c.search_vector @@ p.q_or');
    expect(sql).toContain('and not (c.search_vector @@ p.q_and)');
    expect(sql).toContain('order by tier asc, rank desc');
  });

  it('keeps the workspace / enabled / non-archived filters in both tiers', () => {
    const andMatches = sql.match(/c\.workspace_id = p_workspace_id/g) ?? [];
    expect(andMatches.length).toBe(2);
    expect((sql.match(/d\.enabled = true/g) ?? []).length).toBe(2);
    expect((sql.match(/d\.archived = false/g) ?? []).length).toBe(2);
  });

  it('changes no tables, columns, policies or data', () => {
    // Negative checks run on comment-stripped SQL: the header comments
    // mention these words in prose ("No tables, columns, policies or
    // data change").
    const sqlNoComments = sql.replace(/^--.*$/gm, '');
    expect(sqlNoComments).not.toMatch(/create table/i);
    expect(sqlNoComments).not.toMatch(/alter table/i);
    expect(sqlNoComments).not.toMatch(/enable row level security/i);
    expect(sqlNoComments).not.toMatch(/create policy/i);
    expect(sqlNoComments).not.toMatch(/^\s*(insert|update|delete)\s+into\s+public\./im);
  });
});

describe('outbox RPC contract via mocked Supabase client', () => {
  beforeEach(() => seedEvents());

  it('claim returns due pending rows and marks them processing', async () => {
    const client = getSupabase(env);
    const { data, error } = await client.rpc('claim_automation_events', { p_limit: 10 });
    expect(error).toBeNull();
    // The claim is global (the dispatcher is not workspace-scoped):
    // every due pending row is claimed, including the other
    // workspace's, while processed/failed rows are not.
    expect((data as Array<{ id: string }>).map((e) => e.id).sort()).toEqual([
      'evt-other-ws',
      'evt-pending-1',
      'evt-pending-2',
    ]);
    expect(mockState.automationEvents.find((e) => e.id === 'evt-pending-1')!.attempts).toBe(1);
  });

  it('ack processed / failed / dead transitions', async () => {
    const client = getSupabase(env);
    await client.rpc('claim_automation_events', { p_limit: 10 });
    await client.rpc('ack_automation_event', { p_event_id: 'evt-pending-1', p_status: 'processed' });
    await client.rpc('ack_automation_event', { p_event_id: 'evt-pending-2', p_status: 'failed' });
    expect(mockState.ackCalls).toEqual([
      { eventId: 'evt-pending-1', status: 'processed' },
      { eventId: 'evt-pending-2', status: 'failed' },
    ]);
    const failed = mockState.automationEvents.find((e) => e.id === 'evt-pending-2')!;
    expect(failed.status).toBe('pending');
    expect(new Date(failed.next_attempt_at).getTime()).toBeGreaterThan(Date.now());
    await client.rpc('ack_automation_event', { p_event_id: 'evt-pending-2', p_status: 'dead' });
    expect(mockState.automationEvents.find((e) => e.id === 'evt-pending-2')!.status).toBe('dead');
  });

  it('stale reclaim resets crashed processing rows to pending', async () => {
    const client = getSupabase(env);
    const stale = mockState.automationEvents.find((e) => e.id === 'evt-pending-1')!;
    stale.status = 'processing';
    stale.attempts = 2;
    stale.claimed_at = new Date(Date.now() - 600_000).toISOString();
    const { data } = await client.rpc('reclaim_stale_automation_events', {
      p_timeout_seconds: 300,
    });
    expect(data).toBe(1);
    expect(stale.status).toBe('pending');
    expect(stale.attempts).toBe(2);
  });

  it('no-destination leaves the event pending without consuming retries', async () => {
    // Contract test for the dispatcher's no-destination path
    // (resetEventToPending in apps/worker/src/dispatcher.ts, covered
    // end-to-end in the worker's own test file): with no destination
    // configured the worker must NOT ack — it resets the claimed row
    // to pending with a direct service-role update. The API test
    // cannot import the worker package (apps/api tsconfig rootDir),
    // so this test exercises the same update against the mocked
    // client and asserts the observable contract.
    const client = getSupabase(env);
    await client.rpc('claim_automation_events', { p_limit: 10 });
    const claimed = mockState.automationEvents.filter((e) => e.id.startsWith('evt-pending'));
    expect(claimed.every((e) => e.status === 'processing')).toBe(true);
    for (const e of claimed) {
      const { error } = await client
        .from('automation_events')
        .update({ status: 'pending', claimed_at: null, next_attempt_at: null })
        .eq('id', e.id);
      expect(error).toBeNull();
    }
    expect(mockState.ackCalls).toEqual([]);
    // The claim bumped attempts once (1); the no-destination reset adds
    // nothing further, and the rows are pending again for a later run.
    for (const e of claimed) {
      const row = mockState.automationEvents.find((x) => x.id === e.id)!;
      expect(row.status).toBe('pending');
      expect(row.attempts).toBe(1);
    }
  });
});

describe('GET /api/workspaces/:workspaceId/automation-events', () => {
  beforeEach(() => seedEvents());
  const app = buildTestApp();

  it('member lists events with {automation_events, total, page, pageSize}', async () => {
    const res = await request(app)
      .get('/api/workspaces/ws-1/automation-events')
      .set('Authorization', 'Bearer valid-token');
    expect(res.status).toBe(200);
    expect(res.body.total).toBe(4);
    expect(res.body.page).toBe(1);
    expect(res.body.pageSize).toBe(20);
    expect(res.body.automation_events).toHaveLength(4);
    // Other workspace rows are never visible.
    expect(res.body.automation_events.every((e: any) => e.workspace_id === 'ws-1')).toBe(true);
  });

  it('status filter narrows the list', async () => {
    const res = await request(app)
      .get('/api/workspaces/ws-1/automation-events?status=pending')
      .set('Authorization', 'Bearer valid-token');
    expect(res.status).toBe(200);
    expect(res.body.total).toBe(2);
    expect(res.body.automation_events.every((e: any) => e.status === 'pending')).toBe(true);
  });

  it('invalid status filter is a 400 with {error}', async () => {
    const res = await request(app)
      .get('/api/workspaces/ws-1/automation-events?status=bogus')
      .set('Authorization', 'Bearer valid-token');
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/Invalid status filter/);
  });

  it('pagination slices the list and keeps the total', async () => {
    const res = await request(app)
      .get('/api/workspaces/ws-1/automation-events?page=2&pageSize=1')
      .set('Authorization', 'Bearer valid-token');
    expect(res.status).toBe(200);
    expect(res.body.total).toBe(4);
    expect(res.body.page).toBe(2);
    expect(res.body.pageSize).toBe(1);
    expect(res.body.automation_events).toHaveLength(1);
  });

  it('non-member gets 403', async () => {
    const res = await request(app)
      .get('/api/workspaces/ws-1/automation-events')
      .set('Authorization', 'Bearer other-token');
    expect(res.status).toBe(403);
    expect(res.body.error).toMatch(/not a member/);
  });

  it('missing token gets 401', async () => {
    const res = await request(app).get('/api/workspaces/ws-1/automation-events');
    expect(res.status).toBe(401);
  });
});

