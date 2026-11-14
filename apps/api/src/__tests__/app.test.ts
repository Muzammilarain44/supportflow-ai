/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import request from 'supertest';

// ---- Mock Supabase client (offline tests; live Supabase tests need real env — see README) ----
const mockState = vi.hoisted(() => ({
  userId: 'user-1',
  members: [{ workspace_id: 'ws-1', user_id: 'user-1', role: 'owner' }] as Array<Record<string, string>>,
  rpcError: null as { message: string } | null,
  rpcResult: { id: 'ws-2', name: 'Acme', slug: 'acme', description: null, owner_id: 'user-1' },
}));
vi.mock('../lib/supabase.js', () => {
  const makeClient = () => {
    const builder = (table: string) => {
      const filters: Record<string, string> = {};
      const b: Record<string, unknown> & { select: () => unknown; eq: (c: string, v: string) => unknown; maybeSingle: () => Promise<unknown>; single: () => Promise<unknown>; then: (r: (v: unknown) => void) => void } = {
        select: () => b,
        eq: (col: string, val: string) => { filters[col] = val; return b; },
        maybeSingle: async () => {
          const found = mockState.members.find(
            (m) => (!filters.workspace_id || m.workspace_id === filters.workspace_id) && (!filters.user_id || m.user_id === filters.user_id),
          );
          return { data: found ?? null, error: null };
        },
        single: async () => ({ data: { id: 'ws-1', name: 'Acme', slug: 'acme', description: null, owner_id: 'user-1' }, error: null }),
        then: (resolve: any) => resolve({ data: table === 'workspace_members' ? mockState.members.map((m) => ({ workspace_id: m.workspace_id, workspaces: { id: m.workspace_id, name: 'Acme', slug: 'acme' } })) : [], error: null }),
      };
      return b;
    };
    return {
      auth: { getUser: async (token: string) => (token === 'valid-token' || token === 'other-token'
        ? { data: { user: { id: token === 'valid-token' ? 'user-1' : 'user-2', email: 'a@example.com' } }, error: null }
        : { data: { user: null }, error: { message: 'bad token' } }) },
      from: (table: string) => builder(table),
      rpc: async () => (mockState.rpcError ? { data: null, error: mockState.rpcError } : { data: mockState.rpcResult, error: null }),
    };
  };
  return { getSupabase: () => makeClient(), getUserSupabase: () => makeClient() };
});

import { createApp } from '../app.js';
import { isMember } from '../middleware/workspaceAuth.js';
import { createWorkspaceSchema } from '@supportflow/shared';

const env = { PORT: 4000, FRONTEND_URL: 'http://localhost:5173', SUPABASE_URL: 'https://example.supabase.co', SUPABASE_ANON_KEY: 'test-key', NODE_ENV: 'test' } as any;
const app = createApp(env);

describe('health', () => {
  it('GET /health returns ok', async () => {
    const res = await request(app).get('/health');
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('ok');
  });
});

describe('validation', () => {
  it('Zod rejects a bad workspace payload', () => {
    expect(createWorkspaceSchema.safeParse({ name: 'A', slug: 'BAD SLUG' }).success).toBe(false);
    expect(createWorkspaceSchema.safeParse({ name: 'Acme', slug: 'acme' }).success).toBe(true);
  });
  it('POST /api/workspaces rejects invalid slug with 400', async () => {
    const res = await request(app).post('/api/workspaces').set('Authorization', 'Bearer valid-token').send({ name: 'Acme', slug: 'BAD SLUG' });
    expect(res.status).toBe(400);
  });
});

describe('protected routes', () => {
  it('401 without a token', async () => {
    const res = await request(app).get('/api/workspaces');
    expect(res.status).toBe(401);
  });
  it('401 with an invalid token', async () => {
    const res = await request(app).get('/api/workspaces').set('Authorization', 'Bearer nope');
    expect(res.status).toBe(401);
  });
});

describe('workspace creation + tenant isolation', () => {
  beforeEach(() => { mockState.rpcError = null; });
  it('creates a workspace via the secure RPC (mocked)', async () => {
    const res = await request(app).post('/api/workspaces').set('Authorization', 'Bearer valid-token').send({ name: 'Acme', slug: 'acme' });
    expect(res.status).toBe(201);
    expect(res.body.workspace.slug).toBe('acme');
  });
  it('duplicate slug surfaces as 409 (mocked RPC error)', async () => {
    mockState.rpcError = { message: 'Workspace slug already exists' };
    const res = await request(app).post('/api/workspaces').set('Authorization', 'Bearer valid-token').send({ name: 'Acme', slug: 'acme' });
    expect(res.status).toBe(409);
  });
  it('403 for a non-member workspace (tenant isolation)', async () => {
    const res = await request(app).get('/api/workspaces/ws-1').set('Authorization', 'Bearer other-token');
    expect(res.status).toBe(403);
  });
  it('200 for a member workspace', async () => {
    const res = await request(app).get('/api/workspaces/ws-1').set('Authorization', 'Bearer valid-token');
    expect(res.status).toBe(200);
  });
  it('isMember() unit check: same workspace, different user is not a member', () => {
    expect(isMember([{ workspace_id: 'ws-1', user_id: 'user-1' }], 'ws-1', 'user-2')).toBe(false);
    expect(isMember([{ workspace_id: 'ws-1', user_id: 'user-1' }], 'ws-1', 'user-1')).toBe(true);
    expect(isMember([{ workspace_id: 'ws-1', user_id: 'user-1' }], 'ws-2', 'user-1')).toBe(false);
  });
});
