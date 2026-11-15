/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { WorkspaceContext } from '../context/WorkspaceContext';
import { ToastProvider } from '../components/Toast';
import Dashboard from '../pages/Dashboard';
import Inbox from '../pages/Inbox';
import Tickets, { TicketDetailPage } from '../pages/Tickets';
import Knowledge from '../pages/Knowledge';
import AISettings from '../pages/AISettings';
import Automations from '../pages/Automations';

vi.mock('../lib/supabase', () => ({
  supabase: {
    auth: { getSession: async () => ({ data: { session: null } }) },
    channel: () => ({ on: () => ({ subscribe: () => ({}) }) }),
    removeChannel: async () => {},
  },
}));

vi.mock('../context/AuthContext', () => ({
  useAuth: () => ({ user: { id: 'u1', email: 'u1@example.com' }, session: null, loading: false }),
}));

const workspaceValue = {
  workspaces: [{ id: 'ws-1', name: 'Acme', slug: 'acme', description: null, owner_id: 'u1', created_at: '2026-01-01', updated_at: '2026-01-01' }],
  workspaceId: 'ws-1',
  workspace: { id: 'ws-1', name: 'Acme', slug: 'acme', description: null, owner_id: 'u1', created_at: '2026-01-01', updated_at: '2026-01-01' },
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

const okJson = (body: any) => ({ ok: true, json: async () => body });

describe('Knowledge page', () => {
  it('renders the document list with kind and indexing status', async () => {
    const fetchMock = vi.fn(async (url: string) => {
      if (url.includes('/knowledge')) {
        return okJson({
          knowledge_documents: [
            {
              id: 'k1', workspace_id: 'ws-1', title: 'Refund policy', content: 'Refunds within 30 days.',
              kind: 'article', enabled: true, archived: false, created_by: 'u1',
              created_at: '2026-11-14T10:00:00.000Z', updated_at: '2026-11-14T10:00:00.000Z',
              latest_job_status: 'completed',
            },
            {
              id: 'k2', workspace_id: 'ws-1', title: 'How do I reset my password?', content: 'Use the reset link.',
              kind: 'faq', enabled: false, archived: false, created_by: 'u1',
              created_at: '2026-11-14T10:00:00.000Z', updated_at: '2026-11-14T10:00:00.000Z',
            },
          ],
          total: 2, page: 1, pageSize: 20,
        });
      }
      return okJson({});
    });
    vi.stubGlobal('fetch', fetchMock);
    withProviders(<Knowledge />);
    expect(await screen.findByText('Refund policy')).toBeInTheDocument();
    expect(screen.getByText('How do I reset my password?')).toBeInTheDocument();
    expect(screen.getByText('Indexed')).toBeInTheDocument();
    expect(screen.getByPlaceholderText('Search by title…')).toBeInTheDocument();
  });

  it('shows the empty state when there are no documents', async () => {
    const fetchMock = vi.fn(async () => okJson({ knowledge_documents: [], total: 0, page: 1, pageSize: 20 }));
    vi.stubGlobal('fetch', fetchMock);
    withProviders(<Knowledge />);
    expect(await screen.findByText('No knowledge articles yet')).toBeInTheDocument();
  });
});

describe('AI settings page', () => {
  const settingsBody = {
    ai_settings: {
      id: 'ai-1', workspace_id: 'ws-1', enabled: true, mode: 'suggestion',
      provider_order: ['groq', 'gemini'], auto_reply_require_grounding: true,
      escalation_on_low_confidence: true,
      created_at: '2026-11-14T10:00:00.000Z', updated_at: '2026-11-14T10:00:00.000Z',
    },
  };
  const membersBody = {
    members: [{ id: 'm1', workspace_id: 'ws-1', user_id: 'u1', role: 'owner', display_name: 'Owner', avatar_url: null, initials: 'O', member_since: '2026-01-01', created_at: '2026-01-01', updated_at: '2026-01-01' }],
  };

  it('shows all response modes and never renders an API key field', async () => {
    const fetchMock = vi.fn(async (url: string) => {
      if (url.includes('/ai-settings')) return okJson(settingsBody);
      if (url.includes('/members')) return okJson(membersBody);
      return okJson({});
    });
    vi.stubGlobal('fetch', fetchMock);
    const { container } = withProviders(<AISettings />);
    expect(await screen.findByText('Disabled')).toBeInTheDocument();
    expect(screen.getByText('Suggestion Only')).toBeInTheDocument();
    expect(screen.getByText('Automatic Reply')).toBeInTheDocument();
    expect(screen.getByText('Human Only')).toBeInTheDocument();
    expect(screen.getByText(/Groq.*Gemini/)).toBeInTheDocument();
    // No secrets anywhere on the page: no key input, no password field.
    expect(screen.queryByLabelText(/key/i)).toBeNull();
    expect(container.querySelector('input[type="password"]')).toBeNull();
    expect(container.querySelector('input[name*="key" i]')).toBeNull();
  });

  it('shows the automatic-reply warning when Automatic Reply is selected', async () => {
    const fetchMock = vi.fn(async (url: string) => {
      if (url.includes('/ai-settings')) return okJson(settingsBody);
      if (url.includes('/members')) return okJson(membersBody);
      return okJson({});
    });
    vi.stubGlobal('fetch', fetchMock);
    withProviders(<AISettings />);
    await screen.findByText('Automatic Reply');
    fireEvent.click(screen.getByText('Automatic Reply'));
    expect(await screen.findByText(/Automatic replies send AI messages to customers/)).toBeInTheDocument();
  });
});

describe('Automations page', () => {
  it('shows real automation counts and failed executions', async () => {
    const fetchMock = vi.fn(async (url: string) => {
      if (url.includes('/ai-overview')) {
        return okJson({
          ai_enabled: true, mode: 'auto',
          automation: { pending: 2, processing: 1, failed: 3, dead: 0, last_processed_at: '2026-11-14T10:00:00.000Z' },
          totals: { assisted_conversations: 4, suggestions: 5, auto_replies: 6, handoffs: 1, failed_executions: 2 },
        });
      }
      if (url.includes('/automation-events')) {
        return okJson({
          automation_events: [{
            id: 'ev-1', workspace_id: 'ws-1', event_type: 'ticket.created', entity_type: 'ticket',
            entity_id: 't-12345678', status: 'completed', attempts: 1,
            created_at: '2026-11-14T10:00:00.000Z', processed_at: '2026-11-14T10:01:00.000Z',
          }],
          total: 1, page: 1, pageSize: 20,
        });
      }
      if (url.includes('/ai-executions')) {
        return okJson({
          ai_executions: [{
            id: 'ex-1', workspace_id: 'ws-1', conversation_id: 'c1', message_id: 'm1', event_id: null,
            provider: 'groq', model: 'openai/gpt-oss-20b', mode: 'auto', status: 'failed',
            prompt_tokens: 100, completion_tokens: 0, latency_ms: 2500, error: 'Provider timeout', suggestion: null,
            created_at: '2026-11-14T10:00:00.000Z',
          }],
          total: 1, page: 1, pageSize: 50,
        });
      }
      return okJson({});
    });
    vi.stubGlobal('fetch', fetchMock);
    withProviders(<Automations />);
    expect(await screen.findByText('Automation Activity')).toBeInTheDocument();
    expect(await screen.findByText('Pending')).toBeInTheDocument();
    expect(screen.getByText('ticket.created')).toBeInTheDocument();
    expect(screen.getByText('Provider timeout')).toBeInTheDocument();
    expect(screen.getByText('groq · openai/gpt-oss-20b')).toBeInTheDocument();
  });

  it('shows empty states when there is no automation activity', async () => {
    const fetchMock = vi.fn(async (url: string) => {
      if (url.includes('/ai-overview')) {
        return okJson({
          ai_enabled: false, mode: 'disabled',
          automation: { pending: 0, processing: 0, failed: 0, dead: 0, last_processed_at: null },
          totals: { assisted_conversations: 0, suggestions: 0, auto_replies: 0, handoffs: 0, failed_executions: 0 },
        });
      }
      if (url.includes('/automation-events')) return okJson({ automation_events: [], total: 0, page: 1, pageSize: 20 });
      if (url.includes('/ai-executions')) return okJson({ ai_executions: [], total: 0, page: 1, pageSize: 50 });
      return okJson({});
    });
    vi.stubGlobal('fetch', fetchMock);
    withProviders(<Automations />);
    expect(await screen.findByText('No automation events yet')).toBeInTheDocument();
    expect(screen.getByText('No failed or escalated AI executions.')).toBeInTheDocument();
  });
});

describe('Inbox AI suggestion panel', () => {
  const conversationBody = {
    conversation: {
      id: 'c1', workspace_id: 'ws-1', customer_id: 'cust-1', status: 'open', priority: 'medium',
      assigned_to: null, tags: [], ai_paused: false, handoff_reason: null, handed_off_at: null,
      created_at: '2026-11-14T10:00:00.000Z', updated_at: '2026-11-14T10:00:00.000Z', last_message_at: '2026-11-14T10:05:00.000Z',
    },
    customer: { id: 'cust-1', full_name: 'Alice Example', email: 'alice@example.com', phone: null, tags: [] },
    assigned_member: null,
  };
  const listBody = {
    conversations: [{
      id: 'c1', workspace_id: 'ws-1', customer_id: 'cust-1', status: 'open', priority: 'high',
      assigned_to: null, tags: [], created_at: '2026-11-14T10:00:00.000Z', updated_at: '2026-11-14T10:00:00.000Z',
      last_message_at: '2026-11-14T10:05:00.000Z',
      customer: { id: 'cust-1', full_name: 'Alice Example', email: 'alice@example.com' },
      last_message: { body: 'Hi, I need help', created_at: '2026-11-14T10:05:00.000Z' },
      unread_count: 0,
    }],
    total: 1, page: 1, pageSize: 20,
  };
  const messagesBody = {
    messages: [{
      id: 'm1', workspace_id: 'ws-1', conversation_id: 'c1', customer_id: 'cust-1',
      sender_type: 'customer', sender_id: null, body: 'Hi, I need help',
      client_message_id: null, created_at: '2026-11-14T10:05:00.000Z', read_at: null,
    }],
    total: 1, page: 1, pageSize: 100,
  };

  function inboxFetchMock() {
    let suggestionStatus = 'pending';
    const calls: string[] = [];
    const fetchMock = vi.fn(async (url: string, init?: any) => {
      calls.push(`${init?.method ?? 'GET'} ${url} ${init?.body ?? ''}`);
      if (url.includes('/suggestions/s1/accept')) {
        suggestionStatus = 'accepted';
        return okJson({ ai_suggestion: { id: 's1', status: 'accepted' } });
      }
      if (url.includes('/suggestions/s1/reject')) {
        suggestionStatus = 'rejected';
        return okJson({ ai_suggestion: { id: 's1', status: 'rejected' } });
      }
      if (url.includes('/suggestions')) {
        return okJson({
          ai_suggestions: suggestionStatus === 'pending' ? [{
            id: 's1', workspace_id: 'ws-1', conversation_id: 'c1', message_id: 'm1',
            suggestion: 'Try restarting the router and checking the cable.',
            sources: [{ title: 'Router troubleshooting' }],
            status: 'pending', reviewed_by: null,
            created_at: '2026-11-14T10:06:00.000Z', updated_at: '2026-11-14T10:06:00.000Z',
          }] : [],
          total: suggestionStatus === 'pending' ? 1 : 0, page: 1, pageSize: 20,
        });
      }
      if (url.includes('/ai-executions')) {
        return okJson({
          ai_executions: [{
            id: 'ex-1', workspace_id: 'ws-1', conversation_id: 'c1', message_id: 'm1', event_id: null,
            provider: 'groq', model: 'openai/gpt-oss-20b', mode: 'suggestion', status: 'success',
            prompt_tokens: 100, completion_tokens: 50, latency_ms: 1200, error: null, suggestion: 'Try restarting…',
            created_at: '2026-11-14T10:06:00.000Z',
          }],
          total: 1, page: 1, pageSize: 20,
        });
      }
      if (url.includes('/messages')) return okJson(messagesBody);
      if (url.includes('/read')) return okJson({ read_count: 0 });
      if (url.includes('/notes')) return okJson({ notes: [], total: 0, page: 1, pageSize: 20 });
      if (url.includes('/tickets')) return okJson({ tickets: [], total: 0, page: 1, pageSize: 100 });
      if (url.includes('/members')) return okJson({ members: [] });
      if (url.includes('/conversations/c1')) return okJson(conversationBody);
      if (url.includes('/conversations')) return okJson(listBody);
      return okJson({});
    });
    return { fetchMock, calls };
  }

  function renderInbox() {
    const { fetchMock, calls } = inboxFetchMock();
    vi.stubGlobal('fetch', fetchMock);
    withProviders(
      <Routes><Route path="/inbox/:conversationId" element={<Inbox />} /></Routes>,
      '/inbox/c1',
    );
    return { calls };
  }

  it('shows the pending suggestion with sources and accepts it', async () => {
    const { calls } = renderInbox();
    expect(await screen.findByText('AI suggestion')).toBeInTheDocument();
    expect(screen.getByText('Try restarting the router and checking the cable.')).toBeInTheDocument();
    expect(screen.getByText(/Sources: Router troubleshooting/)).toBeInTheDocument();
    expect(await screen.findByText(/groq · openai\/gpt-oss-20b · Success/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Accept' }));
    await waitFor(() => expect(screen.queryByText('Try restarting the router and checking the cable.')).toBeNull());
    expect(calls.some((c) => c.includes('POST') && c.includes('/suggestions/s1/accept'))).toBe(true);
  });

  it('edits a suggestion and sends the edited text', async () => {
    const { calls } = renderInbox();
    await screen.findByText('AI suggestion');
    fireEvent.click(screen.getByRole('button', { name: 'Edit' }));
    const textarea = screen.getByLabelText('Edit suggestion');
    expect((textarea as HTMLTextAreaElement).value).toBe('Try restarting the router and checking the cable.');
    fireEvent.change(textarea, { target: { value: 'Please restart the router first.' } });
    fireEvent.click(screen.getByRole('button', { name: 'Send edited suggestion' }));
    await waitFor(() => expect(calls.some((c) => c.includes('/suggestions/s1/accept') && c.includes('Please restart the router first.'))).toBe(true));
  });

  it('rejects a suggestion', async () => {
    const { calls } = renderInbox();
    await screen.findByText('AI suggestion');
    fireEvent.click(screen.getByRole('button', { name: 'Reject' }));
    await waitFor(() => expect(screen.queryByText('Try restarting the router and checking the cable.')).toBeNull());
    expect(calls.some((c) => c.includes('POST') && c.includes('/suggestions/s1/reject'))).toBe(true);
  });
});

describe('Tickets escalation display', () => {
  const escalatedTicket = {
    id: 't1', workspace_id: 'ws-1', customer_id: 'cust-1', conversation_id: 'c1',
    subject: 'Billing question', description: 'Charged twice', category: 'billing',
    priority: 'high', status: 'open', assigned_to: null, created_by: 'u1',
    created_at: '2026-11-14T10:00:00.000Z', updated_at: '2026-11-14T10:00:00.000Z', resolved_at: null,
    escalation_reason: 'Customer asked for a human', escalated_at: '2026-11-14T11:00:00.000Z',
  };

  it('shows the Escalated badge in the tickets list', async () => {
    const fetchMock = vi.fn(async (url: string) => {
      if (url.includes('/tickets/stats')) {
        return okJson({ by_status: { open: 1, in_progress: 0, waiting_for_customer: 0, resolved: 0, closed: 0 }, by_priority: { low: 0, medium: 0, high: 1, urgent: 0 }, total: 1 });
      }
      if (url.includes('/tickets')) return okJson({ tickets: [escalatedTicket], total: 1, page: 1, pageSize: 20 });
      if (url.includes('/members')) return okJson({ members: [] });
      return okJson({});
    });
    vi.stubGlobal('fetch', fetchMock);
    withProviders(
      <Routes><Route path="/tickets" element={<Tickets />} /></Routes>,
      '/tickets',
    );
    expect(await screen.findByText('Billing question')).toBeInTheDocument();
    expect(screen.getByText('Escalated')).toBeInTheDocument();
  });

  it('shows the escalation reason and conversation link on the ticket detail page', async () => {
    const fetchMock = vi.fn(async (url: string) => {
      if (url.includes('/tickets/t1/events')) return okJson({ events: [], total: 0, page: 1, pageSize: 20 });
      if (url.includes('/tickets/t1')) {
        return okJson({
          ticket: escalatedTicket, customer: null,
          conversation: { id: 'c1', status: 'open', priority: 'medium', customer_id: 'cust-1' },
          assigned_member: null,
        });
      }
      if (url.includes('/members')) return okJson({ members: [] });
      return okJson({});
    });
    vi.stubGlobal('fetch', fetchMock);
    withProviders(
      <Routes><Route path="/tickets/:ticketId" element={<TicketDetailPage />} /></Routes>,
      '/tickets/t1',
    );
    expect(await screen.findByText('Escalated: Customer asked for a human')).toBeInTheDocument();
    const link = screen.getByText('Open conversation');
    expect(link.closest('a')?.getAttribute('href')).toBe('/inbox/c1');
  });
});

describe('Dashboard AI overview', () => {
  it('renders real AI overview values', async () => {
    const fetchMock = vi.fn(async (url: string) => {
      if (url.includes('/ai-overview')) {
        return okJson({
          ai_enabled: true, mode: 'suggestion',
          automation: { pending: 2, processing: 0, failed: 1, dead: 0, last_processed_at: '2026-11-14T10:00:00.000Z' },
          totals: { assisted_conversations: 4, suggestions: 7, auto_replies: 3, handoffs: 2, failed_executions: 1 },
        });
      }
      if (url.includes('/tickets/stats')) {
        return okJson({ by_status: { open: 0, in_progress: 0, waiting_for_customer: 0, resolved: 0, closed: 0 }, by_priority: { low: 0, medium: 0, high: 0, urgent: 0 }, total: 0 });
      }
      if (url.includes('/customers')) return okJson({ customers: [], total: 0, page: 1, pageSize: 1 });
      if (url.includes('/conversations')) return okJson({ conversations: [], total: 0, page: 1, pageSize: 1 });
      if (url.includes('/tickets')) return okJson({ tickets: [], total: 0, page: 1, pageSize: 5 });
      return okJson({});
    });
    vi.stubGlobal('fetch', fetchMock);
    withProviders(<Dashboard />);
    expect(await screen.findByText('AI & Automation')).toBeInTheDocument();
    expect(await screen.findByText('Enabled')).toBeInTheDocument();
    expect(screen.getByText('AI-assisted conversations')).toBeInTheDocument();
    expect(screen.getByText('Handoffs')).toBeInTheDocument();
    expect(screen.getByText('Failed executions')).toBeInTheDocument();
  });
});
