/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { WorkspaceContext } from '../context/WorkspaceContext';
import { ToastProvider } from '../components/Toast';
import WidgetDemo from '../pages/WidgetDemo';

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
  status: 'ready',
  error: null,
  refetchWorkspaces: () => {},
};

function testClient() {
  return new QueryClient({ defaultOptions: { queries: { retry: false } } });
}

function withProviders(ui: React.ReactElement) {
  return render(
    <QueryClientProvider client={testClient()}>
      <WorkspaceContext.Provider value={workspaceValue as any}>
        <ToastProvider>
          <MemoryRouter>{ui}</MemoryRouter>
        </ToastProvider>
      </WorkspaceContext.Provider>
    </QueryClientProvider>,
  );
}

function settingsPayload(allowedOrigins: string[]) {
  return {
    widget_settings: {
      id: 'ws-1', workspace_id: 'ws-1', public_key: 'wgt_0123456789abcdef0123456789abcdef',
      business_name: 'Acme Support', welcome_message: 'Hi! How can we help?', primary_color: '#7C3AED',
      enabled: true, allowed_origins: allowedOrigins,
      created_at: '2026-01-01T00:00:00.000Z', updated_at: '2026-01-01T00:00:00.000Z',
    },
  };
}

beforeEach(() => {
  window.localStorage.clear();
  window.history.pushState({}, '', '/');
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('Widget demo allowed origins display (Phase 2.1 fix)', () => {
  it('with an empty stored allow-list shows the empty state and no example origins', async () => {
    const fetchMock = vi.fn(async (url: string) => {
      if (url.includes('/widget-settings')) return { ok: true, json: async () => settingsPayload([]) };
      return { ok: true, json: async () => ({}) };
    });
    vi.stubGlobal('fetch', fetchMock);
    withProviders(<WidgetDemo />);

    expect(await screen.findByText(/No origins configured/)).toBeInTheDocument();
    // The origins field is empty and its placeholder is not an origin.
    const textarea = screen.getByLabelText(/Allowed origins/i) as HTMLTextAreaElement;
    expect(textarea.value).toBe('');
    expect(textarea.placeholder).toBe('One origin per line');
    // Example origins must never appear as if configured.
    expect(document.body.textContent).not.toContain('https://example.com');
    expect(document.body.textContent).not.toContain('https://shop.example.com');
    // The enforcement note stays.
    expect(screen.getByText(/Enforced server-side since Phase 2.1/)).toBeInTheDocument();
  });

  it('with stored origins shows the actual stored list', async () => {
    const fetchMock = vi.fn(async (url: string) => {
      if (url.includes('/widget-settings')) return { ok: true, json: async () => settingsPayload(['https://example.com', 'https://shop.example.com']) };
      return { ok: true, json: async () => ({}) };
    });
    vi.stubGlobal('fetch', fetchMock);
    withProviders(<WidgetDemo />);

    const textarea = await screen.findByLabelText(/Allowed origins/i) as HTMLTextAreaElement;
    expect(textarea.value).toBe('https://example.com\nhttps://shop.example.com');
    expect(screen.queryByText(/No origins configured/)).not.toBeInTheDocument();
  });
});
