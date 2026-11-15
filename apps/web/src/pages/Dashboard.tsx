import { useQuery } from '@tanstack/react-query';
import { Bot, Inbox, Link as LinkIcon, Plus, Ticket } from 'lucide-react';
import { Link } from 'react-router-dom';
import { api } from '../lib/api';
import { useWorkspace } from '../context/WorkspaceContext';
import { EmptyState, NoWorkspaceState, Skeleton, WorkspaceErrorState } from '../components/ui';

function timeAgo(iso: string | null | undefined): string {
  if (!iso) return '';
  const mins = Math.floor((Date.now() - new Date(iso).getTime()) / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

export default function Dashboard() {
  const { workspaceId, workspace, loading: wsLoading, status: wsStatus, error: wsError, refetchWorkspaces } = useWorkspace();
  const enabled = !!workspaceId;
  const statsQ = useQuery({
    queryKey: ['ticket-stats', workspaceId],
    queryFn: () => api.getTicketStats(workspaceId!),
    enabled,
  });
  const customersQ = useQuery({
    queryKey: ['customers-total', workspaceId],
    queryFn: () => api.listCustomers(workspaceId!, { page: 1, pageSize: 1 }),
    enabled,
  });
  const convsQ = useQuery({
    queryKey: ['conversations-open', workspaceId],
    queryFn: () => api.listConversations(workspaceId!, { page: 1, pageSize: 1, status: 'open' }),
    enabled,
  });
  const recentTicketsQ = useQuery({
    queryKey: ['recent-tickets', workspaceId],
    queryFn: () => api.listTickets(workspaceId!, { page: 1, pageSize: 5 }),
    enabled,
  });
  const aiOverviewQ = useQuery({
    queryKey: ['ai-overview', workspaceId],
    queryFn: () => api.getAiOverview(workspaceId!),
    enabled,
  });
  const recentConvsQ = useQuery({
    queryKey: ['recent-conversations', workspaceId],
    queryFn: () => api.listConversations(workspaceId!, { page: 1, pageSize: 5 }),
    enabled,
  });

  const stats = statsQ.data;
  const openTickets = stats
    ? (stats.by_status.open ?? 0) + (stats.by_status.in_progress ?? 0) + (stats.by_status.waiting_for_customer ?? 0)
    : 0;
  const loading = wsLoading || statsQ.isLoading || customersQ.isLoading || convsQ.isLoading;
  const error = statsQ.error ?? customersQ.error ?? convsQ.error;
  const cards = [
    { label: 'Total tickets', value: stats ? String(stats.total) : '0', note: 'All tickets in this workspace.' },
    { label: 'Open tickets', value: stats ? String(openTickets) : '0', note: 'Open, in progress or waiting for customer.' },
    { label: 'Total customers', value: String(customersQ.data?.total ?? 0), note: 'Customers in this workspace.' },
    { label: 'Open conversations', value: String(convsQ.data?.total ?? 0), note: 'Conversations currently open.' },
  ];
  const recentTickets = recentTicketsQ.data?.tickets ?? [];
  const recentConvs = recentConvsQ.data?.conversations ?? [];
  const hasActivity = recentTickets.length > 0 || recentConvs.length > 0;

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold text-white">Overview</h1>
          <p className="text-sm text-slate-400">
            {workspace ? `Workspace: ${workspace.name}` : 'Your workspace at a glance — real numbers, no invented metrics.'}
          </p>
        </div>
        <Link to="/onboarding" className="flex items-center gap-2 rounded-lg bg-primary px-4 py-2 text-sm font-medium text-white hover:bg-purple-600">
          <Plus className="h-4 w-4" /> New workspace
        </Link>
      </div>

      {wsStatus === 'error' && <WorkspaceErrorState message={wsError?.message} onRetry={refetchWorkspaces} />}
      {wsStatus === 'empty' && <NoWorkspaceState />}

      {error && (
        <div className="rounded-xl border border-danger/50 bg-danger/10 p-4 text-sm text-red-300" role="alert">
          Could not load workspace data: {(error as Error).message}
        </div>
      )}

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        {loading
          ? [0, 1, 2, 3].map((i) => <Skeleton key={i} className="h-28" />)
          : cards.map((c) => (
              <div key={c.label} className="rounded-xl border border-slate-700/60 bg-card p-5">
                <p className="text-sm text-slate-400">{c.label}</p>
                <p className="mt-2 text-3xl font-bold text-white">{c.value}</p>
                <p className="mt-1 text-xs text-slate-500">{c.note}</p>
              </div>
            ))}
      </div>

      {/* AI & Automation overview — real values from GET /ai-overview. */}
      <div className="rounded-xl border border-slate-700/60 bg-card p-5">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <h2 className="font-semibold text-white">AI &amp; Automation</h2>
          <Link to="/automations" className="text-sm text-purple-300 hover:underline">View automation activity</Link>
        </div>
        {aiOverviewQ.isLoading ? (
          <div className="mt-4 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
            {[0, 1, 2, 3, 4, 5].map((i) => <Skeleton key={i} className="h-20" />)}
          </div>
        ) : aiOverviewQ.isError ? (
          <div className="mt-4 rounded-lg border border-danger/50 bg-danger/10 p-4 text-sm text-red-300" role="alert">
            Could not load AI overview: {(aiOverviewQ.error as Error).message}
            <button onClick={() => void aiOverviewQ.refetch()} className="ml-3 rounded-lg bg-primary px-3 py-1 text-xs font-medium text-white hover:bg-purple-600">
              Retry
            </button>
          </div>
        ) : aiOverviewQ.data ? (
          <div className="mt-4 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
            <div>
              <p className="text-sm text-slate-400">AI status</p>
              <p className="mt-2 text-xl font-bold text-white">
                <span>{aiOverviewQ.data.ai_enabled ? 'Enabled' : 'Disabled'}</span>
                {' — '}
                <span className="text-sm font-medium capitalize text-slate-400">{aiOverviewQ.data.mode.replace(/_/g, ' ')}</span>
              </p>
            </div>
            {[
              { label: 'Automation pending', value: aiOverviewQ.data.automation.pending },
              { label: 'Automation failed', value: aiOverviewQ.data.automation.failed },
              { label: 'AI-assisted conversations', value: aiOverviewQ.data.totals.assisted_conversations },
              { label: 'Suggestions', value: aiOverviewQ.data.totals.suggestions },
              { label: 'Auto replies', value: aiOverviewQ.data.totals.auto_replies },
              { label: 'Handoffs', value: aiOverviewQ.data.totals.handoffs },
              { label: 'Failed executions', value: aiOverviewQ.data.totals.failed_executions },
            ].map((c) => (
              <div key={c.label}>
                <p className="text-sm text-slate-400">{c.label}</p>
                <p className="mt-2 text-xl font-bold text-white">{c.value}</p>
              </div>
            ))}
          </div>
        ) : null}
      </div>

      <div className="grid gap-4 lg:grid-cols-2">
        <div className="rounded-xl border border-slate-700/60 bg-card p-5">
          <h2 className="font-semibold text-white">AI resolution rate</h2>
          <p className="mt-2 text-3xl font-bold text-white">—</p>
          <p className="mt-1 text-xs text-slate-500">AI agent arrives in Phase 4 — demo preview only.</p>
        </div>
        <div className="rounded-xl border border-slate-700/60 bg-card p-5">
          <h2 className="font-semibold text-white">Recent activity</h2>
          {!enabled || (!recentTicketsQ.isLoading && !recentConvsQ.isLoading && !hasActivity) ? (
            <p className="mt-3 flex items-center gap-2 text-sm text-slate-400">
              <Inbox className="h-4 w-4" /> No activity yet — this section fills in once conversations and tickets exist (Phase 2).
            </p>
          ) : (
            <ul className="mt-3 space-y-2">
              {recentTickets.map((t) => (
                <li key={`t-${t.id}`} className="flex items-center gap-2 text-sm">
                  <Ticket className="h-4 w-4 shrink-0 text-primary" />
                  <Link to={`/tickets/${t.id}`} className="min-w-0 flex-1 truncate text-slate-200 hover:underline">
                    {t.subject}
                  </Link>
                  <span className="shrink-0 text-xs text-slate-500">{timeAgo(t.updated_at)}</span>
                </li>
              ))}
              {recentConvs.map((c) => (
                <li key={`c-${c.id}`} className="flex items-center gap-2 text-sm">
                  <LinkIcon className="h-4 w-4 shrink-0 text-primary" />
                  <Link to={`/inbox/${c.id}`} className="min-w-0 flex-1 truncate text-slate-200 hover:underline">
                    {c.customer?.full_name ?? 'Conversation'} — {c.last_message?.body ?? 'No messages yet'}
                  </Link>
                  <span className="shrink-0 text-xs text-slate-500">{timeAgo(c.last_message_at ?? c.created_at)}</span>
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>

      <div className="rounded-xl border border-slate-700/60 bg-card p-5">
        <h2 className="font-semibold text-white">Quick actions</h2>
        <div className="mt-3 flex flex-wrap gap-3">
          <Link to="/tickets" className="flex items-center gap-2 rounded-lg bg-primary px-4 py-2 text-sm text-white">
            <Plus className="h-4 w-4" /> New ticket
          </Link>
          <Link to="/customers" className="flex items-center gap-2 rounded-lg bg-slate-700 px-4 py-2 text-sm text-white hover:bg-slate-600">
            Customers
          </Link>
          <span className="flex items-center gap-2 rounded-lg bg-slate-700 px-4 py-2 text-sm text-slate-400" title="Phase 4">
            <Bot className="h-4 w-4" /> AI agent — Phase 4
          </span>
        </div>
      </div>

      {!hasActivity && <EmptyState title="Nothing here yet" description="Tickets and conversations you create will show up on this page with real counts — nothing is invented." />}
    </div>
  );
}
