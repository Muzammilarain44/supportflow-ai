import { createContext, useContext, useEffect, useState, type ReactNode } from 'react';
import { useQuery } from '@tanstack/react-query';
import { api, type Workspace } from '../lib/api';
import { useAuth } from './AuthContext';

export const WORKSPACE_STORAGE_KEY = 'supportflow.workspaceId';

/**
 * Explicit workspace initialization states (Phase 2.1, Issue 1).
 * The old code only exposed `workspaceId: string | null`, so pages could not
 * tell "still loading" apart from "confirmed no workspace" — direct
 * navigation briefly rendered the "No workspace yet" empty state while the
 * request was still in flight.
 *  - 'auth-loading': Supabase session still resolving.
 *  - 'loading': workspace list request in flight.
 *  - 'ready': at least one workspace loaded and one selected.
 *  - 'empty': request succeeded and the user genuinely has no workspace.
 *  - 'error': the workspace request failed (never render the empty state).
 */
export type WorkspaceStatus = 'auth-loading' | 'loading' | 'ready' | 'empty' | 'error';

interface WorkspaceValue {
  workspaces: Workspace[];
  workspaceId: string | null;
  workspace: Workspace | null;
  setWorkspaceId: (id: string) => void;
  loading: boolean;
  status: WorkspaceStatus;
  error: Error | null;
  refetchWorkspaces: () => void;
}

const defaultValue: WorkspaceValue = {
  workspaces: [],
  workspaceId: null,
  workspace: null,
  setWorkspaceId: () => {},
  loading: false,
  status: 'auth-loading',
  error: null,
  refetchWorkspaces: () => {},
};

const WorkspaceContext = createContext<WorkspaceValue>(defaultValue);
export { WorkspaceContext };

export function WorkspaceProvider({ children }: { children: ReactNode }) {
  const { user, loading: authLoading } = useAuth();
  const [selectedId, setSelectedId] = useState<string | null>(() => {
    try {
      return localStorage.getItem(WORKSPACE_STORAGE_KEY);
    } catch {
      return null;
    }
  });
  const { data, isLoading, isError, error, refetch } = useQuery({
    queryKey: ['workspaces'],
    queryFn: api.listWorkspaces,
    enabled: !!user && !authLoading,
    staleTime: 60_000,
  });
  // Never expose a previous user's cached workspaces after logout / user
  // switch: the list is only trusted while a user is signed in.
  const workspaces = user ? (data?.workspaces ?? []) : [];

  // Logout (or user switch) clears the workspace selection so the next
  // session never starts from a stale stored id.
  useEffect(() => {
    if (!user && !authLoading) {
      setSelectedId(null);
      try {
        localStorage.removeItem(WORKSPACE_STORAGE_KEY);
      } catch {
        /* storage unavailable — in-memory state is already cleared */
      }
    }
  }, [user, authLoading]);

  // Default to the first workspace; drop a stale stored id that no longer belongs to the user.
  useEffect(() => {
    if (isLoading || workspaces.length === 0) return;
    if (!selectedId || !workspaces.some((w) => w.id === selectedId)) {
      const first = workspaces[0].id;
      setSelectedId(first);
      try {
        localStorage.setItem(WORKSPACE_STORAGE_KEY, first);
      } catch {
        /* storage unavailable — selection still works for this session */
      }
    }
  }, [isLoading, workspaces, selectedId]);

  const setWorkspaceId = (id: string) => {
    setSelectedId(id);
    try {
      localStorage.setItem(WORKSPACE_STORAGE_KEY, id);
    } catch {
      /* ignore */
    }
  };

  const workspace = workspaces.find((w) => w.id === selectedId) ?? null;

  // Explicit status: the empty state is only ever reached after a
  // successful request confirmed zero workspaces.
  let status: WorkspaceStatus;
  if (authLoading || !user) {
    status = 'auth-loading';
  } else if (isLoading) {
    status = 'loading';
  } else if (isError) {
    status = 'error';
  } else if (workspaces.length === 0) {
    status = 'empty';
  } else if (!workspace) {
    // Workspaces arrived but the default selection has not been applied yet
    // (the selection effect runs after render) — still loading, not empty.
    status = 'loading';
  } else {
    status = 'ready';
  }

  return (
    <WorkspaceContext.Provider
      value={{
        workspaces,
        workspaceId: workspace?.id ?? null,
        workspace,
        setWorkspaceId,
        loading: status === 'auth-loading' || status === 'loading',
        status,
        error: (error as Error | null) ?? null,
        refetchWorkspaces: () => {
          void refetch();
        },
      }}
    >
      {children}
    </WorkspaceContext.Provider>
  );
}

export function useWorkspace() {
  return useContext(WorkspaceContext);
}
