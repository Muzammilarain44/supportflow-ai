/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { WorkspaceContext, WORKSPACE_STORAGE_KEY } from '../context/WorkspaceContext';
import { ToastProvider } from '../components/Toast';
import { StatusBadge, PriorityBadge, Pagination } from '../components/ui';
import WidgetEmbed from '../pages/WidgetEmbed';
import Inbox from '../pages/Inbox';
import Tickets from '../pages/Tickets';

vi.mock('../lib/supabase', () => ({
  supabase: {
    auth: { getSession: async () => ({ data: { session: null } }) },
    channel: () => ({ on: () => ({ subscribe: () => ({}) }) }),
    removeChannel: async () => {},
  },
}));

const workspaceValue = {
  workspaces: [{ id: 'ws-1', name: 'Acme', slug: 'acme', description: null, owner_id: 'u1', created_at: '2026-01-01', updated_at: '2026-01-01' }],
  workspaceId: 'ws-1',
  workspace: { id: 'ws-1', name: 'Acme', slug: 'acme', description: null, owner_id: 'u1', created_at: '2026-01-01', updated_at: '2026-01-01' },
  setWorkspaceId: () => {},
  loading: false,
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

describe('status and priority badges', () => {
  it('renders ticket statuses with readable labels', () => {
    render(<><StatusBadge status="in_progress" /><StatusBadge status="resolved" /><PriorityBadge priority="urgent" /></>);
    expect(screen.getByText('in progress')).toBeInTheDocument();
    expect(screen.getByText('resolved')).toBeInTheDocument();
    expect(screen.getByText('urgent')).toBeInTheDocument();
  });
});

describe('pagination controls', () => {
  it('goes to the next page and disables Previous on page 1', async () => {
    const onPageChange = vi.fn();
    render(<Pagination page={1} pageSize={20} total={45} onPageChange={onPageChange} />);
    expect(screen.getByText('Page 1 of 3 — 45 results')).toBeInTheDocument();
    expect(screen.getByLabelText('Previous page')).toBeDisabled();
    fireEvent.click(screen.getByLabelText('Next page'));
    expect(onPageChange).toHaveBeenCalledWith(2);
  });
  it('disables Next on the last page', () => {
    render(<Pagination page={3} pageSize={20} total={45} onPageChange={() => {}} />);
    expect(screen.getByLabelText('Next page')).toBeDisabled();
  });
});

describe('inbox unread badge', () => {
  it('shows the unread count for a conversation with unread customer messages', async () => {
    const fetchMock = vi.fn(async (url: string) => {
      let body: any = {};
      if (url.includes('/conversations')) {
        body = {
          conversations: [{
            id: 'c1', workspace_id: 'ws-1', customer_id: 'cust-1', status: 'open', priority: 'high',
            assigned_to: null, tags: [], created_at: '2026-11-14T10:00:00.000Z', updated_at: '2026-11-14T10:00:00.000Z',
            last_message_at: '2026-11-14T10:05:00.000Z',
            customer: { id: 'cust-1', full_name: 'Alice Example', email: 'alice@example.com' },
            last_message: { body: 'Hi, I need help', created_at: '2026-11-14T10:05:00.000Z' },
            unread_count: 3,
          }],
          total: 1, page: 1, pageSize: 20,
        };
      } else if (url.includes('/members')) {
        body = { members: [] };
      }
      return { ok: true, json: async () => body };
    });
    vi.stubGlobal('fetch', fetchMock);
    withProviders(
      <Routes><Route path="/inbox" element={<Inbox />} /></Routes>,
      '/inbox',
    );
    expect(await screen.findByText('Alice Example')).toBeInTheDocument();
    expect(screen.getByLabelText('3 unread messages')).toBeInTheDocument();
    expect(screen.getByText('Hi, I need help')).toBeInTheDocument();
  });
});

describe('tickets list', () => {
  it('renders real tickets from the API with status and priority badges', async () => {
    const fetchMock = vi.fn(async (url: string) => {
      let body: any = {};
      if (url.includes('/tickets/stats')) {
        body = { by_status: { open: 1, in_progress: 0, waiting_for_customer: 0, resolved: 0, closed: 0 }, by_priority: { low: 0, medium: 0, high: 1, urgent: 0 }, total: 1 };
      } else if (url.includes('/tickets')) {
        body = {
          tickets: [{
            id: 't1', workspace_id: 'ws-1', customer_id: 'cust-1', conversation_id: null,
            subject: 'Billing question', description: 'Charged twice', category: 'billing',
            priority: 'high', status: 'open', assigned_to: null, created_by: 'u1',
            created_at: '2026-11-14T10:00:00.000Z', updated_at: '2026-11-14T10:00:00.000Z', resolved_at: null,
          }],
          total: 1, page: 1, pageSize: 20,
        };
      } else if (url.includes('/members')) {
        body = { members: [] };
      }
      return { ok: true, json: async () => body };
    });
    vi.stubGlobal('fetch', fetchMock);
    withProviders(
      <Routes><Route path="/tickets" element={<Tickets />} /></Routes>,
      '/tickets',
    );
    expect(await screen.findByText('Billing question')).toBeInTheDocument();
    // 'open' appears twice: the stats card and the ticket's status badge.
    expect(screen.getAllByText('open').length).toBeGreaterThanOrEqual(2);
    // 'high' appears twice: the priority filter option and the ticket's priority badge.
    expect(screen.getAllByText('high').length).toBeGreaterThanOrEqual(2);
  });
});

describe('widget embed send flow', () => {
  it('loads config, starts a visitor session, and sends a message (mocked fetch)', async () => {
    window.history.pushState({}, '', '/widget-embed?key=wgt_testkey1234567890abcdef');
    const historyMessages: Array<{ id: string; sender_type: string; body: string; created_at: string }> = [];
    const calls: string[] = [];
    const fetchMock = vi.fn(async (url: string, init?: any) => {
      calls.push(`${init?.method ?? 'GET'} ${url}`);
      let body: any = {};
      if (url.includes('/widget/config')) {
        body = { business_name: 'Acme Support', welcome_message: 'Hi! How can we help?', primary_color: '#7C3AED', enabled: true };
      } else if (url.includes('/widget/sessions')) {
        body = { token: 'visitor-token-1', conversation_id: 'conv-1', customer_id: 'cust-1', expires_at: '2026-11-15T00:00:00.000Z' };
      } else if (url.includes('/widget/history')) {
        body = { messages: historyMessages };
      } else if (url.includes('/widget/messages')) {
        const parsed = JSON.parse(init.body as string);
        historyMessages.push({ id: 'm1', sender_type: 'customer', body: parsed.body, created_at: '2026-11-14T11:00:00.000Z' });
        body = { message_id: 'm1' };
      }
      return { ok: true, json: async () => body };
    });
    vi.stubGlobal('fetch', fetchMock);

    render(<WidgetEmbed />);

    const openButton = await screen.findByRole('button', { name: /Open chat with Acme Support/ });
    fireEvent.click(openButton);
    expect(screen.getByText('Hi! How can we help?')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Start chat' }));
    await waitFor(() => expect(screen.getByLabelText('Type your message')).toBeInTheDocument());
    expect(window.localStorage.getItem(`${WORKSPACE_STORAGE_KEY}`)).toBeNull();
    expect(window.localStorage.getItem('supportflow.widget.wgt_testkey1234567890abcdef')).toBe('visitor-token-1');

    fireEvent.change(screen.getByLabelText('Type your message'), { target: { value: 'Hello widget' } });
    fireEvent.click(screen.getByRole('button', { name: 'Send message' }));
    await waitFor(() => expect(screen.getByText('Hello widget')).toBeInTheDocument());
    expect(calls.some((c) => c.includes('POST') && c.includes('/widget/messages'))).toBe(true);
  });

  it('shows an error when no widget key is in the URL', async () => {
    window.history.pushState({}, '', '/widget-embed');
    render(<WidgetEmbed />);
    expect(await screen.findByText(/No widget key provided/)).toBeInTheDocument();
  });
});
