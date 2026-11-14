# Supabase Migrations — Phase 1

Apply `0001_phase1_workspaces.sql` in Supabase Dashboard > SQL Editor (project "SupportFlow AI").
It creates only `workspaces` and `workspace_members`, with RLS and the secure
`create_workspace_with_owner()` function.

## Future tables (documented, NOT created yet — Phases 2+)
- `customers`, `conversations`, `messages`, `tickets`
- `knowledge_documents`, `knowledge_chunks`
- `automation_jobs`, `automation_runs`
- `audit_logs`

Every future tenant-owned table must have a `workspace_id` FK, RLS scoped to
`workspace_members`, and no wildcard policies. See `docs/architecture.md`.
