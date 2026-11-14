# SupportFlow AI — Phase 1

Multi-tenant AI customer support automation SaaS. **Phase 1 only**: auth, workspaces,
dashboard foundation, Express + Supabase backend, RLS. Later modules are labelled
"Coming in a later phase" — nothing is faked as working.

- Live Supabase project: "SupportFlow AI" — `https://ylqfcfrqbxeevemkkbha.supabase.co`
- GitHub: https://github.com/Muzammilarain44/supportflow-ai (empty at build time; code not pushed by Muse — upload/push is the owner's step, see below)

## Stack
React + Vite + TypeScript, Tailwind, React Router, TanStack Query, Zustand, Lucide,
Recharts, React Hook Form + Zod · Node + Express + TypeScript · Supabase Auth/Postgres/RLS.

## Quick start
```bash
npm install
cp .env.example .env          # then fill in the real anon key (below)
cp .env.example apps/web/.env # VITE_* values
cp .env.example apps/api/.env # SUPABASE_* values (remove VITE_ lines if you like)
npm run dev                   # web on http://localhost:5173, api on http://localhost:4000
```
Root scripts: `dev`, `dev:web`, `dev:api`, `build`, `lint`, `test`, `test:api`, `test:web`.

## Environment variables
| Variable | Where | Notes |
|---|---|---|
| `SUPABASE_URL` | api / root | `https://ylqfcfrqbxeevemkkbha.supabase.co` (supplied, not a secret) |
| `SUPABASE_ANON_KEY` | api | Supabase Dashboard > Project Settings > API — **required, not supplied to Muse** |
| `SUPABASE_SERVICE_ROLE_KEY` | api (optional) | Only if a future server-only operation needs it; never in frontend |
| `VITE_SUPABASE_URL` | web | Same URL as above |
| `VITE_SUPABASE_ANON_KEY` | web | Same anon key |
| `VITE_API_URL` | web | `http://localhost:4000` |
| `PORT` | api | `4000` |
| `FRONTEND_URL` | api | `http://localhost:5173` (CORS origin) |

## Supabase setup (free project, already created as "SupportFlow AI")
1. Supabase Dashboard > select project "SupportFlow AI" > Authentication > Providers > enable **Email**.
2. Authentication > URL Configuration > Site URL: `http://localhost:5173` (add production URL later).
3. SQL Editor > paste and run `supabase/migrations/0001_phase1_workspaces.sql` (creates `workspaces`, `workspace_members`, RLS, `create_workspace_with_owner()`).
4. Project Settings > API > copy the **Project URL** (already known) and **anon public key** into `.env` / `apps/web/.env` / `apps/api/.env`.
5. Sign up in the app, confirm email if required, log in, create a workspace.

## What Phase 1 includes / excludes
Includes: app shell, sidebar/top nav/profile menu, login/signup/logout/password-reset request,
protected routes, workspace onboarding + secure creation, dashboard empty states, health endpoint,
auth + workspace middleware, Zod validation, structured logging, RLS migrations, docs, tests.
Excludes (placeholders only): Inbox, Tickets, Knowledge Base, Automations, Analytics, Team,
AI agent, n8n, real metrics.

## Tests
```bash
npm run test        # api (Vitest + Supertest, Supabase mocked) + web (Vitest + Testing Library)
npm run test:api
npm run test:web
```
Tests run **offline** with a mocked Supabase client (see `apps/api/src/__tests__/app.test.ts`).
Live Supabase tests (real signup/login/workspace creation) need a real anon key and the
migration applied; they are not automated in Phase 1 — verify manually via the steps above.
Do not claim a live test passed unless it was run against the real project.

## Known limitations
- Anon key was **not** supplied, so live Supabase Auth has not been verified end-to-end by Muse; only offline mocked tests were run.
- No demo/seed data by design; dashboard metrics are empty states.
- No deployment, no GitHub push (Muse has no push access to the owner's repos; owner uploads/pushes).
- n8n is a placeholder only.

## Phase 1 acceptance checklist
- [x] Frontend + backend start (verified by `npm run build` + tests; run `npm run dev` to check live)
- [ ] Supabase Auth works live — needs anon key + migration (owner step)
- [ ] User can sign up, log in, create a workspace — needs anon key (owner step)
- [x] Workspace membership enforced (middleware + RLS, tested offline)
- [x] Protected pages reject unauthenticated access (tested)
- [x] Migrations can be applied (SQL file provided; apply in SQL Editor)
- [x] No real credentials committed (placeholders only; grep verified)

## Starting Phase 2 (only after approval)
1. Confirm Phase 1 live verification above.
2. Add migrations for `customers`, `conversations`, `messages`, `tickets` with `workspace_id` + RLS.
3. Build ticket CRUD + inbox UI, then the embeddable widget.
4. Do not start Phase 2 until the user approves it.

## Troubleshooting
- `Missing required environment variable SUPABASE_ANON_KEY` — fill `.env` (api) / `apps/web/.env`; the API fails fast on boot by design.
- `Workspace slug already exists` (409) — pick a different slug.
- 401 from the API — log in again; the JWT may have expired.
- 403 on a workspace — you are not a member of that workspace (tenant isolation working as intended).
- Vite "Supabase keys not set" warning — set `VITE_SUPABASE_*` in `apps/web/.env` and restart.
