/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, it, expect, vi } from 'vitest';
import request from 'supertest';
import express from 'express';

// ---- Rich in-memory mock Supabase client (offline tests) ----
// The valid widget key lives in mockState.widgetKey (hoisted, so the
// vi.mock factory can use it).

const mockState = vi.hoisted(() => {
  let seq = 0;
  const ts = () => new Date(Date.now() + ++seq * 1000).toISOString();
  // Mock ids must be UUID-shaped: the shared Zod schemas validate
  // customer_id / assigned_to as UUIDs, exactly like real Supabase ids.
  const nextId = () => `00000000-0000-4000-8000-${String(++seq).padStart(12, '0')}`;
  return {
    seq: 0,
    ts,
    nextId,
    userIds: {
      user1: '11111111-1111-4111-8111-111111111111',
      user2: '22222222-2222-4222-8222-222222222222',
      user3: '33333333-3333-4333-8333-333333333333',
    },
    otherWsCustomerId: '99999999-9999-4999-8999-999999999999',
    members: [
      { id: 'mem-1', workspace_id: 'ws-1', user_id: '11111111-1111-4111-8111-111111111111', role: 'owner', created_at: '2026-01-01T00:00:00.000Z' },
      { id: 'mem-3', workspace_id: 'ws-1', user_id: '33333333-3333-4333-8333-333333333333', role: 'member', created_at: '2026-01-01T00:00:00.000Z' },
    ] as Array<Record<string, any>>,
    workspaces: [
      { id: 'ws-1', name: 'Acme', slug: 'acme', description: null, owner_id: '11111111-1111-4111-8111-111111111111' },
    ] as Array<Record<string, any>>,
    customers: [
      { id: '99999999-9999-4999-8999-999999999999', workspace_id: 'ws-2', full_name: 'Other WS', email: 'other@ws2.example', phone: null, tags: [], notes: null, created_at: '2026-01-01T00:00:00.000Z', updated_at: '2026-01-01T00:00:00.000Z', last_activity_at: null },
    ] as Array<Record<string, any>>,
    conversations: [] as Array<Record<string, any>>,
    messages: [] as Array<Record<string, any>>,
    tickets: [] as Array<Record<string, any>>,
    ticketEvents: [] as Array<Record<string, any>>,
    conversationNotes: [] as Array<Record<string, any>>,
    automationEvents: [] as Array<Record<string, any>>,
    widgetSettings: [] as Array<Record<string, any>>,
    widgetSessions: new Map<string, { conversation_id: string; customer_id: string }>(),
    widgetKey: 'wgt_0123456789abcdef0123456789abcdef',
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
      case 'tickets': return mockState.tickets;
      case 'ticket_events': return mockState.ticketEvents;
      case 'conversation_notes': return mockState.conversationNotes;
      case 'automation_events': return mockState.automationEvents;
      case 'widget_settings': return mockState.widgetSettings;
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
    let countMode: string | null = null;
    let head = false;
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
      // Rows are cloned on the way out: real Supabase returns fresh JSON,
      // so a handler holding a pre-update row must NOT see later mutations
      // of that row (e.g. ticket PATCH compares old vs new values).
      const clone = (r: Record<string, any>) => ({ ...r });
      const rows = tableRows(table);
      if (op === 'insert') {
        const inserted: Array<Record<string, any>> = [];
        for (const input of insertRows ?? []) {
          if (table === 'customers') {
            const dup = rows.find(
              (r) => r.workspace_id === input.workspace_id && String(r.email).toLowerCase() === String(input.email).toLowerCase(),
            );
            if (dup) return { data: null, count: null, error: { code: '23505', message: 'duplicate key value violates unique constraint "customers_workspace_email_idx"' } };
          }
          if (table === 'messages' && input.client_message_id) {
            const dup = rows.find(
              (r) => r.conversation_id === input.conversation_id && r.client_message_id === input.client_message_id,
            );
            if (dup) return { data: null, count: null, error: { code: '23505', message: 'duplicate key value violates unique constraint "messages_conversation_client_id_idx"' } };
          }
          const row = {
            ...input,
            id: input.id ?? mockState.nextId(),
            created_at: input.created_at ?? mockState.ts(),
            updated_at: mockState.ts(),
          };
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
      if (op === 'delete') {
        const matched = applyFilters(rows);
        const keep = rows.filter((r) => !matched.includes(r));
        (tableRows(table) as any).length = 0;
        tableRows(table).push(...keep);
        return { data: matched.map(clone), count: null, error: null };
      }
      const filtered = applyFilters(rows);
      const total = filtered.length;
      let out = applyOrder(filtered);
      if (range) out = out.slice(range[0], range[1] + 1);
      if (limitN !== null) out = out.slice(0, limitN);
      if (head) return { data: [], count: total, error: null };
      return { data: out.map(clone), count: countMode === 'exact' ? total : null, error: null };
    };

    const b: any = {
      select: (_cols?: string, opts?: { count?: string; head?: boolean }) => {
        if (opts?.count) countMode = opts.count;
        if (opts?.head) head = true;
        return b;
      },
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
          'member-token': mockState.userIds.user3,
          'other-token': mockState.userIds.user2,
        };
        const id = map[token];
        return id
          ? { data: { user: { id, email: `${id}@example.com` } }, error: null }
          : { data: { user: null }, error: { message: 'bad token' } };
      },
    },
    from: (table: string) => makeBuilder(table),
    rpc: async (fn: string, params: Record<string, any>) => {
      if (fn === 'record_automation_event') {
        const allowed = ['customer.message.created', 'conversation.created', 'ticket.created', 'ticket.priority.changed', 'ticket.assigned', 'ticket.resolved'];
        if (!allowed.includes(params.p_event_type)) return { data: null, error: { message: 'Invalid automation event type' } };
        mockState.automationEvents.push({
          id: mockState.nextId(),
          workspace_id: params.p_workspace_id,
          event_type: params.p_event_type,
          entity_type: params.p_entity_type,
          entity_id: params.p_entity_id,
          payload: params.p_payload ?? {},
          status: 'pending',
          created_at: mockState.ts(),
        });
        return { data: mockState.nextId(), error: null };
      }
      if (fn === 'get_widget_config') {
        if (params.p_public_key !== mockState.widgetKey) return { data: [], error: null };
        return { data: [{ business_name: 'Acme Support', welcome_message: 'Hi! How can we help?', primary_color: '#7C3AED', enabled: true }], error: null };
      }
      if (fn === 'create_widget_visitor_session') {
        if (params.p_public_key !== mockState.widgetKey) return { data: null, error: { message: 'Unknown widget key' } };
        const customerId = mockState.nextId();
        mockState.customers.push({
          id: customerId, workspace_id: 'ws-1',
          full_name: params.p_visitor_name ?? 'Website visitor',
          email: params.p_visitor_email ?? `visitor-${customerId}@widget.local`,
          phone: null, tags: [], notes: null, created_at: mockState.ts(), updated_at: mockState.ts(), last_activity_at: null,
        });
        const conversationId = mockState.nextId();
        mockState.conversations.push({
          id: conversationId, workspace_id: 'ws-1', customer_id: customerId, status: 'open', priority: 'medium',
          assigned_to: null, tags: [], created_at: mockState.ts(), updated_at: mockState.ts(), last_message_at: null,
        });
        const token = mockState.nextId();
        mockState.widgetSessions.set(token, { conversation_id: conversationId, customer_id: customerId });
        return { data: [{ session_token: token, conversation_id: conversationId, customer_id: customerId, expires_at: new Date(Date.now() + 86400000).toISOString() }], error: null };
      }
      if (fn === 'post_widget_visitor_message') {
        const session = mockState.widgetSessions.get(params.p_token);
        if (!session) return { data: null, error: { message: 'Invalid or expired session' } };
        // Idempotency (mirrors 0005): same client key in this conversation
        // returns the existing message — no second row, no second event.
        const clientKey = params.p_client_message_id ?? null;
        if (clientKey) {
          const existing = mockState.messages.find(
            (m) => m.conversation_id === session.conversation_id && m.client_message_id === clientKey,
          );
          if (existing) return { data: [{ message_id: existing.id, is_duplicate: true }], error: null };
        }
        const messageId = mockState.nextId();
        mockState.messages.push({
          id: messageId, workspace_id: 'ws-1', conversation_id: session.conversation_id, customer_id: session.customer_id,
          sender_type: 'customer', sender_id: null, body: params.p_body, client_message_id: clientKey,
          created_at: mockState.ts(), read_at: null,
        });
        const conv = mockState.conversations.find((c) => c.id === session.conversation_id);
        if (conv) conv.last_message_at = mockState.ts();
        mockState.automationEvents.push({
          id: mockState.nextId(), workspace_id: 'ws-1', event_type: 'customer.message.created',
          entity_type: 'message', entity_id: messageId,
          payload: { workspace_id: 'ws-1', conversation_id: session.conversation_id, message_id: messageId, customer_id: session.customer_id },
          status: 'pending', created_at: mockState.ts(),
        });
        return { data: [{ message_id: messageId, is_duplicate: false }], error: null };
      }
      if (fn === 'get_widget_visitor_history') {
        const session = mockState.widgetSessions.get(params.p_token);
        if (!session) return { data: [], error: null };
        const rows = mockState.messages
          .filter((m) => m.conversation_id === session.conversation_id)
          .map((m) => ({ message_id: m.id, sender_type: m.sender_type, body: m.body, created_at: m.created_at }));
        return { data: rows, error: null };
      }
      if (fn === 'create_workspace_with_owner') {
        return { data: { id: 'ws-2', name: params.p_name, slug: params.p_slug, description: params.p_description ?? null, owner_id: 'user-1' }, error: null };
      }
      return { data: null, error: { message: `Unknown RPC ${fn}` } };
    },
  });
  return { getSupabase: () => makeClient(), getUserSupabase: () => makeClient() };
});

