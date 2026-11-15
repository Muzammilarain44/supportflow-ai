/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { WorkspaceContext } from '../context/WorkspaceContext';
import { ToastProvider } from '../components/Toast';
import Tickets from '../pages/Tickets';

vi.mock('../lib/supabase', () => ({
  supabase: {
    auth: { getSession: async () => ({ data: { session: null } }) },
    channel: () => ({ on: () => ({ subscribe: () => ({}) }) }),
    removeChannel: async () => {},
  },
}));

const USER_1 = '11111111-1111-4111-8111-111111111111';

const workspaceValue = {
  workspaces: [{ id: 'ws-1', name: 'Acme', slug: 'acme', description: null, owner_id: USER_1, created_at: '2026-01-01', updated_at: '2026-01-01' }],
  workspaceId: 'ws-1',
  workspace: { id: 'ws-1', name: 'Acme', slug: 'acme', description: null, owner_id: USER_1, created_at: '2026-01-01', updated_at: '2026-01-01' },
  setWorkspaceId: () => {},
  loading: false,
  status: 'ready',
  error: null,
  refetchWorkspaces: () => {},
};

const membersWithProfiles = [
  { id: 'mem-1', workspace_id: 'ws-1', user_id: USER_1, role: 'owner', created_at: '2026-01-01T00:00:00.000Z', updated_at: '2026-01-01T00:00:00.000Z', display_name: 'Alice Owner', avatar_url: null, initials: 'AO', member_since: '2026-01-01T00:00:00.000Z' },
];

function testClient() {
  return new QueryClient({ defaultOptions: { queries: { retry: false } } });
}

beforeEach(() => {
  window.localStorage.clear();
  window.history.pushState({}, '', '/');
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('Tickets list assignee while members are loading (Phase 2.1 fix)', () => {
  it('shows a loading placeholder — never "Unnamed member" — until members resolve, then the real name', async () => {
    let resolveMembers!: (v: any) => void;
    const membersPromise = new Promise<any>((resolve) => { resolveMembers = resolve; });
    const fetchMock = vi.fn(async (url: string) => {
      if (url.includes('/tickets/stats')) {
        return { ok: true, json: async () => ({ by_status: { open: 1, in_progress: 0, waiting_for_customer: 0, resolved: 0, closed: 0 }, by_priority: { low: 0, medium: 0, high: 1, urgent: 0 }, total: 1 }) };
      }
      if (url.includes('/tickets')) {
        return {
          ok: true,
          json: async () => ({
            tickets: [
              { id: 't1', workspace_id: 'ws-1', customer_id: null, conversation_id: null, subject: 'Billing question', description: null, category: 'billing', priority: 'high', status: 'open', assigned_to: USER_1, created_by: USER_1, created_at: '2026-11-14T10:00:00.000Z', updated_at: '2026-11-14T10:00:00.000Z', resolved_at: null },
            ],
            total: 1, page: 1, pageSize: 20,
          }),
        };
      }
      if (url.includes('/members')) {
        return membersPromise.then(() => ({ ok: true, json: async () => ({ members: membersWithProfiles }) }));
      }
      return { ok: true, json: async () => ({}) };
    });
    vi.stubGlobal('fetch', fetchMock);

    render(
      <QueryClientProvider client={testClient()}>
        <WorkspaceContext.Provider value={workspaceValue as any}>
          <ToastProvider>
            <MemoryRouter initialEntries={['/tickets']}>
              <Routes><Route path="/tickets" element={<Tickets />} /></Routes>
            </MemoryRouter>
          </ToastProvider>
        </WorkspaceContext.Provider>
      </QueryClientProvider>,
    );

    // Tickets render while the members request is still pending.
    expect(await screen.findByText('Billing question')).toBeInTheDocument();
    expect(document.body.textContent).not.toContain('Unnamed member');
    expect(screen.getAllByText('…').length).toBeGreaterThanOrEqual(1);

    // Once members resolve, the real name appears.
    resolveMembers(undefined);
    expect(await screen.findByText('Alice Owner')).toBeInTheDocument();
    expect(document.body.textContent).not.toContain('Unnamed member');
  });
});
