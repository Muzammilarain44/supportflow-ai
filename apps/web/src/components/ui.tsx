import { useEffect, useRef, type ReactNode } from 'react';
import { X } from 'lucide-react';

export function Skeleton({ className = '' }: { className?: string }) {
  return <div className={`animate-pulse rounded-lg bg-slate-700/60 ${className}`} aria-hidden="true" />;
}

export function EmptyState({
  title,
  description,
  action,
}: {
  title: string;
  description?: string;
  action?: ReactNode;
}) {
  return (
    <div className="rounded-xl border border-slate-700/60 bg-card p-10 text-center">
      <h2 className="text-lg font-semibold text-white">{title}</h2>
      {description && <p className="mx-auto mt-2 max-w-md text-sm text-slate-400">{description}</p>}
      {action && <div className="mt-4">{action}</div>}
    </div>
  );
}

export function Modal({
  open,
  onClose,
  title,
  children,
}: {
  open: boolean;
  onClose: () => void;
  title: string;
  children: ReactNode;
}) {
  const panelRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
      // Focus trap-lite: keep Tab inside the dialog.
      if (e.key === 'Tab' && panelRef.current) {
        const focusables = panelRef.current.querySelectorAll<HTMLElement>(
          'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])',
        );
        if (focusables.length === 0) return;
        const first = focusables[0];
        const last = focusables[focusables.length - 1];
        if (e.shiftKey && document.activeElement === first) {
          e.preventDefault();
          last.focus();
        } else if (!e.shiftKey && document.activeElement === last) {
          e.preventDefault();
          first.focus();
        }
      }
    };
    document.addEventListener('keydown', onKey);
    const first = panelRef.current?.querySelector<HTMLElement>('button, input, select, textarea, [href]');
    first?.focus();
    return () => document.removeEventListener('keydown', onKey);
  }, [open, onClose]);
  if (!open) return null;
  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4"
      onClick={onClose}
      role="presentation"
    >
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-label={title}
        className="max-h-[90vh] w-full max-w-lg overflow-y-auto rounded-2xl border border-slate-700 bg-card p-6 shadow-xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="mb-4 flex items-center justify-between">
          <h2 className="text-lg font-semibold text-white">{title}</h2>
          <button onClick={onClose} aria-label="Close dialog" className="rounded-lg p-1 text-slate-400 hover:bg-slate-700 hover:text-white">
            <X className="h-5 w-5" />
          </button>
        </div>
        {children}
      </div>
    </div>
  );
}

const statusStyles: Record<string, string> = {
  open: 'bg-primary/15 text-purple-300',
  in_progress: 'bg-warning/15 text-amber-300',
  waiting_for_customer: 'bg-warning/15 text-amber-300',
  pending: 'bg-warning/15 text-amber-300',
  resolved: 'bg-success/15 text-green-300',
  closed: 'bg-slate-700/60 text-slate-300',
};
const priorityStyles: Record<string, string> = {
  urgent: 'bg-danger/15 text-red-300',
  high: 'bg-warning/15 text-amber-300',
  medium: 'bg-primary/15 text-purple-300',
  low: 'bg-slate-700/60 text-slate-300',
};
const roleStyles: Record<string, string> = {
  owner: 'bg-primary/15 text-purple-300',
  admin: 'bg-warning/15 text-amber-300',
  member: 'bg-slate-700/60 text-slate-300',
};

function label(value: string) {
  return value.replace(/_/g, ' ');
}

export function StatusBadge({ status }: { status: string }) {
  return (
    <span className={`inline-block rounded-full px-2.5 py-0.5 text-xs font-medium capitalize ${statusStyles[status] ?? 'bg-slate-700/60 text-slate-300'}`}>
      {label(status)}
    </span>
  );
}

export function PriorityBadge({ priority }: { priority: string }) {
  return (
    <span className={`inline-block rounded-full px-2.5 py-0.5 text-xs font-medium capitalize ${priorityStyles[priority] ?? 'bg-slate-700/60 text-slate-300'}`}>
      {label(priority)}
    </span>
  );
}

export function RoleBadge({ role }: { role: string }) {
  return (
    <span className={`inline-block rounded-full px-2.5 py-0.5 text-xs font-medium capitalize ${roleStyles[role] ?? 'bg-slate-700/60 text-slate-300'}`}>
      {label(role)}
    </span>
  );
}

export function Pagination({
  page,
  pageSize,
  total,
  onPageChange,
}: {
  page: number;
  pageSize: number;
  total: number;
  onPageChange: (page: number) => void;
}) {
  const totalPages = Math.max(1, Math.ceil(total / pageSize));
  return (
    <div className="flex items-center justify-between gap-3 pt-4" aria-label="Pagination">
      <p className="text-sm text-slate-400">
        Page {page} of {totalPages} — {total} result{total === 1 ? '' : 's'}
      </p>
      <div className="flex gap-2">
        <button
          onClick={() => onPageChange(page - 1)}
          disabled={page <= 1}
          className="rounded-lg bg-slate-700 px-3 py-1.5 text-sm text-white hover:bg-slate-600 disabled:opacity-40"
          aria-label="Previous page"
        >
          Previous
        </button>
        <button
          onClick={() => onPageChange(page + 1)}
          disabled={page >= totalPages}
          className="rounded-lg bg-slate-700 px-3 py-1.5 text-sm text-white hover:bg-slate-600 disabled:opacity-40"
          aria-label="Next page"
        >
          Next
        </button>
      </div>
    </div>
  );
}

/** Shown when the selected workspace is missing — links to onboarding. */
export function NoWorkspaceState() {
  return (
    <EmptyState
      title="No workspace yet"
      description="Create a workspace first — customers, conversations and tickets live inside a workspace."
      action={
        <a href="/onboarding" className="inline-block rounded-lg bg-primary px-4 py-2 text-sm font-medium text-white hover:bg-purple-600">
          Create a workspace
        </a>
      }
    />
  );
}

export const inputCls =
  'w-full rounded-lg border border-slate-600 bg-navy px-3 py-2 text-sm text-white placeholder:text-slate-500 focus:border-primary focus:outline-none';
export const selectCls =
  'rounded-lg border border-slate-600 bg-navy px-3 py-2 text-sm text-white focus:border-primary focus:outline-none';
export const btnPrimary =
  'rounded-lg bg-primary px-4 py-2 text-sm font-medium text-white hover:bg-purple-600 disabled:opacity-50';
export const btnSecondary =
  'rounded-lg bg-slate-700 px-4 py-2 text-sm text-white hover:bg-slate-600 disabled:opacity-50';
