import { supabase } from './supabase';
const API_URL = (import.meta.env.VITE_API_URL as string | undefined) ?? 'http://localhost:4000';
async function authHeaders(): Promise<Record<string, string>> {
  const { data } = await supabase.auth.getSession();
  const token = data.session?.access_token;
  return token ? { Authorization: `Bearer ${token}` } : {};
}
export async function apiFetch(path: string, init: RequestInit = {}) {
  const res = await fetch(`${API_URL}${path}`, { ...init, headers: { 'Content-Type': 'application/json', ...(await authHeaders()), ...(init.headers ?? {}) } });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error((body as { error?: string }).error ?? `Request failed (${res.status})`);
  return body;
}
export const api = {
  listWorkspaces: () => apiFetch('/api/workspaces'),
  createWorkspace: (payload: { name: string; slug: string; description?: string | null }) =>
    apiFetch('/api/workspaces', { method: 'POST', body: JSON.stringify(payload) }),
  getWorkspace: (id: string) => apiFetch(`/api/workspaces/${id}`),
};
