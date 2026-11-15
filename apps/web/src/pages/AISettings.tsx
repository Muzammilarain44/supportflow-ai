import { useState, type FormEvent } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api, type AiMode, type AiSettings } from '../lib/api';
import { useWorkspace } from '../context/WorkspaceContext';
import { useAuth } from '../context/AuthContext';
import { useToast } from '../components/Toast';
import {
  NoWorkspaceState, Skeleton, WorkspaceErrorState, WorkspaceLoadingSkeleton,
  btnPrimary,
} from '../components/ui';

const MODES: Array<{ value: AiMode; label: string; explanation: string }> = [
  { value: 'disabled', label: 'Disabled', explanation: 'The AI never replies or suggests anything. Agents handle every conversation.' },
  { value: 'suggestion', label: 'Suggestion Only', explanation: 'The AI drafts replies for agents to review. Nothing is sent to customers automatically.' },
  { value: 'auto', label: 'Automatic Reply', explanation: 'The AI replies to customers on its own, using only the knowledge base. Low-confidence cases are handed to an agent.' },
  { value: 'human_only', label: 'Human Only', explanation: 'Only agents reply. AI suggestions are hidden and AI can never be resumed on a handed-off conversation.' },
];

export default function AISettings() {
  const { workspaceId, status: wsStatus, error: wsError, refetchWorkspaces } = useWorkspace();
  const { user } = useAuth();
  const toast = useToast();
  const queryClient = useQueryClient();

  const settingsQ = useQuery({
    queryKey: ['ai-settings', workspaceId],
    queryFn: () => api.getAiSettings(workspaceId!),
    enabled: !!workspaceId,
  });
  const membersQ = useQuery({
    queryKey: ['members', workspaceId],
    queryFn: () => api.listMembersWithProfiles(workspaceId!),
    enabled: !!workspaceId,
  });

  const settings: AiSettings | undefined = settingsQ.data?.ai_settings;
  const myRole = (membersQ.data?.members ?? []).find((m) => m.user_id === user?.id)?.role;
  const canEdit = myRole === 'owner' || myRole === 'admin';

  const [enabled, setEnabled] = useState(false);
  const [mode, setMode] = useState<AiMode>('suggestion');
  const [requireGrounding, setRequireGrounding] = useState(true);
  const [escalateLowConfidence, setEscalateLowConfidence] = useState(true);
  const [lastSettingsId, setLastSettingsId] = useState<string | undefined>(undefined);
  const settingsKey = settings ? `${settings.workspace_id}:${settings.updated_at ?? ''}` : undefined;
  if (settingsKey !== lastSettingsId) {
    setLastSettingsId(settingsKey);
    setEnabled(settings?.enabled ?? false);
    setMode(settings?.mode ?? 'suggestion');
    setRequireGrounding(settings?.auto_reply_require_grounding ?? true);
    setEscalateLowConfidence(settings?.escalation_on_low_confidence ?? true);
  }

  const saveMut = useMutation({
    mutationFn: () => api.updateAiSettings(workspaceId!, {
      enabled, mode,
      auto_reply_require_grounding: requireGrounding,
      escalation_on_low_confidence: escalateLowConfidence,
    }),
    onSuccess: () => {
      toast.success('AI settings saved');
      void queryClient.invalidateQueries({ queryKey: ['ai-settings', workspaceId] });
      void queryClient.invalidateQueries({ queryKey: ['ai-overview', workspaceId] });
    },
    onError: (err) => toast.error(`Could not save AI settings: ${(err as Error).message}`),
  });

  const submit = (e: FormEvent) => {
    e.preventDefault();
    saveMut.mutate();
  };

  if (wsStatus === 'auth-loading' || wsStatus === 'loading') return <WorkspaceLoadingSkeleton />;
  if (wsStatus === 'error') return <WorkspaceErrorState message={wsError?.message} onRetry={refetchWorkspaces} />;
  if (wsStatus === 'empty' || !workspaceId) return <NoWorkspaceState />;

  const providerOrder = settings?.provider_order ?? ['groq', 'gemini'];
  const providerLabel = (p: string) => (p === 'groq' ? 'Groq' : p === 'gemini' ? 'Gemini' : p);

  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-2xl font-bold text-white">AI Settings</h1>
        <p className="text-sm text-slate-400">How the AI assistant behaves in this workspace.</p>
        <p className="mt-1 text-xs text-slate-500">Profile and workspace settings remain in their existing places — this page only covers AI.</p>
      </div>

      {settingsQ.isLoading ? (
        <div className="space-y-2"><Skeleton className="h-10" /><Skeleton className="h-64" /></div>
      ) : settingsQ.isError ? (
        <p className="rounded-xl border border-danger/50 bg-danger/10 p-4 text-sm text-red-300" role="alert">
          Could not load AI settings: {(settingsQ.error as Error).message}
        </p>
      ) : (
        <form onSubmit={submit} className="space-y-4">
          {!membersQ.isLoading && !canEdit && (
            <p className="rounded-xl border border-warning/50 bg-warning/10 p-4 text-sm text-amber-300" role="note">
              Only workspace owners and admins can change AI settings. You can view the current settings below.
            </p>
          )}

          <div className="rounded-xl border border-slate-700/60 bg-card p-5">
            <h2 className="font-semibold text-white">AI assistance</h2>
            <label className="mt-3 flex items-center gap-3 text-sm text-slate-200">
              <input
                type="checkbox"
                checked={enabled}
                disabled={!canEdit}
                onChange={(e) => setEnabled(e.target.checked)}
                className="h-4 w-4 accent-purple-600"
              />
              AI enabled
            </label>
            <p className="mt-1 text-xs text-slate-500">When off, the AI does nothing in this workspace, whatever the mode below says.</p>
          </div>

          <div className="rounded-xl border border-slate-700/60 bg-card p-5">
            <h2 className="font-semibold text-white">Response mode</h2>
            <div className="mt-3 space-y-3" role="radiogroup" aria-label="AI response mode">
              {MODES.map((m) => (
                <label key={m.value} className={`flex cursor-pointer items-start gap-3 rounded-lg border p-3 ${mode === m.value ? 'border-primary bg-primary/10' : 'border-slate-700/60'}`}>
                  <input
                    type="radio"
                    name="ai-mode"
                    value={m.value}
                    checked={mode === m.value}
                    disabled={!canEdit}
                    onChange={() => setMode(m.value)}
                    className="mt-1 h-4 w-4 accent-purple-600"
                  />
                  <span>
                    <span className="block text-sm font-medium text-white">{m.label}</span>
                    <span className="block text-xs text-slate-400">{m.explanation}</span>
                  </span>
                </label>
              ))}
            </div>
            {mode === 'auto' && (
              <p className="mt-3 rounded-lg border border-warning/50 bg-warning/10 p-3 text-sm text-amber-300" role="alert">
                Automatic replies send AI messages to customers. Only enable if you have reviewed the grounding and escalation policy.
              </p>
            )}
          </div>

          <div className="rounded-xl border border-slate-700/60 bg-card p-5">
            <h2 className="font-semibold text-white">Providers</h2>
            <p className="mt-2 text-sm text-slate-300">
              Provider order: {providerOrder.map(providerLabel).join(' → ')} — Groq first, Gemini fallback.
            </p>
            <p className="mt-1 text-xs text-slate-500">Providers are configured by the workspace owner outside this page. No API keys are shown or stored here.</p>
          </div>

          <div className="rounded-xl border border-slate-700/60 bg-card p-5">
            <h2 className="font-semibold text-white">Grounding &amp; escalation</h2>
            <label className="mt-3 flex items-start gap-3 text-sm text-slate-200">
              <input
                type="checkbox"
                checked={requireGrounding}
                disabled={!canEdit}
                onChange={(e) => setRequireGrounding(e.target.checked)}
                className="mt-0.5 h-4 w-4 accent-purple-600"
              />
              <span>
                Require grounding for auto-reply
                <span className="block text-xs text-slate-400">Automatic replies are only sent when the answer is grounded in a knowledge document.</span>
              </span>
            </label>
            <label className="mt-3 flex items-start gap-3 text-sm text-slate-200">
              <input
                type="checkbox"
                checked={escalateLowConfidence}
                disabled={!canEdit}
                onChange={(e) => setEscalateLowConfidence(e.target.checked)}
                className="mt-0.5 h-4 w-4 accent-purple-600"
              />
              <span>
                Escalate on low confidence
                <span className="block text-xs text-slate-400">When the AI is unsure, the conversation is handed to an agent instead of guessing.</span>
              </span>
            </label>
          </div>

          <div className="flex items-center gap-3">
            <button type="submit" disabled={!canEdit || saveMut.isPending} className={btnPrimary}>
              {saveMut.isPending ? 'Saving…' : 'Save AI settings'}
            </button>
            {saveMut.isError && (
              <p className="text-sm text-red-300" role="alert">Save failed: {(saveMut.error as Error).message}</p>
            )}
          </div>
        </form>
      )}
    </div>
  );
}
