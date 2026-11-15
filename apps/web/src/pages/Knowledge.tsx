import { useState, type FormEvent } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { BookOpen, Plus, RefreshCw } from 'lucide-react';
import { api, type KnowledgeDocument, type KnowledgeKind } from '../lib/api';
import { useWorkspace } from '../context/WorkspaceContext';
import { useToast } from '../components/Toast';
import {
  EmptyState, Modal, NoWorkspaceState, Pagination, Skeleton, WorkspaceErrorState,
  WorkspaceLoadingSkeleton, btnPrimary, btnSecondary, inputCls, selectCls,
} from '../components/ui';

function formatTime(iso: string): string {
  return new Date(iso).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
}

/** Indexing badge: only shows a real status when the API returned one. */
function IndexingBadge({ doc }: { doc: KnowledgeDocument }) {
  const raw = doc.latest_job_status ?? doc.indexing_status ?? null;
  if (!raw) return <span className="text-xs text-slate-500">—</span>;
  const lower = raw.toLowerCase();
  if (lower.includes('fail') || lower.includes('error')) {
    return <span className="rounded-full bg-danger/15 px-2.5 py-0.5 text-xs font-medium text-red-300">Failed</span>;
  }
  if (lower.includes('complete') || lower.includes('success') || lower === 'indexed' || lower === 'done') {
    return <span className="rounded-full bg-success/15 px-2.5 py-0.5 text-xs font-medium text-green-300">Indexed</span>;
  }
  if (lower.includes('process') || lower.includes('pending') || lower.includes('index')) {
    return <span className="rounded-full bg-warning/15 px-2.5 py-0.5 text-xs font-medium text-amber-300">Indexing</span>;
  }
  return <span className="rounded-full bg-slate-700/60 px-2.5 py-0.5 text-xs font-medium text-slate-300">{raw}</span>;
}