import { createApp } from '../app.js';
import { rateLimit } from '../middleware/rateLimit.js';

const USER_2 = '22222222-2222-4222-8222-222222222222';
const USER_3 = '33333333-3333-4333-8333-333333333333';
const OTHER_WS_CUSTOMER = '99999999-9999-4999-8999-999999999999';

const env = { PORT: 4000, FRONTEND_URL: 'http://localhost:5173', SUPABASE_URL: 'https://example.supabase.co', SUPABASE_ANON_KEY: 'test-key', NODE_ENV: 'test' } as any;
const app = createApp(env);
const auth = { Authorization: 'Bearer valid-token' };
const otherAuth = { Authorization: 'Bearer other-token' };
const WS = '/api/workspaces/ws-1';

let sharedCustomerId = '';
let sharedConversationId = '';
let sharedTicketId = '';

describe('customers', () => {
  it('creates a customer (201)', async () => {
    const res = await request(app).post(`${WS}/customers`).set(auth).send({
      full_name: 'Alice Example', email: 'alice@example.com', phone: '+92 300 1234567', tags: ['vip'],
    });
    expect(res.status).toBe(201);
    expect(res.body.customer.email).toBe('alice@example.com');
    expect(res.body.customer.tags).toEqual(['vip']);
    sharedCustomerId = res.body.customer.id;
  });

  it('duplicate email in the same workspace -> 409', async () => {
    const res = await request(app).post(`${WS}/customers`).set(auth).send({
      full_name: 'Alice Again', email: 'ALICE@example.com',
    });
    expect(res.status).toBe(409);
    expect(res.body.error).toBe('A customer with this email already exists in this workspace');
  });

  it('rejects an invalid customer payload (400)', async () => {
    const res = await request(app).post(`${WS}/customers`).set(auth).send({ full_name: 'A', email: 'not-an-email' });
    expect(res.status).toBe(400);
  });

  it('lists with the pagination shape', async () => {
    for (const n of ['One', 'Two', 'Three']) {
      await request(app).post(`${WS}/customers`).set(auth).send({ full_name: `PageTest ${n}`, email: `pagetest-${n.toLowerCase()}@example.com` });
    }
    const page1 = await request(app).get(`${WS}/customers?search=PageTest&page=1&pageSize=2`).set(auth);
    expect(page1.status).toBe(200);
    expect(page1.body.total).toBe(3);
    expect(page1.body.customers).toHaveLength(2);
    expect(page1.body.page).toBe(1);
    expect(page1.body.pageSize).toBe(2);
    const page2 = await request(app).get(`${WS}/customers?search=PageTest&page=2&pageSize=2`).set(auth);
    expect(page2.body.customers).toHaveLength(1);
  });

  it('searches by name/email and filters by tag', async () => {
    const byName = await request(app).get(`${WS}/customers?search=alice`).set(auth);
    expect(byName.body.customers.map((c: any) => c.email)).toContain('alice@example.com');
    const byTag = await request(app).get(`${WS}/customers?tag=vip`).set(auth);
    expect(byTag.body.customers.map((c: any) => c.email)).toContain('alice@example.com');
    const noTag = await request(app).get(`${WS}/customers?tag=no-such-tag`).set(auth);
    expect(noTag.body.customers).toHaveLength(0);
  });

  it('gets a customer with ticket/conversation summary counts', async () => {
    const res = await request(app).get(`${WS}/customers/${sharedCustomerId}`).set(auth);
    expect(res.status).toBe(200);
    expect(res.body.customer.id).toBe(sharedCustomerId);
    expect(res.body.tickets.total).toBe(0);
    expect(res.body.conversations.total).toBe(0);
    expect(Array.isArray(res.body.recent_conversations)).toBe(true);
  });

  it('patches a customer (200) and 404s for an unknown id', async () => {
    const res = await request(app).patch(`${WS}/customers/${sharedCustomerId}`).set(auth).send({ phone: '+92 300 9999999', tags: ['vip', 'beta'] });
    expect(res.status).toBe(200);
    expect(res.body.customer.phone).toBe('+92 300 9999999');
    const missing = await request(app).patch(`${WS}/customers/no-such-id`).set(auth).send({ phone: 'x' });
    expect(missing.status).toBe(404);
  });

  it('403 for a non-member workspace, 401 without a token', async () => {
    const forbidden = await request(app).get(`${WS}/customers`).set(otherAuth);
    expect(forbidden.status).toBe(403);
    const unauthed = await request(app).get(`${WS}/customers`);
    expect(unauthed.status).toBe(401);
    const postForbidden = await request(app).post(`${WS}/customers`).set(otherAuth).send({ full_name: 'Nope', email: 'nope@example.com' });
    expect(postForbidden.status).toBe(403);
  });
});

