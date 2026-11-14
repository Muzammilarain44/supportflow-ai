import ComingSoon from '../components/ComingSoon';
export function SettingsPage() {
  return <div className="space-y-4"><h1 className="text-2xl font-bold text-white">Settings</h1><ComingSoon title="Settings — Phase 1 foundation" description="Profile and workspace settings are a Phase 1 shell. Team roles, billing and audit logs arrive in later phases. Your account email and session are managed by Supabase Auth." /></div>;
}
export function KnowledgePage() { return <div className="space-y-4"><h1 className="text-2xl font-bold text-white">Knowledge Base</h1><ComingSoon title="Knowledge base & RAG" description="Document ingestion, embeddings, vector search and grounded AI answers arrive in Phase 4." /></div>; }
export function AutomationsPage() { return <div className="space-y-4"><h1 className="text-2xl font-bold text-white">Automations</h1><ComingSoon title="n8n automations" description="n8n webhook integration, workflow runs, retry and failure handling arrive in Phase 3. No workflow is wired up yet." /></div>; }
export function AnalyticsPage() { return <div className="space-y-4"><h1 className="text-2xl font-bold text-white">Analytics</h1><ComingSoon title="Analytics" description="Real performance analytics arrive in Phase 5. No metrics are invented in Phase 1." /></div>; }
