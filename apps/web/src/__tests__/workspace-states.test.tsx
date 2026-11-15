/* Phase 2.1, Issue 1 — workspace loading states.
 * The "No workspace yet" empty state must only appear after the workspace
 * request succeeded and confirmed zero workspaces. While loading (or on
 * error) pages must show a skeleton / error state instead. */
import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { WorkspaceContext, type WorkspaceStatus } from '../context/WorkspaceContext';
import Team from '../pages/Team';

function wsValue(status: WorkspaceStatus) {
  return {
    workspaces: status === 'ready' ? [{ id: 'ws-1', name: 'Test WS', slug: 'test-ws', created_at: '2026-01-01T00:00:00.000Z' }] : [],
    workspaceId: status === 'ready' ? 'ws-1' : null,
    workspace:
      status === 'ready'
        ? { id: 'ws-1', name: 'Test WS', slug: 'test-ws', created_at: '2026-01-01T00:00:00.000Z' }
        : null,
    setWorkspaceId: () => {},
    loading: status === 'auth-loading' || status === 'loading',
    status,
    error: status === 'error' ? new Error('Network down') : null,
    refetchWorkspaces: () => {},
  };
}

function renderTeam(status: WorkspaceStatus) {
  render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <MemoryRouter>
        <WorkspaceContext.Provider value={wsValue(status)}>
          <Team />
        </WorkspaceContext.Provider>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe('workspace loading states (Issue 1)', () => {
  it('shows a loading skeleton, not the empty state, while auth is loading', () => {
    renderTeam('auth-loading');
    expect(screen.getByLabelText('Loading workspace')).toBeInTheDocument();
    expect(screen.queryByText('No workspace yet')).not.toBeInTheDocument();
  });

  it('shows a loading skeleton, not the empty state, while workspaces load', () => {
    renderTeam('loading');
    expect(screen.getByLabelText('Loading workspace')).toBeInTheDocument();
    expect(screen.queryByText('No workspace yet')).not.toBeInTheDocument();
  });

  it('shows an error/retry state, not the empty state, when the request fails', () => {
    renderTeam('error');
    expect(screen.getByText(/Couldn't load your workspace/)).toBeInTheDocument();
    expect(screen.getByText('Try again')).toBeInTheDocument();
    expect(screen.queryByText('No workspace yet')).not.toBeInTheDocument();
  });

  it('shows the genuine empty state only after a confirmed zero-workspace result', () => {
    renderTeam('empty');
    expect(screen.getByText('No workspace yet')).toBeInTheDocument();
    expect(screen.queryByLabelText('Loading workspace')).not.toBeInTheDocument();
  });

  it('renders the page content once a workspace is ready', () => {
    renderTeam('ready');
    expect(screen.getByText('Team')).toBeInTheDocument();
    expect(screen.queryByText('No workspace yet')).not.toBeInTheDocument();
    expect(screen.queryByLabelText('Loading workspace')).not.toBeInTheDocument();
  });
});