describe('conversations', () => {
  it('creates a conversation (201)', async () => {
    const res = await request(app).post(`${WS}/conversations`).set(auth).send({ customer_id: sharedCustomerId, priority: 'high' });
    expect(res.status).toBe(201);
    expect(res.body.conversation.customer_id).toBe(sharedCustomerId);
    expect(res.body.conversation.priority).toBe('high');
    sharedConversationId = res.body.conversation.id;
    const customer = await request(app).get(`${WS}/customers/${sharedCustomerId}`).set(auth);
    expect(customer.body.conversations.total).toBe(1);
  });

  it('rejects a conversation for a customer in another workspace (400)', async () => {
    const res = await request(app).post(`${WS}/conversations`).set(auth).send({ customer_id: OTHER_WS_CUSTOMER });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('Related record belongs to a different workspace');
  });

  it('agent reply 201, then duplicate client_message_id returns the existing message (200)', async () => {
    const first = await request(app).post(`${WS}/conversations/${sharedConversationId}/messages`).set(auth).send({
      body: 'Hello, how can I help?', client_message_id: 'cm-1',
    });
    expect(first.status).toBe(201);
    expect(first.body.message.sender_type).toBe('agent');
    const retry = await request(app).post(`${WS}/conversations/${sharedConversationId}/messages`).set(auth).send({
      body: 'Hello, how can I help?', client_message_id: 'cm-1',
    });
    expect(retry.status).toBe(200);
    expect(retry.body.message.id).toBe(first.body.message.id);
    expect(mockState.messages.filter((m) => m.client_message_id === 'cm-1')).toHaveLength(1);
  });

  it('rejects an empty agent reply (400)', async () => {
    const res = await request(app).post(`${WS}/conversations/${sharedConversationId}/messages`).set(auth).send({ body: '   ' });
    expect(res.status).toBe(400);
  });

  it('lists messages chronologically (oldest first)', async () => {
    await request(app).post(`${WS}/conversations/${sharedConversationId}/messages`).set(auth).send({ body: 'Second reply' });
    const res = await request(app).get(`${WS}/conversations/${sharedConversationId}/messages`).set(auth);
    expect(res.status).toBe(200);
    expect(res.body.total).toBe(2);
    expect(res.body.messages[0].body).toBe('Hello, how can I help?');
    expect(res.body.messages[1].body).toBe('Second reply');
  });

  it('gets a conversation with customer + assigned member info', async () => {
    const res = await request(app).get(`${WS}/conversations/${sharedConversationId}`).set(auth);
    expect(res.status).toBe(200);
    expect(res.body.customer.email).toBe('alice@example.com');
    expect(res.body.assigned_member).toBeNull();
  });

  it('assign to a non-member -> 400; assign to a member -> 200', async () => {
    const bad = await request(app).patch(`${WS}/conversations/${sharedConversationId}`).set(auth).send({ assigned_to: USER_2 });
    expect(bad.status).toBe(400);
    expect(bad.body.error).toBe('Assignee must be a member of this workspace');
    const ok = await request(app).patch(`${WS}/conversations/${sharedConversationId}`).set(auth).send({ assigned_to: USER_3 });
    expect(ok.status).toBe(200);
    expect(ok.body.conversation.assigned_to).toBe(USER_3);
  });

  it('rejects an invalid conversation status (400)', async () => {
    const res = await request(app).patch(`${WS}/conversations/${sharedConversationId}`).set(auth).send({ status: 'bogus' });
    expect(res.status).toBe(400);
  });

  it('adds and lists internal notes', async () => {
    const created = await request(app).post(`${WS}/conversations/${sharedConversationId}/notes`).set(auth).send({ body: 'Customer prefers email follow-up.' });
    expect(created.status).toBe(201);
    const listed = await request(app).get(`${WS}/conversations/${sharedConversationId}/notes`).set(auth);
    expect(listed.status).toBe(200);
    expect(listed.body.notes).toHaveLength(1);
    expect(listed.body.notes[0].body).toBe('Customer prefers email follow-up.');
  });

  it('403 for a non-member workspace, 401 without a token', async () => {
    expect((await request(app).get(`${WS}/conversations`).set(otherAuth)).status).toBe(403);
    expect((await request(app).get(`${WS}/conversations`)).status).toBe(401);
  });
});

