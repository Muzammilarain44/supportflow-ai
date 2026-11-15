import { useQuery } from '@tanstack/react-query';
import { api, type MemberWithProfile } from '../lib/api';
import { useWorkspace } from '../context/WorkspaceContext';
import { EmptyState, NoWorkspaceState, RoleBadge, Skeleton, WorkspaceErrorState, WorkspaceLoadingSkeleton } from '../components/ui';

function formatTime(iso: string): string {
  return new Date(iso).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
}

/** Avatar initials: prefer the server-computed value, derive from the name as fallback. */
function initialsFor(m: MemberWithProfile): string {
  if (m.initials) return m.initials;
  const parts = (m.display_name ?? '').trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return '?';
  return parts.slice(0, 2).map((p) => p[0]!.toUpperCase()).join('');
}

export default function Team() {
  const { workspaceId, workspace, status: wsStatus, error: wsError, refetchWorkspaces } = useWorkspace();
  const membersQ = useQuery({
    queryKey: ['members', workspaceId],
    queryFn: () => api.listMembersWithProfiles(workspaceId!),
    enabled: !!workspaceId,
  });
  const members = membersQ.data?.members ?? [];

if (wsStatus === 'auth-loading' || wsStatus === 'loading') return <WorkspaceLoadingSkeleton />;
if (wsStatus === 'error') return <WorkspaceErrorState message={wsError?.message} onRetry={refetchWorkspaces} />;
if (wsStatus === 'empty' || !workspaceId) return <NoWorkspaceState />;

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
                <th className="px-4 py-3 font-medium">Member</th>
                <th className="px-4 py-3 font-medium">Role</th>
                <th className="px-4 py-3 font-medium">Member since</th>
              </tr>
            </thead>
            <tbody>
              {members.map((m) => (
                <tr key={m.id} className="border-b border-slate-800">
                  <td className="px-4 py-3">
                    <span className="flex items-center gap-3">
                      {m.avatar_url ? (
                        <img src={m.avatar_url} alt="" className="h-8 w-8 rounded-full object-cover" />
                      ) : (
                        <span className="flex h-8 w-8 items-center justify-center rounded-full bg-primary/20 text-xs font-bold text-purple-300" aria-hidden="true">
                          {initialsFor(m)}
                        </span>
                      )}
                      <span className="font-medium text-slate-200">{m.display_name}</span>
                    </span>
                  </td>
                  <td className="px-4 py-3"><RoleBadge role={m.role} /></td>
                  <td className="px-4 py-3 text-slate-400">{formatTime(m.member_since)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