export default function Knowledge() {
  const { workspaceId, status: wsStatus, error: wsError, refetchWorkspaces } = useWorkspace();
  const toast = useToast();
  const queryClient = useQueryClient();
  const [search, setSearch] = useState('');
  const [kindFilter, setKindFilter] = useState('');
  const [page, setPage] = useState(1);
  const [createOpen, setCreateOpen] = useState(false);
  const [editing, setEditing] = useState<KnowledgeDocument | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<KnowledgeDocument | null>(null);

  const listQ = useQuery({
    queryKey: ['knowledge', workspaceId, search, kindFilter, page],
    queryFn: () => api.listKnowledge(workspaceId!, {
      page, pageSize: 20, q: search || undefined, kind: kindFilter || undefined,
    }),
    enabled: !!workspaceId,
  });
  const docs = listQ.data?.knowledge_documents ?? [];
  const total = listQ.data?.total ?? 0;

  const invalidate = () => {
    void queryClient.invalidateQueries({ queryKey: ['knowledge', workspaceId] });
  };
  const toggleMut = useMutation({
    mutationFn: (doc: KnowledgeDocument) => api.updateKnowledge(workspaceId!, doc.id, { enabled: !doc.enabled }),
    onSuccess: () => { toast.success('Document updated'); invalidate(); },
    onError: (err) => toast.error(`Update failed: ${(err as Error).message}`),
  });
  const deleteMut = useMutation({
    mutationFn: (doc: KnowledgeDocument) => api.deleteKnowledge(workspaceId!, doc.id),
    onSuccess: () => { toast.success('Document archived'); setDeleteTarget(null); invalidate(); },
    onError: (err) => toast.error(`Archive failed: ${(err as Error).message}`),
  });
  const reindexMut = useMutation({
    mutationFn: (doc: KnowledgeDocument) => api.reindexKnowledge(workspaceId!, doc.id),
    onSuccess: () => { toast.success('Reindexing started'); invalidate(); },
    onError: (err) => toast.error(`Reindex failed: ${(err as Error).message}`),
  });

  if (wsStatus === 'auth-loading' || wsStatus === 'loading') return <WorkspaceLoadingSkeleton />;
  if (wsStatus === 'error') return <WorkspaceErrorState message={wsError?.message} onRetry={refetchWorkspaces} />;
  if (wsStatus === 'empty' || !workspaceId) return <NoWorkspaceState />;

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold text-white">Knowledge Base</h1>
          <p className="text-sm text-slate-400">Articles and FAQs the AI answers from. Only enabled documents are used.</p>
        </div>
        <button onClick={() => setCreateOpen(true)} className={`${btnPrimary} flex items-center gap-2`}>
          <Plus className="h-4 w-4" /> New document
        </button>
      </div>

      <div className="flex flex-wrap gap-2 rounded-xl border border-slate-700/60 bg-card p-3">
        <input
          className={`${inputCls} min-w-48 flex-1`}
          placeholder="Search by title…"
          value={search}
          onChange={(e) => { setSearch(e.target.value); setPage(1); }}
          aria-label="Search knowledge documents"
        />
        <select className={selectCls} value={kindFilter} onChange={(e) => { setKindFilter(e.target.value); setPage(1); }} aria-label="Filter by kind">
          <option value="">All kinds</option>
          <option value="article">Article</option>
          <option value="faq">FAQ</option>
        </select>
      </div>

      {listQ.isLoading ? (
        <div className="space-y-2">{[0, 1, 2].map((i) => <Skeleton key={i} className="h-16" />)}</div>
      ) : listQ.isError ? (
        <p className="rounded-xl border border-danger/50 bg-danger/10 p-4 text-sm text-red-300" role="alert">
          Could not load knowledge documents: {(listQ.error as Error).message}
        </p>
      ) : docs.length === 0 ? (
        <EmptyState
          title="No knowledge articles yet"
          description="Add your first article or FAQ — the AI will ground its answers in these documents."
          action={<button onClick={() => setCreateOpen(true)} className={btnPrimary}>New document</button>}
        />
      ) : (
        <div className="overflow-x-auto rounded-xl border border-slate-700/60 bg-card">
          <table className="w-full min-w-[720px] text-left text-sm">
            <thead>
              <tr className="border-b border-slate-700/60 text-slate-400">
                <th className="px-4 py-3 font-medium">Title</th>
                <th className="px-4 py-3 font-medium">Kind</th>
                <th className="px-4 py-3 font-medium">Indexing</th>
                <th className="px-4 py-3 font-medium">Enabled</th>
                <th className="px-4 py-3 font-medium">Updated</th>
                <th className="px-4 py-3 font-medium">Actions</th>
              </tr>
            </thead>
            <tbody>
              {docs.map((doc) => (
                <tr key={doc.id} className="border-b border-slate-800 hover:bg-slate-800/50">
                  <td className="px-4 py-3">
                    <span className="flex items-center gap-2 font-medium text-white">
                      <BookOpen className="h-4 w-4 shrink-0 text-primary" /> {doc.title}
                    </span>
                    <span className="block max-w-md truncate text-xs text-slate-500">{doc.content}</span>
                  </td>
                  <td className="px-4 py-3 capitalize text-slate-300">{doc.kind}</td>
                  <td className="px-4 py-3"><IndexingBadge doc={doc} /></td>
                  <td className="px-4 py-3">
                    <button
                      role="switch"
                      aria-checked={doc.enabled}
                      aria-label={`Enable ${doc.title}`}
                      disabled={toggleMut.isPending}
                      onClick={() => toggleMut.mutate(doc)}
                      className={`relative h-6 w-11 rounded-full transition-colors ${doc.enabled ? 'bg-success' : 'bg-slate-600'}`}
                    >
                      <span className={`absolute left-0.5 top-0.5 h-5 w-5 rounded-full bg-white transition-transform ${doc.enabled ? 'translate-x-5' : ''}`} />
                    </button>
                  </td>
                  <td className="px-4 py-3 text-slate-400">{formatTime(doc.updated_at)}</td>
                  <td className="px-4 py-3">
                    <div className="flex flex-wrap gap-2">
                      <button onClick={() => setEditing(doc)} className={btnSecondary}>Edit</button>
                      <button
                        onClick={() => reindexMut.mutate(doc)}
                        disabled={reindexMut.isPending}
                        className={`${btnSecondary} flex items-center gap-1`}
                      >
                        <RefreshCw className="h-3.5 w-3.5" /> Reindex
                      </button>
                      <button onClick={() => setDeleteTarget(doc)} className="rounded-lg bg-danger/15 px-3 py-1.5 text-sm text-red-300 hover:bg-danger/25">
                        Archive
                      </button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          <div className="p-4"><Pagination page={page} pageSize={20} total={total} onPageChange={setPage} /></div>
        </div>
      )}

      <KnowledgeFormModal
        open={createOpen}
        onClose={() => setCreateOpen(false)}
        onSaved={() => { setCreateOpen(false); invalidate(); }}
      />
      <KnowledgeFormModal
        open={!!editing}
        doc={editing ?? undefined}
        onClose={() => setEditing(null)}
        onSaved={() => { setEditing(null); invalidate(); }}
      />
      <Modal open={!!deleteTarget} onClose={() => setDeleteTarget(null)} title="Archive document">
        <p className="text-sm text-slate-300">
          Archive “{deleteTarget?.title}”? It will no longer be used for AI answers. This cannot be undone from here.
        </p>
        <div className="mt-4 flex justify-end gap-2">
          <button onClick={() => setDeleteTarget(null)} className={btnSecondary}>Cancel</button>
          <button
            onClick={() => deleteTarget && deleteMut.mutate(deleteTarget)}
            disabled={deleteMut.isPending}
            className="rounded-lg bg-danger px-4 py-2 text-sm font-medium text-white hover:bg-red-600 disabled:opacity-50"
          >
            {deleteMut.isPending ? 'Archiving…' : 'Archive'}
          </button>
        </div>
      </Modal>
    </div>
  );
}

function KnowledgeFormModal({
  open, doc, onClose, onSaved,
}: {
  open: boolean;
  doc?: KnowledgeDocument;
  onClose: () => void;
  onSaved: () => void;
}) {
  const { workspaceId } = useWorkspace();
  const toast = useToast();
  const [title, setTitle] = useState('');
  const [kind, setKind] = useState<KnowledgeKind>('article');
  const [content, setContent] = useState('');
  const [enabled, setEnabled] = useState(true);

  // Prefill when editing a different document.
  const [lastDocId, setLastDocId] = useState<string | undefined>(undefined);
  if (doc?.id !== lastDocId) {
    setLastDocId(doc?.id);
    setTitle(doc?.title ?? '');
    setKind(doc?.kind ?? 'article');
    setContent(doc?.content ?? '');
    setEnabled(doc?.enabled ?? true);
  }

  const saveMut = useMutation({
    mutationFn: () => {
      if (!workspaceId) throw new Error('No workspace selected');
      const payload = { title: title.trim(), content: content.trim(), kind };
      return doc
        ? api.updateKnowledge(workspaceId, doc.id, { ...payload, enabled })
        : api.createKnowledge(workspaceId, payload);
    },
    onSuccess: () => { toast.success(doc ? 'Document updated' : 'Document created'); onSaved(); },
    onError: (err) => toast.error(`Could not save document: ${(err as Error).message}`),
  });

  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (!title.trim() || !content.trim()) return;
    saveMut.mutate();
  };

  return (
    <Modal open={open} onClose={onClose} title={doc ? 'Edit document' : 'New document'}>
      <form onSubmit={submit} className="space-y-4">
        <label className="block text-sm text-slate-300">Title
          <input className={`${inputCls} mt-1`} required value={title} onChange={(e) => setTitle(e.target.value)} placeholder="e.g. Refund policy" maxLength={200} />
        </label>
        <label className="block text-sm text-slate-300">Kind
          <select className={`${selectCls} mt-1 w-full`} value={kind} onChange={(e) => setKind(e.target.value as KnowledgeKind)}>
            <option value="article">Article</option>
            <option value="faq">FAQ</option>
          </select>
        </label>
        <label className="block text-sm text-slate-300">Content
          <textarea className={`${inputCls} mt-1`} required value={content} onChange={(e) => setContent(e.target.value)} placeholder="Write the facts the AI should answer from…" rows={8} maxLength={20000} />
        </label>
        {doc && (
          <label className="flex items-center gap-2 text-sm text-slate-300">
            <input type="checkbox" checked={enabled} onChange={(e) => setEnabled(e.target.checked)} />
            Enabled — the AI may use this document
          </label>
        )}
        <div className="flex justify-end gap-2">
          <button type="button" onClick={onClose} className={btnSecondary}>Cancel</button>
          <button type="submit" disabled={saveMut.isPending || !title.trim() || !content.trim()} className={btnPrimary}>
            {saveMut.isPending ? 'Saving…' : doc ? 'Save changes' : 'Create document'}
          </button>
        </div>
      </form>
    </Modal>
  );
}