describe('tickets', () => {
  it('creates a ticket (201) with a created event + outbox row', async () => {
    const res = await request(app).post(`${WS}/tickets`).set(auth).send({
      subject: 'Billing question', description: 'Charged twice', category: 'billing', priority: 'high',
      customer_id: sharedCustomerId, conversation_id: sharedConversationId,
    });
    expect(res.status).toBe(201);
    expect(res.body.ticket.status).toBe('open');
    sharedTicketId = res.body.ticket.id;
    const events = await request(app).get(`${WS}/tickets/${sharedTicketId}/events`).set(auth);
    expect(events.body.events.map((e: any) => e.event_type)).toContain('created');
    const outbox = mockState.automationEvents.find((e) => e.event_type === 'ticket.created' && e.entity_id === sharedTicketId);
    expect(outbox).toBeDefined();
    expect(Object.keys(outbox!.payload)).not.toContain('body');
  });

  it('rejects status on create (strict schema, 400)', async () => {
    const res = await request(app).post(`${WS}/tickets`).set(auth).send({ subject: 'Bad create', status: 'resolved' });
    expect(res.status).toBe(400);
  });

  it('rejects a ticket linked to another workspace (400)', async () => {
    const res = await request(app).post(`${WS}/tickets`).set(auth).send({ subject: 'Cross WS', customer_id: OTHER_WS_CUSTOMER });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('Related record belongs to a different workspace');
  });

  it('rejects an invalid ticket status (400)', async () => {
    const res = await request(app).patch(`${WS}/tickets/${sharedTicketId}`).set(auth).send({ status: 'done' });
    expect(res.status).toBe(400);
  });

  it('assign to a non-member -> 400; assign to a member -> 200 + event + outbox', async () => {
    const bad = await request(app).patch(`${WS}/tickets/${sharedTicketId}`).set(auth).send({ assigned_to: USER_2 });
    expect(bad.status).toBe(400);
    const ok = await request(app).patch(`${WS}/tickets/${sharedTicketId}`).set(auth).send({ assigned_to: USER_3 });
    expect(ok.status).toBe(200);
    expect(ok.body.ticket.assigned_to).toBe(USER_3);
    const events = await request(app).get(`${WS}/tickets/${sharedTicketId}/events`).set(auth);
    expect(events.body.events.map((e: any) => e.event_type)).toContain('assigned');
    const outbox = mockState.automationEvents.find((e) => e.event_type === 'ticket.assigned' && e.entity_id === sharedTicketId);
    expect(outbox).toBeDefined();
    expect(outbox!.payload.assigned_to).toBe(USER_3);
  });

  it('priority change records an event + outbox row', async () => {
    const res = await request(app).patch(`${WS}/tickets/${sharedTicketId}`).set(auth).send({ priority: 'urgent' });
    expect(res.status).toBe(200);
    const events = await request(app).get(`${WS}/tickets/${sharedTicketId}/events`).set(auth);
    const change = events.body.events.find((e: any) => e.event_type === 'priority_changed');
    expect(change).toBeDefined();
    expect(change.old_value).toBe('high');
    expect(change.new_value).toBe('urgent');
    expect(mockState.automationEvents.some((e) => e.event_type === 'ticket.priority.changed' && e.entity_id === sharedTicketId)).toBe(true);
  });

  it('resolving sets resolved_at + events + outbox; reopening clears resolved_at', async () => {
    const resolved = await request(app).patch(`${WS}/tickets/${sharedTicketId}`).set(auth).send({ status: 'resolved' });
    expect(resolved.status).toBe(200);
    expect(resolved.body.ticket.resolved_at).not.toBeNull();
    const events = await request(app).get(`${WS}/tickets/${sharedTicketId}/events`).set(auth);
    const types = events.body.events.map((e: any) => e.event_type);
    expect(types).toContain('status_changed');
    expect(types).toContain('resolved');
    expect(mockState.automationEvents.some((e) => e.event_type === 'ticket.resolved' && e.entity_id === sharedTicketId)).toBe(true);
    const reopened = await request(app).patch(`${WS}/tickets/${sharedTicketId}`).set(auth).send({ status: 'open' });
    expect(reopened.body.ticket.resolved_at).toBeNull();
    const events2 = await request(app).get(`${WS}/tickets/${sharedTicketId}/events`).set(auth);
    expect(events2.body.events.map((e: any) => e.event_type)).toContain('reopened');
  });

  it('adds a note as a ticket event', async () => {
    const res = await request(app).post(`${WS}/tickets/${sharedTicketId}/notes`).set(auth).send({ body: 'Called the customer, refund issued.' });
    expect(res.status).toBe(201);
    expect(res.body.event.event_type).toBe('note_added');
    const events = await request(app).get(`${WS}/tickets/${sharedTicketId}/events`).set(auth);
    expect(events.body.events.some((e: any) => e.event_type === 'note_added')).toBe(true);
  });

  it('gets a ticket with customer + conversation + assigned member', async () => {
    const res = await request(app).get(`${WS}/tickets/${sharedTicketId}`).set(auth);
    expect(res.status).toBe(200);
    expect(res.body.customer.email).toBe('alice@example.com');
    expect(res.body.conversation.id).toBe(sharedConversationId);
    expect(res.body.assigned_member.user_id).toBe(USER_3);
  });

  it('lists with filters and reports real stats', async () => {
    const byStatus = await request(app).get(`${WS}/tickets?status=open`).set(auth);
    expect(byStatus.body.tickets.every((t: any) => t.status === 'open')).toBe(true);
    const bySearch = await request(app).get(`${WS}/tickets?search=Billing`).set(auth);
    expect(bySearch.body.tickets.length).toBeGreaterThanOrEqual(1);
    const stats = await request(app).get(`${WS}/tickets/stats`).set(auth);
    expect(stats.status).toBe(200);
    expect(stats.body.total).toBeGreaterThanOrEqual(1);
    expect(stats.body.by_status.open).toBeGreaterThanOrEqual(1);
    expect(stats.body.by_priority.urgent).toBeGreaterThanOrEqual(1);
  });

  it('404s for an unknown ticket', async () => {
    expect((await request(app).get(`${WS}/tickets/no-such-id`).set(auth)).status).toBe(404);
  });

  it('403 for a non-member workspace, 401 without a token', async () => {
    expect((await request(app).get(`${WS}/tickets`).set(otherAuth)).status).toBe(403);
    expect((await request(app).get(`${WS}/tickets`)).status).toBe(401);
  });
});

