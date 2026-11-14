import { useState, type FormEvent } from 'react';
import { useNavigate } from 'react-router-dom';
import { api } from '../lib/api';
export default function Onboarding() {
  const navigate = useNavigate();
  const [name, setName] = useState(''); const [slug, setSlug] = useState(''); const [description, setDescription] = useState('');
  const [error, setError] = useState<string | null>(null); const [busy, setBusy] = useState(false);
  const slugify = (v: string) => { setName(v); setSlug(v.toLowerCase().trim().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 63)); };
  const submit = async (e: FormEvent) => {
    e.preventDefault(); setBusy(true); setError(null);
    try { await api.createWorkspace({ name, slug, description: description || null }); navigate('/'); }
    catch (err) { setError((err as Error).message); } finally { setBusy(false); }
  };
  const inputCls = 'w-full rounded-lg border border-slate-600 bg-navy px-3 py-2 text-sm text-white placeholder:text-slate-500 focus:border-primary focus:outline-none';
  return (
    <div className="mx-auto max-w-lg">
      <h1 className="text-2xl font-bold text-white">Create your workspace</h1>
      <p className="mt-1 text-sm text-slate-400">One workspace per business. You become its owner; members are added in a later phase.</p>
      <form onSubmit={submit} className="mt-6 space-y-4 rounded-xl border border-slate-700/60 bg-card p-6">
        {error && <p className="rounded-lg bg-danger/10 p-3 text-sm text-red-300" role="alert">{error}</p>}
        <label className="block text-sm text-slate-300">Workspace name<input className={inputCls} required value={name} onChange={(e) => slugify(e.target.value)} placeholder="Acme Support" /></label>
        <label className="block text-sm text-slate-300">Slug (lowercase, letters/numbers/hyphens)<input className={inputCls} required value={slug} onChange={(e) => setSlug(e.target.value)} placeholder="acme-support" /></label>
        <label className="block text-sm text-slate-300">Company description (optional)<textarea className={inputCls} value={description} onChange={(e) => setDescription(e.target.value)} placeholder="What does your business do?" /></label>
        <button disabled={busy} className="w-full rounded-lg bg-primary py-2 text-sm font-medium text-white hover:bg-purple-600 disabled:opacity-50">{busy ? 'Creating…' : 'Create workspace'}</button>
      </form>
    </div>
  );
}
