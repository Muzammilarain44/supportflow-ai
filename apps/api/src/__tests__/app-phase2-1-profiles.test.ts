/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, it, expect, vi } from 'vitest';
import request from 'supertest';

// ---- Phase 2.1 (Issue 2) — profiles: real member names, not UUIDs ----
// Mock Supabase client following the app-phase2.test.ts mockState pattern,
// extended with a `profiles` table, `upsert` support, and user_metadata
// (full_name / name) on getUser so lazy profile creation can be tested.
// NOTE: this tests the API against the mocked client only. The migration
// SQL itself (backfill, RLS policies, auth.users trigger) is NOT tested
// live here — that needs a real Supabase project (parent verifies live).

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
      user3: '33333333-3333-4333-8333-333333333333',
    },
    members: [
      { id: 'mem-1', workspace_id: 'ws-1', user_id: '11111111-1111-4111-8111-111111111111', role: 'owner', created_at: '2026-01-01T00:00:00.000Z' },
      { id: 'mem-3', workspace_id: 'ws-1', user_id: '33333333-3333-4333-8333-333333333333', role: 'member', created_at: '2026-01-01T00:00:00.000Z' },
    ] as Array<Record<string, any>>,
    workspaces: [
      { id: 'ws-1', name: 'Acme', slug: 'acme', description: null, owner_id: '11111111-1111-4111-8111-111111111111' },
    ] as Array<Record<string, any>>,
    // user1 HAS a profile; user3 has NONE (lazy creation must create it).
    profiles: [
      { id: '11111111-1111-4111-8111-111111111111', display_name: 'Alice Owner', avatar_url: null, created_at: '2026-01-01T00:00:00.000Z', updated_at: '2026-01-01T00:00:00.000Z' },
    ] as Array<Record<string, any>>,
  };
});

