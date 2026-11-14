import { createContext, useContext, useEffect, useState, type ReactNode } from 'react';
import { useQuery } from '@tanstack/react-query';
import { api, type Workspace } from '../lib/api';
import { useAuth } from './AuthContext';

export const WORKSPACE_STORAGE_KEY = 'supportflow.workspaceId';

interface WorkspaceValue {
  workspaces: Workspace[];
  workspaceId: string | null;
  workspace: Workspace | null;
  setWorkspaceId: (id: string) => void;
  loading: boolean;
}

const defaultValue: WorkspaceValue = {
  workspaces: [],
  workspaceId: null,
  workspace: null,
  setWorkspaceId: () => {},
  loading: false,
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
  const { data, isLoading } = useQuery({
    queryKey: ['workspaces'],
    queryFn: api.listWorkspaces,
    enabled: !!user && !authLoading,
    staleTime: 60_000,
  });
  const workspaces = data?.workspaces ?? [];

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
  return (
    <WorkspaceContext.Provider
      value={{ workspaces, workspaceId: workspace?.id ?? null, workspace, setWorkspaceId, loading: isLoading || authLoading }}
    >
      {children}
    </WorkspaceContext.Provider>
  );
}

export function useWorkspace() {
  return useContext(WorkspaceContext);
}
