/* eslint-disable @typescript-eslint/no-explicit-any */
// SupportFlow AI — Phase 3 AI tests (Worker B).
// Provider layer (mocked global fetch), processor (in-memory fake client),
// and routes (supertest + mocked Supabase lib). No real Groq/Gemini,
// no live DB, no live keys.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import request from 'supertest';
import express from 'express';

// ---------------------------------------------------------------------------
// Mocked Supabase lib (used by the route tests below). Hoisted state.
// ---------------------------------------------------------------------------

const mockState = vi.hoisted(() => {
  let seq = 0;
  const nextId = () => `00000000-0000-4000-8000-${String(++seq).padStart(12, '0')}`;
  return {
    seq: 0,
    nextId,
    userIds: {
      owner: '11111111-1111-4111-8111-111111111111',
      member: '33333333-3333-4333-8333-333333333333',
    },
    members: [
      { id: 'mem-1', workspace_id: 'ws-1', user_id: '11111111-1111-4111-8111-111111111111', role: 'owner' },
      { id: 'mem-3', workspace_id: 'ws-1', user_id: '33333333-3333-4333-8333-333333333333', role: 'member' },
    ] as Array<Record<string, any>>,
    workspaces: [
      { id: 'ws-1', name: 'Acme Support', slug: 'acme', description: null, owner_id: '11111111-1111-4111-8111-111111111111' },
    ] as Array<Record<string, any>>,
    knowledgeDocs: [] as Array<Record<string, any>>,
    knowledgeChunks: [] as Array<Record<string, any>>,
    knowledgeJobs: [] as Array<Record<string, any>>,
    aiSettings: [] as Array<Record<string, any>>,
    aiExecutions: [] as Array<Record<string, any>>,
    aiSuggestions: [] as Array<Record<string, any>>,
    handoffs: [] as Array<Record<string, any>>,
    automationEvents: [] as Array<Record<string, any>>,
    messages: [] as Array<Record<string, any>>,
    conversations: [] as Array<Record<string, any>>,
    tickets: [] as Array<Record<string, any>>,
  };
});

vi.mock('../lib/supabase.js', () => {
  const tableRows = (table: string): Array<Record<string, any>> => {
    switch (table) {
      case 'workspace_members': return mockState.members;
      case 'workspaces': return mockState.workspaces;
      case 'knowledge_documents': return mockState.knowledgeDocs;
      case 'knowledge_chunks': return mockState.knowledgeChunks;
      case 'knowledge_index_jobs': return mockState.knowledgeJobs;
      case 'ai_settings': return mockState.aiSettings;
      case 'ai_executions': return mockState.aiExecutions;
      case 'ai_suggestions': return mockState.aiSuggestions;
      case 'handoffs': return mockState.handoffs;
      case 'automation_events': return mockState.automationEvents;
      case 'messages': return mockState.messages;
      case 'conversations': return mockState.conversations;
      case 'tickets': return mockState.tickets;
      default: return [];
    }
  };
  const ilikeMatch = (value: unknown, pattern: string) => {
    const needle = pattern.replace(/^%|%$/g, '').toLowerCase();
    return String(value ?? '').toLowerCase().includes(needle);
  };
  class B {
    filters: Array<(r: Record<string, any>) => boolean> = [];
    orders: Array<{ col: string; asc: boolean }> = [];
    op: 'select' | 'insert' | 'update' | 'delete' = 'select';
    insertRows: Array<Record<string, any>> = [];
    patch: Record<string, any> = {};
    rangePair: [number, number] | null = null;
    limitN: number | null = null;
    countMode: string | null = null;
    head = false;
    constructor(private table: string) {}
    select(_c?: string, opts?: { count?: string; head?: boolean }) {
      if (opts?.count) this.countMode = opts.count;
      if (opts?.head) this.head = true;
      return this;
    }
    eq(col: string, val: unknown) { this.filters.push((r) => r[col] === val); return this; }
    neq(col: string, val: unknown) { this.filters.push((r) => r[col] !== val); return this; }
    is(col: string, val: unknown) { this.filters.push((r) => (val === null ? r[col] == null : r[col] === val)); return this; }
    in(col: string, vals: unknown[]) { this.filters.push((r) => vals.includes(r[col])); return this; }
    ilike(col: string, pattern: string) { this.filters.push((r) => ilikeMatch(r[col], pattern)); return this; }
    like(col: string, pattern: string) {
      const needle = pattern.replace(/^%|%$/g, '');
      this.filters.push((r) => String(r[col] ?? '').includes(needle));
      return this;
    }
    or(expr: string) {
      const parts = expr.split(',').map((p) => {
        const m = p.match(/^(\w+)\.(ilike|eq)\.(.*)$/);
        return m ? { col: m[1], op: m[2], val: m[3] } : null;
      }).filter(Boolean) as Array<{ col: string; op: string; val: string }>;
      this.filters.push((r) => parts.some((p) =>
        p.op === 'ilike' ? ilikeMatch(r[p.col], p.val) : String(r[p.col] ?? '') === p.val,
      ));
      return this;
    }
    contains(col: string, vals: unknown[]) {
      this.filters.push((r) => Array.isArray(r[col]) && vals.every((v) => (r[col] as unknown[]).includes(v)));
      return this;
    }
    textSearch() { return this; }
    order(col: string, opts?: { ascending?: boolean }) {
      this.orders.push({ col, asc: opts?.ascending ?? true });
      return this;
    }
    range(from: number, to: number) { this.rangePair = [from, to]; return this; }
    limit(n: number) { this.limitN = n; return this; }
    insert(input: Record<string, any> | Array<Record<string, any>>) {
      this.op = 'insert';
      this.insertRows = Array.isArray(input) ? input : [input];
      return this;
    }
    update(patch: Record<string, any>) { this.op = 'update'; this.patch = patch; return this; }
    delete() { this.op = 'delete'; return this; }
    execute(): { data: any; count: number | null; error: any } {
      const rows = tableRows(this.table);
      if (this.op === 'insert') {
        if (this.table === 'messages' && this.insertRows.some((i) => i.client_message_id)) {
          for (const input of this.insertRows) {
            if (!input.client_message_id) continue;
            const dup = rows.find((r) => r.conversation_id === input.conversation_id && r.client_message_id === input.client_message_id);
            if (dup) return { data: null, count: null, error: { code: '23505', message: 'duplicate client_message_id' } };
          }
        }
        const inserted = this.insertRows.map((input) => {
          const row = { ...input, id: input.id ?? mockState.nextId(), created_at: new Date().toISOString(), updated_at: new Date().toISOString() };
          rows.push(row);
          return { ...row };
        });
        return { data: inserted, count: null, error: null };
      }
      if (this.op === 'update') {
        const matched = rows.filter((r) => this.filters.every((f) => f(r)));
        for (const row of matched) Object.assign(row, this.patch);
        return { data: matched.map((r) => ({ ...r })), count: null, error: null };
      }
      if (this.op === 'delete') {
        const matched = rows.filter((r) => this.filters.every((f) => f(r)));
        const keep = rows.filter((r) => !matched.includes(r));
        rows.length = 0;
        rows.push(...keep);
        return { data: matched.map((r) => ({ ...r })), count: null, error: null };
      }
      let out = rows.filter((r) => this.filters.every((f) => f(r)));
      const total = out.length;
      for (const o of this.orders) {
        out = [...out].sort((a, b) => {
          if (a[o.col] == null && b[o.col] == null) return 0;
          if (a[o.col] == null) return 1;
          if (b[o.col] == null) return -1;
          return a[o.col] < b[o.col] ? (o.asc ? -1 : 1) : a[o.col] > b[o.col] ? (o.asc ? 1 : -1) : 0;
        });
      }
      if (this.rangePair) out = out.slice(this.rangePair[0], this.rangePair[1] + 1);
      if (this.limitN !== null) out = out.slice(0, this.limitN);
      if (this.head) return { data: [], count: total, error: null };
      return { data: out.map((r) => ({ ...r })), count: this.countMode === 'exact' ? total : null, error: null };
    }
    async single() {
      const res = this.execute();
      if (res.error) return { data: null, error: res.error };
      if (!res.data || res.data.length === 0) return { data: null, error: { code: 'PGRST116', message: 'no rows' } };
      return { data: res.data[0], error: null };
    }
    async maybeSingle() {
      const res = this.execute();
      if (res.error) return { data: null, error: res.error };
      if (!res.data || res.data.length === 0) return { data: null, error: null };
      return { data: res.data[0], error: null };
    }
    then(resolve: (v: unknown) => void, reject?: (e: unknown) => void) {
      try { resolve(this.execute()); } catch (e) { if (reject) reject(e); }
    }
  }
  const makeClient = () => ({
    auth: {
      getUser: async (token: string) => {
        const map: Record<string, string> = {
          'owner-token': mockState.userIds.owner,
          'member-token': mockState.userIds.member,
        };
        const id = map[token];
        return id
          ? { data: { user: { id, email: `${id}@example.com` } }, error: null }
          : { data: { user: null }, error: { message: 'bad token' } };
      },
    },
    from: (table: string) => new B(table),
    rpc: async () => ({ data: null, error: { message: 'Unknown RPC' } }),
  });
  return { getSupabase: () => makeClient(), getUserSupabase: () => makeClient() };
});

