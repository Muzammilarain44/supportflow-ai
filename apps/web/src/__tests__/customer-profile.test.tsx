/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { WorkspaceContext } from '../context/WorkspaceContext';
import { ToastProvider } from '../components/Toast';
import { CustomerDetailPage } from '../pages/Customers';

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

function detailPayload(overrides: Record<string, any> = {}) {
  return {
    customer: {
      id: 'c1', workspace_id: 'ws-1', full_name: 'Activity Customer', email: 'activity@example.com',
      phone: '+92 300 1112222', tags: [], notes: 'Patch test note',
      created_at: '2026-11-15T03:06:56.041917+00:00', updated_at: '2026-11-15T03:07:27.691582+00:00',
      last_activity_at: '2026-11-15T04:15:00.000Z',
    },
    tickets: { total: 1 },
    conversations: { total: 1 },
    recent_conversations: [
      {
        id: 'conv1', status: 'open', priority: 'medium', last_message_at: '2026-11-15T03:07:21.269+00:00',
        created_at: '2026-11-15T03:07:02.334821+00:00',
        last_message: { body: 'Hello, agent reply here.', created_at: '2026-11-15T03:07:21.148058+00:00' },
      },
    ],
    recent_tickets: [
      {
        id: 't1', workspace_id: 'ws-1', customer_id: 'c1', conversation_id: 'conv1', subject: 'Printer not working',
        description: null, category: 'technical', priority: 'high', status: 'resolved', assigned_to: USER_1,
        created_by: USER_1, created_at: '2026-11-15T03:07:00.000Z', updated_at: '2026-11-15T03:07:30.000Z',
        resolved_at: '2026-11-15T03:07:30.000Z',
      },
    ],
    ...overrides,
  };
}

describe('Customer profile page (Phase 2.1 fix)', () => {
  it('shows Last activity and lists the conversation + ticket from the detail response', async () => {
    const seenUrls: string[] = [];
    const fetchMock = vi.fn(async (url: string) => {
      seenUrls.push(url);
      return { ok: true, json: async () => detailPayload() };
    });
    vi.stubGlobal('fetch', fetchMock);
    withProviders(
      <Routes><Route path="/customers/:customerId" element={<CustomerDetailPage />} /></Routes>,
      '/customers/c1',
    );

    expect(await screen.findByText('Activity Customer')).toBeInTheDocument();
    // Last activity is rendered from the customer's last_activity_at.
    const expectedActivity = new Date('2026-11-15T04:15:00.000Z').toLocaleString(undefined, {
      month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit',
    });
    expect(screen.getByText('Last activity')).toBeInTheDocument();
    expect(screen.getByText(expectedActivity)).toBeInTheDocument();
    expect(screen.queryByText('No activity yet')).not.toBeInTheDocument();
    // Histories come from the detail response, not from separate list fetches.
    // (The conversation row renders "open · <last message>" in one link, so
    // match the message text as a substring.)
    expect(screen.getByText(/Hello, agent reply here\./)).toBeInTheDocument();
    expect(screen.getByText('Printer not working')).toBeInTheDocument();
    expect(screen.queryByText('No conversations yet.')).not.toBeInTheDocument();
    expect(screen.queryByText('No tickets for this customer yet.')).not.toBeInTheDocument();
    expect(seenUrls.some((u) => u.includes('/tickets?'))).toBe(false);
    expect(seenUrls.some((u) => u.includes('/conversations?'))).toBe(false);
  });

  it('shows "No activity yet" when the customer has no activity', async () => {
    const fetchMock = vi.fn(async () => ({
      ok: true,
      json: async () => detailPayload({
        customer: { ...detailPayload().customer, last_activity_at: null },
        tickets: { total: 0 },
        conversations: { total: 0 },
        recent_conversations: [],
        recent_tickets: [],
      }),
    }));
    vi.stubGlobal('fetch', fetchMock);
    withProviders(
      <Routes><Route path="/customers/:customerId" element={<CustomerDetailPage />} /></Routes>,
      '/customers/c1',
    );
    expect(await screen.findByText('Activity Customer')).toBeInTheDocument();
    expect(screen.getByText('No activity yet')).toBeInTheDocument();
    expect(screen.getByText('No conversations yet.')).toBeInTheDocument();
    expect(screen.getByText('No tickets for this customer yet.')).toBeInTheDocument();
  });
});
