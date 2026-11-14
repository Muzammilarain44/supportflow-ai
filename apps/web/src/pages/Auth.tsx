import { useState, type FormEvent } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { Zap } from 'lucide-react';
import { useAuth } from '../context/AuthContext';

function Shell({ title, subtitle, children }: { title: string; subtitle: string; children: React.ReactNode }) {
  return (
    <div className="flex min-h-screen items-center justify-center bg-navy p-4">
      <div className="w-full max-w-md rounded-2xl border border-slate-700/60 bg-card p-8">
        <div className="mb-6 flex items-center gap-2"><Zap className="h-7 w-7 text-primary" /><span className="text-xl font-bold text-white">SupportFlow <span className="text-primary">AI</span></span></div>
        <h1 className="text-2xl font-bold text-white">{title}</h1>
        <p className="mt-1 text-sm text-slate-400">{subtitle}</p>
        <div className="mt-6">{children}</div>
      </div>
    </div>
  );
}
const inputCls = 'w-full rounded-lg border border-slate-600 bg-navy px-3 py-2 text-sm text-white placeholder:text-slate-500 focus:border-primary focus:outline-none';
export function LoginPage() {
  const { signIn, resetPassword } = useAuth();
  const navigate = useNavigate();
  const [email, setEmail] = useState(''); const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null); const [info, setInfo] = useState<string | null>(null); const [busy, setBusy] = useState(false);
  const submit = async (e: FormEvent) => { e.preventDefault(); setBusy(true); setError(null); const { error: err } = await signIn(email, password); setBusy(false); if (err) setError(err); else navigate('/'); };
  const reset = async () => { if (!email) { setError('Enter your email first, then request a reset link.'); return; } const { error: err } = await resetPassword(email); if (err) setError(err); else setInfo('If that email is registered, a password-reset link has been sent.'); };
  return <Shell title="Welcome back" subtitle="Log in to your SupportFlow workspace.">
    <form onSubmit={submit} className="space-y-4">
      {error && <p className="rounded-lg bg-danger/10 p-3 text-sm text-red-300" role="alert">{error}</p>}
      {info && <p className="rounded-lg bg-success/10 p-3 text-sm text-green-300" role="status">{info}</p>}
      <label className="block text-sm text-slate-300">Email<input className={inputCls} type="email" required value={email} onChange={(e) => setEmail(e.target.value)} placeholder="you@company.com" /></label>
      <label className="block text-sm text-slate-300">Password<input className={inputCls} type="password" required value={password} onChange={(e) => setPassword(e.target.value)} placeholder="••••••••" /></label>
      <button disabled={busy} className="w-full rounded-lg bg-primary py-2 text-sm font-medium text-white hover:bg-purple-600 disabled:opacity-50">{busy ? 'Logging in…' : 'Log in'}</button>
    </form>
    <div className="mt-4 flex justify-between text-sm"><button onClick={reset} className="text-purple-300 hover:underline">Forgot password?</button><Link to="/signup" className="text-purple-300 hover:underline">Create account</Link></div>
  </Shell>;
}
export function SignupPage() {
  const { signUp } = useAuth(); const navigate = useNavigate();
  const [email, setEmail] = useState(''); const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null); const [info, setInfo] = useState<string | null>(null); const [busy, setBusy] = useState(false);
  const submit = async (e: FormEvent) => { e.preventDefault(); if (password.length < 8) { setError('Password must be at least 8 characters.'); return; } setBusy(true); setError(null); const { error: err } = await signUp(email, password); setBusy(false); if (err) setError(err); else { setInfo('Account created. Check your email to confirm, then log in.'); setTimeout(() => navigate('/login'), 1500); } };
  return <Shell title="Create your account" subtitle="Free during Phase 1 — no credit card required.">
    <form onSubmit={submit} className="space-y-4">
      {error && <p className="rounded-lg bg-danger/10 p-3 text-sm text-red-300" role="alert">{error}</p>}
      {info && <p className="rounded-lg bg-success/10 p-3 text-sm text-green-300" role="status">{info}</p>}
      <label className="block text-sm text-slate-300">Email<input className={inputCls} type="email" required value={email} onChange={(e) => setEmail(e.target.value)} placeholder="you@company.com" /></label>
      <label className="block text-sm text-slate-300">Password (min 8 characters)<input className={inputCls} type="password" required value={password} onChange={(e) => setPassword(e.target.value)} placeholder="••••••••" /></label>
      <button disabled={busy} className="w-full rounded-lg bg-primary py-2 text-sm font-medium text-white hover:bg-purple-600 disabled:opacity-50">{busy ? 'Creating…' : 'Sign up'}</button>
    </form>
    <p className="mt-4 text-sm text-slate-400">Already have an account? <Link to="/login" className="text-purple-300 hover:underline">Log in</Link></p>
  </Shell>;
}