// Imports AFTER the mock (hoisted vi.mock applies to these modules).
import { generateCompletion, selectProviders, listProviders, AiUnavailableError, type AiConfig } from '../lib/ai.js';
import { processAutomationEvent, type AutomationEvent } from '../lib/aiProcessor.js';
import { signWebhook } from '../lib/webhookAuth.js';
import { authMiddleware } from '../middleware/auth.js';
import { errorHandler } from '../errors.js';
import { knowledgeRouter } from '../routes/knowledge.js';
import { aiSettingsRouter } from '../routes/aiSettings.js';
import { automationRouter, aiWorkspaceRouter } from '../routes/automation.js';

const TEST_CONFIG: AiConfig = {
  providerOrder: ['groq', 'gemini'],
  groqApiKey: 'test-groq-key',
  geminiApiKey: 'test-gemini-key',
  groqModel: 'gpt-oss-120b',
  groqQualityModel: 'openai/gpt-oss-120b',
  geminiModel: 'gemini-3.8-flash',
  geminiFallbackModels: ['gemini-3.6-flash', 'gemini-3.5-flash-lite', 'gemini-3.1-flash-lite'],
  timeoutMs: 5000,
};

function okResponse(text: string, usage = { prompt_tokens: 10, completion_tokens: 20 }) {
  return {
    ok: true,
    status: 200,
    json: async () => ({ choices: [{ message: { content: text } }], usage }),
  } as any;
}
function errResponse(status: number) {
  return { ok: false, status, json: async () => ({ error: { message: `HTTP ${status}` } }) } as any;
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// Provider layer (mocked fetch)
// ---------------------------------------------------------------------------

describe('ai provider layer', () => {
  it('succeeds via Groq and reports usage', async () => {
    const fetchMock = vi.fn(async () => okResponse('Hello, how can I help?'));
    vi.stubGlobal('fetch', fetchMock);
    const res = await generateCompletion(
      { messages: [{ role: 'user', content: 'Hi' }] },
      TEST_CONFIG,
      fetchMock as any,
    );
    expect(res.text).toBe('Hello, how can I help?');
    expect(res.provider).toBe('groq');
    expect(res.model).toBe('gpt-oss-120b');
    expect(res.promptTokens).toBe(10);
    expect(res.completionTokens).toBe(20);
    const firstCall = fetchMock.mock.calls[0] as unknown as [unknown, { body: unknown }];
    const url = String(firstCall[0]);
    expect(url).toContain('api.groq.com');
    const body = JSON.parse(String(firstCall[1].body));
    expect(body.temperature).toBe(0.3);
    // The key must never appear in any returned value.
    expect(JSON.stringify(res)).not.toContain('test-groq-key');
  });

  it('falls back Groq 429 -> Gemini success, surfacing the quota failure path', async () => {
    const fetchMock = vi.fn(async (url: string) =>
      String(url).includes('groq') ? errResponse(429) : okResponse('Gemini answer'),
    );
    vi.stubGlobal('fetch', fetchMock);
    const res = await generateCompletion(
      { messages: [{ role: 'user', content: 'Hi' }] },
      TEST_CONFIG,
      fetchMock as any,
    );
    expect(res.provider).toBe('gemini');
    expect(res.text).toBe('Gemini answer');
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('tries each Gemini model in the fallback chain before succeeding', async () => {
    // Gemini 3.8-flash 503 (observed live once), 3.6-flash 503, then
    // 3.5-flash-lite succeeds — the per-model chain, not just provider failover.
    const fetchMock = vi.fn(async (url: string, init: any) => {
      const body = JSON.parse(String(init.body));
      if (String(url).includes('groq')) return errResponse(500);
      if (body.model === 'gemini-3.8-flash') return errResponse(503);
      if (body.model === 'gemini-3.6-flash') return errResponse(503);
      return okResponse('Lite answer');
    });
    vi.stubGlobal('fetch', fetchMock);
    const res = await generateCompletion(
      { messages: [{ role: 'user', content: 'Hi' }] },
      TEST_CONFIG,
      fetchMock as any,
    );
    expect(res.provider).toBe('gemini');
    expect(res.model).toBe('gemini-3.5-flash-lite');
    expect(res.text).toBe('Lite answer');
    expect(fetchMock).toHaveBeenCalledTimes(4); // Groq + 3 Gemini models
  });

  it('both providers failing throws AiUnavailableError with quota surfaced', async () => {
    const fetchMock = vi.fn(async () => errResponse(429));
    vi.stubGlobal('fetch', fetchMock);
    await expect(
      generateCompletion({ messages: [{ role: 'user', content: 'Hi' }] }, TEST_CONFIG, fetchMock as any),
    ).rejects.toMatchObject({ name: 'AiUnavailableError', status: 429, quotaExceeded: true, retryable: true });
  });

  it('both providers 500 -> AiUnavailableError (retryable, not quota)', async () => {
    const fetchMock = vi.fn(async () => errResponse(500));
    vi.stubGlobal('fetch', fetchMock);
    await expect(
      generateCompletion({ messages: [{ role: 'user', content: 'Hi' }] }, TEST_CONFIG, fetchMock as any),
    ).rejects.toMatchObject({ name: 'AiUnavailableError', status: 500, quotaExceeded: false });
  });

  it('times out via AbortController and falls through', async () => {
    const hanging = vi.fn(async (_url: string, init: any) => {
      await new Promise((_resolve, reject) => {
        init.signal.addEventListener('abort', () => {
          const e = new Error('aborted');
          e.name = 'AbortError';
          reject(e);
        });
      });
      return okResponse('never');
    });
    const config = { ...TEST_CONFIG, timeoutMs: 10 };
    await expect(
      generateCompletion({ messages: [{ role: 'user', content: 'Hi' }] }, config, hanging as any),
    ).rejects.toBeInstanceOf(AiUnavailableError);
    expect(hanging).toHaveBeenCalledTimes(5); // 1 Groq attempt + 4 Gemini models (primary + 3 fallbacks)
  });

  it('rejects empty / invalid model output and tries the next provider', async () => {
    const fetchMock = vi.fn(async (url: string) =>
      String(url).includes('groq')
        ? ({ ok: true, status: 200, json: async () => ({ choices: [] }) } as any)
        : okResponse('Fallback answer'),
    );
    vi.stubGlobal('fetch', fetchMock);
    const res = await generateCompletion(
      { messages: [{ role: 'user', content: 'Hi' }] },
      TEST_CONFIG,
      fetchMock as any,
    );
    expect(res.provider).toBe('gemini');
    expect(res.text).toBe('Fallback answer');
  });

  it('skips a provider with no key and errors when none is configured', async () => {
    const fetchMock = vi.fn(async () => okResponse('Gemini only'));
    const noGroq = { ...TEST_CONFIG, groqApiKey: undefined };
    const res = await generateCompletion(
      { messages: [{ role: 'user', content: 'Hi' }] },
      noGroq,
      fetchMock as any,
    );
    expect(res.provider).toBe('gemini');
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const noKeys = { ...TEST_CONFIG, groqApiKey: undefined, geminiApiKey: undefined };
    await expect(
      generateCompletion({ messages: [{ role: 'user', content: 'Hi' }] }, noKeys, fetchMock as any),
    ).rejects.toMatchObject({ provider: 'none' });
  });

  it('selectProviders is pure: dedupes, drops unknowns, defaults when empty', () => {
    expect(selectProviders(['gemini', 'groq', 'gemini'])).toEqual(['gemini', 'groq']);
    expect(selectProviders(['unknown', 'GROQ'])).toEqual(['groq']);
    expect(selectProviders([])).toEqual(['groq', 'gemini']);
    expect(selectProviders(['bogus'])).toEqual(['groq', 'gemini']);
  });

  it('listProviders never exposes API keys', () => {
    const listed = listProviders(TEST_CONFIG);
    expect(JSON.stringify(listed)).not.toContain('test-groq-key');
    expect(JSON.stringify(listed)).not.toContain('test-gemini-key');
    expect(listed).toEqual([
      { provider: 'groq', model: 'gpt-oss-120b', configured: true },
      { provider: 'gemini', model: 'gemini-3.8-flash', configured: true },
    ]);
  });
});

// ---------------------------------------------------------------------------
// Processor (fake Supabase client, injected generate stub)
// ---------------------------------------------------------------------------

describe('processAutomationEvent', () => {
  // Small fake client reusing the same builder semantics as the route mock,
  // but with processor tables + a search_knowledge_chunks RPC.
  const pState = {
    messages: [] as any[],
    conversations: [] as any[],
    settings: [] as any[],
    executions: [] as any[],
    suggestions: [] as any[],
    tickets: [] as any[],
    handoffs: [] as any[],
    workspaces: [{ id: 'ws-1', name: 'Acme Support' }] as any[],
    knowledge: [] as Array<{ workspace_id: string; documentId: string; documentTitle: string; chunk: string }>,
  };
  let pSeq = 0;
  const pNextId = () => `00000000-0000-4000-8000-${String(++pSeq).padStart(12, '0')}`;

  function pTable(table: string): any[] {
    switch (table) {
      case 'messages': return pState.messages;
      case 'conversations': return pState.conversations;
      case 'ai_settings': return pState.settings;
      case 'ai_executions': return pState.executions;
      case 'ai_suggestions': return pState.suggestions;
      case 'tickets': return pState.tickets;
      case 'handoffs': return pState.handoffs;
      case 'workspaces': return pState.workspaces;
      default: return [];
    }
  }

  class PB {
    filters: Array<(r: any) => boolean> = [];
    orders: Array<{ col: string; asc: boolean }> = [];
    op: 'select' | 'insert' | 'update' = 'select';
    rows: any[] = [];
    patch: any = {};
    limitN: number | null = null;
    constructor(private table: string) {}
    select() { return this; }
    eq(c: string, v: unknown) { this.filters.push((r) => r[c] === v); return this; }
    in(c: string, vs: unknown[]) { this.filters.push((r) => vs.includes(r[c])); return this; }
    is(c: string, v: unknown) { this.filters.push((r) => (v === null ? r[c] == null : r[c] === v)); return this; }
    order(c: string, o?: { ascending?: boolean }) { this.orders.push({ col: c, asc: o?.ascending ?? true }); return this; }
    limit(n: number) { this.limitN = n; return this; }
    insert(input: any | any[]) { this.op = 'insert'; this.rows = Array.isArray(input) ? input : [input]; return this; }
    update(p: any) { this.op = 'update'; this.patch = p; return this; }
    private exec() {
      const rows = pTable(this.table);
      if (this.op === 'insert') {
        for (const input of this.rows) {
          if (this.table === 'messages' && input.client_message_id) {
            const dup = rows.find((r) => r.conversation_id === input.conversation_id && r.client_message_id === input.client_message_id);
            if (dup) return { data: null, error: { code: '23505', message: 'duplicate' } };
          }
        }
        const inserted = this.rows.map((input) => {
          const row = { ...input, id: input.id ?? pNextId(), created_at: new Date().toISOString(), updated_at: new Date().toISOString() };
          rows.push(row);
          return { ...row };
        });
        return { data: inserted, error: null };
      }
      if (this.op === 'update') {
        const matched = rows.filter((r) => this.filters.every((f) => f(r)));
        for (const row of matched) Object.assign(row, this.patch);
        return { data: matched.map((r) => ({ ...r })), error: null };
      }
      let out = rows.filter((r) => this.filters.every((f) => f(r)));
      for (const o of this.orders) {
        out = [...out].sort((a, b) => (a[o.col] < b[o.col] ? (o.asc ? -1 : 1) : a[o.col] > b[o.col] ? (o.asc ? 1 : -1) : 0));
      }
      if (this.limitN !== null) out = out.slice(0, this.limitN);
      return { data: out.map((r) => ({ ...r })), error: null };
    }
    async single() {
      const res = this.exec();
      if (res.error) return { data: null, error: res.error };
      if (!res.data || res.data.length === 0) return { data: null, error: { code: 'PGRST116', message: 'no rows' } };
      return { data: res.data[0], error: null };
    }
    async maybeSingle() {
      const res = this.exec();
      if (res.error) return { data: null, error: res.error };
      if (!res.data || res.data.length === 0) return { data: null, error: null };
      return { data: res.data[0], error: null };
    }
    then(resolve: (v: unknown) => void, reject?: (e: unknown) => void) {
      try { resolve(this.exec()); } catch (e) { if (reject) reject(e); }
    }
  }

  const fakeClient = {
    from: (t: string) => new PB(t),
    rpc: async (fn: string, params: any) => {
      if (fn !== 'search_knowledge_chunks') return { data: null, error: { message: 'Unknown RPC' } };
      const terms = String(params.p_query).toLowerCase().split(/\W+/).filter((w: string) => w.length > 2);
      const hits = pState.knowledge
        .filter((k) => k.workspace_id === params.p_workspace_id)
        .map((k) => ({ ...k, rank: terms.filter((t: string) => k.chunk.toLowerCase().includes(t)).length }))
        .filter((k) => k.rank > 0)
        .sort((a, b) => b.rank - a.rank)
        .slice(0, params.p_limit)
        .map((k) => ({ chunk: k.chunk, document_title: k.documentTitle, document_id: k.documentId, rank: k.rank }));
      return { data: hits, error: null };
    },
  } as any;

  const baseEvent = (overrides: Partial<AutomationEvent> = {}): AutomationEvent => ({
    id: 'evt-1',
    event_type: 'customer.message.created',
    workspace_id: 'ws-1',
    entity_type: 'message',
    entity_id: 'msg-1',
    payload: {},
    ...overrides,
  });

  function seedConversation(opts: { aiPaused?: boolean } = {}) {
    pState.conversations.push({
      id: 'conv-1', workspace_id: 'ws-1', customer_id: 'cust-1',
      ai_paused: opts.aiPaused ?? false, handoff_reason: null, handed_off_at: null,
    });
  }
  function seedCustomerMessage(body = 'What is your refund policy?') {
    pState.messages.push({
      id: 'msg-1', workspace_id: 'ws-1', conversation_id: 'conv-1', customer_id: 'cust-1',
      sender_type: 'customer', body, client_message_id: 'c-1',
    });
  }
  function seedSettings(mode: string, enabled = true, grounding = true, order: string[] = ['groq', 'gemini']) {
    pState.settings.push({
      id: 'set-1', workspace_id: 'ws-1', enabled, mode,
      provider_order: order, auto_reply_require_grounding: grounding,
      escalation_on_low_confidence: true,
    });
  }
  function seedKnowledge(chunk = 'Our refund policy allows refunds within 30 days of purchase.') {
    pState.knowledge.push({ workspace_id: 'ws-1', documentId: 'doc-1', documentTitle: 'Refund Policy', chunk });
  }
  const okGenerate = (text = 'Refunds are available within 30 days of purchase.') =>
    (async () => ({ text, provider: 'groq' as const, model: 'gpt-oss-120b', promptTokens: 10, completionTokens: 20, latencyMs: 5 }));

  beforeEach(() => {
    pState.messages.length = 0;
    pState.conversations.length = 0;
    pState.settings.length = 0;
    pState.executions.length = 0;
    pState.suggestions.length = 0;
    pState.tickets.length = 0;
    pState.handoffs.length = 0;
    pState.knowledge.length = 0;
    pSeq = 0;
  });

  it('suggestion mode creates a draft only (no agent message sent)', async () => {
    seedConversation();
    seedCustomerMessage();
    seedSettings('suggestion');
    seedKnowledge();
    const res = await processAutomationEvent(fakeClient, baseEvent(), { generate: okGenerate() as any });
    expect(res.outcome).toBe('suggestion_created');
    expect(pState.suggestions).toHaveLength(1);
    expect(pState.suggestions[0]!.status).toBe('pending');
    expect(pState.suggestions[0]!.sources).toEqual([{ documentId: 'doc-1', documentTitle: 'Refund Policy' }]);
    expect(pState.messages.filter((m) => m.sender_type === 'agent')).toHaveLength(0);
    expect(pState.executions).toHaveLength(1);
    expect(pState.executions[0]!.status).toBe('success');
    expect(pState.executions[0]!.provider).toBe('groq');
  });

  it('suggestion mode is idempotent: a duplicate process-event creates no second suggestion and no second provider call', async () => {
    seedConversation();
    seedCustomerMessage();
    seedSettings('suggestion');
    seedKnowledge();
    let calls = 0;
    const countingGenerate = async () => {
      calls += 1;
      return { text: 'Refunds are available within 30 days of purchase.', provider: 'groq' as const, model: 'gpt-oss-120b', promptTokens: 10, completionTokens: 20, latencyMs: 5 };
    };
    const event = baseEvent();
    const res1 = await processAutomationEvent(fakeClient, event, { generate: countingGenerate as any });
    expect(res1.outcome).toBe('suggestion_created');
    expect(res1.id).toBeTruthy();
    // Re-processing the same event returns the existing draft — the
    // provider is not called again and no second suggestion is stored.
    const res2 = await processAutomationEvent(fakeClient, event, { generate: countingGenerate as any });
    expect(res2.outcome).toBe('suggestion_created');
    expect(res2.id).toBe(res1.id);
    expect(pState.suggestions).toHaveLength(1);
    expect(pState.executions).toHaveLength(1);
    expect(calls).toBe(1);
  });

  it('per-workspace provider_order wins: ["gemini"] makes generation use Gemini first', async () => {
    seedConversation();
    seedCustomerMessage();
    seedSettings('suggestion', true, true, ['gemini']);
    seedKnowledge();
    const seenConfigs: AiConfig[] = [];
    const capturingGenerate = async (_input: any, cfg: AiConfig) => {
      seenConfigs.push(cfg);
      return { text: 'Gemini draft reply.', provider: 'gemini' as const, model: 'gemini-3.8-flash', promptTokens: 10, completionTokens: 20, latencyMs: 5 };
    };
    const res = await processAutomationEvent(fakeClient, baseEvent(), {
      generate: capturingGenerate as any,
      config: TEST_CONFIG,
    });
    expect(res.outcome).toBe('suggestion_created');
    expect(seenConfigs).toHaveLength(1);
    expect(seenConfigs[0]!.providerOrder).toEqual(['gemini']);
    expect(pState.executions[0]!.provider).toBe('gemini');
    expect(pState.executions[0]!.model).toBe('gemini-3.8-flash');
  });

  it('per-workspace provider_order ["groq","gemini"] keeps Groq first; an empty row order falls back to the env config', async () => {
    seedConversation();
    seedCustomerMessage();
    seedSettings('suggestion', true, true, ['groq', 'gemini']);
    seedKnowledge();
    const seen: AiConfig[] = [];
    const gen = async (_input: any, cfg: AiConfig) => {
      seen.push(cfg);
      return { text: 'Groq draft.', provider: 'groq' as const, model: 'gpt-oss-120b', promptTokens: 1, completionTokens: 2, latencyMs: 1 };
    };
    const res = await processAutomationEvent(fakeClient, baseEvent(), { generate: gen as any, config: TEST_CONFIG });
    expect(res.outcome).toBe('suggestion_created');
    expect(seen).toHaveLength(1);
    expect(seen[0]!.providerOrder).toEqual(['groq', 'gemini']);

    // Same workspace, order cleared to []: the env config order is used.
    pState.settings[0]!.provider_order = [];
    pState.suggestions.length = 0;
    pState.executions.length = 0;
    const envOrderConfig: AiConfig = { ...TEST_CONFIG, providerOrder: ['gemini', 'groq'] };
    const seen2: AiConfig[] = [];
    const gen2 = async (_input: any, cfg: AiConfig) => {
      seen2.push(cfg);
      return { text: 'Gemini draft.', provider: 'gemini' as const, model: 'gemini-3.8-flash', promptTokens: 1, completionTokens: 2, latencyMs: 1 };
    };
    const res2 = await processAutomationEvent(fakeClient, baseEvent(), { generate: gen2 as any, config: envOrderConfig });
    expect(res2.outcome).toBe('suggestion_created');
    expect(seen2).toHaveLength(1);
    expect(seen2[0]!.providerOrder).toEqual(['gemini', 'groq']);
  });

  it('auto mode sends an idempotent reply and records it as accepted', async () => {
    seedConversation();
    seedCustomerMessage();
    seedSettings('auto');
    seedKnowledge();
    const event = baseEvent();
    const res1 = await processAutomationEvent(fakeClient, event, { generate: okGenerate() as any });
    expect(res1.outcome).toBe('auto_replied');
    const replies = pState.messages.filter((m) => m.sender_type === 'agent');
    expect(replies).toHaveLength(1);
    expect(replies[0]!.client_message_id).toBe('ai-evt-1');
    expect(pState.suggestions[0]!.status).toBe('accepted');
    // Re-processing the same event does not insert a second reply.
    const res2 = await processAutomationEvent(fakeClient, event, { generate: okGenerate() as any });
    expect(res2.outcome).toBe('auto_replied');
    expect(pState.messages.filter((m) => m.sender_type === 'agent')).toHaveLength(1);
  });

  it('auto mode permission gate: an AI-paused conversation is skipped, never replied to', async () => {
    seedConversation({ aiPaused: true });
    seedCustomerMessage();
    seedSettings('auto');
    seedKnowledge();
    const res = await processAutomationEvent(fakeClient, baseEvent(), { generate: okGenerate() as any });
    expect(res.outcome).toBe('skipped');
    expect(pState.messages.filter((m) => m.sender_type === 'agent')).toHaveLength(0);
    expect(pState.executions[0]!.status).toBe('skipped');
  });

  it('loop prevention: an agent message event is skipped', async () => {
    seedConversation();
    pState.messages.push({
      id: 'msg-2', workspace_id: 'ws-1', conversation_id: 'conv-1', customer_id: 'cust-1',
      sender_type: 'agent', body: 'AI reply text', client_message_id: 'ai-evt-0',
    });
    seedSettings('auto');
    seedKnowledge();
    const res = await processAutomationEvent(fakeClient, baseEvent({ entity_id: 'msg-2' }), { generate: okGenerate() as any });
    expect(res.outcome).toBe('skipped');
    expect(pState.suggestions).toHaveLength(0);
    expect(pState.messages.filter((m) => m.sender_type === 'agent')).toHaveLength(1); // only the seeded one
  });

  it('loop prevention: non-customer-message events are skipped', async () => {
    seedConversation();
    seedCustomerMessage();
    seedSettings('auto');
    const res = await processAutomationEvent(
      fakeClient,
      baseEvent({ event_type: 'ticket.created', entity_type: 'ticket', entity_id: 't-1' }),
      { generate: okGenerate() as any },
    );
    expect(res.outcome).toBe('skipped');
    expect(pState.executions).toHaveLength(0);
  });

  it('unsafe response is never sent; the conversation is escalated', async () => {
    seedConversation();
    seedCustomerMessage();
    seedSettings('auto');
    seedKnowledge();
    const res = await processAutomationEvent(fakeClient, baseEvent(), {
      generate: okGenerate('Good news — you will receive a full refund, it has been processed.') as any,
    });
    expect(res.outcome).toBe('escalated');
    expect(pState.messages.filter((m) => m.sender_type === 'agent')).toHaveLength(0);
    expect(pState.handoffs).toHaveLength(1);
    expect(pState.handoffs[0]!.reason).toContain('unsafe_response');
    expect(pState.tickets).toHaveLength(1);
    expect(pState.conversations[0]!.ai_paused).toBe(true);
    expect(pState.executions[0]!.status).toBe('escalated');
  });

  it('missing knowledge + grounding required escalates instead of answering', async () => {
    seedConversation();
    seedCustomerMessage('Do you sell purple widgets?');
    seedSettings('auto', true, true);
    // No knowledge seeded.
    const res = await processAutomationEvent(fakeClient, baseEvent(), { generate: okGenerate() as any });
    expect(res.outcome).toBe('escalated');
    expect(pState.messages.filter((m) => m.sender_type === 'agent')).toHaveLength(0);
    expect(pState.handoffs).toHaveLength(1);
    expect(pState.executions[0]!.status).toBe('escalated');
  });

  it('human_only and disabled modes skip with an execution row', async () => {
    for (const mode of ['human_only', 'disabled']) {
      seedConversation();
      seedCustomerMessage();
      seedSettings(mode);
      seedKnowledge();
      const res = await processAutomationEvent(fakeClient, baseEvent(), { generate: okGenerate() as any });
      expect(res.outcome).toBe('skipped');
      expect(pState.executions).toHaveLength(1);
      expect(pState.executions[0]!.status).toBe('skipped');
      expect(pState.suggestions).toHaveLength(0);
      // Reset for the next mode.
      pState.messages.length = 0;
      pState.conversations.length = 0;
      pState.settings.length = 0;
      pState.executions.length = 0;
    }
  });

  it('no settings row means AI disabled: skipped with an execution row', async () => {
    seedConversation();
    seedCustomerMessage();
    seedKnowledge();
    const res = await processAutomationEvent(fakeClient, baseEvent(), { generate: okGenerate() as any });
    expect(res.outcome).toBe('skipped');
    expect(pState.executions[0]!.status).toBe('skipped');
  });

  it('provider failure always escalates (never silently drops)', async () => {
    seedConversation();
    seedCustomerMessage();
    seedSettings('auto');
    seedKnowledge();
    const failing = async () => {
      throw new AiUnavailableError('All AI providers failed', { provider: 'gemini', status: 429, retryable: true, quotaExceeded: true });
    };
    const res = await processAutomationEvent(fakeClient, baseEvent(), { generate: failing as any });
    expect(res.outcome).toBe('escalated');
    expect(pState.handoffs).toHaveLength(1);
    expect(pState.handoffs[0]!.reason).toContain('quota');
    expect(pState.executions[0]!.status).toBe('failed');
    expect(pState.conversations[0]!.ai_paused).toBe(true);
  });

  it('escalation reuses an existing open ticket for the same conversation', async () => {
    seedConversation();
    seedCustomerMessage();
    seedSettings('auto');
    pState.tickets.push({
      id: 'ticket-1', workspace_id: 'ws-1', conversation_id: 'conv-1', customer_id: 'cust-1',
      subject: 'Earlier issue', status: 'open', escalation_reason: null, escalated_at: null,
    });
    const res = await processAutomationEvent(fakeClient, baseEvent(), { generate: okGenerate() as any });
    expect(res.outcome).toBe('escalated');
    expect(pState.tickets).toHaveLength(1);
    expect(pState.tickets[0]!.escalation_reason).toContain('Insufficient knowledge');
    expect(pState.handoffs[0]!.ticket_id).toBe('ticket-1');
  });
});

// ---------------------------------------------------------------------------
// Routes (supertest + mocked Supabase lib)
// ---------------------------------------------------------------------------

describe('phase 3 routes', () => {
  const env: any = {
    PORT: 4000,
    FRONTEND_URL: 'http://localhost:5173',
    SUPABASE_URL: 'https://example.supabase.co',
    SUPABASE_ANON_KEY: 'test-key',
    NODE_ENV: 'test',
    AI_PROVIDER_ORDER: 'groq,gemini',
    AI_MODEL_GROQ: 'gpt-oss-120b',
    AI_MODEL_GEMINI: 'gemini-3.8-flash',
    AI_REQUEST_TIMEOUT_MS: 30000,
    AI_DIRECT_PROCESSING: false,
    API_BASE_URL: 'http://localhost:4000',
  };
  const ownerAuth = { Authorization: 'Bearer owner-token' };
  const memberAuth = { Authorization: 'Bearer member-token' };
  const WS = '/api/workspaces/ws-1';

  function buildApp(envOverride: any = {}) {
    const app = express();
    app.use(express.json());
    const e = { ...env, ...envOverride };
    app.use('/api/workspaces/:workspaceId/knowledge', authMiddleware(e), knowledgeRouter(e));
    app.use('/api/workspaces/:workspaceId/ai-settings', authMiddleware(e), aiSettingsRouter(e));
    app.use('/api/workspaces/:workspaceId', authMiddleware(e), aiWorkspaceRouter(e));
    app.use('/api/automation', automationRouter(e));
    app.use(errorHandler);
    return app;
  }

  beforeEach(() => {
    mockState.knowledgeDocs.length = 0;
    mockState.knowledgeChunks.length = 0;
    mockState.knowledgeJobs.length = 0;
    mockState.aiSettings.length = 0;
    mockState.aiExecutions.length = 0;
    mockState.aiSuggestions.length = 0;
    mockState.handoffs.length = 0;
    mockState.automationEvents.length = 0;
    mockState.messages.length = 0;
    mockState.conversations.length = 0;
    mockState.tickets.length = 0;
    mockState.seq = 0;
  });

  it('knowledge: create indexes chunks, list, patch re-chunks, delete archives', async () => {
    const app = buildApp();
    const created = await request(app).post(`${WS}/knowledge`).set(ownerAuth).send({
      title: 'Refund Policy', content: 'Refunds within 30 days. Contact support for help.', kind: 'article',
    });
    expect(created.status).toBe(201);
    const docId = created.body.document.id as string;
    expect(mockState.knowledgeChunks.filter((c) => c.document_id === docId).length).toBeGreaterThan(0);
    expect(mockState.knowledgeJobs.filter((j) => j.document_id === docId)[0]!.status).toBe('done');

    const listed = await request(app).get(`${WS}/knowledge?q=refund`).set(ownerAuth);
    expect(listed.status).toBe(200);
    expect(listed.body.total).toBe(1);
    expect(listed.body.items).toHaveLength(1);

    const patched = await request(app).patch(`${WS}/knowledge/${docId}`).set(ownerAuth).send({
      content: 'Refunds within 60 days now. Updated policy text here.',
    });
    expect(patched.status).toBe(200);
    const chunks = mockState.knowledgeChunks.filter((c) => c.document_id === docId);
    expect(chunks.some((c) => String(c.content).includes('60 days'))).toBe(true);

    const archived = await request(app).delete(`${WS}/knowledge/${docId}`).set(ownerAuth);
    expect(archived.status).toBe(200);
    expect(archived.body.document.archived).toBe(true);
    const listedAfter = await request(app).get(`${WS}/knowledge`).set(ownerAuth);
    expect(listedAfter.body.total).toBe(0);
  });

  it('knowledge: rejects invalid payloads and unknown ids', async () => {
    const app = buildApp();
    const bad = await request(app).post(`${WS}/knowledge`).set(ownerAuth).send({ title: 'x', content: '', kind: 'faq' });
    expect(bad.status).toBe(400);
    const missing = await request(app).get(`${WS}/knowledge/no-such-id`).set(ownerAuth);
    expect(missing.status).toBe(404);
  });

  it('ai-settings: defaults when no row, owner can PATCH, member gets 403, API keys rejected', async () => {
    const app = buildApp();
    const defaults = await request(app).get(`${WS}/ai-settings`).set(ownerAuth);
    expect(defaults.status).toBe(200);
    expect(defaults.body.settings.enabled).toBe(false);
    expect(defaults.body.settings.mode).toBe('suggestion');
    expect(defaults.body.settings.provider_order).toEqual(['groq', 'gemini']);

    const forbidden = await request(app).patch(`${WS}/ai-settings`).set(memberAuth).send({ enabled: true });
    expect(forbidden.status).toBe(403);

    const withKey = await request(app).patch(`${WS}/ai-settings`).set(ownerAuth).send({ enabled: true, GROQ_API_KEY: 'sk-secret' });
    expect(withKey.status).toBe(400);

    const updated = await request(app).patch(`${WS}/ai-settings`).set(ownerAuth).send({ enabled: true, mode: 'auto' });
    expect(updated.status).toBe(200);
    expect(updated.body.settings.enabled).toBe(true);
    expect(updated.body.settings.mode).toBe('auto');
    expect(updated.body.settings).not.toHaveProperty('GROQ_API_KEY');
  });

  it('ai-overview returns real counts from tables', async () => {
    const app = buildApp();
    mockState.aiSettings.push({ id: 's1', workspace_id: 'ws-1', enabled: true, mode: 'auto', provider_order: ['groq'], auto_reply_require_grounding: true, escalation_on_low_confidence: true });
    mockState.aiExecutions.push(
      { id: 'e1', workspace_id: 'ws-1', conversation_id: 'conv-1', status: 'success' },
      { id: 'e2', workspace_id: 'ws-1', conversation_id: 'conv-1', status: 'success' },
      { id: 'e3', workspace_id: 'ws-1', conversation_id: 'conv-2', status: 'failed' },
    );
    mockState.aiSuggestions.push({ id: 'sg1', workspace_id: 'ws-1', conversation_id: 'conv-1', status: 'pending' });
    mockState.messages.push({ id: 'm1', workspace_id: 'ws-1', conversation_id: 'conv-1', sender_type: 'agent', client_message_id: 'ai-evt-1' });
    mockState.handoffs.push({ id: 'h1', workspace_id: 'ws-1', conversation_id: 'conv-1' });
    mockState.automationEvents.push(
      { id: 'a1', workspace_id: 'ws-1', status: 'pending', processed_at: null },
      { id: 'a2', workspace_id: 'ws-1', status: 'failed', processed_at: '2026-11-15T10:00:00.000Z' },
    );
    const res = await request(app).get(`${WS}/ai-overview`).set(ownerAuth);
    expect(res.status).toBe(200);
    expect(res.body.ai_enabled).toBe(true);
    expect(res.body.mode).toBe('auto');
    expect(res.body.totals.assisted_conversations).toBe(1);
    expect(res.body.totals.suggestions).toBe(1);
    expect(res.body.totals.auto_replies).toBe(1);
    expect(res.body.totals.handoffs).toBe(1);
    expect(res.body.totals.failed_executions).toBe(1);
    expect(res.body.automation.pending).toBe(1);
    expect(res.body.automation.failed).toBe(1);
    expect(res.body.automation.last_processed_at).toBe('2026-11-15T10:00:00.000Z');
  });

  it('suggestions: accept inserts an agent reply (idempotent), reject marks rejected', async () => {
    const app = buildApp();
    mockState.conversations.push({ id: 'conv-1', workspace_id: 'ws-1', customer_id: 'cust-1', status: 'open' });
    mockState.aiSuggestions.push(
      { id: 'sugg-1', workspace_id: 'ws-1', conversation_id: 'conv-1', message_id: 'msg-1', suggestion: 'Draft reply here.', sources: [], status: 'pending', reviewed_by: null },
      { id: 'sugg-2', workspace_id: 'ws-1', conversation_id: 'conv-1', message_id: 'msg-1', suggestion: 'Another draft.', sources: [], status: 'pending', reviewed_by: null },
    );
    const accepted = await request(app)
      .post(`${WS}/conversations/conv-1/suggestions/sugg-1/accept`)
      .set(ownerAuth)
      .send({ edited_text: 'Edited reply here.' });
    expect(accepted.status).toBe(200);
    expect(accepted.body.suggestion.status).toBe('edited');
    expect(accepted.body.suggestion.reviewed_by).toBe(mockState.userIds.owner);
    expect(accepted.body.message.body).toBe('Edited reply here.');
    expect(accepted.body.message.client_message_id).toBe('sugg-sugg-1');

    const again = await request(app)
      .post(`${WS}/conversations/conv-1/suggestions/sugg-1/accept`)
      .set(ownerAuth)
      .send({});
    expect(again.status).toBe(409);

    const rejected = await request(app)
      .post(`${WS}/conversations/conv-1/suggestions/sugg-2/reject`)
      .set(ownerAuth)
      .send({});
    expect(rejected.status).toBe(200);
    expect(rejected.body.suggestion.status).toBe('rejected');

    const listed = await request(app).get(`${WS}/conversations/conv-1/suggestions`).set(ownerAuth);
    expect(listed.status).toBe(200);
    expect(listed.body.total).toBe(2);
  });

  it('process-event: 503 without a webhook secret, 401 on a bad signature', async () => {
    const noSecretApp = buildApp({ AUTOMATION_WEBHOOK_SECRET: undefined });
    const event = { id: 'evt-9', event_type: 'customer.message.created', workspace_id: 'ws-1', entity_type: 'message', entity_id: 'msg-9', payload: {} };
    const noSecret = await request(noSecretApp).post('/api/automation/process-event').send(event);
    expect(noSecret.status).toBe(503);

    const app = buildApp({ AUTOMATION_WEBHOOK_SECRET: 'a-very-long-test-secret-0123456789' });
    const badSig = await request(app)
      .post('/api/automation/process-event')
      .set({ 'x-sf-signature': 'sha256=deadbeef', 'x-sf-timestamp': String(Math.floor(Date.now() / 1000)) })
      .send(event);
    expect(badSig.status).toBe(401);

    const noSig = await request(app).post('/api/automation/process-event').send(event);
    expect(noSig.status).toBe(401);
  });

  it('process-event: a valid signature reaches the service client (503 without a service key)', async () => {
    const secret = 'a-very-long-test-secret-0123456789';
    const app = buildApp({ AUTOMATION_WEBHOOK_SECRET: secret });
    const event = { id: 'evt-9', event_type: 'customer.message.created', workspace_id: 'ws-1', entity_type: 'message', entity_id: 'msg-9', payload: {} };
    const rawBody = JSON.stringify(event);
    const ts = Math.floor(Date.now() / 1000);
    const res = await request(app)
      .post('/api/automation/process-event')
      .set({ 'x-sf-signature': signWebhook(secret, rawBody, ts), 'x-sf-timestamp': String(ts) })
      .send(event);
    // The signature verifies; the service-role client is not configured in
    // this test env, so the route reports 503 (not 401).
    expect(res.status).toBe(503);
    expect(res.body.error).toBe('Automation service is not configured');
  });
});
