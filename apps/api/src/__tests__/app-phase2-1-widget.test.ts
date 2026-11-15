/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, it, expect, vi } from 'vitest';
import request from 'supertest';

// ---- Mock Supabase client (offline tests), following app-phase2.test.ts ----
// Two widgets: widgetKey has allow-list ['https://shop.example.com'];
// widgetKeyEmpty has an EMPTY allow-list (secure default: own origin only).

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
      { id: 'ws-2', name: 'Second', slug: 'second', description: null, owner_id: '11111111-1111-4111-8111-111111111111' },
    ] as Array<Record<string, any>>,
    customers: [] as Array<Record<string, any>>,
    conversations: [] as Array<Record<string, any>>,
    messages: [] as Array<Record<string, any>>,
    automationEvents: [] as Array<Record<string, any>>,
    widgetSettings: [
      {
        id: 'ws-set-1', workspace_id: 'ws-1', public_key: 'wgt_0123456789abcdef0123456789abcdef',
        enabled: true, business_name: 'Acme Support', welcome_message: 'Hi! How can we help?',
        primary_color: '#7C3AED', allowed_origins: ['https://shop.example.com'],
        created_at: '2026-01-01T00:00:00.000Z', updated_at: '2026-01-01T00:00:00.000Z',
      },
      {
        id: 'ws-set-2', workspace_id: 'ws-2', public_key: 'wgt_fedcba9876543210fedcba9876543210',
        enabled: true, business_name: 'Second Support', welcome_message: 'Hello!',
        primary_color: '#7C3AED', allowed_origins: [],
        created_at: '2026-01-01T00:00:00.000Z', updated_at: '2026-01-01T00:00:00.000Z',
      },
    ] as Array<Record<string, any>>,
    widgetSessions: new Map<string, { conversation_id: string; customer_id: string; parent_origin: string | null; allowed_origins: string[]; enabled: boolean }>(),
    widgetKey: 'wgt_0123456789abcdef0123456789abcdef',
    widgetKeyEmpty: 'wgt_fedcba9876543210fedcba9876543210',
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
      case 'widget_settings': return mockState.widgetSettings;
      default: return [];
    }
  };

  const makeBuilder = (table: string) => {
    const filters: Predicate[] = [];
    let op: 'select' | 'insert' | 'update' | 'delete' = 'select';
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
      const filtered = rows.filter((r) => filters.every((f) => f(r)));
      return { data: filtered.map(clone), count: null, error: null };
    };

    const b: any = {
      select: () => b,
      eq: (col: string, val: unknown) => { filters.push((r) => r[col] === val); return b; },
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
    rpc: async (fn: string, params: Record<string, any>) => {
      const settingsFor = (key: string) => mockState.widgetSettings.find((s) => s.public_key === key);
      if (fn === 'get_widget_config') {
        const s = settingsFor(params.p_public_key);
        if (!s) return { data: [], error: null };
        return { data: [{ business_name: s.business_name, welcome_message: s.welcome_message, primary_color: s.primary_color, enabled: s.enabled }], error: null };
      }
      if (fn === 'get_widget_origin_policy') {
        const s = settingsFor(params.p_public_key);
        if (!s) return { data: [], error: null };
        return { data: [{ enabled: s.enabled, allowed_origins: s.allowed_origins }], error: null };
      }
      if (fn === 'get_widget_session_policy') {
        const session = mockState.widgetSessions.get(params.p_token);
        if (!session) return { data: [], error: null };
        return { data: [{ parent_origin: session.parent_origin, allowed_origins: session.allowed_origins, enabled: session.enabled }], error: null };
      }
      if (fn === 'create_widget_visitor_session') {
        const s = settingsFor(params.p_public_key);
        if (!s) return { data: null, error: { message: 'Unknown widget key' } };
        if (!s.enabled) return { data: null, error: { message: 'Widget is disabled' } };
        const customerId = mockState.nextId();
        mockState.customers.push({
          id: customerId, workspace_id: s.workspace_id,
          full_name: params.p_visitor_name ?? 'Website visitor',
          email: params.p_visitor_email ?? `visitor-${customerId}@widget.local`,
          phone: null, tags: [], notes: null, created_at: mockState.ts(), updated_at: mockState.ts(), last_activity_at: null,
        });
        const conversationId = mockState.nextId();
        mockState.conversations.push({
          id: conversationId, workspace_id: s.workspace_id, customer_id: customerId, status: 'open', priority: 'medium',
          assigned_to: null, tags: [], created_at: mockState.ts(), updated_at: mockState.ts(), last_message_at: null,
        });
        const token = mockState.nextId();
        mockState.widgetSessions.set(token, {
          conversation_id: conversationId,
          customer_id: customerId,
          parent_origin: params.p_parent_origin ?? null,
          allowed_origins: s.allowed_origins,
          enabled: s.enabled,
        });
        return { data: [{ session_token: token, conversation_id: conversationId, customer_id: customerId, expires_at: new Date(Date.now() + 86400000).toISOString() }], error: null };
      }
      if (fn === 'post_widget_visitor_message') {
        const session = mockState.widgetSessions.get(params.p_token);
        if (!session) return { data: null, error: { message: 'Invalid or expired session' } };
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
      return { data: null, error: { message: `Unknown RPC ${fn}` } };
    },
  });
  return { getSupabase: () => makeClient(), getUserSupabase: () => makeClient() };
});