describe('widget (public)', () => {
  let visitorToken = '';
  let visitorConversationId = '';

  it('returns config for a known key, 404 for an unknown key', async () => {
    const ok = await request(app).get(`/api/widget/config?key=${mockState.widgetKey}`);
    expect(ok.status).toBe(200);
    expect(ok.body.business_name).toBe('Acme Support');
    expect(ok.body.enabled).toBe(true);
    expect(ok.body.workspace_id).toBeUndefined();
    const missing = await request(app).get('/api/widget/config?key=wgt_00000000000000000000000000000000');
    expect(missing.status).toBe(404);
    expect(missing.body.error).toBe('Widget not found');
  });

  it('creates a visitor session (201, token returned once)', async () => {
    const res = await request(app).post('/api/widget/sessions').send({
      key: mockState.widgetKey, name: 'Widget Visitor', email: 'widget-visitor@example.com',
    });
    expect(res.status).toBe(201);
    expect(res.body.token).toBeTruthy();
    expect(res.body.conversation_id).toBeTruthy();
    expect(res.body.customer_id).toBeTruthy();
    expect(res.body.expires_at).toBeTruthy();
    expect(res.body.workspace_id).toBeUndefined();
    visitorToken = res.body.token;
    visitorConversationId = res.body.conversation_id;
  });

  it('rejects a session for an unknown key (404)', async () => {
    const res = await request(app).post('/api/widget/sessions').send({ key: 'wgt_00000000000000000000000000000000' });
    expect(res.status).toBe(404);
  });

  it('posts a visitor message (201) and shows it in history', async () => {
    const sent = await request(app).post('/api/widget/messages').send({ token: visitorToken, body: 'Hi, I need help with my order.' });
    expect(sent.status).toBe(201);
    expect(sent.body.message_id).toBeTruthy();
    const history = await request(app).get(`/api/widget/history?token=${visitorToken}`);
    expect(history.status).toBe(200);
    expect(history.body.messages.map((m: any) => m.body)).toContain('Hi, I need help with my order.');
    // The visitor message is a customer message: the agent inbox sees it unread.
    const inbox = await request(app).get(`${WS}/conversations?search=widget-visitor`).set(auth);
    expect(inbox.body.conversations).toHaveLength(1);
    expect(inbox.body.conversations[0].id).toBe(visitorConversationId);
    expect(inbox.body.conversations[0].unread_count).toBe(1);
    expect(inbox.body.conversations[0].last_message.body).toContain('Hi, I need help');
    // Marking read clears the unread count.
    const read = await request(app).post(`${WS}/conversations/${visitorConversationId}/read`).set(auth).send({});
    expect(read.status).toBe(200);
    expect(read.body.read_count).toBe(1);
    const inboxAfter = await request(app).get(`${WS}/conversations?search=widget-visitor`).set(auth);
    expect(inboxAfter.body.conversations[0].unread_count).toBe(0);
  });

  it('rejects an empty widget message (400) and a bad token (401)', async () => {
    const empty = await request(app).post('/api/widget/messages').send({ token: visitorToken, body: '' });
    expect(empty.status).toBe(400);
    const bad = await request(app).post('/api/widget/messages').send({ token: 'no-such-token', body: 'hello' });
    expect(bad.status).toBe(401);
  });

  it('dedupes a repeated widget message with the same client_message_id (201 then 200, one row)', async () => {
    const payload = { token: visitorToken, body: 'Same message sent twice.', client_message_id: 'visitor-msg-1' };
    const first = await request(app).post('/api/widget/messages').send(payload);
    expect(first.status).toBe(201);
    expect(first.body.message_id).toBeTruthy();
    const second = await request(app).post('/api/widget/messages').send(payload);
    expect(second.status).toBe(200);
    expect(second.body.message_id).toBe(first.body.message_id);
    // Only one row stored, and only one outbox event recorded.
    const history = await request(app).get(`/api/widget/history?token=${visitorToken}`);
    expect(history.body.messages.filter((m: any) => m.body === 'Same message sent twice.')).toHaveLength(1);
    const events = mockState.automationEvents.filter(
      (e) => e.event_type === 'customer.message.created' && e.entity_id === first.body.message_id,
    );
    expect(events).toHaveLength(1);
  });

  it('history for an unknown token returns an empty list (200)', async () => {
    const res = await request(app).get('/api/widget/history?token=no-such-token');
    expect(res.status).toBe(200);
    expect(res.body.messages).toEqual([]);
  });
});

