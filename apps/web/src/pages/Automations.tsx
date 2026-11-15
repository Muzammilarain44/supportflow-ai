import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { RefreshCw } from 'lucide-react';
import { api } from '../lib/api';
import { useWorkspace } from '../context/WorkspaceContext';
import {
  EmptyState, NoWorkspaceState, Pagination, Skeleton, WorkspaceErrorState,
  WorkspaceLoadingSkeleton, btnSecondary, selectCls,
} from '../components/ui';

function formatTime(iso: string | null | undefined): string {
  if (!iso) return '—';
  return new Date(iso).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
}

export default function Automations() {
  const { workspaceId, status: wsStatus, error: wsError, refetchWorkspaces } = useWorkspace();
  const queryClient = useQueryClient();
  const [statusFilter, setStatusFilter] = useState('');
  const [page, setPage] = useState(1);

  const overviewQ = useQuery({
    queryKey: ['ai-overview', workspaceId],
    queryFn: () => api.getAiOverview(workspaceId!),
    enabled: !!workspaceId,
  });
  const eventsQ = useQuery({
    queryKey: ['automation-events', workspaceId, statusFilter, page],
    queryFn: () => api.listAutomationEvents(workspaceId!, {
      page, pageSize: 20, status: statusFilter || undefined,
    }),
    enabled: !!workspaceId,
  });
  const executionsQ = useQuery({
    queryKey: ['ai-executions', workspaceId],
    queryFn: () => api.listAiExecutions(workspaceId!, { page: 1, pageSize: 50 }),
    enabled: !!workspaceId,
  });

  const overview = overviewQ.data;
  const events = eventsQ.data?.automation_events ?? [];
  const eventsTotal = eventsQ.data?.total ?? 0;
  const failedExecutions = (executionsQ.data?.ai_executions ?? []).filter(
    (e) => e.status === 'failed' || e.status === 'escalated',
  );

  const refresh = () => {
    void queryClient.invalidateQueries({ queryKey: ['ai-overview', workspaceId] });
    void queryClient.invalidateQueries({ queryKey: ['automation-events', workspaceId] });
    void queryClient.invalidateQueries({ queryKey: ['ai-executions', workspaceId] });
  };

  if (wsStatus === 'auth-loading' || wsStatus === 'loading') return <WorkspaceLoadingSkeleton />;
  if (wsStatus === 'error') return <WorkspaceErrorState message={wsError?.message} onRetry={refetchWorkspaces} />;
  if (wsStatus === 'empty' || !workspaceId) return <NoWorkspaceState />;

  const automation = overview?.automation;
  const summaryCards = [
    { label: 'Pending', value: automation?.pending ?? 0 },
    { label: 'Processing', value: automation?.processing ?? 0 },
    { label: 'Failed', value: automation?.failed ?? 0 },
    { label: 'Dead', value: automation?.dead ?? 0 },
  ];

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold text-white">Automation Activity</h1>
          <p className="text-sm text-slate-400">Automation events and AI executions in this workspace — real counts, no invented metrics.</p>
        </div>
        <button onClick={refresh} className={`${btnSecondary} flex items-center gap-2`}>
          <RefreshCw className="h-4 w-4" /> Refresh
        </button>
      </div>

      {overviewQ.isError ? (
        <p className="rounded-xl border border-danger/50 bg-danger/10 p-4 text-sm text-red-300" role="alert">
          Could not load automation overview: {(overviewQ.error as Error).message}
        </p>
      ) : (
        <>
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            {overviewQ.isLoading
              ? [0, 1, 2, 3].map((i) => <Skeleton key={i} className="h-24" />)
              : summaryCards.map((c) => (
                <div key={c.label} className="rounded-xl border border-slate-700/60 bg-card p-4">
                  <p className="text-xs text-slate-400">{c.label}</p>
                  <p className="mt-1 text-2xl font-bold text-white">{c.value}</p>
                </div>
              ))}
          </div>
          <p className="text-sm text-slate-400">
            Last execution: {overviewQ.isLoading ? 'Loading…' : formatTime(automation?.last_processed_at)}
          </p>
        </>
      )}

      <div className="rounded-xl border border-slate-700/60 bg-card p-5">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <h2 className="font-semibold text-white">Automation events</h2>
          <select className={selectCls} value={statusFilter} onChange={(e) => { setStatusFilter(e.target.value); setPage(1); }} aria-label="Filter events by status">
            <option value="">All statuses</option>
            {['pending', 'processing', 'failed', 'dead', 'completed'].map((s) => (
              <option key={s} value={s}>{s}</option>
            ))}
          </select>
        </div>
        {eventsQ.isLoading ? (
          <div className="mt-3 space-y-2">{[0, 1, 2].map((i) => <Skeleton key={i} className="h-12" />)}</div>
        ) : eventsQ.isError ? (
          <p className="mt-3 text-sm text-red-300" role="alert">Could not load automation events: {(eventsQ.error as Error).message}</p>
        ) : events.length === 0 ? (
          <div className="mt-3">
            <EmptyState title="No automation events yet" description="Events from tickets, conversations and customers will appear here once automation runs." />
          </div>
        ) : (
          <div className="mt-3 overflow-x-auto">
            <table className="w-full min-w-[720px] text-left text-sm">
              <thead>
                <tr className="border-b border-slate-700/60 text-slate-400">
                  <th className="px-4 py-3 font-medium">Event type</th>
                  <th className="px-4 py-3 font-medium">Entity</th>
                  <th className="px-4 py-3 font-medium">Status</th>
                  <th className="px-4 py-3 font-medium">Attempts</th>
                  <th className="px-4 py-3 font-medium">Created</th>
                  <th className="px-4 py-3 font-medium">Processed</th>
                </tr>
              </thead>
              <tbody>
                {events.map((ev) => (
                  <tr key={ev.id} className="border-b border-slate-800 hover:bg-slate-800/50">
                    <td className="px-4 py-3 font-medium text-white">{ev.event_type}</td>
                    <td className="px-4 py-3 text-slate-300">{ev.entity_type} · <span className="text-slate-500">{ev.entity_id.slice(0, 8)}…</span></td>
                    <td className="px-4 py-3 capitalize text-slate-300">{ev.status}</td>
                    <td className="px-4 py-3 text-slate-300">{ev.attempts}</td>
                    <td className="px-4 py-3 text-slate-400">{formatTime(ev.created_at)}</td>
                    <td className="px-4 py-3 text-slate-400">{formatTime(ev.processed_at)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            <div className="p-4"><Pagination page={page} pageSize={20} total={eventsTotal} onPageChange={setPage} /></div>
          </div>
        )}
      </div>

      <div className="rounded-xl border border-slate-700/60 bg-card p-5">
        <h2 className="font-semibold text-white">Failed AI executions</h2>
        {executionsQ.isLoading ? (
          <div className="mt-3 space-y-2">{[0, 1].map((i) => <Skeleton key={i} className="h-12" />)}</div>
        ) : executionsQ.isError ? (
          <p className="mt-3 text-sm text-red-300" role="alert">Could not load AI executions: {(executionsQ.error as Error).message}</p>
        ) : failedExecutions.length === 0 ? (
          <p className="mt-3 text-sm text-slate-400">No failed or escalated AI executions.</p>
        ) : (
          <ul className="mt-3 space-y-2">
            {failedExecutions.map((ex) => (
              <li key={ex.id} className="rounded-lg bg-slate-800 p-3 text-sm">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="font-medium text-white">{ex.provider ?? 'Unknown provider'} · {ex.model ?? 'Unknown model'}</span>
                  <span className={`rounded-full px-2.5 py-0.5 text-xs font-medium capitalize ${ex.status === 'failed' ? 'bg-danger/15 text-red-300' : 'bg-warning/15 text-amber-300'}`}>
                    {ex.status}
                  </span>
                  <span className="ml-auto text-xs text-slate-500">{formatTime(ex.created_at)}</span>
                </div>
                {ex.error && <p className="mt-1 text-slate-300">{ex.error}</p>}
                <p className="mt-1 text-xs text-slate-500">
                  Latency: {ex.latency_ms === null || ex.latency_ms === undefined ? '—' : `${ex.latency_ms} ms`}
                </p>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
