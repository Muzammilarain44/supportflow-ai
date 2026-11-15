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

## Phase 3 — AI automation (n8n + Groq/Gemini + Knowledge Base)

Phase 3 adds the automation loop on top of Phases 1–2: widget messages
and ticket changes become outbox events, the dispatcher delivers them
to n8n, n8n forwards them to the API, and the API runs the AI step
against the workspace's Knowledge Base.

**What is new**
- **n8n workflow** (`n8n/workflows/supportflow-ai-phase3.json`) — HMAC-verified
  webhook, event validation, dedupe on `event_id`, forward to
  `POST /api/automation/process-event`. Runs on the owner's Windows
  laptop via a free Cloudflare Tunnel — see `docs/phase3-n8n-setup.md`.
- **AI providers: Groq first, Gemini fallback** (OpenAI-compatible
  endpoints). Keys are set in Render only, from the owner via Secure
  Vault — never committed, never pasted in chat. Default models
  `openai/gpt-oss-20b` (quality tier `openai/gpt-oss-120b`) /
  `gemini-3.8-flash` (verify live in the Groq console
  / Google AI Studio before production use; Gemini free tier may be
  ~20 requests/day).
- **Knowledge Base / lexical RAG** — Postgres full-text search over
  `knowledge_chunks` (migration 0009). Vector retrieval is **not**
  wired in Phase 3 (migration 0010 adds an optional embedding column
  only) — that is Phase 4.
- **AI modes per workspace** (default: **Suggestion Only**): Disabled /
  Suggestion Only / Automatic Reply / Human Only. Automatic replies
  only where a workspace policy explicitly permits them.
- **Audit log** — every AI attempt is written to `ai_executions`.
- **Member invitations: deferred** (future enhancement, not in Phase 3).

**Honest status: n8n is NOT 24/7.** It runs on the owner's laptop, so
automation only runs while the laptop is on and the tunnel is up. When
it is down, events stay `pending` in the outbox and are delivered
later — nothing is lost, nothing is duplicated. Render / Vercel /
Supabase run on free tiers with their own caveats (Render cold start
~1 min, Supabase pause after 7 days inactivity). Full status table:
`docs/phase3-architecture.md`.

**How to run**
```bash
npm --workspace apps/worker run start   # dispatcher: polls the outbox, delivers to n8n
```
API and web run as before (`npm run dev`). n8n runs on the laptop —
full steps in `docs/phase3-n8n-setup.md`. Set `AI_DIRECT_PROCESSING=true`
to skip n8n and process in the worker directly.

**Docs**
- Architecture / data flow / modes: `docs/phase3-architecture.md`
- n8n setup (laptop + tunnel + Render): `docs/phase3-n8n-setup.md`
- Security (HMAC, secrets, RLS, prompt injection): `docs/phase3-security.md`
- Troubleshooting: `docs/phase3-troubleshooting.md`
- Env vars (placeholders only): `.env.example` (Phase 3 section)

## Troubleshooting
- `Missing required environment variable SUPABASE_ANON_KEY` — fill `.env` (api) / `apps/web/.env`; the API fails fast on boot by design.
- `Workspace slug already exists` (409) — pick a different slug.
- 401 from the API — log in again; the JWT may have expired.
- 403 on a workspace — you are not a member of that workspace (tenant isolation working as intended).
- Vite "Supabase keys not set" warning — set `VITE_SUPABASE_*` in `apps/web/.env` and restart.
