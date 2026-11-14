import { Clock } from 'lucide-react';
export default function ComingSoon({ title, description }: { title: string; description: string }) {
  return (
    <div className="rounded-xl border border-slate-700/60 bg-card p-10 text-center">
      <Clock className="mx-auto mb-4 h-10 w-10 text-primary" />
      <h2 className="text-xl font-semibold text-white">{title}</h2>
      <p className="mx-auto mt-2 max-w-md text-sm text-slate-400">{description}</p>
      <span className="mt-4 inline-block rounded-full bg-primary/15 px-3 py-1 text-xs font-medium text-purple-300">Coming in a later phase</span>
    </div>
  );
}
