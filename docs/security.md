# Security — SupportFlow AI (Phase 1)

- Supabase Auth email/password only; no custom password storage.
- JWT verified server-side (`supabase.auth.getUser`) on every `/api/*` route; 401 on missing/invalid token.
- Workspace membership enforced per request (`workspace_members`); 403 for non-members; cross-workspace access is prevented by both the middleware and RLS.
- RLS enabled on all tenant tables; no wildcard policies.
- Workspace + owner membership created atomically via `SECURITY DEFINER` function `create_workspace_with_owner()` (granted to `authenticated` only); the function validates auth + slug and rejects duplicate slugs.
- Service-role key (if ever used server-side) is env-only, never logged, never shipped to the browser.
- All write bodies validated with Zod (shared schemas in `packages/shared`).
- CORS restricted to `FRONTEND_URL`; JSON body limit 1 MB; central error handler never leaks stack traces.
- Secrets in env vars only; `.env` gitignored; `.env.example` contains placeholders only.
- n8n webhooks are NOT exposed in Phase 1; no webhook URL exists in the repo.
