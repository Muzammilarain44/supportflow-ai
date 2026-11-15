/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { WorkspaceContext } from '../context/WorkspaceContext';
import { ToastProvider } from '../components/Toast';
import WidgetEmbed, { getParentOrigin } from '../pages/WidgetEmbed';
import Customers from '../pages/Customers';
import { api } from '../lib/api';

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

describe('getParentOrigin (widget embed)', () => {
  it('extracts the origin from a full referrer URL', () => {
    expect(getParentOrigin('https://shop.example.com/products/1?x=2')).toBe('https://shop.example.com');
  });

  it('keeps a non-default port and lowercases the host', () => {
    expect(getParentOrigin('https://SHOP.example.com:8443/page')).toBe('https://shop.example.com:8443');
  });

  it('returns undefined for an empty referrer (direct navigation / stripped referrer)', () => {
    expect(getParentOrigin('')).toBeUndefined();
  });

  it('returns undefined for an unparsable referrer', () => {
    expect(getParentOrigin('not a url :::')).toBeUndefined();
  });
});

describe('widget api client sends parent_origin', () => {
  it('getWidgetConfig appends parent_origin to the query string', async () => {
    const fetchMock = vi.fn(async () => ({ ok: true, json: async () => ({ business_name: 'Acme', welcome_message: 'Hi', primary_color: '#7C3AED', enabled: true }) }));
    vi.stubGlobal('fetch', fetchMock);
    await api.getWidgetConfig('wgt_testkey', 'https://shop.example.com');
    const url = String(fetchMock.mock.calls[0][0]);
    expect(url).toContain('parent_origin=https%3A%2F%2Fshop.example.com');
    await api.getWidgetConfig('wgt_testkey');
    expect(String(fetchMock.mock.calls[1][0])).not.toContain('parent_origin');
  });

  it('createWidgetSession / sendWidgetMessage include parent_origin in the body; history in the query', async () => {
    const fetchMock = vi.fn(async (url: string) => {
      if (url.includes('/widget/history')) return { ok: true, json: async () => ({ messages: [] }) };
      return { ok: true, json: async () => ({ token: 't', message_id: 'm1' }) };
    });
    vi.stubGlobal('fetch', fetchMock);
    await api.createWidgetSession({ key: 'wgt_testkey', parent_origin: 'https://shop.example.com' });
    expect(JSON.parse(String(fetchMock.mock.calls[0][1].body)).parent_origin).toBe('https://shop.example.com');
    await api.sendWidgetMessage({ token: 't', body: 'hi', parent_origin: 'https://shop.example.com' });
    expect(JSON.parse(String(fetchMock.mock.calls[1][1].body)).parent_origin).toBe('https://shop.example.com');
    await api.getWidgetHistory('t', 'https://shop.example.com');
    expect(String(fetchMock.mock.calls[2][0])).toContain('parent_origin=https%3A%2F%2Fshop.example.com');
  });
});

describe('WidgetEmbed passes the embedding origin (mocked fetch)', () => {
  it('sends document.referrer origin as parent_origin on config and session calls', async () => {
    window.history.pushState({}, '', '/widget-embed?key=wgt_testkey1234567890abcdef');
    Object.defineProperty(window.document, 'referrer', {
      value: 'https://shop.example.com/landing-page',
      configurable: true,
    });
    const calls: Array<{ url: string; body?: string }> = [];
    const fetchMock = vi.fn(async (url: string, init?: any) => {
      calls.push({ url, body: init?.body as string | undefined });
      let body: any = {};
      if (url.includes('/widget/config')) {
        body = { business_name: 'Acme Support', welcome_message: 'Hi! How can we help?', primary_color: '#7C3AED', enabled: true };
      } else if (url.includes('/widget/sessions')) {
        body = { token: 'visitor-token-1', conversation_id: 'conv-1', customer_id: 'cust-1', expires_at: '2026-11-15T00:00:00.000Z' };
      } else if (url.includes('/widget/history')) {
        body = { messages: [] };
      }
      return { ok: true, json: async () => body };
    });
    vi.stubGlobal('fetch', fetchMock);

    render(<WidgetEmbed />);

    const openButton = await screen.findByRole('button', { name: /Open chat with Acme Support/ });
    const configCall = calls.find((c) => c.url.includes('/widget/config'));
    expect(configCall?.url).toContain('parent_origin=https%3A%2F%2Fshop.example.com');

    fireEvent.click(openButton);
    fireEvent.click(screen.getByRole('button', { name: 'Start chat' }));
    await waitFor(() => expect(screen.getByLabelText('Type your message')).toBeInTheDocument());
    const sessionCall = calls.find((c) => c.url.includes('/widget/sessions'));
    expect(JSON.parse(sessionCall?.body ?? '{}').parent_origin).toBe('https://shop.example.com');
  });
});

describe('Customers last-activity display (Issue 3)', () => {
  it('shows "No activity yet" when last_activity_at is null', async () => {
    const fetchMock = vi.fn(async (url: string) => {
      let body: any = {};
      if (url.includes('/customers')) {
        body = {
          customers: [
            { id: 'c1', workspace_id: 'ws-1', full_name: 'Quiet Bob', email: 'quiet@example.com', phone: null, tags: [], notes: null, created_at: '2026-11-01T00:00:00.000Z', updated_at: '2026-11-01T00:00:00.000Z', last_activity_at: null },
            { id: 'c2', workspace_id: 'ws-1', full_name: 'Active Alice', email: 'active@example.com', phone: null, tags: [], notes: null, created_at: '2026-11-01T00:00:00.000Z', updated_at: '2026-11-10T10:00:00.000Z', last_activity_at: '2026-11-10T10:00:00.000Z' },
          ],
          total: 2, page: 1, pageSize: 20,
        };
      }
      return { ok: true, json: async () => body };
    });
    vi.stubGlobal('fetch', fetchMock);
    withProviders(
      <Routes><Route path="/customers" element={<Customers />} /></Routes>,
      '/customers',
    );
    expect(await screen.findByText('Quiet Bob')).toBeInTheDocument();
    expect(screen.getByText('No activity yet')).toBeInTheDocument();
    expect(screen.queryByText('—')).not.toBeInTheDocument();
  });
});
