/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, it, expect, vi } from 'vitest';
import express from 'express';
import request from 'supertest';

// ---- Mock Supabase client (offline tests), following app-phase2-1-widget.test.ts ----
const mockState = vi.hoisted(() => {
  let seq = 0;
  const ts = () => new Date(Date.now() + ++seq * 1000).toISOString();
  const nextId = () => `00000000-0000-4000-8000-${String(++seq).padStart(12, '0')}`;
  const user1 = '11111111-1111-4111-8111-111111111111';
  const user2 = '22222222-2222-4222-8222-222222222222';
  const longMessage = `I was charged twice for my subscription this month and the extra charge is still on my card even after I contacted support twice already and nobody replied to me yet`;
  return {
    ts, nextId, user1, user2, longMessage,
    members: [
      { id: 'mem-1', workspace_id: 'ws-1', user_id: user1, role: 'owner', created_at: '2026-01-01T00:00:00.000Z' },
    ] as Array<Record<string, any>>,
    conversations: [
      {
        id: 'conv-1', workspace_id: 'ws-1', customer_id: 'cust-1', status: 'open', priority: 'medium',
        assigned_to: null, tags: [], ai_paused: false, handoff_reason: null, handed_off_at: null,
        created_at: '2026-01-01T00:00:00.000Z', updated_at: '2026-01-01T00:00:00.000Z', last_message_at: null,
      },
      {
        id: 'conv-2', workspace_id: 'ws-1', customer_id: 'cust-1', status: 'open', priority: 'medium',
        assigned_to: null, tags: [], ai_paused: false, handoff_reason: null, handed_off_at: null,
        created_at: '2026-01-01T00:00:00.000Z', updated_at: '2026-01-01T00:00:00.000Z', last_message_at: null,
      },
    ] as Array<Record<string, any>>,
    messages: [
      {
        id: 'msg-1', workspace_id: 'ws-1', conversation_id: 'conv-1', customer_id: 'cust-1',
        sender_type: 'customer', sender_id: null, body: 'I was charged twice for my subscription',
        client_message_id: null, created_at: '2026-01-01T00:01:00.000Z', read_at: null,
      },
    ] as Array<Record<string, any>>,
    tickets: [] as Array<Record<string, any>>,
    handoffs: [] as Array<Record<string, any>>,
    aiSettings: [
      {
        id: 'ai-set-1', workspace_id: 'ws-1', enabled: true, mode: 'suggestion',
        provider_order: ['groq', 'gemini'], auto_reply_require_grounding: true,
        escalation_on_low_confidence: true,
        created_at: '2026-01-01T00:00:00.000Z', updated_at: '2026-01-01T00:00:00.000Z',
      },
    ] as Array<Record<string, any>>,
  };
});

