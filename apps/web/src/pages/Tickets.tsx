import { useEffect, useState, type FormEvent } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { ArrowLeft, Plus } from 'lucide-react';
import { api, type MemberWithProfile, type Ticket, type TicketCategory, type TicketStatus } from '../lib/api';
import { useWorkspace } from '../context/WorkspaceContext';
import { useToast } from '../components/Toast';
import {
  EmptyState, Modal, NoWorkspaceState, Pagination, PriorityBadge, Skeleton, WorkspaceErrorState,
  WorkspaceLoadingSkeleton, StatusBadge, btnPrimary, btnSecondary, inputCls, selectCls,
} from '../components/ui';

const STATUSES: TicketStatus[] = ['open', 'in_progress', 'waiting_for_customer', 'resolved', 'closed'];
const PRIORITIES = ['low', 'medium', 'high', 'urgent'] as const;
const CATEGORIES: TicketCategory[] = ['general', 'billing', 'technical', 'feature', 'bug', 'other'];

function formatTime(iso: string): string {
  return new Date(iso).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
}

/** Display name for an assignee id from the members-with-profiles list.
 * While the members are still loading the name cannot be resolved yet, so
 * callers must show a loading placeholder instead of the 'Unnamed member'
 * fallback — otherwise the table flashes the fallback on direct navigation
 * while the members request is still in flight. */
function assigneeName(members: MemberWithProfile[], membersLoading: boolean, userId: string | null): string | null {
  if (!userId) return null;
  if (membersLoading) return '…';
  return members.find((m) => m.user_id === userId)?.display_name ?? 'Unnamed member';
}