import { createApp } from '../app.js';
import {
  isAllowedParentOrigin,
  isOwnOrigin,
  normalizeAllowedOrigins,
  normalizeOrigin,
} from '../lib/originPolicy.js';

const env = { PORT: 4000, FRONTEND_URL: 'http://localhost:5173', SUPABASE_URL: 'https://example.supabase.co', SUPABASE_ANON_KEY: 'test-key', NODE_ENV: 'test' } as any;
const app = createApp(env);
const auth = { Authorization: 'Bearer valid-token' };
const OWN = 'http://localhost:5173';
const APPROVED = 'https://shop.example.com';
const EVIL = 'https://evil.example.com';

describe('originPolicy unit tests', () => {
  it('accepts a valid https origin', () => {
    expect(normalizeOrigin('https://shop.example.com')).toBe('https://shop.example.com');
  });

  it('rejects http for a non-localhost host', () => {
    expect(normalizeOrigin('http://shop.example.com')).toBeNull();
  });

  it('allows http only for localhost', () => {
    expect(normalizeOrigin('http://localhost:5173')).toBe('http://localhost:5173');
    expect(normalizeOrigin('http://localhost')).toBe('http://localhost');
  });

  it('normalises host case and strips a trailing slash', () => {
    expect(normalizeOrigin('HTTPS://Shop.Example.COM/')).toBe('https://shop.example.com');
    expect(normalizeOrigin('https://shop.example.com/some/path?x=1')).toBe('https://shop.example.com');
  });

  it('keeps a non-default port and drops the default port (port mismatch rejected by exact match)', () => {
    expect(normalizeOrigin('https://shop.example.com:8443')).toBe('https://shop.example.com:8443');
    expect(normalizeOrigin('https://shop.example.com:443')).toBe('https://shop.example.com');
    expect(isAllowedParentOrigin({ claimed: 'https://shop.example.com:8443', allowedOrigins: ['https://shop.example.com'], frontendUrl: OWN })).toBe(false);
  });

  it('rejects wildcards', () => {
    expect(normalizeOrigin('https://*.example.com')).toBeNull();
  });

  it('rejects userinfo / embedded credentials', () => {
    expect(normalizeOrigin('https://user:pass@shop.example.com')).toBeNull();
  });

  it('rejects empty, non-string and over-length values', () => {
    expect(normalizeOrigin('')).toBeNull();
    expect(normalizeOrigin('   ')).toBeNull();
    expect(normalizeOrigin(undefined)).toBeNull();
    expect(normalizeOrigin(42)).toBeNull();
    expect(normalizeOrigin(`https://${'a'.repeat(250)}.com`)).toBeNull();
    expect(normalizeOrigin('not-a-url')).toBeNull();
    expect(normalizeOrigin('ftp://example.com')).toBeNull();
  });

  it('scheme mismatch is rejected by the allow-list check', () => {
    expect(isAllowedParentOrigin({ claimed: 'http://shop.example.com', allowedOrigins: ['https://shop.example.com'], frontendUrl: OWN })).toBe(false);
  });

  it('empty allow-list allows only the app own origin', () => {
    expect(isAllowedParentOrigin({ claimed: OWN, allowedOrigins: [], frontendUrl: OWN })).toBe(true);
    expect(isAllowedParentOrigin({ claimed: APPROVED, allowedOrigins: [], frontendUrl: OWN })).toBe(false);
    expect(isAllowedParentOrigin({ claimed: null, allowedOrigins: [], frontendUrl: OWN })).toBe(false);
  });

  it('non-empty allow-list requires an exact normalised match', () => {
    expect(isAllowedParentOrigin({ claimed: APPROVED, allowedOrigins: ['https://shop.example.com'], frontendUrl: OWN })).toBe(true);
    expect(isAllowedParentOrigin({ claimed: EVIL, allowedOrigins: ['https://shop.example.com'], frontendUrl: OWN })).toBe(false);
    expect(isAllowedParentOrigin({ claimed: null, allowedOrigins: ['https://shop.example.com'], frontendUrl: OWN })).toBe(false);
  });

  it('isOwnOrigin compares against the frontend URL', () => {
    expect(isOwnOrigin(OWN, OWN)).toBe(true);
    expect(isOwnOrigin(APPROVED, OWN)).toBe(false);
    expect(isOwnOrigin(null, OWN)).toBe(false);
  });

  it('normalizeAllowedOrigins normalises, dedupes and rejects invalid entries', () => {
    expect(normalizeAllowedOrigins(['HTTPS://Shop.Example.COM/', 'https://shop.example.com'])).toEqual(['https://shop.example.com']);
    expect(() => normalizeAllowedOrigins(['http://plain.example.com'])).toThrow('Invalid allowed origin');
    expect(() => normalizeAllowedOrigins(['https://*.example.com'])).toThrow('Invalid allowed origin');
    expect(() => normalizeAllowedOrigins('https://example.com' as any)).toThrow('allowed_origins must be an array');
  });
});

