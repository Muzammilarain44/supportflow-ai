import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react';
import { MessageSquare, Send, X } from 'lucide-react';
import { api } from '../lib/api';

interface WidgetMessage {
  id: string;
  sender_type: string;
  body: string;
  created_at: string;
}

function tokenKey(key: string) {
  return `supportflow.widget.${key}`;
}

/**
 * The origin of the page embedding this iframe, derived from
 * document.referrer. Returns undefined when there is no referrer (direct
 * navigation, or a referrer-policy that strips it) or when it is not a
 * parsable URL. This is a client-asserted hint, not proof: the server
 * validates it against the widget's allow-list, and a non-browser client
 * can claim any origin — see docs/phase2-1-origins.md. Exported for
 * unit tests.
 */
export function getParentOrigin(referrer: string): string | undefined {
  if (!referrer) return undefined;
  try {
    return new URL(referrer).origin;
  } catch {
    return undefined;
  }
}

export default function WidgetEmbed() {
  const [key] = useState(() => new URLSearchParams(window.location.search).get('key') ?? '');
  const [config, setConfig] = useState<{ business_name: string; welcome_message: string; primary_color: string; enabled: boolean } | null>(null);
  const [configError, setConfigError] = useState<string | null>(null);
  const [open, setOpen] = useState(false);
  const [token, setToken] = useState<string | null>(() => {
    try {
      return key ? localStorage.getItem(tokenKey(key)) : null;
    } catch {
      return null;
    }
  });
  const [messages, setMessages] = useState<WidgetMessage[]>([]);
  // Embedding page origin, captured once from document.referrer (see
  // getParentOrigin). Sent as parent_origin on every widget API call so
  // the server can enforce the widget's allow-list. Empty referrer ->
  // undefined -> the server applies its empty-origin default.
  const [parentOrigin] = useState<string | undefined>(() => getParentOrigin(document.referrer));
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [draft, setDraft] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const bottomRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!key) {
      setConfigError('No widget key provided. Add ?key=<public_key> to the URL.');
      return;
    }
    api.getWidgetConfig(key, parentOrigin)
      .then(setConfig)
      .catch((err: Error) => setConfigError(err.message));
  }, [key, parentOrigin]);

  const loadHistory = useCallback(async (t: string) => {
    try {
      const res = await api.getWidgetHistory(t, parentOrigin);
      setMessages(res.messages);
    } catch {
      // Unknown/expired token returns [] with 200 per the API; a network
      // failure here is non-fatal — the next poll retries.
    }
  }, [parentOrigin]);

  useEffect(() => {
    if (!token) return;
    void loadHistory(token);
    const id = window.setInterval(() => void loadHistory(token), 5000);
    return () => window.clearInterval(id);
  }, [token, loadHistory]);

  useEffect(() => {
    bottomRef.current?.scrollIntoView?.({ behavior: 'smooth' });
  }, [messages.length, open]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    document.addEventListener('keydown', onKey);
    inputRef.current?.focus();
    return () => document.removeEventListener('keydown', onKey);
  }, [open]);

  const startSession = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const res = await api.createWidgetSession({
        key,
        name: name.trim() || undefined,
        email: email.trim() || undefined,
        parent_origin: parentOrigin,
      });
      setToken(res.token);
      try {
        localStorage.setItem(tokenKey(key), res.token);
      } catch {
        /* storage unavailable — the session still works for this page load */
      }
      await loadHistory(res.token);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const send = async (e: FormEvent) => {
    e.preventDefault();
    if (!token || !draft.trim()) return;
    const body = draft.trim();
    setDraft('');
    setBusy(true);
    setError(null);
    // Optimistic echo; the next history poll replaces it with the server row.
    const optimistic: WidgetMessage = {
      id: `local-${Date.now()}`,
      sender_type: 'customer',
      body,
      created_at: new Date().toISOString(),
    };
    setMessages((m) => [...m, optimistic]);
    try {
      await api.sendWidgetMessage({ token, body, client_message_id: crypto.randomUUID(), parent_origin: parentOrigin });
      await loadHistory(token);
    } catch (err) {
      setError((err as Error).message);
      setMessages((m) => m.filter((x) => x.id !== optimistic.id));
      setDraft(body);
    } finally {
      setBusy(false);
    }
  };

  const primary = config?.primary_color ?? '#7C3AED';

  return (
    <div className="min-h-screen bg-transparent" style={{ background: 'transparent' }}>
      {!config && !configError && (
        <p className="p-4 text-sm text-slate-400" role="status">Loading chat widget…</p>
      )}
      {configError && (
        <p className="m-4 rounded-lg bg-danger/10 p-3 text-sm text-red-300" role="alert">{configError}</p>
      )}

      {/* Floating button */}
      <button
        onClick={() => setOpen((o) => !o)}
        aria-label={open ? 'Close chat' : `Open chat with ${config?.business_name ?? 'support'}`}
        aria-expanded={open}
        className="fixed bottom-4 right-4 z-50 flex h-14 w-14 items-center justify-center rounded-full text-white shadow-lg transition-transform hover:scale-105"
        style={{ background: primary }}
      >
        {open ? <X className="h-6 w-6" /> : <MessageSquare className="h-6 w-6" />}
      </button>

      {open && config && (
        <section
          role="dialog"
          aria-modal="false"
          aria-label={`Chat with ${config.business_name}`}
          className="fixed bottom-20 right-4 z-50 flex h-[480px] w-[min(360px,calc(100vw-2rem))] flex-col overflow-hidden rounded-2xl border border-slate-700 bg-card shadow-2xl"
        >
          <header className="flex items-center justify-between px-4 py-3 text-white" style={{ background: primary }}>
            <div>
              <h1 className="font-semibold">{config.business_name}</h1>
              <p className="text-xs opacity-80">We usually reply quickly</p>
            </div>
            <button onClick={() => setOpen(false)} aria-label="Close chat" className="rounded-lg p-1 hover:bg-white/20">
              <X className="h-5 w-5" />
            </button>
          </header>

          {!token ? (
            <form onSubmit={startSession} className="flex flex-1 flex-col justify-center gap-3 p-4">
              <p className="text-sm text-slate-200">{config.welcome_message}</p>
              <p className="text-xs text-slate-400">Tell us who you are (optional) and start chatting.</p>
              <label className="text-sm text-slate-300">Name (optional)
                <input className="mt-1 w-full rounded-lg border border-slate-600 bg-navy px-3 py-2 text-sm text-white placeholder:text-slate-500 focus:border-primary focus:outline-none" value={name} onChange={(e) => setName(e.target.value)} maxLength={100} placeholder="Your name" />
              </label>
              <label className="text-sm text-slate-300">Email (optional)
                <input className="mt-1 w-full rounded-lg border border-slate-600 bg-navy px-3 py-2 text-sm text-white placeholder:text-slate-500 focus:border-primary focus:outline-none" type="email" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="you@example.com" />
              </label>
              {error && <p className="rounded-lg bg-danger/10 p-2 text-sm text-red-300" role="alert">{error}</p>}
              <button type="submit" disabled={busy} className="rounded-lg px-4 py-2 text-sm font-medium text-white disabled:opacity-50" style={{ background: primary }}>
                {busy ? 'Starting…' : 'Start chat'}
              </button>
            </form>
          ) : (
            <>
              <div className="flex-1 space-y-3 overflow-y-auto p-4" aria-live="polite">
                <p className="rounded-lg bg-slate-800 p-2 text-sm text-slate-200">{config.welcome_message}</p>
                {messages.map((m) => (
                  <div key={m.id} className={`flex ${m.sender_type === 'customer' ? 'justify-end' : 'justify-start'}`}>
                    <div className={`max-w-[85%] rounded-2xl px-3 py-2 text-sm ${m.sender_type === 'customer' ? 'text-white' : 'bg-slate-700 text-slate-100'}`} style={m.sender_type === 'customer' ? { background: primary } : undefined}>
                      <p className="whitespace-pre-wrap">{m.body}</p>
                      <p className="mt-1 text-right text-[11px] opacity-70">
                        {new Date(m.created_at).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })}
                      </p>
                    </div>
                  </div>
                ))}
                <div ref={bottomRef} />
              </div>
              {error && <p className="border-t border-slate-700/60 px-4 pt-2 text-sm text-red-300" role="alert">{error}</p>}
              <form onSubmit={send} className="flex gap-2 border-t border-slate-700/60 p-3">
                <label htmlFor="widget-composer" className="sr-only">Type your message</label>
                <input
                  id="widget-composer"
                  ref={inputRef}
                  className="w-full rounded-lg border border-slate-600 bg-navy px-3 py-2 text-sm text-white placeholder:text-slate-500 focus:border-primary focus:outline-none"
                  value={draft}
                  onChange={(e) => setDraft(e.target.value)}
                  placeholder="Type your message…"
                  maxLength={5000}
                />
                <button type="submit" disabled={busy || !draft.trim()} aria-label="Send message" className="flex items-center gap-1 rounded-lg px-3 py-2 text-sm font-medium text-white disabled:opacity-50" style={{ background: primary }}>
                  <Send className="h-4 w-4" />
                </button>
              </form>
            </>
          )}
        </section>
      )}
    </div>
  );
}