export default function Tickets() {
  const { workspaceId, status: wsStatus, error: wsError, refetchWorkspaces } = useWorkspace();
  const toast = useToast();
  const queryClient = useQueryClient();
  const [search, setSearch] = useState('');
  const [status, setStatus] = useState('');
  const [priority, setPriority] = useState('');
  const [assignedTo, setAssignedTo] = useState('');
  const [sort, setSort] = useState('created_at');
  const [page, setPage] = useState(1);
  const [view, setView] = useState<'table' | 'kanban'>('table');
  const [createOpen, setCreateOpen] = useState(false);

  const statsQ = useQuery({
    queryKey: ['ticket-stats', workspaceId],
    queryFn: () => api.getTicketStats(workspaceId!),
    enabled: !!workspaceId,
  });
  const listQ = useQuery({
    queryKey: ['tickets', workspaceId, search, status, priority, assignedTo, sort, page, view],
    queryFn: () =>
      api.listTickets(workspaceId!, {
        page: view === 'kanban' ? 1 : page,
        pageSize: view === 'kanban' ? 100 : 20,
        search: search || undefined,
        status: status || undefined,
        priority: priority || undefined,
        assignedTo: assignedTo || undefined,
        sort,
      }),
    enabled: !!workspaceId,
  });
  const membersQ = useQuery({
    queryKey: ['members', workspaceId],
    queryFn: () => api.listMembersWithProfiles(workspaceId!),
    enabled: !!workspaceId,
  });

  const stats = statsQ.data;
  const tickets = listQ.data?.tickets ?? [];
  const total = listQ.data?.total ?? 0;
  const members = membersQ.data?.members ?? [];

if (wsStatus === 'auth-loading' || wsStatus === 'loading') return <WorkspaceLoadingSkeleton />;
if (wsStatus === 'error') return <WorkspaceErrorState message={wsError?.message} onRetry={refetchWorkspaces} />;
if (wsStatus === 'empty' || !workspaceId) return <NoWorkspaceState />;

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-2xl font-bold text-white">Tickets</h1>
        <div className="flex gap-2">
          <div className="flex rounded-lg bg-slate-700 p-0.5" role="group" aria-label="Ticket view">
            <button onClick={() => setView('table')} aria-pressed={view === 'table'} className={`rounded-md px-3 py-1.5 text-sm ${view === 'table' ? 'bg-primary text-white' : 'text-slate-300'}`}>Table</button>
            <button onClick={() => setView('kanban')} aria-pressed={view === 'kanban'} className={`rounded-md px-3 py-1.5 text-sm ${view === 'kanban' ? 'bg-primary text-white' : 'text-slate-300'}`}>Board</button>
          </div>
          <button onClick={() => setCreateOpen(true)} className={`${btnPrimary} flex items-center gap-2`}>
            <Plus className="h-4 w-4" /> New ticket
          </button>
        </div>
      </div>

      {/* Real stats from /tickets/stats */}
      <div className="grid gap-3 sm:grid-cols-3 lg:grid-cols-6">
        <StatCard label="Total" value={stats?.total ?? 0} loading={statsQ.isLoading} />
        {STATUSES.map((s) => (
          <StatCard key={s} label={s.replace(/_/g, ' ')} value={stats?.by_status[s] ?? 0} loading={statsQ.isLoading} />
        ))}
      </div>

      <div className="flex flex-wrap gap-2 rounded-xl border border-slate-700/60 bg-card p-3">
        <input className={`${inputCls} min-w-48 flex-1`} placeholder="Search by subject…" value={search} onChange={(e) => { setSearch(e.target.value); setPage(1); }} aria-label="Search tickets" />
        <select className={selectCls} value={status} onChange={(e) => { setStatus(e.target.value); setPage(1); }} aria-label="Filter by status">
          <option value="">All statuses</option>
          {STATUSES.map((s) => <option key={s} value={s}>{s.replace(/_/g, ' ')}</option>)}
        </select>
        <select className={selectCls} value={priority} onChange={(e) => { setPriority(e.target.value); setPage(1); }} aria-label="Filter by priority">
          <option value="">All priorities</option>
          {PRIORITIES.map((p) => <option key={p} value={p}>{p}</option>)}
        </select>
        <select className={selectCls} value={assignedTo} onChange={(e) => { setAssignedTo(e.target.value); setPage(1); }} aria-label="Filter by assignee">
          <option value="">Anyone</option>
          <option value="unassigned">Unassigned</option>
          {(membersQ.data?.members ?? []).map((m) => <option key={m.user_id} value={m.user_id}>{m.display_name} ({m.role})</option>)}
        </select>
        <select className={selectCls} value={sort} onChange={(e) => setSort(e.target.value)} aria-label="Sort tickets">
          <option value="created_at">Newest first</option>
          <option value="priority">Priority</option>
          <option value="status">Status</option>
        </select>
      </div>

      {listQ.isLoading ? (
        <div className="space-y-2">{[0, 1, 2].map((i) => <Skeleton key={i} className="h-14" />)}</div>
      ) : listQ.isError ? (
        <p className="rounded-xl border border-danger/50 bg-danger/10 p-4 text-sm text-red-300" role="alert">
          Could not load tickets: {(listQ.error as Error).message}
        </p>
      ) : tickets.length === 0 ? (
        <EmptyState title="No tickets yet" description="Create your first ticket — it will show up here with real counts, not placeholders." action={<button onClick={() => setCreateOpen(true)} className={btnPrimary}>New ticket</button>} />
      ) : view === 'table' ? (
        <div className="overflow-x-auto rounded-xl border border-slate-700/60 bg-card">
          <table className="w-full min-w-[720px] text-left text-sm">
            <thead>
              <tr className="border-b border-slate-700/60 text-slate-400">
                <th className="px-4 py-3 font-medium">Subject</th>
                <th className="px-4 py-3 font-medium">Status</th>
                <th className="px-4 py-3 font-medium">Priority</th>
                <th className="px-4 py-3 font-medium">Assignee</th>
                <th className="px-4 py-3 font-medium">Updated</th>
              </tr>
            </thead>
            <tbody>
              {tickets.map((t: Ticket) => (
                <tr key={t.id} className="border-b border-slate-800 hover:bg-slate-800/50">
                  <td className="px-4 py-3">
                    <Link to={`/tickets/${t.id}`} className="font-medium text-white hover:underline">{t.subject}</Link>
                    <span className="block text-xs text-slate-500">{t.category}</span>
                  </td>
                  <td className="px-4 py-3"><StatusBadge status={t.status} /></td>
                  <td className="px-4 py-3"><PriorityBadge priority={t.priority} /></td>
                  <td className="px-4 py-3 text-slate-300">{assigneeName(members, membersQ.isLoading, t.assigned_to) ?? 'Unassigned'}</td>
                  <td className="px-4 py-3 text-slate-400">{formatTime(t.updated_at)}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <div className="p-4"><Pagination page={page} pageSize={20} total={total} onPageChange={setPage} /></div>
        </div>
      ) : (
        <Kanban
          tickets={tickets}
          onStatusChange={(id, s) => {
            api.updateTicket(workspaceId, id, { status: s })
              .then(() => {
                toast.success('Ticket status updated');
                void queryClient.invalidateQueries({ queryKey: ['tickets', workspaceId] });
                void queryClient.invalidateQueries({ queryKey: ['ticket-stats', workspaceId] });
              })
              .catch((err: Error) => toast.error(`Status change failed: ${err.message}`));
          }}
        />
      )}

      <CreateTicketModal
        open={createOpen}
        onClose={() => setCreateOpen(false)}
        onCreated={() => {
          setCreateOpen(false);
          void queryClient.invalidateQueries({ queryKey: ['tickets', workspaceId] });
          void queryClient.invalidateQueries({ queryKey: ['ticket-stats', workspaceId] });
        }}
      />
    </div>
  );
}

function StatCard({ label, value, loading }: { label: string; value: number; loading: boolean }) {
  return (
    <div className="rounded-xl border border-slate-700/60 bg-card p-4">
      <p className="text-xs capitalize text-slate-400">{label}</p>
      <p className="mt-1 text-2xl font-bold text-white">{loading ? '…' : value}</p>
    </div>
  );
}

function Kanban({ tickets, onStatusChange }: { tickets: Ticket[]; onStatusChange: (id: string, status: TicketStatus) => void }) {
  return (
    <div className="grid gap-3 md:grid-cols-3 xl:grid-cols-5">
      {STATUSES.map((status) => {
        const col = tickets.filter((t) => t.status === status);
        return (
          <div key={status} className="rounded-xl border border-slate-700/60 bg-card p-3">
            <h2 className="mb-3 flex items-center justify-between text-sm font-semibold capitalize text-white">
              {status.replace(/_/g, ' ')} <span className="rounded-full bg-slate-700 px-2 py-0.5 text-xs">{col.length}</span>
            </h2>
            <ul className="space-y-2">
              {col.map((t) => (
                <li key={t.id} className="rounded-lg bg-slate-800 p-3">
                  <Link to={`/tickets/${t.id}`} className="text-sm font-medium text-white hover:underline">{t.subject}</Link>
                  <div className="mt-2 flex items-center gap-2"><PriorityBadge priority={t.priority} /></div>
                  <label className="mt-2 block text-xs text-slate-400">Move to
                    <select
                      className={`${selectCls} mt-1 w-full`}
                      value={t.status}
                      onChange={(e) => onStatusChange(t.id, e.target.value as TicketStatus)}
                      aria-label={`Change status of ${t.subject}`}
                    >
                      {STATUSES.map((s) => <option key={s} value={s}>{s.replace(/_/g, ' ')}</option>)}
                    </select>
                  </label>
                </li>
              ))}
              {col.length === 0 && <li className="text-xs text-slate-500">No tickets</li>}
            </ul>
          </div>
        );
      })}
    </div>
  );
}

function CreateTicketModal({ open, onClose, onCreated }: { open: boolean; onClose: () => void; onCreated: () => void }) {
  const { workspaceId } = useWorkspace();
  const toast = useToast();
  const [subject, setSubject] = useState('');
  const [description, setDescription] = useState('');
  const [category, setCategory] = useState<TicketCategory>('general');
  const [priority, setPriority] = useState<'low' | 'medium' | 'high' | 'urgent'>('medium');
  const [customerSearch, setCustomerSearch] = useState('');
  const [customerId, setCustomerId] = useState('');
  const [conversationId, setConversationId] = useState('');

  const customersQ = useQuery({
    queryKey: ['customers-search', workspaceId, customerSearch],
    queryFn: () => api.listCustomers(workspaceId!, { page: 1, pageSize: 10, search: customerSearch || undefined }),
    enabled: open && !!workspaceId,
  });
  const convsQ = useQuery({
    queryKey: ['conversations-search', workspaceId],
    queryFn: () => api.listConversations(workspaceId!, { page: 1, pageSize: 10 }),
    enabled: open && !!workspaceId,
  });

  const createMut = useMutation({
    mutationFn: () =>
      api.createTicket(workspaceId!, {
        subject: subject.trim(),
        description: description.trim() || null,
        category,
        priority,
        customer_id: customerId || undefined,
        conversation_id: conversationId || undefined,
      }),
    onSuccess: () => {
      toast.success('Ticket created');
      setSubject(''); setDescription(''); setCustomerId(''); setConversationId('');
      onCreated();
    },
    onError: (err) => toast.error(`Could not create ticket: ${(err as Error).message}`),
  });

  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (!subject.trim()) return;
    createMut.mutate();
  };

  return (
    <Modal open={open} onClose={onClose} title="New ticket">
      <form onSubmit={submit} className="space-y-4">
        <label className="block text-sm text-slate-300">Subject
          <input className={`${inputCls} mt-1`} required value={subject} onChange={(e) => setSubject(e.target.value)} placeholder="Brief summary of the issue" maxLength={200} />
        </label>
        <label className="block text-sm text-slate-300">Description
          <textarea className={`${inputCls} mt-1`} value={description} onChange={(e) => setDescription(e.target.value)} placeholder="What happened? (optional)" maxLength={5000} />
        </label>
        <div className="grid grid-cols-2 gap-3">
          <label className="block text-sm text-slate-300">Category
            <select className={`${selectCls} mt-1 w-full`} value={category} onChange={(e) => setCategory(e.target.value as TicketCategory)}>
              {CATEGORIES.map((c) => <option key={c} value={c}>{c}</option>)}
            </select>
          </label>
          <label className="block text-sm text-slate-300">Priority
            <select className={`${selectCls} mt-1 w-full`} value={priority} onChange={(e) => setPriority(e.target.value as typeof priority)}>
              {PRIORITIES.map((p) => <option key={p} value={p}>{p}</option>)}
            </select>
          </label>
        </div>
        <label className="block text-sm text-slate-300">Customer (search, optional)
          <input className={`${inputCls} mt-1`} value={customerSearch} onChange={(e) => setCustomerSearch(e.target.value)} placeholder="Type a name or email…" />
        </label>
        <label className="block text-sm text-slate-300">Customer
          <select className={`${selectCls} mt-1 w-full`} value={customerId} onChange={(e) => setCustomerId(e.target.value)}>
            <option value="">No customer</option>
            {(customersQ.data?.customers ?? []).map((c) => <option key={c.id} value={c.id}>{c.full_name} — {c.email}</option>)}
          </select>
        </label>
        <label className="block text-sm text-slate-300">Linked conversation (optional)
          <select className={`${selectCls} mt-1 w-full`} value={conversationId} onChange={(e) => setConversationId(e.target.value)}>
            <option value="">None</option>
            {(convsQ.data?.conversations ?? []).map((c) => <option key={c.id} value={c.id}>{c.customer?.full_name ?? c.id} — {c.status}</option>)}
          </select>
        </label>
        <div className="flex justify-end gap-2">
          <button type="button" onClick={onClose} className={btnSecondary}>Cancel</button>
          <button type="submit" disabled={createMut.isPending || !subject.trim()} className={btnPrimary}>{createMut.isPending ? 'Creating…' : 'Create ticket'}</button>
        </div>
      </form>
    </Modal>
  );
}

export function TicketDetailPage() {
  const { workspaceId, status: wsStatus, error: wsError, refetchWorkspaces } = useWorkspace();
  const { ticketId } = useParams<{ ticketId: string }>();
  const navigate = useNavigate();
  const toast = useToast();
  const queryClient = useQueryClient();
  const [noteDraft, setNoteDraft] = useState('');
  const [editing, setEditing] = useState(false);
  const [editSubject, setEditSubject] = useState('');
  const [editDescription, setEditDescription] = useState('');

  const detailQ = useQuery({
    queryKey: ['ticket', workspaceId, ticketId],
    queryFn: () => api.getTicket(workspaceId!, ticketId!),
    enabled: !!workspaceId && !!ticketId,
  });
  const eventsQ = useQuery({
    queryKey: ['ticket-events', workspaceId, ticketId],
    queryFn: () => api.listTicketEvents(workspaceId!, ticketId!),
    enabled: !!workspaceId && !!ticketId,
  });
  const membersQ = useQuery({
    queryKey: ['members', workspaceId],
    queryFn: () => api.listMembersWithProfiles(workspaceId!),
    enabled: !!workspaceId,
  });

  const invalidate = () => {
    void queryClient.invalidateQueries({ queryKey: ['ticket', workspaceId, ticketId] });
    void queryClient.invalidateQueries({ queryKey: ['tickets', workspaceId] });
    void queryClient.invalidateQueries({ queryKey: ['ticket-stats', workspaceId] });
    void queryClient.invalidateQueries({ queryKey: ['ticket-events', workspaceId, ticketId] });
  };
  const updateMut = useMutation({
    mutationFn: (patch: Parameters<typeof api.updateTicket>[2]) => api.updateTicket(workspaceId!, ticketId!, patch),
    onSuccess: () => { toast.success('Ticket updated'); invalidate(); setEditing(false); },
    onError: (err) => toast.error(`Update failed: ${(err as Error).message}`),
  });
  const noteMut = useMutation({
    mutationFn: (body: string) => api.addTicketNote(workspaceId!, ticketId!, body),
    onSuccess: () => { setNoteDraft(''); toast.success('Note added'); invalidate(); },
    onError: (err) => toast.error(`Could not add note: ${(err as Error).message}`),
  });

  useEffect(() => {
    if (detailQ.data) {
      setEditSubject(detailQ.data.ticket.subject);
      setEditDescription(detailQ.data.ticket.description ?? '');
    }
  }, [detailQ.data]);

if (wsStatus === 'auth-loading' || wsStatus === 'loading') return <WorkspaceLoadingSkeleton />;
if (wsStatus === 'error') return <WorkspaceErrorState message={wsError?.message} onRetry={refetchWorkspaces} />;
if (wsStatus === 'empty' || !workspaceId) return <NoWorkspaceState />;
  if (detailQ.isLoading) return <div className="space-y-2"><Skeleton className="h-10" /><Skeleton className="h-64" /></div>;
  if (detailQ.isError || !detailQ.data) {
    return <div className="rounded-xl border border-danger/50 bg-danger/10 p-4 text-sm text-red-300" role="alert">Could not load this ticket: {(detailQ.error as Error | undefined)?.message ?? 'Not found'}</div>;
  }
  const { ticket, customer, conversation, assigned_member } = detailQ.data;
  const events = eventsQ.data?.events ?? [];

  return (
    <div className="space-y-4">
      <button onClick={() => navigate('/tickets')} className="flex items-center gap-1 text-sm text-slate-400 hover:text-white">
        <ArrowLeft className="h-4 w-4" /> Back to tickets
      </button>
      <div className="rounded-xl border border-slate-700/60 bg-card p-5">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            {editing ? (
              <input className={inputCls} value={editSubject} onChange={(e) => setEditSubject(e.target.value)} aria-label="Ticket subject" />
            ) : (
              <h1 className="text-xl font-bold text-white">{ticket.subject}</h1>
            )}
            <p className="mt-1 text-sm text-slate-400">
              Created {formatTime(ticket.created_at)} · Category: {ticket.category}
              {ticket.resolved_at ? ` · Resolved ${formatTime(ticket.resolved_at)}` : ''}
            </p>
          </div>
          <div className="flex gap-2"><StatusBadge status={ticket.status} /><PriorityBadge priority={ticket.priority} /></div>
        </div>

        {editing ? (
          <textarea className={`${inputCls} mt-4`} value={editDescription} onChange={(e) => setEditDescription(e.target.value)} rows={4} aria-label="Ticket description" />
        ) : (
          <p className="mt-4 whitespace-pre-wrap text-sm text-slate-200">{ticket.description ?? 'No description.'}</p>
        )}

        <div className="mt-4 grid gap-3 sm:grid-cols-3">
          <label className="block text-sm text-slate-300">Status
            <select className={`${selectCls} mt-1 w-full`} value={ticket.status} onChange={(e) => updateMut.mutate({ status: e.target.value as TicketStatus })}>
              {STATUSES.map((s) => <option key={s} value={s}>{s.replace(/_/g, ' ')}</option>)}
            </select>
          </label>
          <label className="block text-sm text-slate-300">Priority
            <select className={`${selectCls} mt-1 w-full`} value={ticket.priority} onChange={(e) => updateMut.mutate({ priority: e.target.value as Ticket['priority'] })}>
              {PRIORITIES.map((p) => <option key={p} value={p}>{p}</option>)}
            </select>
          </label>
          <label className="block text-sm text-slate-300">Assignee
            <select className={`${selectCls} mt-1 w-full`} value={ticket.assigned_to ?? ''} onChange={(e) => updateMut.mutate({ assigned_to: e.target.value || null })}>
              <option value="">Unassigned</option>
              {(membersQ.data?.members ?? []).map((m) => <option key={m.user_id} value={m.user_id}>{m.display_name} ({m.role})</option>)}
            </select>
          </label>
        </div>
        <p className="mt-2 text-sm text-slate-400">
          Assigned to: {(() => {
            if (!ticket.assigned_to) return 'Unassigned';
            if (membersQ.isLoading) return 'Loading…';
            const member = (membersQ.data?.members ?? []).find((m) => m.user_id === ticket.assigned_to);
            if (member) return `${member.display_name} (${member.role})`;
            return assigned_member ? `Unnamed member (${assigned_member.role})` : 'Unnamed member';
          })()}
        </p>
        <div className="mt-4 flex gap-2">
          {editing ? (
            <>
              <button
                onClick={() => updateMut.mutate({ subject: editSubject.trim(), description: editDescription.trim() || null })}
                disabled={updateMut.isPending || !editSubject.trim()}
                className={btnPrimary}
              >Save</button>
              <button onClick={() => setEditing(false)} className={btnSecondary}>Cancel</button>
            </>
          ) : (
            <button onClick={() => setEditing(true)} className={btnSecondary}>Edit subject / description</button>
          )}
        </div>
      </div>

      <div className="grid gap-4 lg:grid-cols-2">
        <div className="rounded-xl border border-slate-700/60 bg-card p-5">
          <h2 className="font-semibold text-white">Linked records</h2>
          <p className="mt-2 text-sm text-slate-300">
            Customer: {customer ? <Link to={`/customers/${customer.id}`} className="text-purple-300 hover:underline">{customer.full_name} ({customer.email})</Link> : 'None'}
          </p>
          <p className="mt-1 text-sm text-slate-300">
            Conversation: {conversation ? <Link to={`/inbox/${conversation.id}`} className="text-purple-300 hover:underline">Open conversation ({conversation.status})</Link> : 'None'}
          </p>
        </div>
        <div className="rounded-xl border border-slate-700/60 bg-card p-5">
          <h2 className="font-semibold text-white">Internal notes</h2>
          <form
            className="mt-3 flex gap-2"
            onSubmit={(e) => { e.preventDefault(); if (noteDraft.trim()) noteMut.mutate(noteDraft.trim()); }}
          >
            <label htmlFor="ticket-note" className="sr-only">Add an internal note</label>
            <input id="ticket-note" className={inputCls} value={noteDraft} onChange={(e) => setNoteDraft(e.target.value)} placeholder="Add a note…" maxLength={5000} />
            <button type="submit" disabled={noteMut.isPending || !noteDraft.trim()} className={btnSecondary}>Add</button>
          </form>
        </div>
      </div>

      <div className="rounded-xl border border-slate-700/60 bg-card p-5">
        <h2 className="font-semibold text-white">History</h2>
        {events.length === 0 ? (
          <p className="mt-2 text-sm text-slate-400">No events yet.</p>
        ) : (
          <ol className="mt-3 space-y-2">
            {events.map((ev) => (
              <li key={ev.id} className="border-l-2 border-primary/50 pl-3 text-sm text-slate-300">
                <span className="font-medium text-white">{ev.event_type.replace(/_/g, ' ')}</span>
                {ev.old_value !== null || ev.new_value !== null ? (
                  <span> — {ev.field_name}: {ev.old_value ?? '—'} → {ev.new_value ?? '—'}</span>
                ) : null}
                {ev.note && <span className="block text-slate-400">{ev.note}</span>}
                <span className="block text-xs text-slate-500">{formatTime(ev.created_at)}</span>
              </li>
            ))}
          </ol>
        )}
      </div>
    </div>
  );
}