describe('widget origin enforcement (API)', () => {
  let visitorToken = '';

  it('config: approved origin -> 200 without exposing the allow-list', async () => {
    const res = await request(app).get(`/api/widget/config?key=${mockState.widgetKey}&parent_origin=${encodeURIComponent(APPROVED)}`);
    expect(res.status).toBe(200);
    expect(res.body.business_name).toBe('Acme Support');
    expect(res.body.allowed_origins).toBeUndefined();
  });

  it('config: unapproved origin -> 403 with a generic error', async () => {
    const res = await request(app).get(`/api/widget/config?key=${mockState.widgetKey}&parent_origin=${encodeURIComponent(EVIL)}`);
    expect(res.status).toBe(403);
    expect(res.body.error).toBe('Embedding origin not allowed');
    expect(JSON.stringify(res.body)).not.toContain('shop.example.com');
  });

  it('config: no claimed origin -> 403', async () => {
    const res = await request(app).get(`/api/widget/config?key=${mockState.widgetKey}`);
    expect(res.status).toBe(403);
  });

  it('config: empty allow-list allows the own-domain origin, rejects a foreign origin', async () => {
    const own = await request(app).get(`/api/widget/config?key=${mockState.widgetKeyEmpty}&parent_origin=${encodeURIComponent(OWN)}`);
    expect(own.status).toBe(200);
    const foreign = await request(app).get(`/api/widget/config?key=${mockState.widgetKeyEmpty}&parent_origin=${encodeURIComponent(APPROVED)}`);
    expect(foreign.status).toBe(403);
  });

  it('sessions: approved origin -> 201 and the origin is stored on the session', async () => {
    const res = await request(app).post('/api/widget/sessions').send({
      key: mockState.widgetKey, name: 'Shop Visitor', email: 'shop-visitor@example.com', parent_origin: APPROVED,
    });
    expect(res.status).toBe(201);
    expect(res.body.token).toBeTruthy();
    visitorToken = res.body.token;
    expect(mockState.widgetSessions.get(visitorToken)?.parent_origin).toBe(APPROVED);
  });

  it('sessions: unapproved origin -> 403, missing origin -> 403', async () => {
    const bad = await request(app).post('/api/widget/sessions').send({ key: mockState.widgetKey, parent_origin: EVIL });
    expect(bad.status).toBe(403);
    const missing = await request(app).post('/api/widget/sessions').send({ key: mockState.widgetKey });
    expect(missing.status).toBe(403);
  });

  it('sessions: empty allow-list allows the own origin, rejects a foreign origin', async () => {
    const own = await request(app).post('/api/widget/sessions').send({ key: mockState.widgetKeyEmpty, parent_origin: OWN });
    expect(own.status).toBe(201);
    const foreign = await request(app).post('/api/widget/sessions').send({ key: mockState.widgetKeyEmpty, parent_origin: APPROVED });
    expect(foreign.status).toBe(403);
  });

  it('messages: matching stored origin -> 201; mismatched or missing origin -> 403', async () => {
    const ok = await request(app).post('/api/widget/messages').send({ token: visitorToken, body: 'Hello from the shop.', parent_origin: APPROVED });
    expect(ok.status).toBe(201);
    const wrong = await request(app).post('/api/widget/messages').send({ token: visitorToken, body: 'Hello again.', parent_origin: EVIL });
    expect(wrong.status).toBe(403);
    const missing = await request(app).post('/api/widget/messages').send({ token: visitorToken, body: 'Hello again.' });
    expect(missing.status).toBe(403);
  });

  it('messages: unknown token still -> 401 (origin check cannot resolve a session)', async () => {
    const res = await request(app).post('/api/widget/messages').send({ token: 'no-such-token', body: 'hi', parent_origin: APPROVED });
    expect(res.status).toBe(401);
  });

  it('history: matching origin -> 200 with the message; mismatched origin -> 403', async () => {
    const ok = await request(app).get(`/api/widget/history?token=${visitorToken}&parent_origin=${encodeURIComponent(APPROVED)}`);
    expect(ok.status).toBe(200);
    expect(ok.body.messages.map((m: any) => m.body)).toContain('Hello from the shop.');
    const wrong = await request(app).get(`/api/widget/history?token=${visitorToken}&parent_origin=${encodeURIComponent(EVIL)}`);
    expect(wrong.status).toBe(403);
    const missing = await request(app).get(`/api/widget/history?token=${visitorToken}`);
    expect(missing.status).toBe(403);
  });

  it('history: unknown token still returns an empty list (200)', async () => {
    const res = await request(app).get(`/api/widget/history?token=no-such-token&parent_origin=${encodeURIComponent(APPROVED)}`);
    expect(res.status).toBe(200);
    expect(res.body.messages).toEqual([]);
  });
});

