/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { WorkspaceContext } from '../context/WorkspaceContext';
import { ToastProvider } from '../components/Toast';
import Team from '../pages/Team';
import Tickets, { TicketDetailPage } from '../pages/Tickets';

vi.mock('../lib/supabase', () => ({
  supabase: {
    auth: { getSession: async () => ({ data: { session: null } }) },
    channel: () => ({ on: () => ({ subscribe: () => ({}) }) }),
    removeChannel: async () => {},
  },
}));

const USER_1 = '11111111-1111-4111-8111-111111111111';
const USER_3 = '33333333-3333-4333-8333-333333333333';

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
  { id: 'mem-3', workspace_id: 'ws-1', user_id: USER_3, role: 'member', created_at: '2026-01-01T00:00:00.000Z', updated_at: '2026-01-01T00:00:00.000Z', display_name: 'Unnamed member', avatar_url: null, initials: '?', member_since: '2026-01-01T00:00:00.000Z' },
];

function testClient() {
  return new QueryClient({ defaultOptions: { queries: { retry: false } } });
}

function withProviders(ui: React.ReactElement, route = '/') {
  return render(
    <QueryClientProvider client={testClient()}>
      <WorkspaceContext.Provider value={workspaceValue as any}>
        <ToastProvider>
          <MemoryRouter initialEntries={[route]}>{ui}</MemoryRouter>
        </ToastProvider>
      </WorkspaceContext.Provider>
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  window.localStorage.clear();
  window.history.pushState({}, '', '/');
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('Team page (Issue 2)', () => {
  it('renders display names + initials and no raw UUID', async () => {
    const fetchMock = vi.fn(async (url: string) => {
      let body: any = {};
      if (url.includes('/members')) body = { members: membersWithProfiles };
      return { ok: true, json: async () => body };
    });
    vi.stubGlobal('fetch', fetchMock);
    withProviders(<Team />);

    expect(await screen.findByText('Alice Owner')).toBeInTheDocument();
    expect(screen.getByText('AO')).toBeInTheDocument();
    expect(screen.getByText('Unnamed member')).toBeInTheDocument();
    expect(screen.getByText('owner')).toBeInTheDocument();
    // Both members joined the same day, so the date appears twice.
    expect(screen.getAllByText('Jan 1, 2026')).toHaveLength(2);
    // No raw UUID anywhere on the page (UUIDs stay React keys / internal ids only).
    expect(document.body.textContent).not.toContain(USER_1);
    expect(document.body.textContent).not.toContain(USER_3);
    expect(document.body.textContent).not.toContain('User ID');
  });

  it('renders the avatar image when avatar_url is set', async () => {
    const withAvatar = [{ ...membersWithProfiles[0], avatar_url: 'https://example.com/alice.png' }];
    const fetchMock = vi.fn(async () => ({ ok: true, json: async () => ({ members: withAvatar }) }));
    vi.stubGlobal('fetch', fetchMock);
    withProviders(<Team />);
    expect(await screen.findByText('Alice Owner')).toBeInTheDocument();
    const img = document.querySelector('img[src="https://example.com/alice.png"]');
    expect(img).not.toBeNull();
  });
});

describe('Tickets list assignee (Issue 2)', () => {
  it('shows the assignee display name, not a UUID prefix', async () => {
    const fetchMock = vi.fn(async (url: string) => {
      let body: any = {};
      if (url.includes('/tickets/stats')) {
        body = { by_status: { open: 2, in_progress: 0, waiting_for_customer: 0, resolved: 0, closed: 0 }, by_priority: { low: 0, medium: 0, high: 2, urgent: 0 }, total: 2 };
      } else if (url.includes('/tickets')) {
        body = {
          tickets: [
            { id: 't1', workspace_id: 'ws-1', customer_id: null, conversation_id: null, subject: 'Billing question', description: null, category: 'billing', priority: 'high', status: 'open', assigned_to: USER_1, created_by: USER_1, created_at: '2026-11-14T10:00:00.000Z', updated_at: '2026-11-14T10:00:00.000Z', resolved_at: null },
            { id: 't2', workspace_id: 'ws-1', customer_id: null, conversation_id: null, subject: 'No assignee yet', description: null, category: 'general', priority: 'high', status: 'open', assigned_to: null, created_by: USER_1, created_at: '2026-11-14T10:00:00.000Z', updated_at: '2026-11-14T10:00:00.000Z', resolved_at: null },
          ],
          total: 2, page: 1, pageSize: 20,
        };
      } else if (url.includes('/members')) {
        body = { members: membersWithProfiles };
      }
      return { ok: true, json: async () => body };
    });
    vi.stubGlobal('fetch', fetchMock);
    withProviders(
      <Routes><Route path="/tickets" element={<Tickets />} /></Routes>,
      '/tickets',
    );
    expect(await screen.findByText('Billing question')).toBeInTheDocument();
    expect(screen.getByText('Alice Owner')).toBeInTheDocument();
    // 'Unassigned' appears twice: the assignee filter option and the ticket's cell.
    expect(screen.getAllByText('Unassigned')).toHaveLength(2);
    // The assignee filter also offers names, not UUID prefixes.
    expect(screen.getByRole('option', { name: 'Alice Owner (owner)' })).toBeInTheDocument();
    expect(document.body.textContent).not.toContain(USER_1);
    expect(document.body.textContent).not.toContain('11111111');
  });
});

describe('Ticket detail assignee (Issue 2)', () => {
  it('shows the assignee display name with role, not the UUID', async () => {
    const fetchMock = vi.fn(async (url: string) => {
      let body: any = {};
      if (url.includes('/tickets/t1/events')) {
        body = { events: [], total: 0, page: 1, pageSize: 20 };
      } else if (url.includes('/tickets/t1')) {
        body = {
          ticket: { id: 't1', workspace_id: 'ws-1', customer_id: null, conversation_id: null, subject: 'Billing question', description: 'Charged twice', category: 'billing', priority: 'high', status: 'open', assigned_to: USER_1, created_by: USER_1, created_at: '2026-11-14T10:00:00.000Z', updated_at: '2026-11-14T10:00:00.000Z', resolved_at: null },
          customer: null,
          conversation: null,
          assigned_member: { id: 'mem-1', workspace_id: 'ws-1', user_id: USER_1, role: 'owner', created_at: '2026-01-01T00:00:00.000Z' },
        };
      } else if (url.includes('/members')) {
        body = { members: membersWithProfiles };
      }
      return { ok: true, json: async () => body };
    });
    vi.stubGlobal('fetch', fetchMock);
    withProviders(
      <Routes><Route path="/tickets/:ticketId" element={<TicketDetailPage />} /></Routes>,
      '/tickets/t1',
    );
    expect(await screen.findByText('Billing question')).toBeInTheDocument();
    expect(screen.getByText('Assigned to: Alice Owner (owner)')).toBeInTheDocument();
    expect(document.body.textContent).not.toContain(USER_1);
    expect(document.body.textContent).not.toContain('11111111');
  });

  it('falls back to "Unnamed member" when the assignee has no profile name', async () => {
    const fetchMock = vi.fn(async (url: string) => {
      let body: any = {};
      if (url.includes('/tickets/t1/events')) {
        body = { events: [], total: 0, page: 1, pageSize: 20 };
      } else if (url.includes('/tickets/t1')) {
        body = {
          ticket: { id: 't1', workspace_id: 'ws-1', customer_id: null, conversation_id: null, subject: 'Mystery ticket', description: null, category: 'general', priority: 'low', status: 'open', assigned_to: USER_3, created_by: USER_1, created_at: '2026-11-14T10:00:00.000Z', updated_at: '2026-11-14T10:00:00.000Z', resolved_at: null },
          customer: null,
          conversation: null,
          assigned_member: { id: 'mem-3', workspace_id: 'ws-1', user_id: USER_3, role: 'member', created_at: '2026-01-01T00:00:00.000Z' },
        };
      } else if (url.includes('/members')) {
        body = { members: membersWithProfiles };
      }
      return { ok: true, json: async () => body };
    });
    vi.stubGlobal('fetch', fetchMock);
    withProviders(
      <Routes><Route path="/tickets/:ticketId" element={<TicketDetailPage />} /></Routes>,
      '/tickets/t1',
    );
    expect(await screen.findByText('Mystery ticket')).toBeInTheDocument();
    expect(screen.getByText('Assigned to: Unnamed member (member)')).toBeInTheDocument();
    expect(document.body.textContent).not.toContain(USER_3);
  });
});
