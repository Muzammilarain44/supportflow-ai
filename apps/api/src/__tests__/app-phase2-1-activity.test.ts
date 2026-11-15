/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, it, expect, vi } from 'vitest';
import request from 'supertest';

// ---- Mock Supabase client (offline tests), following app-phase2.test.ts ----
// NOTE: the mocked client cannot run real Postgres triggers. These tests
// assert what the API layer can prove: the customers list response
// carries last_activity_at, and a PATCH profile edit leaves it untouched.
// The migration-0007 trigger itself (visitor message / agent reply bump
// last_activity_at forward, older timestamps never regress it) is marked
// NOT TESTED here — see the skipped test below; the coordinator verifies
// it live after applying 0007.

const mockState = vi.hoisted(() => {
  let seq = 0;
  const ts = () => new Date(Date.now() + ++seq * 1000).toISOString();
  const nextId = () => `00000000-0000-4000-8000-${String(++seq).padStart(12, '0')}`;
  return {
    seq: 0,
    ts,
    nextId,
    userIds: {
      user1: '11111111-1111-4111-8111-111111111111',
      user2: '22222222-2222-4222-8222-222222222222',
    },
    members: [
      { id: 'mem-1', workspace_id: 'ws-1', user_id: '11111111-1111-4111-8111-111111111111', role: 'owner', created_at: '2026-01-01T00:00:00.000Z' },
    ] as Array<Record<string, any>>,
    workspaces: [
      { id: 'ws-1', name: 'Acme', slug: 'acme', description: null, owner_id: '11111111-1111-4111-8111-111111111111' },
    ] as Array<Record<string, any>>,
    customers: [
      { id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', workspace_id: 'ws-1', full_name: 'Active Alice', email: 'active@example.com', phone: null, tags: [], notes: null, created_at: '2026-11-01T00:00:00.000Z', updated_at: '2026-11-10T10:00:00.000Z', last_activity_at: '2026-11-10T10:00:00.000Z' },
      { id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', workspace_id: 'ws-1', full_name: 'Quiet Bob', email: 'quiet@example.com', phone: null, tags: [], notes: null, created_at: '2026-11-01T00:00:00.000Z', updated_at: '2026-11-01T00:00:00.000Z', last_activity_at: null },
    ] as Array<Record<string, any>>,
    conversations: [
      { id: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc', workspace_id: 'ws-1', customer_id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', status: 'open', priority: 'medium', assigned_to: null, tags: [], created_at: '2026-11-10T09:00:00.000Z', updated_at: '2026-11-10T09:00:00.000Z', last_message_at: '2026-11-10T10:00:00.000Z' },
    ] as Array<Record<string, any>>,
    messages: [] as Array<Record<string, any>>,
    automationEvents: [] as Array<Record<string, any>>,
  };
});

vi.mock('../lib/supabase.js', () => {
  type Predicate = (row: Record<string, any>) => boolean;

  const tableRows = (table: string): Array<Record<string, any>> => {
    switch (table) {
      case 'workspace_members': return mockState.members;
      case 'workspaces': return mockState.workspaces;
      case 'customers': return mockState.customers;
      case 'conversations': return mockState.conversations;
      case 'messages': return mockState.messages;
      case 'automation_events': return mockState.automationEvents;
      default: return [];
    }
  };

  const ilikeMatch = (value: unknown, pattern: string) => {
    const needle = pattern.replace(/^%|%$/g, '').toLowerCase();
    return String(value ?? '').toLowerCase().includes(needle);
  };

  const makeBuilder = (table: string) => {
    const filters: Predicate[] = [];
    const orders: Array<{ col: string; asc: boolean; nullsFirst: boolean }> = [];
    let op: 'select' | 'insert' | 'update' | 'delete' = 'select';
    let range: [number, number] | null = null;
    let limitN: number | null = null;
    let insertRows: Array<Record<string, any>> | null = null;
    let updatePatch: Record<string, any> | null = null;

    const applyFilters = (rows: Array<Record<string, any>>) => rows.filter((r) => filters.every((f) => f(r)));
    const applyOrder = (rows: Array<Record<string, any>>) => {
      if (orders.length === 0) return rows;
      return [...rows].sort((a, b) => {
        for (const o of orders) {
          const av = a[o.col];
          const bv = b[o.col];
          if (av == null && bv == null) continue;
          if (av == null) return o.nullsFirst ? -1 : 1;
          if (bv == null) return o.nullsFirst ? 1 : -1;
          if (av < bv) return o.asc ? -1 : 1;
          if (av > bv) return o.asc ? 1 : -1;
        }
        return 0;
      });
    };

    const execute = (): { data: any; count: number | null; error: any } => {
      const clone = (r: Record<string, any>) => ({ ...r });
      const rows = tableRows(table);
      if (op === 'insert') {
        const inserted: Array<Record<string, any>> = [];
        for (const input of insertRows ?? []) {
          if (table === 'messages' && input.client_message_id) {
            const dup = rows.find(
              (r) => r.conversation_id === input.conversation_id && r.client_message_id === input.client_message_id,
            );
            if (dup) return { data: null, count: null, error: { code: '23505', message: 'duplicate key value violates unique constraint "messages_conversation_client_id_idx"' } };
          }
          const row = { ...input, id: input.id ?? mockState.nextId(), created_at: input.created_at ?? mockState.ts(), updated_at: mockState.ts() };
          rows.push(row);
          inserted.push(row);
        }
        return { data: inserted.map(clone), count: null, error: null };
      }
      if (op === 'update') {
        const matched = applyFilters(rows);
        for (const row of matched) {
          Object.assign(row, updatePatch ?? {});
          row.updated_at = mockState.ts();
        }
        return { data: matched.map(clone), count: null, error: null };
      }
      const filtered = applyFilters(rows);
      const total = filtered.length;
      let out = applyOrder(filtered);
      if (range) out = out.slice(range[0], range[1] + 1);
      if (limitN !== null) out = out.slice(0, limitN);
      return { data: out.map(clone), count: total, error: null };
    };

    const b: any = {
      select: () => b,
      eq: (col: string, val: unknown) => { filters.push((r) => r[col] === val); return b; },
      neq: (col: string, val: unknown) => { filters.push((r) => r[col] !== val); return b; },
      is: (col: string, val: unknown) => {
        if (val === null) filters.push((r) => r[col] == null);
        else filters.push((r) => r[col] === val);
        return b;
      },
      in: (col: string, vals: unknown[]) => { filters.push((r) => vals.includes(r[col])); return b; },
      ilike: (col: string, pattern: string) => { filters.push((r) => ilikeMatch(r[col], pattern)); return b; },
      or: (expr: string) => {
        const parts = expr.split(',').map((p) => {
          const m = p.match(/^(\w+)\.(ilike|eq)\.(.*)$/);
          return m ? { col: m[1], op: m[2], val: m[3] } : null;
        }).filter(Boolean) as Array<{ col: string; op: string; val: string }>;
        filters.push((r) => parts.some((p) =>
          p.op === 'ilike' ? ilikeMatch(r[p.col], p.val) : String(r[p.col] ?? '') === p.val,
        ));
        return b;
      },
      contains: (col: string, vals: unknown[]) => {
        filters.push((r) => Array.isArray(r[col]) && vals.every((v) => (r[col] as unknown[]).includes(v)));
        return b;
      },
      order: (col: string, opts?: { ascending?: boolean; nullsFirst?: boolean }) => {
        orders.push({ col, asc: opts?.ascending ?? true, nullsFirst: opts?.nullsFirst ?? false });
        return b;
      },
      range: (from: number, to: number) => { range = [from, to]; return b; },
      limit: (n: number) => { limitN = n; return b; },
      insert: (input: Record<string, any> | Array<Record<string, any>>) => {
        op = 'insert';
        insertRows = Array.isArray(input) ? input : [input];
        return b;
      },
      update: (patch: Record<string, any>) => { op = 'update'; updatePatch = patch; return b; },
      delete: () => { op = 'delete'; return b; },
      single: async () => {
        const res = execute();
        if (res.error) return { data: null, error: res.error };
        if (!res.data || res.data.length === 0) return { data: null, error: { code: 'PGRST116', message: 'JSON object requested, multiple (or no) rows returned' } };
        return { data: res.data[0], error: null };
      },
      maybeSingle: async () => {
        const res = execute();
        if (res.error) return { data: null, error: res.error };
        if (!res.data || res.data.length === 0) return { data: null, error: null };
        return { data: res.data[0], error: null };
      },
      then: (resolve: (v: unknown) => void, reject?: (e: unknown) => void) => {
        try { resolve(execute()); } catch (e) { if (reject) reject(e); }
      },
    };
    return b;
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
    rpc: async () => ({ data: null, error: { message: 'Unknown RPC' } }),
  });
  return { getSupabase: () => makeClient(), getUserSupabase: () => makeClient() };
});

import { createApp } from '../app.js';

const env = { PORT: 4000, FRONTEND_URL: 'http://localhost:5173', SUPABASE_URL: 'https://example.supabase.co', SUPABASE_ANON_KEY: 'test-key', NODE_ENV: 'test' } as any;
const app = createApp(env);
const auth = { Authorization: 'Bearer valid-token' };
const WS = '/api/workspaces/ws-1';
const ACTIVE_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const QUIET_ID = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const CONV_ID = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';

describe('customer last_activity_at (Issue 3)', () => {
  it('customers list carries last_activity_at (timestamp or null)', async () => {
    const res = await request(app).get(`${WS}/customers`).set(auth);
    expect(res.status).toBe(200);
    const byId = new Map(res.body.customers.map((c: any) => [c.id, c]));
    expect((byId.get(ACTIVE_ID) as any).last_activity_at).toBe('2026-11-10T10:00:00.000Z');
    expect((byId.get(QUIET_ID) as any).last_activity_at).toBeNull();
  });

  it('PATCH customer (profile edit) does NOT change last_activity_at', async () => {
    const before = await request(app).get(`${WS}/customers/${ACTIVE_ID}`).set(auth);
    expect(before.body.customer.last_activity_at).toBe('2026-11-10T10:00:00.000Z');
    const patched = await request(app).patch(`${WS}/customers/${ACTIVE_ID}`).set(auth).send({ phone: '+92 300 1111111', notes: 'Prefers email.' });
    expect(patched.status).toBe(200);
    expect(patched.body.customer.last_activity_at).toBe('2026-11-10T10:00:00.000Z');
    expect(patched.body.customer.phone).toBe('+92 300 1111111');
  });

  it('agent reply inserts into the same messages table the Issue 3 trigger watches', async () => {
    // The trigger fires on INSERT into messages; both the visitor RPC and
    // this agent-reply endpoint insert into that one table, so one trigger
    // covers both paths. The mock records the insert; the trigger bump
    // itself runs only in real Postgres (see the skipped test below).
    const res = await request(app).post(`${WS}/conversations/${CONV_ID}/messages`).set(auth).send({
      body: 'Thanks for reaching out — looking into it now.',
    });
    expect(res.status).toBe(201);
    expect(res.body.message.sender_type).toBe('agent');
    expect(mockState.messages).toHaveLength(1);
    expect(mockState.messages[0].conversation_id).toBe(CONV_ID);
    expect(mockState.messages[0].customer_id).toBe(ACTIVE_ID);
  });

  it.skip('LIVE ONLY — NOT TESTED HERE: migration 0007 trigger bumps last_activity_at on visitor + agent messages, never regresses it', () => {
    // Requires real Postgres: apply 0007 in the Supabase SQL Editor, then
    // verify live that (1) a visitor message moves the customer's
    // last_activity_at forward, (2) an agent reply does the same, (3) a
    // message with an older created_at never moves it backwards, and
    // (4) PATCH customer still leaves it unchanged. Skipped on purpose:
    // the mocked API tests cannot execute a database trigger.
    expect(true).toBe(true);
  });
});