describe('widget settings (admin)', () => {
  it('404s before settings exist, then creates them (201)', async () => {
    const before = await request(app).get(`${WS}/widget-settings`).set(auth);
    expect(before.status).toBe(404);
    const created = await request(app).post(`${WS}/widget-settings`).set(auth).send({
      business_name: 'Acme Support', welcome_message: 'Hi there!', primary_color: '#123456', enabled: true,
    });
    expect(created.status).toBe(201);
    expect(created.body.widget_settings.business_name).toBe('Acme Support');
    expect(created.body.widget_settings.workspace_id).toBe('ws-1');
    const after = await request(app).get(`${WS}/widget-settings`).set(auth);
    expect(after.status).toBe(200);
    expect(after.body.widget_settings.business_name).toBe('Acme Support');
  });

  it('second create is 409', async () => {
    const res = await request(app).post(`${WS}/widget-settings`).set(auth).send({ business_name: 'Again' });
    expect(res.status).toBe(409);
  });

  it('patches branding and rejects public_key / workspace_id changes (400)', async () => {
    const ok = await request(app).patch(`${WS}/widget-settings`).set(auth).send({ welcome_message: 'Updated welcome', enabled: false });
    expect(ok.status).toBe(200);
    expect(ok.body.widget_settings.welcome_message).toBe('Updated welcome');
    expect(ok.body.widget_settings.enabled).toBe(false);
    const bad = await request(app).patch(`${WS}/widget-settings`).set(auth).send({ public_key: 'wgt_00000000000000000000000000000000' });
    expect(bad.status).toBe(400);
    const badWs = await request(app).patch(`${WS}/widget-settings`).set(auth).send({ workspace_id: 'ws-2' });
    expect(badWs.status).toBe(400);
  });

  it('403 for a non-member workspace, 401 without a token', async () => {
    expect((await request(app).get(`${WS}/widget-settings`).set(otherAuth)).status).toBe(403);
    expect((await request(app).get(`${WS}/widget-settings`)).status).toBe(401);
  });
});