vi.mock('../lib/supabase.js', () => {
  type Predicate = (row: Record<string, any>) => boolean;

  const tableRows = (table: string): Array<Record<string, any>> => {
    switch (table) {
      case 'workspace_members': return mockState.members;
      case 'conversations': return mockState.conversations;
      case 'messages': return mockState.messages;
      case 'tickets': return mockState.tickets;
      case 'handoffs': return mockState.handoffs;
      case 'ai_settings': return mockState.aiSettings;
      default: return [];
    }
  };

  const makeBuilder = (table: string) => {
    const filters: Predicate[] = [];
    const orderings: Array<{ col: string; ascending: boolean }> = [];
    let limitNum: number | null = null;
    let op: 'select' | 'insert' | 'update' = 'select';
    let insertRows: Array<Record<string, any>> | null = null;
    let updatePatch: Record<string, any> | null = null;

    const execute = (): { data: any; count: number | null; error: any } => {
      const clone = (r: Record<string, any>) => ({ ...r });
      const rows = tableRows(table);
      if (op === 'insert') {
        const inserted: Array<Record<string, any>> = [];
        for (const input of insertRows ?? []) {
          const row = { ...input, id: input.id ?? mockState.nextId(), created_at: input.created_at ?? mockState.ts(), updated_at: mockState.ts() };
          rows.push(row);
          inserted.push(row);
        }
        return { data: inserted.map(clone), count: null, error: null };
      }
      if (op === 'update') {
        const matched = rows.filter((r) => filters.every((f) => f(r)));
        for (const row of matched) {
          Object.assign(row, updatePatch ?? {});
          row.updated_at = mockState.ts();
        }
        return { data: matched.map(clone), count: null, error: null };
      }
      let filtered = rows.filter((r) => filters.every((f) => f(r)));
      for (const { col, ascending } of orderings) {
        filtered = [...filtered].sort((a, b) => {
          const av = a[col] ?? '';
          const bv = b[col] ?? '';
          if (av === bv) return 0;
          return (av < bv ? -1 : 1) * (ascending ? 1 : -1);
        });
      }
      if (limitNum !== null) filtered = filtered.slice(0, limitNum);
      return { data: filtered.map(clone), count: null, error: null };
    };

    const b: any = {
      select: () => b,
      eq: (col: string, val: unknown) => { filters.push((r) => r[col] === val); return b; },
      in: (col: string, vals: unknown[]) => { filters.push((r) => vals.includes(r[col])); return b; },
      is: (col: string, val: null) => { filters.push((r) => r[col] === val); return b; },
      order: (col: string, opts?: { ascending?: boolean }) => {
        orderings.push({ col, ascending: opts?.ascending ?? true });
        return b;
      },
      limit: (n: number) => { limitNum = n; return b; },
      range: (from: number, to: number) => {
        const res = execute();
        return Promise.resolve({ ...res, data: (res.data ?? []).slice(from, to + 1) });
      },
      single: async () => {
        const res = execute();
        if (!res.data || res.data.length === 0) return { data: null, error: { code: 'PGRST116', message: 'no rows' } };
        return { data: res.data[0], error: null };
      },
      maybeSingle: async () => {
        const res = execute();
        if (!res.data || res.data.length === 0) return { data: null, error: null };
        return { data: res.data[0], error: null };
      },
      insert: (input: Record<string, any> | Array<Record<string, any>>) => {
        op = 'insert';
        insertRows = Array.isArray(input) ? input : [input];
        return b;
      },
      update: (patch: Record<string, any>) => { op = 'update'; updatePatch = patch; return b; },
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
          'valid-token': mockState.user1,
          'other-token': mockState.user2,
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

import { authMiddleware } from '../middleware/auth.js';
import { requireWorkspaceMember } from '../middleware/workspaceAuth.js';
import { handoffsRouter } from '../routes/handoffs.js';
import { errorHandler } from '../errors.js';

const env = { PORT: 4000, FRONTEND_URL: 'http://localhost:5173', SUPABASE_URL: 'https://example.supabase.co', SUPABASE_ANON_KEY: 'test-key', NODE_ENV: 'test' } as any;

// The coordinator mounts handoffsRouter under
// /api/workspaces/:workspaceId/conversations/:conversationId with the
// standard auth + membership chain; the test mounts it the same way.
const app = express();
app.use(express.json());
app.use(
  '/api/workspaces/:workspaceId/conversations/:conversationId',
  authMiddleware(env),
  requireWorkspaceMember(env),
  handoffsRouter(env),
);
app.use(errorHandler);

const auth = { Authorization: 'Bearer valid-token' };
const otherAuth = { Authorization: 'Bearer other-token' };
const base = '/api/workspaces/ws-1/conversations/conv-1';

describe('POST /handoff', () => {
  it('creates a new ticket from the first customer message and pauses AI', async () => {
    const res = await request(app).post(`${base}/handoff`).set(auth).send({ reason: 'Customer asked for a human' });
    expect(res.status).toBe(201);
    expect(res.body.reused).toBe(false);
    expect(res.body.ticket.id).toBeTruthy();
    expect(res.body.handoff.id).toBeTruthy();
    expect(mockState.tickets).toHaveLength(1);
    const ticket = mockState.tickets[0];
    expect(ticket.subject).toBe('I was charged twice for my subscription');
    expect(ticket.category).toBe('general');
    expect(ticket.priority).toBe('medium');
    expect(ticket.status).toBe('open');
    expect(ticket.customer_id).toBe('cust-1');
    expect(ticket.conversation_id).toBe('conv-1');
    expect(ticket.escalation_reason).toBe('Customer asked for a human');
    expect(ticket.escalated_at).toBeTruthy();
    expect(mockState.handoffs).toHaveLength(1);
    expect(mockState.handoffs[0].ticket_id).toBe(ticket.id);
    expect(mockState.handoffs[0].reason).toBe('Customer asked for a human');
    expect(mockState.handoffs[0].triggered_by).toBe('agent');
    expect(mockState.handoffs[0].ai_paused).toBe(true);
    const conv = mockState.conversations.find((c) => c.id === 'conv-1')!;
    expect(conv.ai_paused).toBe(true);
    expect(conv.handoff_reason).toBe('Customer asked for a human');
    expect(conv.handed_off_at).toBeTruthy();
  });

  it('reuses the open ticket on a repeated escalation and preserves its assignment', async () => {
    // Assign the ticket to the second user, then escalate again.
    mockState.tickets[0].assigned_to = mockState.user2;
    const res = await request(app).post(`${base}/handoff`).set(auth).send({ reason: 'Still needs a human' });
    expect(res.status).toBe(201);
    expect(res.body.reused).toBe(true);
    expect(res.body.ticket.id).toBe(mockState.tickets[0].id);
    // Duplicate escalation: same ticket reused, no second ticket row.
    expect(mockState.tickets).toHaveLength(1);
    expect(mockState.handoffs).toHaveLength(2);
    expect(mockState.tickets[0].assigned_to).toBe(mockState.user2);
    expect(mockState.tickets[0].escalation_reason).toBe('Still needs a human');
    expect(mockState.tickets[0].escalated_at).toBeTruthy();
  });

  it('creates a new ticket when the previous one is no longer open', async () => {
    mockState.tickets[0].status = 'resolved';
    const res = await request(app).post(`${base}/handoff`).set(auth).send({ reason: 'Reopened by customer' });
    expect(res.status).toBe(201);
    expect(res.body.reused).toBe(false);
    expect(res.body.ticket.id).not.toBe(mockState.tickets[0].id);
    expect(mockState.tickets).toHaveLength(2);
  });

  it('truncates a long first customer message to 120 chars for the subject', async () => {
    mockState.messages.push({
      id: 'msg-2', workspace_id: 'ws-1', conversation_id: 'conv-2', customer_id: 'cust-1',
      sender_type: 'customer', sender_id: null, body: mockState.longMessage,
      client_message_id: null, created_at: '2026-01-01T00:02:00.000Z', read_at: null,
    });
    const res = await request(app)
      .post('/api/workspaces/ws-1/conversations/conv-2/handoff')
      .set(auth)
      .send({ reason: 'Long message escalation' });
    expect(res.status).toBe(201);
    const ticket = mockState.tickets.find((t) => t.conversation_id === 'conv-2')!;
    expect(ticket.subject).toBe(mockState.longMessage.slice(0, 120));
    expect(ticket.subject.length).toBe(120);
  });

  it('rejects a reason shorter than 3 characters', async () => {
    const res = await request(app).post(`${base}/handoff`).set(auth).send({ reason: 'ab' });
    expect(res.status).toBe(400);
    expect(res.body.error).toBeTruthy();
  });

  it('returns 404 for an unknown conversation', async () => {
    const res = await request(app)
      .post('/api/workspaces/ws-1/conversations/no-such-conv/handoff')
      .set(auth)
      .send({ reason: 'Customer asked for a human' });
    expect(res.status).toBe(404);
  });

  it('returns 403 for a non-member', async () => {
    const res = await request(app).post(`${base}/handoff`).set(otherAuth).send({ reason: 'Customer asked for a human' });
    expect(res.status).toBe(403);
  });
});

describe('POST /ai-resume', () => {
  it('clears the AI pause and stamps resumed_at on the latest handoff', async () => {
    const res = await request(app).post(`${base}/ai-resume`).set(auth).send({});
    expect(res.status).toBe(200);
    expect(res.body.resumed).toBe(true);
    const conv = mockState.conversations.find((c) => c.id === 'conv-1')!;
    expect(conv.ai_paused).toBe(false);
    expect(conv.handoff_reason).toBeNull();
    expect(conv.handed_off_at).toBeNull();
    // Latest handoff for conv-1 (the third one) is resumed; earlier ones are untouched.
    const convHandoffs = mockState.handoffs.filter((h) => h.conversation_id === 'conv-1');
    const latest = convHandoffs[convHandoffs.length - 1];
    expect(latest.resumed_at).toBeTruthy();
    expect(latest.ai_paused).toBe(false);
  });

  it('is blocked with 409 when AI is disabled in workspace settings', async () => {
    // Re-pause first so there is something to resume.
    await request(app).post(`${base}/handoff`).set(auth).send({ reason: 'Pause again for policy test' });
    mockState.aiSettings[0].enabled = false;
    const res = await request(app).post(`${base}/ai-resume`).set(auth).send({});
    expect(res.status).toBe(409);
    expect(res.body.error).toBe('AI assistance cannot be resumed under the current workspace policy');
    // The pause is still in place.
    expect(mockState.conversations.find((c) => c.id === 'conv-1')!.ai_paused).toBe(true);
    mockState.aiSettings[0].enabled = true;
  });

  it('is blocked with 409 when the mode is human_only', async () => {
    mockState.aiSettings[0].mode = 'human_only';
    const res = await request(app).post(`${base}/ai-resume`).set(auth).send({});
    expect(res.status).toBe(409);
    expect(res.body.error).toBe('AI assistance cannot be resumed under the current workspace policy');
    expect(mockState.conversations.find((c) => c.id === 'conv-1')!.ai_paused).toBe(true);
    mockState.aiSettings[0].mode = 'suggestion';
  });

  it('returns 404 for an unknown conversation', async () => {
    const res = await request(app)
      .post('/api/workspaces/ws-1/conversations/no-such-conv/ai-resume')
      .set(auth)
      .send({});
    expect(res.status).toBe(404);
  });
});
