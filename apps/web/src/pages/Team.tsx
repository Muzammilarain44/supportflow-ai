import { useQuery } from '@tanstack/react-query';
import { api } from '../lib/api';
import { useWorkspace } from '../context/WorkspaceContext';
import { EmptyState, NoWorkspaceState, RoleBadge, Skeleton } from '../components/ui';

function formatTime(iso: string): string {
  return new Date(iso).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
}

export default function Team() {
  const { workspaceId, workspace } = useWorkspace();
  const membersQ = useQuery({
    queryKey: ['members', workspaceId],
    queryFn: () => api.listMembers(workspaceId!),
    enabled: !!workspaceId,
  });
  const members = membersQ.data?.members ?? [];

  if (!workspaceId) return <NoWorkspaceState />;

  return (
    <div className="space-y-4">
      <h1 className="text-2xl font-bold text-white">Team</h1>
      <p className="text-sm text-slate-400">
        Members of {workspace?.name ?? 'this workspace'} — fetched from the real member list.
      </p>
      <div className="rounded-xl border border-warning/50 bg-warning/10 p-4 text-sm text-amber-200" role="note">
        Invitations are not supported yet — members join by creating a workspace or being added by an owner in a later phase.
      </div>
      {membersQ.isLoading ? (
        <div className="space-y-2">{[0, 1].map((i) => <Skeleton key={i} className="h-14" />)}</div>
      ) : membersQ.isError ? (
        <p className="rounded-xl border border-danger/50 bg-danger/10 p-4 text-sm text-red-300" role="alert">
          Could not load members: {(membersQ.error as Error).message}
        </p>
      ) : members.length === 0 ? (
        <EmptyState title="No members" description="This workspace has no members listed." />
      ) : (
        <div className="overflow-x-auto rounded-xl border border-slate-700/60 bg-card">
          <table className="w-full min-w-[520px] text-left text-sm">
            <thead>
              <tr className="border-b border-slate-700/60 text-slate-400">
                <th className="px-4 py-3 font-medium">User ID</th>
                <th className="px-4 py-3 font-medium">Role</th>
                <th className="px-4 py-3 font-medium">Member since</th>
              </tr>
            </thead>
            <tbody>
              {members.map((m) => (
                <tr key={m.id} className="border-b border-slate-800">
                  <td className="px-4 py-3 font-mono text-xs text-slate-200">{m.user_id}</td>
                  <td className="px-4 py-3"><RoleBadge role={m.role} /></td>
                  <td className="px-4 py-3 text-slate-400">{formatTime(m.created_at)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
