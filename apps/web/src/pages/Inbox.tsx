import { useEffect, useRef, useState, type FormEvent } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { ArrowLeft, MessageSquare, Send } from 'lucide-react';
import { api, type Conversation, type Message } from '../lib/api';
import { supabase } from '../lib/supabase';
import { useWorkspace } from '../context/WorkspaceContext';
import { useToast } from '../components/Toast';
import {
  EmptyState, NoWorkspaceState, PriorityBadge, Skeleton, StatusBadge,
  btnPrimary, btnSecondary, inputCls, selectCls,
} from '../components/ui';

function timeAgo(iso: string | null | undefined): string {
  if (!iso) return '';
  const mins = Math.floor((Date.now() - new Date(iso).getTime()) / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

function formatTime(iso: string): string {
  return new Date(iso).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
}

export default function Inbox() {
  const { workspaceId } = useWorkspace();
  const { conversationId } = useParams<{ conversationId?: string }>();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [search, setSearch] = useState('');
  const [statusFilter, setStatusFilter] = useState('');
  const [assignedFilter, setAssignedFilter] = useState('');
  const [page, setPage] = useState(1);

  const listQ = useQuery({
    queryKey: ['conversations', workspaceId, search, statusFilter, assignedFilter, page],
    queryFn: () =>
      api.listConversations(workspaceId!, {
        page, pageSize: 20, search: search || undefined,
        status: statusFilter || undefined, assignedTo: assignedFilter || undefined,
      }),
    enabled: !!workspaceId,
  });
  const membersQ = useQuery({
    queryKey: ['members', workspaceId],
    queryFn: () => api.listMembers(workspaceId!),
    enabled: !!workspaceId,
  });
  const conversations = listQ.data?.conversations ?? [];
  const total = listQ.data?.total ?? 0;

  // Realtime: subscribe to new messages in THIS workspace only. If the
  // channel fails, the 5s polling fallback on the open thread still works.
  useEffect(() => {
    if (!workspaceId) return;
    const channel = supabase
      .channel(`messages-${workspaceId}`)
      .on(
        'postgres_changes',
        { event: 'INSERT', schema: 'public', table: 'messages', filter: `workspace_id=eq.${workspaceId}` },
        (payload) => {
          const convId = (payload.new as { conversation_id?: string }).conversation_id;
          if (convId) queryClient.invalidateQueries({ queryKey: ['messages', workspaceId, convId] });
          queryClient.invalidateQueries({ queryKey: ['conversations', workspaceId] });
        },
      )
      .subscribe();
    return () => {
      void supabase.removeChannel(channel);
    };
  }, [workspaceId, queryClient]);

  if (!workspaceId) return <NoWorkspaceState />;

  const showThread = !!conversationId;
  return (
    <div className="space-y-4">
      <h1 className="text-2xl font-bold text-white">Inbox</h1>
      <div className="grid gap-4 lg:grid-cols-[320px_minmax(0,1fr)_280px]">
        {/* Conversation list — hidden on mobile while a thread is open */}
        <div className={`rounded-xl border border-slate-700/60 bg-card ${showThread ? 'hidden lg:block' : ''}`}>
          <div className="space-y-2 border-b border-slate-700/60 p-3">
            <input
              className={inputCls}
              placeholder="Search by customer name or email…"
              value={search}
              onChange={(e) => { setSearch(e.target.value); setPage(1); }}
              aria-label="Search conversations"
            />
            <div className="flex gap-2">
              <select className={`${selectCls} flex-1`} value={statusFilter} onChange={(e) => { setStatusFilter(e.target.value); setPage(1); }} aria-label="Filter by status">
                <option value="">All statuses</option>
                {(['open', 'pending', 'resolved', 'closed'] as const).map((s) => <option key={s} value={s}>{s}</option>)}
              </select>
              <select className={`${selectCls} flex-1`} value={assignedFilter} onChange={(e) => { setAssignedFilter(e.target.value); setPage(1); }} aria-label="Filter by assignee">
                <option value="">Anyone</option>
                <option value="unassigned">Unassigned</option>
                {(membersQ.data?.members ?? []).map((m) => <option key={m.user_id} value={m.user_id}>{m.user_id.slice(0, 8)}… ({m.role})</option>)}
              </select>
            </div>
          </div>
          {listQ.isLoading ? (
            <div className="space-y-2 p-3">{[0, 1, 2].map((i) => <Skeleton key={i} className="h-16" />)}</div>
          ) : listQ.isError ? (
            <p className="p-4 text-sm text-red-300" role="alert">Could not load conversations: {(listQ.error as Error).message}</p>
          ) : conversations.length === 0 ? (
            <div className="p-4">
              <EmptyState title="No conversations yet" description="Visitor messages from the chat widget will appear here." />
            </div>
          ) : (
            <ul className="divide-y divide-slate-700/60">
              {conversations.map((c: Conversation) => (
                <li key={c.id}>
                  <Link
                    to={`/inbox/${c.id}`}
                    className={`block p-3 hover:bg-slate-800/60 ${c.id === conversationId ? 'bg-primary/10' : ''}`}
                    aria-current={c.id === conversationId ? 'true' : undefined}
                  >
                    <div className="flex items-center justify-between gap-2">
                      <span className="truncate text-sm font-medium text-white">{c.customer?.full_name ?? 'Unknown customer'}</span>
                      {(c.unread_count ?? 0) > 0 && (
                        <span className="flex h-5 min-w-5 shrink-0 items-center justify-center rounded-full bg-primary px-1.5 text-[11px] font-bold text-white" aria-label={`${c.unread_count} unread messages`}>
                          {c.unread_count}
                        </span>
                      )}
                    </div>
                    <p className="mt-1 truncate text-xs text-slate-400">{c.last_message?.body ?? 'No messages yet'}</p>
                    <div className="mt-1.5 flex items-center gap-2 text-[11px] text-slate-500">
                      <StatusBadge status={c.status} />
                      <span>{timeAgo(c.last_message_at ?? c.created_at)}</span>
                    </div>
                  </Link>
                </li>
              ))}
            </ul>
          )}
          {total > 20 && (
            <div className="flex justify-between p-3 text-sm">
              <button disabled={page <= 1} onClick={() => setPage(page - 1)} className={btnSecondary}>Previous</button>
              <button disabled={page * 20 >= total} onClick={() => setPage(page + 1)} className={btnSecondary}>Next</button>
            </div>
          )}
        </div>

        {/* Thread */}
        <div className={showThread ? '' : 'hidden lg:block'}>
          {conversationId ? (
            <Thread
              key={conversationId}
              conversationId={conversationId}
              onBack={() => navigate('/inbox')}
            />
          ) : (
            <div className="rounded-xl border border-slate-700/60 bg-card p-10 text-center">
              <MessageSquare className="mx-auto mb-3 h-8 w-8 text-primary" />
              <p className="text-slate-400">Select a conversation to read and reply.</p>
            </div>
          )}
        </div>

        {/* Right panel */}
        <div className={showThread ? 'hidden lg:block' : 'hidden lg:block'}>
          {conversationId && <ConversationPanel key={`panel-${conversationId}`} conversationId={conversationId} />}
        </div>
      </div>
    </div>
  );
}

function Thread({ conversationId, onBack }: { conversationId: string; onBack: () => void }) {
  const { workspaceId } = useWorkspace();
  const toast = useToast();
  const queryClient = useQueryClient();
  const [draft, setDraft] = useState('');
  const bottomRef = useRef<HTMLDivElement>(null);

  const detailQ = useQuery({
    queryKey: ['conversation', workspaceId, conversationId],
    queryFn: () => api.getConversation(workspaceId!, conversationId),
    enabled: !!workspaceId,
  });
  // Poll every 5s while open — the fallback if Supabase Realtime is unavailable.
  const messagesQ = useQuery({
    queryKey: ['messages', workspaceId, conversationId],
    queryFn: () => api.listMessages(workspaceId!, conversationId, { page: 1, pageSize: 100 }),
    enabled: !!workspaceId,
    refetchInterval: 5000,
  });
  const messages = messagesQ.data?.messages ?? [];

  // Mark customer messages read when the thread opens.
  useEffect(() => {
    if (!workspaceId) return;
    api.markConversationRead(workspaceId, conversationId)
      .then(() => queryClient.invalidateQueries({ queryKey: ['conversations', workspaceId] }))
      .catch(() => { /* read marking is best-effort */ });
  }, [workspaceId, conversationId, queryClient]);

  useEffect(() => {
    bottomRef.current?.scrollIntoView?.({ behavior: 'smooth' });
  }, [messages.length]);

  const sendMut = useMutation({
    mutationFn: (body: string) =>
      api.sendMessage(workspaceId!, conversationId, { body, client_message_id: crypto.randomUUID() }),
    onSuccess: () => {
      setDraft('');
      void queryClient.invalidateQueries({ queryKey: ['messages', workspaceId, conversationId] });
      void queryClient.invalidateQueries({ queryKey: ['conversations', workspaceId] });
    },
    onError: (err) => toast.error(`Could not send message: ${(err as Error).message}`),
  });

  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (!draft.trim() || sendMut.isPending) return;
    sendMut.mutate(draft.trim());
  };

  if (!workspaceId) return null;
  if (detailQ.isLoading || messagesQ.isLoading) {
    return <div className="space-y-2 rounded-xl border border-slate-700/60 bg-card p-4"><Skeleton className="h-10" /><Skeleton className="h-64" /></div>;
  }
  if (detailQ.isError || !detailQ.data) {
    return <div className="rounded-xl border border-danger/50 bg-danger/10 p-4 text-sm text-red-300" role="alert">Could not load this conversation: {(detailQ.error as Error | undefined)?.message ?? 'Not found'}</div>;
  }
  const conv = detailQ.data.conversation;
  return (
    <div className="flex flex-col rounded-xl border border-slate-700/60 bg-card">
      <div className="flex items-center gap-3 border-b border-slate-700/60 p-3">
        <button onClick={onBack} className="rounded-lg p-1 text-slate-400 hover:bg-slate-700 lg:hidden" aria-label="Back to conversation list">
          <ArrowLeft className="h-5 w-5" />
        </button>
        <div className="min-w-0 flex-1">
          <p className="truncate font-medium text-white">{detailQ.data.customer?.full_name ?? 'Unknown customer'}</p>
          <p className="truncate text-xs text-slate-400">{detailQ.data.customer?.email ?? ''}</p>
        </div>
        <StatusBadge status={conv.status} />
        <PriorityBadge priority={conv.priority} />
      </div>
      <div className="max-h-[55vh] min-h-64 space-y-3 overflow-y-auto p-4" aria-live="polite">
        {messages.length === 0 ? (
          <p className="text-center text-sm text-slate-400">No messages yet — write the first reply below.</p>
        ) : (
          messages.map((m: Message) => (
            <div key={m.id} className={`flex ${m.sender_type === 'agent' ? 'justify-end' : 'justify-start'}`}>
              <div className={`max-w-[80%] rounded-2xl px-3 py-2 ${m.sender_type === 'agent' ? 'bg-primary text-white' : m.sender_type === 'system' ? 'bg-slate-700 text-slate-300' : 'bg-slate-700 text-slate-100'}`}>
                <p className="whitespace-pre-wrap text-sm">{m.body}</p>
                <p className={`mt-1 text-right text-[11px] ${m.sender_type === 'agent' ? 'text-purple-200' : 'text-slate-400'}`}>
                  {m.sender_type === 'agent' ? 'You' : m.sender_type === 'system' ? 'System' : 'Customer'} · {formatTime(m.created_at)}
                </p>
              </div>
            </div>
          ))
        )}
        <div ref={bottomRef} />
      </div>
      <form onSubmit={submit} className="flex gap-2 border-t border-slate-700/60 p-3">
        <label htmlFor="inbox-composer" className="sr-only">Reply to customer</label>
        <input
          id="inbox-composer"
          className={inputCls}
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          placeholder="Type your reply…"
          maxLength={5000}
        />
        <button type="submit" disabled={sendMut.isPending || !draft.trim()} className={btnPrimary} aria-label="Send reply">
          <Send className="h-4 w-4" /> {sendMut.isPending ? 'Sending…' : 'Send'}
        </button>
      </form>
      {sendMut.isError && <p className="px-4 pb-3 text-sm text-red-300" role="alert">Send failed — try again.</p>}
    </div>
  );
}

function ConversationPanel({ conversationId }: { conversationId: string }) {
  const { workspaceId } = useWorkspace();
  const toast = useToast();
  const queryClient = useQueryClient();
  const [noteDraft, setNoteDraft] = useState('');

  const detailQ = useQuery({
    queryKey: ['conversation', workspaceId, conversationId],
    queryFn: () => api.getConversation(workspaceId!, conversationId),
    enabled: !!workspaceId,
  });
  const notesQ = useQuery({
    queryKey: ['conversation-notes', workspaceId, conversationId],
    queryFn: () => api.listConversationNotes(workspaceId!, conversationId),
    enabled: !!workspaceId,
  });
  const membersQ = useQuery({
    queryKey: ['members', workspaceId],
    queryFn: () => api.listMembers(workspaceId!),
    enabled: !!workspaceId,
  });
  const ticketsQ = useQuery({
    queryKey: ['tickets-for-conversation', workspaceId, conversationId],
    queryFn: () => api.listTickets(workspaceId!, { page: 1, pageSize: 100 }),
    enabled: !!workspaceId,
    select: (d) => d.tickets.filter((t) => t.conversation_id === conversationId),
  });

  const updateMut = useMutation({
    mutationFn: (patch: Parameters<typeof api.updateConversation>[2]) => api.updateConversation(workspaceId!, conversationId, patch),
    onSuccess: () => {
      toast.success('Conversation updated');
      void queryClient.invalidateQueries({ queryKey: ['conversation', workspaceId, conversationId] });
      void queryClient.invalidateQueries({ queryKey: ['conversations', workspaceId] });
    },
    onError: (err) => toast.error(`Update failed: ${(err as Error).message}`),
  });
  const noteMut = useMutation({
    mutationFn: (body: string) => api.addConversationNote(workspaceId!, conversationId, body),
    onSuccess: () => {
      setNoteDraft('');
      toast.success('Note added');
      void queryClient.invalidateQueries({ queryKey: ['conversation-notes', workspaceId, conversationId] });
    },
    onError: (err) => toast.error(`Could not add note: ${(err as Error).message}`),
  });

  if (!workspaceId || detailQ.isLoading) return <Skeleton className="h-64" />;
  const conv = detailQ.data?.conversation;
  const customer = detailQ.data?.customer;
  if (!conv) return null;
  const linkedTicket = ticketsQ.data?.[0];

  return (
    <div className="space-y-4 rounded-xl border border-slate-700/60 bg-card p-4">
      <div>
        <h2 className="font-semibold text-white">Customer</h2>
        {customer ? (
          <div className="mt-2 text-sm">
            <Link to={`/customers/${customer.id}`} className="font-medium text-purple-300 hover:underline">{customer.full_name}</Link>
            <p className="text-slate-400">{customer.email}</p>
            {customer.phone && <p className="text-slate-400">{customer.phone}</p>}
            {(customer.tags ?? []).length > 0 && (
              <p className="mt-1 flex flex-wrap gap-1">{customer.tags.map((t) => <span key={t} className="rounded-full bg-slate-700 px-2 py-0.5 text-xs text-slate-300">{t}</span>)}</p>
            )}
          </div>
        ) : (
          <p className="mt-2 text-sm text-slate-400">Customer record not found.</p>
        )}
      </div>

      <div>
        <h2 className="font-semibold text-white">Linked ticket</h2>
        {linkedTicket ? (
          <Link to={`/tickets/${linkedTicket.id}`} className="mt-2 block rounded-lg bg-slate-800 p-2 text-sm text-purple-300 hover:underline">
            {linkedTicket.subject} <StatusBadge status={linkedTicket.status} />
          </Link>
        ) : (
          <p className="mt-2 text-sm text-slate-400">No ticket linked to this conversation.</p>
        )}
      </div>

      <div className="space-y-2">
        <label className="block text-sm text-slate-300">Assigned agent
          <select
            className={`${selectCls} mt-1 w-full`}
            value={conv.assigned_to ?? ''}
            onChange={(e) => updateMut.mutate({ assigned_to: e.target.value || null })}
            aria-label="Assigned agent"
          >
            <option value="">Unassigned</option>
            {(membersQ.data?.members ?? []).map((m) => (
              <option key={m.user_id} value={m.user_id}>{m.user_id.slice(0, 8)}… ({m.role})</option>
            ))}
          </select>
        </label>
        <label className="block text-sm text-slate-300">Priority
          <select
            className={`${selectCls} mt-1 w-full`}
            value={conv.priority}
            onChange={(e) => updateMut.mutate({ priority: e.target.value as Conversation['priority'] })}
            aria-label="Priority"
          >
            {(['low', 'medium', 'high', 'urgent'] as const).map((p) => <option key={p} value={p}>{p}</option>)}
          </select>
        </label>
        <label className="block text-sm text-slate-300">Status
          <select
            className={`${selectCls} mt-1 w-full`}
            value={conv.status}
            onChange={(e) => updateMut.mutate({ status: e.target.value as Conversation['status'] })}
            aria-label="Conversation status"
          >
            {(['open', 'pending', 'resolved', 'closed'] as const).map((s) => <option key={s} value={s}>{s}</option>)}
          </select>
        </label>
        {(conv.tags ?? []).length > 0 && (
          <p className="flex flex-wrap gap-1">{conv.tags.map((t) => <span key={t} className="rounded-full bg-slate-700 px-2 py-0.5 text-xs text-slate-300">{t}</span>)}</p>
        )}
      </div>

      <div>
        <h2 className="font-semibold text-white">Internal notes</h2>
        <p className="text-xs text-slate-500">Only your team sees these — never shown to the customer.</p>
        <ul className="mt-2 space-y-2">
          {(notesQ.data?.notes ?? []).map((n) => (
            <li key={n.id} className="rounded-lg bg-slate-800 p-2 text-sm text-slate-200">
              {n.body}
              <span className="mt-1 block text-[11px] text-slate-500">{formatTime(n.created_at)}</span>
            </li>
          ))}
          {(notesQ.data?.notes ?? []).length === 0 && <li className="text-sm text-slate-400">No internal notes yet.</li>}
        </ul>
        <form
          className="mt-2 flex gap-2"
          onSubmit={(e) => { e.preventDefault(); if (noteDraft.trim()) noteMut.mutate(noteDraft.trim()); }}
        >
          <label htmlFor="conv-note" className="sr-only">Add an internal note</label>
          <input id="conv-note" className={inputCls} value={noteDraft} onChange={(e) => setNoteDraft(e.target.value)} placeholder="Add a note…" maxLength={5000} />
          <button type="submit" disabled={noteMut.isPending || !noteDraft.trim()} className={btnSecondary}>Add</button>
        </form>
      </div>
    </div>
  );
}
