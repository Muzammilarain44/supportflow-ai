# Architecture — SupportFlow AI (Phase 1)

## Monorepo (npm workspaces)
- `apps/web` — React + Vite + TypeScript, Tailwind, React Router, TanStack Query, Zustand (available), Lucide, Recharts, React Hook Form + Zod.
- `apps/api` — Node + Express + TypeScript, Zod validation, Supabase Auth verification.
- `packages/shared` — shared Zod schemas + types (workspace, auth).
- `supabase/migrations` — Phase 1 only: `workspaces`, `workspace_members`.
- `n8n/workflows` — placeholder only; nothing wired up in Phase 1.

## Data flow (Phase 1)
Browser (Vite) -> Supabase Auth (email/password, JWT in session) -> API (`Authorization: Bearer <JWT>`)
-> API verifies the JWT via `supabase.auth.getUser(token)` -> per-workspace membership check
(`workspace_members`) -> Supabase Postgres via the user-scoped client, so RLS applies.
Workspace creation goes through the `SECURITY DEFINER` RPC `create_workspace_with_owner()`,
which inserts the workspace + owner membership in one transaction.

## Database (Phase 1)
`workspaces(id, name, slug UNIQUE, description, owner_id -> auth.users, timestamps)`,
`workspace_members(id, workspace_id FK cascade, user_id -> auth.users, role owner|admin|member, UNIQUE(workspace_id,user_id))`.
RLS enabled on both; policies allow reads only to members (via `workspace_members`);
no `USING (true)` policies; direct writes are denied — creation only via the secure function.

## Future tables (Phases 2+, NOT created yet)
`customers`, `conversations`, `messages`, `tickets`, `knowledge_documents`,
`knowledge_chunks`, `automation_jobs`, `automation_runs`, `audit_logs`.
Each must carry `workspace_id`, RLS scoped to `workspace_members`, indexes on
`workspace_id` / foreign keys, and no wildcard policies.

## Security principles
- Service-role key never in frontend; anon key only via env.
- Auth verified server-side on every protected route; membership checked per workspace.
- Zod validation on every write; structured logging without passwords/tokens/message content.
- Secrets only in env vars; `.env` is gitignored.
