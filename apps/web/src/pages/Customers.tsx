import { useState, type FormEvent } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useParams } from 'react-router-dom';
import { ArrowLeft, Plus } from 'lucide-react';
import { api, type Customer } from '../lib/api';
import { useWorkspace } from '../context/WorkspaceContext';
import { useToast } from '../components/Toast';
import {
  EmptyState, Modal, NoWorkspaceState, Pagination, Skeleton, WorkspaceErrorState,
  WorkspaceLoadingSkeleton, btnPrimary, btnSecondary, inputCls,
} from '../components/ui';

function formatTime(iso: string): string {
  return new Date(iso).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
}

function parseTags(value: string): string[] {
  return value.split(',').map((t) => t.trim()).filter(Boolean);
}

export default function Customers() {
  const { workspaceId, status: wsStatus, error: wsError, refetchWorkspaces } = useWorkspace();
  const toast = useToast();
  const queryClient = useQueryClient();
  const [search, setSearch] = useState('');
  const [tag, setTag] = useState('');
  const [page, setPage] = useState(1);
  const [modal, setModal] = useState<{ mode: 'create' } | { mode: 'edit'; customer: Customer } | null>(null);

  const listQ = useQuery({
    queryKey: ['customers', workspaceId, search, tag, page],
    queryFn: () => api.listCustomers(workspaceId!, { page, pageSize: 20, search: search || undefined, tag: tag || undefined }),
    enabled: !!workspaceId,
  });
  const customers = listQ.data?.customers ?? [];
  const total = listQ.data?.total ?? 0;

if (wsStatus === 'auth-loading' || wsStatus === 'loading') return <WorkspaceLoadingSkeleton />;
if (wsStatus === 'error') return <WorkspaceErrorState message={wsError?.message} onRetry={refetchWorkspaces} />;
if (wsStatus === 'empty' || !workspaceId) return <NoWorkspaceState />;

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-2xl font-bold text-white">Customers</h1>
        <button onClick={() => setModal({ mode: 'create' })} className={`${btnPrimary} flex items-center gap-2`}>
          <Plus className="h-4 w-4" /> Add customer
        </button>
      </div>
      <div className="flex flex-wrap gap-2 rounded-xl border border-slate-700/60 bg-card p-3">
        <input className={`${inputCls} min-w-48 flex-1`} placeholder="Search by name or email…" value={search} onChange={(e) => { setSearch(e.target.value); setPage(1); }} aria-label="Search customers" />
        <input className={`${inputCls} w-40`} placeholder="Filter by tag…" value={tag} onChange={(e) => { setTag(e.target.value); setPage(1); }} aria-label="Filter by tag" />
      </div>
      {listQ.isLoading ? (
        <div className="space-y-2">{[0, 1, 2].map((i) => <Skeleton key={i} className="h-14" />)}</div>
      ) : listQ.isError ? (
        <p className="rounded-xl border border-danger/50 bg-danger/10 p-4 text-sm text-red-300" role="alert">
          Could not load customers: {(listQ.error as Error).message}
        </p>
      ) : customers.length === 0 ? (
        <EmptyState title="No customers yet" description="Add your first customer — or wait for a visitor to start a widget chat, which creates one automatically." action={<button onClick={() => setModal({ mode: 'create' })} className={btnPrimary}>Add customer</button>} />
      ) : (
        <div className="overflow-x-auto rounded-xl border border-slate-700/60 bg-card">
          <table className="w-full min-w-[640px] text-left text-sm">
            <thead>
              <tr className="border-b border-slate-700/60 text-slate-400">
                <th className="px-4 py-3 font-medium">Name</th>
                <th className="px-4 py-3 font-medium">Email</th>
                <th className="px-4 py-3 font-medium">Tags</th>
                <th className="px-4 py-3 font-medium">Last activity</th>
                <th className="px-4 py-3 font-medium">Actions</th>
              </tr>
            </thead>
            <tbody>
              {customers.map((c) => (
                <tr key={c.id} className="border-b border-slate-800 hover:bg-slate-800/50">
                  <td className="px-4 py-3">
                    <Link to={`/customers/${c.id}`} className="font-medium text-white hover:underline">{c.full_name}</Link>
                  </td>
                  <td className="px-4 py-3 text-slate-300">{c.email}</td>
                  <td className="px-4 py-3">
                    <span className="flex flex-wrap gap-1">
                      {(c.tags ?? []).map((t) => <span key={t} className="rounded-full bg-slate-700 px-2 py-0.5 text-xs text-slate-300">{t}</span>)}
                    </span>
                  </td>
                  <td className="px-4 py-3 text-slate-400">{c.last_activity_at ? formatTime(c.last_activity_at) : 'No activity yet'}</td>
                  <td className="px-4 py-3">
                    <button onClick={() => setModal({ mode: 'edit', customer: c })} className="text-sm text-purple-300 hover:underline">Edit</button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          <div className="p-4"><Pagination page={page} pageSize={20} total={total} onPageChange={setPage} /></div>
        </div>
      )}
      <CustomerModal
        open={modal !== null}
        initial={modal?.mode === 'edit' ? modal.customer : null}
        onClose={() => setModal(null)}
        onSaved={() => {
          setModal(null);
          toast.success(modal?.mode === 'edit' ? 'Customer updated' : 'Customer added');
          void queryClient.invalidateQueries({ queryKey: ['customers', workspaceId] });
        }}
      />
    </div>
  );
}

function CustomerModal({ open, initial, onClose, onSaved }: {
  open: boolean;
  initial: Customer | null;
  onClose: () => void;
  onSaved: () => void;
}) {
  const { workspaceId } = useWorkspace();
  const toast = useToast();
  const [fullName, setFullName] = useState(initial?.full_name ?? '');
  const [email, setEmail] = useState(initial?.email ?? '');
  const [phone, setPhone] = useState(initial?.phone ?? '');
  const [tags, setTags] = useState((initial?.tags ?? []).join(', '));
  const [notes, setNotes] = useState(initial?.notes ?? '');

  // Reset the form whenever a different customer (or create mode) opens.
  const [lastInitial, setLastInitial] = useState(initial?.id ?? 'create');
  if ((initial?.id ?? 'create') !== lastInitial) {
    setLastInitial(initial?.id ?? 'create');
    setFullName(initial?.full_name ?? '');
    setEmail(initial?.email ?? '');
    setPhone(initial?.phone ?? '');
    setTags((initial?.tags ?? []).join(', '));
    setNotes(initial?.notes ?? '');
  }

  const mut = useMutation({
    mutationFn: () => {
      const payload = {
        full_name: fullName.trim(),
        email: email.trim(),
        phone: phone.trim() || null,
        tags: parseTags(tags),
        notes: notes.trim() || null,
      };
      return initial
        ? api.updateCustomer(workspaceId!, initial.id, payload)
        : api.createCustomer(workspaceId!, payload);
    },
    onSuccess: onSaved,
    onError: (err) => toast.error(`Could not save customer: ${(err as Error).message}`),
  });
  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (!fullName.trim() || !email.trim()) return;
    mut.mutate();
  };
  return (
    <Modal open={open} onClose={onClose} title={initial ? 'Edit customer' : 'Add customer'}>
      <form onSubmit={submit} className="space-y-4">
        <label className="block text-sm text-slate-300">Full name
          <input className={`${inputCls} mt-1`} required value={fullName} onChange={(e) => setFullName(e.target.value)} maxLength={100} />
        </label>
        <label className="block text-sm text-slate-300">Email
          <input className={`${inputCls} mt-1`} type="email" required value={email} onChange={(e) => setEmail(e.target.value)} />
        </label>
        <label className="block text-sm text-slate-300">Phone (optional)
          <input className={`${inputCls} mt-1`} value={phone} onChange={(e) => setPhone(e.target.value)} maxLength={30} />
        </label>
        <label className="block text-sm text-slate-300">Tags (comma-separated)
          <input className={`${inputCls} mt-1`} value={tags} onChange={(e) => setTags(e.target.value)} placeholder="vip, beta" />
        </label>
        <label className="block text-sm text-slate-300">Notes
          <textarea className={`${inputCls} mt-1`} value={notes} onChange={(e) => setNotes(e.target.value)} maxLength={2000} />
        </label>
        <div className="flex justify-end gap-2">
          <button type="button" onClick={onClose} className={btnSecondary}>Cancel</button>
          <button type="submit" disabled={mut.isPending} className={btnPrimary}>{mut.isPending ? 'Saving…' : 'Save'}</button>
        </div>
      </form>
    </Modal>
  );
}

export function CustomerDetailPage() {
  const { workspaceId, status: wsStatus, error: wsError, refetchWorkspaces } = useWorkspace();
  const { customerId } = useParams<{ customerId: string }>();
  const toast = useToast();
  const queryClient = useQueryClient();
  const [notesDraft, setNotesDraft] = useState('');
  const [editingNotes, setEditingNotes] = useState(false);

  const detailQ = useQuery({
    queryKey: ['customer', workspaceId, customerId],
    queryFn: () => api.getCustomer(workspaceId!, customerId!),
    enabled: !!workspaceId && !!customerId,
  });
  const ticketsQ = useQuery({
    queryKey: ['customer-tickets', workspaceId, customerId],
    queryFn: () => api.listTickets(workspaceId!, { page: 1, pageSize: 20 }),
    enabled: !!workspaceId,
    select: (d) => d.tickets.filter((t) => t.customer_id === customerId),
  });
  const convsQ = useQuery({
    queryKey: ['customer-conversations', workspaceId, customerId],
    queryFn: () => api.listConversations(workspaceId!, { page: 1, pageSize: 20 }),
    enabled: !!workspaceId,
    select: (d) => d.conversations.filter((c) => c.customer_id === customerId),
  });

  const notesMut = useMutation({
    mutationFn: (notes: string) => api.updateCustomer(workspaceId!, customerId!, { notes: notes || null }),
    onSuccess: () => {
      toast.success('Notes saved');
      setEditingNotes(false);
      void queryClient.invalidateQueries({ queryKey: ['customer', workspaceId, customerId] });
    },
    onError: (err) => toast.error(`Could not save notes: ${(err as Error).message}`),
  });

if (wsStatus === 'auth-loading' || wsStatus === 'loading') return <WorkspaceLoadingSkeleton />;
if (wsStatus === 'error') return <WorkspaceErrorState message={wsError?.message} onRetry={refetchWorkspaces} />;
if (wsStatus === 'empty' || !workspaceId) return <NoWorkspaceState />;
  if (detailQ.isLoading) return <div className="space-y-2"><Skeleton className="h-10" /><Skeleton className="h-64" /></div>;
  if (detailQ.isError || !detailQ.data) {
    return <div className="rounded-xl border border-danger/50 bg-danger/10 p-4 text-sm text-red-300" role="alert">Could not load this customer: {(detailQ.error as Error | undefined)?.message ?? 'Not found'}</div>;
  }
  const { customer, tickets, conversations } = detailQ.data;
  const linkedTickets = ticketsQ.data ?? [];
  const linkedConvs = convsQ.data ?? [];

  return (
    <div className="space-y-4">
      <Link to="/customers" className="flex items-center gap-1 text-sm text-slate-400 hover:text-white">
        <ArrowLeft className="h-4 w-4" /> Back to customers
      </Link>
      <div className="rounded-xl border border-slate-700/60 bg-card p-5">
        <h1 className="text-xl font-bold text-white">{customer.full_name}</h1>
        <dl className="mt-3 space-y-1 text-sm text-slate-300">
          <div className="flex gap-2"><dt className="w-20 text-slate-500">Email</dt><dd>{customer.email}</dd></div>
          <div className="flex gap-2"><dt className="w-20 text-slate-500">Phone</dt><dd>{customer.phone ?? '—'}</dd></div>
          <div className="flex gap-2"><dt className="w-20 text-slate-500">Joined</dt><dd>{formatTime(customer.created_at)}</dd></div>
          <div className="flex gap-2"><dt className="w-20 text-slate-500">Tickets</dt><dd>{tickets.total}</dd></div>
          <div className="flex gap-2"><dt className="w-20 text-slate-500">Conversations</dt><dd>{conversations.total}</dd></div>
        </dl>
        {(customer.tags ?? []).length > 0 && (
          <p className="mt-3 flex flex-wrap gap-1">{customer.tags.map((t) => <span key={t} className="rounded-full bg-slate-700 px-2 py-0.5 text-xs text-slate-300">{t}</span>)}</p>
        )}
        <div className="mt-4">
          <h2 className="font-semibold text-white">Notes</h2>
          {editingNotes ? (
            <form
              onSubmit={(e) => { e.preventDefault(); notesMut.mutate(notesDraft.trim()); }}
              className="mt-2 space-y-2"
            >
              <textarea className={inputCls} rows={4} value={notesDraft} onChange={(e) => setNotesDraft(e.target.value)} maxLength={2000} aria-label="Customer notes" />
              <div className="flex gap-2">
                <button type="submit" disabled={notesMut.isPending} className={btnPrimary}>Save notes</button>
                <button type="button" onClick={() => { setEditingNotes(false); setNotesDraft(customer.notes ?? ''); }} className={btnSecondary}>Cancel</button>
              </div>
            </form>
          ) : (
            <>
              <p className="mt-2 whitespace-pre-wrap text-sm text-slate-300">{customer.notes ?? 'No notes yet.'}</p>
              <button onClick={() => { setNotesDraft(customer.notes ?? ''); setEditingNotes(true); }} className={`${btnSecondary} mt-2`}>Edit notes</button>
            </>
          )}
        </div>
      </div>

      <div className="grid gap-4 lg:grid-cols-2">
        <div className="rounded-xl border border-slate-700/60 bg-card p-5">
          <h2 className="font-semibold text-white">Conversation history</h2>
          {linkedConvs.length === 0 ? (
            <p className="mt-2 text-sm text-slate-400">No conversations yet.</p>
          ) : (
            <ul className="mt-2 space-y-2">
              {linkedConvs.map((c) => (
                <li key={c.id} className="rounded-lg bg-slate-800 p-2 text-sm">
                  <Link to={`/inbox/${c.id}`} className="text-purple-300 hover:underline">
                    {c.status} · {c.last_message?.body ?? 'No messages yet'}
                  </Link>
                  <span className="block text-xs text-slate-500">{formatTime(c.last_message_at ?? c.created_at)}</span>
                </li>
              ))}
            </ul>
          )}
        </div>
        <div className="rounded-xl border border-slate-700/60 bg-card p-5">
          <h2 className="font-semibold text-white">Linked tickets</h2>
          {linkedTickets.length === 0 ? (
            <p className="mt-2 text-sm text-slate-400">No tickets for this customer yet.</p>
          ) : (
            <ul className="mt-2 space-y-2">
              {linkedTickets.map((t) => (
                <li key={t.id} className="rounded-lg bg-slate-800 p-2 text-sm">
                  <Link to={`/tickets/${t.id}`} className="text-purple-300 hover:underline">{t.subject}</Link>
                  <span className="block text-xs text-slate-500">{t.status} · {t.priority}</span>
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>
    </div>
  );
}
