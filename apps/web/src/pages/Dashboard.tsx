import { useQuery } from '@tanstack/react-query';
import { Bot, Inbox, Plus, Ticket } from 'lucide-react';
import { Link } from 'react-router-dom';
import { api } from '../lib/api';

const cards = [
  { label: 'Total tickets', value: '—', note: 'No tickets yet — Phase 2 adds ticket management.' },
  { label: 'Open tickets', value: '—', note: 'No open tickets — empty state.' },
  { label: 'Average response time', value: '—', note: 'No conversations yet — Phase 2.' },
  { label: 'AI resolution rate', value: '—', note: 'AI agent arrives in Phase 4 — demo preview only.' },
];
export default function Dashboard() {
  const { data, isLoading, isError, error } = useQuery({ queryKey: ['workspaces'], queryFn: api.listWorkspaces });
  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div><h1 className="text-2xl font-bold text-white">Overview</h1><p className="text-sm text-slate-400">Your workspace at a glance. Metrics appear once real tickets exist.</p></div>
        <Link to="/onboarding" className="flex items-center gap-2 rounded-lg bg-primary px-4 py-2 text-sm font-medium text-white hover:bg-purple-600"><Plus className="h-4 w-4" /> New workspace</Link>
      </div>
      {isLoading && <p className="text-slate-400">Loading workspaces…</p>}
      {isError && <div className="rounded-xl border border-danger/50 bg-danger/10 p-4 text-sm text-red-300" role="alert">Could not load workspaces: {(error as Error).message}. Check the API is running and your Supabase keys are set.</div>}
      {data && <p className="text-sm text-slate-400">You belong to {(data.workspaces ?? []).length} workspace(s). {(data.workspaces ?? []).map((w: { name: string }) => w.name).join(', ') || 'Create your first workspace to get started.'}</p>}
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        {cards.map((c) => (
          <div key={c.label} className="rounded-xl border border-slate-700/60 bg-card p-5">
            <p className="text-sm text-slate-400">{c.label}</p>
            <p className="mt-2 text-3xl font-bold text-white">{c.value}</p>
            <p className="mt-1 text-xs text-slate-500">{c.note}</p>
          </div>
        ))}
      </div>
      <div className="grid gap-4 lg:grid-cols-2">
        <div className="rounded-xl border border-slate-700/60 bg-card p-5">
          <h2 className="font-semibold text-white">Recent activity</h2>
          <p className="mt-3 flex items-center gap-2 text-sm text-slate-400"><Inbox className="h-4 w-4" /> No activity yet — this section fills in once conversations and tickets exist (Phase 2).</p>
        </div>
        <div className="rounded-xl border border-slate-700/60 bg-card p-5">
          <h2 className="font-semibold text-white">Ticket trends</h2>
          <p className="mt-3 text-sm text-slate-400">Chart placeholder — clearly labelled demo preview. Real charts arrive with Analytics (Phase 5); no data is invented.</p>
          <div className="mt-4 flex h-32 items-end gap-2" aria-hidden="true">{[30, 55, 40, 70, 50].map((h, i) => (<div key={i} className="flex-1 rounded-t bg-primary/25" style={{ height: `${h}%` }} />))}</div>
        </div>
      </div>
      <div className="rounded-xl border border-slate-700/60 bg-card p-5">
        <h2 className="font-semibold text-white">Quick actions</h2>
        <div className="mt-3 flex flex-wrap gap-3">
          <Link to="/onboarding" className="flex items-center gap-2 rounded-lg bg-primary px-4 py-2 text-sm text-white"><Plus className="h-4 w-4" /> Create workspace</Link>
          <span className="flex items-center gap-2 rounded-lg bg-slate-700 px-4 py-2 text-sm text-slate-400" title="Phase 2"><Ticket className="h-4 w-4" /> New ticket — Phase 2</span>
          <span className="flex items-center gap-2 rounded-lg bg-slate-700 px-4 py-2 text-sm text-slate-400" title="Phase 4"><Bot className="h-4 w-4" /> AI agent — Phase 4</span>
        </div>
      </div>
    </div>
  );
}