describe('widget-settings origin validation (API)', () => {
  it('PATCH with an invalid origin -> 400', async () => {
    const res = await request(app).patch('/api/workspaces/ws-1/widget-settings').set(auth).send({
      allowed_origins: ['https://ok.example.com', 'http://plain.example.com'],
    });
    expect(res.status).toBe(400);
    expect(res.body.error).toContain('Invalid allowed origin');
  });

  it('PATCH with a wildcard origin -> 400', async () => {
    const res = await request(app).patch('/api/workspaces/ws-1/widget-settings').set(auth).send({
      allowed_origins: ['https://*.example.com'],
    });
    expect(res.status).toBe(400);
  });

  it('PATCH with valid origins stores them normalised and deduped', async () => {
    const res = await request(app).patch('/api/workspaces/ws-1/widget-settings').set(auth).send({
      allowed_origins: ['HTTPS://Shop.Example.COM/', 'https://shop.example.com', 'https://checkout.example.com'],
    });
    expect(res.status).toBe(200);
    expect(res.body.widget_settings.allowed_origins).toEqual(['https://shop.example.com', 'https://checkout.example.com']);
  });
});

describe('widget CORS + version (API)', () => {
  it('/health reports version 0.3.0', async () => {
    const res = await request(app).get('/health');
    expect(res.status).toBe(200);
    expect(res.body.version).toBe('0.3.0');
  });

  it('preflight from the app own origin is reflected; a foreign origin is never granted', async () => {
    const own = await request(app)
      .options('/api/widget/config')
      .set('Origin', OWN)
      .set('Access-Control-Request-Method', 'GET');
    expect(own.headers['access-control-allow-origin']).toBe(OWN);
    // The cors package emits the FIXED configured origin even for a
    // foreign request; the browser still blocks it because the header
    // value does not match the requesting origin. What must never happen
    // is reflecting the foreign origin itself, or '*'.
    const foreign = await request(app)
      .options('/api/widget/config')
      .set('Origin', EVIL)
      .set('Access-Control-Request-Method', 'GET');
    expect(foreign.headers['access-control-allow-origin']).not.toBe(EVIL);
    expect(foreign.headers['access-control-allow-origin']).not.toBe('*');
  });
});