vi.mock('../lib/supabase.js', () => {
  type Predicate = (row: Record<string, any>) => boolean;

  const tableRows = (table: string): Array<Record<string, any>> => {
    switch (table) {
      case 'workspace_members': return mockState.members;
      case 'workspaces': return mockState.workspaces;
      case 'profiles': return mockState.profiles;
      default: return [];
    }
  };

  const makeBuilder = (table: string) => {
    const filters: Predicate[] = [];
    let op: 'select' | 'insert' | 'update' | 'delete' | 'upsert' = 'select';
    let insertRows: Array<Record<string, any>> | null = null;
    let updatePatch: Record<string, any> | null = null;
    let upsertConflict: string | null = null;

    const applyFilters = (rows: Array<Record<string, any>>) => rows.filter((r) => filters.every((f) => f(r)));

    const execute = (): { data: any; count: number | null; error: any } => {
      const clone = (r: Record<string, any>) => ({ ...r });
      const rows = tableRows(table);
      if (op === 'insert' || op === 'upsert') {
        const inserted: Array<Record<string, any>> = [];
        for (const input of insertRows ?? []) {
          if (op === 'upsert' && upsertConflict) {
            const existing = rows.find((r) => r[upsertConflict!] === input[upsertConflict!]);
            if (existing) {
              Object.assign(existing, input);
              existing.updated_at = mockState.ts();
              inserted.push(existing);
              continue;
            }
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
      return { data: filtered.map(clone), count: null, error: null };
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
      order: () => b,
      range: () => b,
      limit: () => b,
      insert: (input: Record<string, any> | Array<Record<string, any>>) => {
        op = 'insert';
        insertRows = Array.isArray(input) ? input : [input];
        return b;
      },
      upsert: (input: Record<string, any> | Array<Record<string, any>>, opts?: { onConflict?: string }) => {
        op = 'upsert';
        upsertConflict = opts?.onConflict ?? null;
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
        const map: Record<string, { id: string; user_metadata: Record<string, unknown> }> = {
          'valid-token': { id: mockState.userIds.user1, user_metadata: { full_name: 'Alice Owner' } },
          'member-token': { id: mockState.userIds.user3, user_metadata: {} },
          'other-token': { id: mockState.userIds.user2, user_metadata: { name: 'Bob Outsider' } },
        };
        const user = map[token];
        return user
          ? { data: { user: { id: user.id, email: `${user.id}@example.com`, user_metadata: user.user_metadata } }, error: null }
          : { data: { user: null }, error: { message: 'bad token' } };
      },
    },
    from: (table: string) => makeBuilder(table),
    rpc: async (fn: string) => ({ data: null, error: { message: `Unknown RPC ${fn}` } }),
  });
  return { getSupabase: () => makeClient(), getUserSupabase: () => makeClient() };
});

import { createApp } from '../app.js';

const USER_1 = '11111111-1111-4111-8111-111111111111';
const USER_2 = '22222222-2222-4222-8222-222222222222';
const USER_3 = '33333333-3333-4333-8333-333333333333';

const env = { PORT: 4000, FRONTEND_URL: 'http://localhost:5173', SUPABASE_URL: 'https://example.supabase.co', SUPABASE_ANON_KEY: 'test-key', NODE_ENV: 'test' } as any;
const app = createApp(env);
const auth = { Authorization: 'Bearer valid-token' };
const memberAuth = { Authorization: 'Bearer member-token' };
const otherAuth = { Authorization: 'Bearer other-token' };
const WS = '/api/workspaces/ws-1';

describe('members with profiles (Issue 2)', () => {
  it('returns display names and initials, not bare UUIDs, and never emails', async () => {
    const res = await request(app).get(`${WS}/members`).set(auth);
    expect(res.status).toBe(200);
    expect(res.body.members).toHaveLength(2);
    const owner = res.body.members.find((m: any) => m.user_id === USER_1);
    expect(owner.display_name).toBe('Alice Owner');
    expect(owner.initials).toBe('AO');
    expect(owner.avatar_url).toBeNull();
    expect(owner.member_since).toBe('2026-01-01T00:00:00.000Z');
    expect(owner.role).toBe('owner');
    // A member with no profile row falls back to 'Unnamed member'.
    const unnamed = res.body.members.find((m: any) => m.user_id === USER_3);
    expect(unnamed.display_name).toBe('Unnamed member');
    expect(unnamed.initials).toBe('?');
    // No email anywhere in the payload.
    expect(JSON.stringify(res.body)).not.toContain('email');
    expect(JSON.stringify(res.body)).not.toContain('@example.com');
  });

  it('403 for a non-member workspace, 401 without a token', async () => {
    expect((await request(app).get(`${WS}/members`).set(otherAuth)).status).toBe(403);
    expect((await request(app).get(`${WS}/members`)).status).toBe(401);
  });
});

describe('GET /api/profile/me (lazy creation)', () => {
  it('returns the existing profile for a user who has one', async () => {
    const res = await request(app).get('/api/profile/me').set(auth);
    expect(res.status).toBe(200);
    expect(res.body.profile.id).toBe(USER_1);
    expect(res.body.profile.display_name).toBe('Alice Owner');
    expect(res.body.profile).not.toHaveProperty('email');
  });

  it('creates a profile on first read for a user who has none (display_name null, not invented)', async () => {
    expect(mockState.profiles.find((p) => p.id === USER_3)).toBeUndefined();
    const res = await request(app).get('/api/profile/me').set(memberAuth);
    expect(res.status).toBe(200);
    expect(res.body.profile.id).toBe(USER_3);
    // member-token's user_metadata is empty, so no name is invented.
    expect(res.body.profile.display_name).toBeNull();
    expect(mockState.profiles.find((p) => p.id === USER_3)).toBeDefined();
    // Second read returns the same row — no duplicate created.
    const again = await request(app).get('/api/profile/me').set(memberAuth);
    expect(again.status).toBe(200);
    expect(again.body.profile.id).toBe(USER_3);
    expect(mockState.profiles.filter((p) => p.id === USER_3)).toHaveLength(1);
  });

  it('401 without a token', async () => {
    expect((await request(app).get('/api/profile/me')).status).toBe(401);
  });
});

describe('PATCH /api/profile/me (self-only)', () => {
  it('updates the caller’s own display_name, trimmed', async () => {
    const res = await request(app).patch('/api/profile/me').set(memberAuth).send({ display_name: '  Charlie Member  ' });
    expect(res.status).toBe(200);
    expect(res.body.profile.id).toBe(USER_3);
    expect(res.body.profile.display_name).toBe('Charlie Member');
    // The other user's profile is untouched.
    const other = await request(app).get('/api/profile/me').set(auth);
    expect(other.body.profile.display_name).toBe('Alice Owner');
  });

  it('accepts a valid https avatar_url and clears it with an empty string', async () => {
    const ok = await request(app).patch('/api/profile/me').set(memberAuth).send({ avatar_url: 'https://example.com/avatar.png' });
    expect(ok.status).toBe(200);
    expect(ok.body.profile.avatar_url).toBe('https://example.com/avatar.png');
    const cleared = await request(app).patch('/api/profile/me').set(memberAuth).send({ avatar_url: '' });
    expect(cleared.status).toBe(200);
    expect(cleared.body.profile.avatar_url).toBeNull();
  });

  it('rejects a display_name over 100 characters (400)', async () => {
    const res = await request(app).patch('/api/profile/me').set(memberAuth).send({ display_name: 'x'.repeat(101) });
    expect(res.status).toBe(400);
  });

  it('rejects a non-https avatar_url (400)', async () => {
    const res = await request(app).patch('/api/profile/me').set(memberAuth).send({ avatar_url: 'http://example.com/avatar.png' });
    expect(res.status).toBe(400);
  });

  it('rejects an injected id field — one user can never target another profile (400)', async () => {
    const res = await request(app).patch('/api/profile/me').set(memberAuth).send({ id: USER_2, display_name: 'Hacked' });
    expect(res.status).toBe(400);
    // The targeted user's profile (had none) was not created or changed by this.
    expect(mockState.profiles.find((p) => p.id === USER_2)).toBeUndefined();
  });

  it('rejects an empty patch (400) and requires auth (401)', async () => {
    expect((await request(app).patch('/api/profile/me').set(memberAuth).send({})).status).toBe(400);
    expect((await request(app).patch('/api/profile/me').send({ display_name: 'Nope' })).status).toBe(401);
  });
});