describe('customer detail linked rows (Phase 2.1 fix)', () => {
  it('returns recent_tickets and recent_conversations with a last_message preview', async () => {
    const res = await request(app).get(`${WS}/customers/${sharedCustomerId}`).set(auth);
    expect(res.status).toBe(200);
    expect(res.body.tickets.total).toBe(1);
    expect(res.body.conversations.total).toBe(1);
    expect(res.body.recent_tickets).toHaveLength(1);
    expect(res.body.recent_tickets[0].id).toBe(sharedTicketId);
    expect(res.body.recent_tickets[0].subject).toBe('Billing question');
    expect(res.body.recent_conversations).toHaveLength(1);
    expect(res.body.recent_conversations[0].id).toBe(sharedConversationId);
    // Latest message in the conversation is the second agent reply.
    expect(res.body.recent_conversations[0].last_message.body).toBe('Second reply');
  });
});

describe('rate limiter', () => {
  it('returns 429 with Retry-After after the limit is exceeded', async () => {
    const tiny = express();
    tiny.use(rateLimit({ windowMs: 60_000, max: 2 }));
    tiny.get('/ping', (_req, res) => res.json({ ok: true }));
    tiny.use((err: any, _req: any, res: any, _next: any) => { void _next; return res.status(err.status ?? 500).json({ error: err.message }); });
    expect((await request(tiny).get('/ping')).status).toBe(200);
    expect((await request(tiny).get('/ping')).status).toBe(200);
    const limited = await request(tiny).get('/ping');
    expect(limited.status).toBe(429);
    expect(limited.body.error).toBe('Too many requests, please try again later');
    expect(limited.headers['retry-after']).toBeTruthy();
  });
});
