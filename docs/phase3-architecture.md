# Phase 3 — Architecture

Phase 3 adds the automation loop to SupportFlow AI: a widget message (or
ticket change) becomes an outbox event, the event is delivered to n8n,
n8n hands it back to the API, and the API runs the AI step (Groq first,
Gemini fallback) against the workspace's Knowledge Base and AI mode.
Phases 1 and 2 are unchanged by this — the dashboard, inbox, tickets,
customers and widget all keep working exactly as before, and turning
automation off returns the product to its Phase 2 behaviour.

## System overview

```
Visitor / agent
    │  widget message, ticket create / update
    ▼
API (Render) ──► automation_events  (transactional outbox, ids-only payload)
    │                status: pending → processing → processed / failed / dead
    ▼
Dispatcher / worker (apps/worker) ── polls pending events, claims one at a time
    │  POST {event} + HMAC headers x-sf-signature / x-sf-timestamp
    │  to N8N_WEBHOOK_URL (Cloudflare Tunnel public URL)
    ▼
n8n (owner's Windows laptop, localhost:5678)
    │  Webhook → Verify signature → Validate event → Sign request
    │  → POST /api/automation/process-event (same HMAC scheme)
    ▼
API process-event (Render) ── re-verifies signature, re-fetches the
    │  conversation/ticket from the database (never trusts the payload
    │  for content), checks the workspace AI mode + policy
    ▼
Knowledge Base (lexical search, Postgres full-text) ── relevant snippets
    │
    ▼
AI provider: Groq FIRST, Gemini FALLBACK (OpenAI-compatible endpoints)
    │
    ├── Suggestion Only (default for new workspaces) → draft suggestion
    │   saved for an agent to review/send; nothing is sent to the visitor
    ├── Automatic Reply → reply sent, only where the workspace policy
    │   explicitly permits it
    ├── Human Only → no AI reply; event recorded, agent handles it
    └── Disabled → no AI call at all
    │
    ▼
ai_executions (audit log: provider, model, mode, outcome, latency)
Messages / tickets updated in the database; inbox UI shows the result.
```

## Data flow, step by step

1. **Event recorded.** When the API creates/updates a ticket or a
   widget visitor message arrives, it writes one row to
   `automation_events` via the `record_automation_event()` RPC
   (migration 0003). The payload contains **ids, slugs and
   status/priority values only** — never message bodies, emails or
   phone numbers. A database CHECK constraint rejects payloads with
   forbidden keys (`body`, `email`, `phone`, `phone_number`, `message`,
   `content`). See `docs/phase2-migrations.md`.
2. **Claim.** The dispatcher (`apps/worker`) polls
   `status = 'pending'` oldest-first in small batches and claims a row
   atomically (`UPDATE … WHERE status = 'pending' RETURNING *`), so two
   workers never process the same event. A claimed-but-unacknowledged
   row (worker crash) is re-polled later — the same `event_id` can
   legitimately be delivered twice, which is why every consumer
   dedupes on it.
3. **Deliver to n8n.** The dispatcher POSTs the event to
   `N8N_WEBHOOK_URL` with `x-sf-signature` /
   `x-sf-timestamp` headers (HMAC-SHA256 over
   `${timestamp}.${rawBody}`, secret `AUTOMATION_WEBHOOK_SECRET`).
   If n8n is unreachable (laptop off, tunnel down), the event stays
   `pending` and is retried with backoff. If n8n answers 200, the
   event is `processed`; on 500 it stays `pending` for retry; after
   the retry budget is exhausted it is `dead` for manual inspection.
   Direct processing (`AI_DIRECT_PROCESSING=true`) skips n8n and calls
   the AI step in-process — see "Deployment modes" below.
4. **n8n verifies and forwards.** The workflow
   (`n8n/workflows/supportflow-ai-phase3.json`) verifies the signature
   (±300 s replay window), validates the event shape, drops duplicates
   on `event_id` (workflow static data, 24 h), re-signs, and POSTs to
   `POST /api/automation/process-event`. It answers 200 only when the
   API answers 200/202, 500 otherwise (so the dispatcher retries),
   401 on a bad signature, 400 on a malformed event.
5. **API re-fetches, then AI.** `process-event` re-verifies the
   signature, then loads the conversation/ticket and the workspace AI
   mode + policy **from the database** — the event payload is never
   trusted for content. It retrieves relevant Knowledge Base snippets
   (lexical search, see below), calls Groq first and Gemini on
   failure, and applies the workspace mode. Every AI call is written
   to `ai_executions` (provider, model, mode, outcome, latency, error
   text on failure).
6. **Result.** A suggestion is stored for agent review, an automatic
   reply is sent only where policy permits, or the event is recorded
   with no AI action (Human Only / Disabled). The inbox UI shows
   suggestions and AI replies like any other message.

## Components

| Component | Where it runs | What it does | Code / file |
|---|---|---|---|
| Web app (dashboard, inbox, widget) | Vercel (`supportflow-ai-delta.vercel.app`) | Agent UI, widget embed + demo | `apps/web` |
| API | Render (`supportflow-api-q0md.onrender.com`) | Auth, CRUD, widget endpoints, `process-event`, dispatcher-facing routes | `apps/api` |
| Database + Auth + RLS | Supabase ("SupportFlow AI") | Postgres, Auth, RLS on all tenant tables | `supabase/migrations/` |
| Outbox | Supabase (`automation_events`, 0003) | Durable pending-event queue, ids-only payloads | `supabase/migrations/0003_phase2_support_platform.sql` |
| Dispatcher / worker | Render (worker service) | Polls outbox, claims, delivers to n8n with HMAC + backoff | `apps/worker` (Phase 3) |
| n8n workflow | Owner's Windows laptop + Cloudflare Tunnel | Signature check, validation, dedupe, forward to `process-event` | `n8n/workflows/supportflow-ai-phase3.json` |
| AI providers | Groq (first), Gemini (fallback) | Draft suggestions / automatic replies grounded in the Knowledge Base | Render env `GROQ_API_KEY` / `GEMINI_API_KEY` |
| Knowledge Base | Supabase (`knowledge_documents`, `knowledge_chunks`, 0009) | Workspace-owned help articles; lexical (full-text) retrieval in Phase 3 | `supabase/migrations/0009_phase3_ai_platform.sql` (Phase 3) |
| AI audit log | Supabase (`ai_executions`, 0009) | One row per AI attempt: provider, model, mode, outcome | `supabase/migrations/0009_phase3_ai_platform.sql` (Phase 3) |
| Embeddings column | Supabase (`knowledge_chunks.embedding`, 0010) | Optional `halfvec(3072)` column — **added but NOT wired** in Phase 3; vector retrieval is a Phase 4 item | `supabase/migrations/0010_phase3_embeddings.sql` (Phase 3) |

> **Paths marked "(Phase 3)"** are the new files added by the parallel
> Phase 3 workstreams alongside this document. If a path is missing in
> your checkout, that workstream's files have not landed yet — do not
> treat the reference as proof the file exists.

## AI modes (per workspace)

| Mode | Behaviour |
|---|---|
| **Suggestion Only** (default for new workspaces) | AI drafts a reply from the Knowledge Base; an agent reviews and sends it. Nothing is ever sent to the visitor automatically. |
| **Automatic Reply** | AI replies are sent automatically — **only** where the workspace policy explicitly permits it (per-workspace setting; see `docs/phase3-security.md`). |
| **Human Only** | No AI reply is generated or sent. The event is recorded and the agent handles it. |
| **Disabled** | No AI call is made at all for the workspace. |

The mode is read from the database on every event — changing it takes
effect on the next event, with no redeploy.

## Knowledge Base / RAG — what Phase 3 actually does

- **Lexical baseline (this is what ships).** Retrieval is PostgreSQL
  full-text search over `knowledge_chunks` (migration 0009). A query
  built from the visitor's message is matched against chunk text with
  ranking; the top chunks are passed to the AI as grounding context.
  It needs no embeddings, no vector extension, and no extra service.
- **Vector retrieval is NOT wired in Phase 3.** Migration 0010 adds an
  optional `halfvec(3072)` `embedding` column on `knowledge_chunks`,
  but nothing in Phase 3 writes embeddings, queries by vector, or
  depends on the column. Do not describe Phase 3 RAG as "vector" or
  "semantic" — it is lexical, and it is reported that way here and in
  `docs/development-roadmap.md` (Knowledge Base / RAG is a Phase 3
  item; vector retrieval is Phase 4).
- **Grounding rule.** The AI is instructed to answer only from the
  retrieved snippets and the conversation, and to escalate (say it
  does not know / hand to a human) rather than invent an answer. If no
  Knowledge Base snippet is retrieved, the suggestion says so instead
  of answering from general knowledge. See
  `docs/phase3-security.md` (prompt-injection defences).

## Deployment modes

| Mode | How it works | When to use |
|---|---|---|
| **n8n (default)** | Dispatcher → Cloudflare Tunnel → n8n on the laptop → API `process-event` | Normal operation. Full workflow, execution history in n8n. Requires the laptop on + tunnel up. |
| **Direct processing** (`AI_DIRECT_PROCESSING=true`) | Dispatcher calls the AI step in-process, skipping n8n entirely | Laptop off for a long stretch, or n8n being rebuilt. Same `process-event` logic, same audit log; no n8n execution history. Set in Render env (`apps/worker` env). |

Both modes share the same outbox, the same idempotency (dedupe on
`event_id`), and the same `ai_executions` audit trail. Switching modes
is an env-var change, not a code change.

## Operational status — what is 24/7 and what is not

| Piece | Runs where | Always on? | Caveat |
|---|---|---|---|
| Frontend (Vercel) | Vercel free tier | Yes | Static hosting; no server. |
| API (Render) | Render free tier | Mostly | Sleeps after ~15 min idle; first request after sleep takes ~1 min (cold start). |
| Database + Auth (Supabase) | Supabase free tier | Mostly | Free projects pause after 7 days of inactivity; wake from the dashboard. |
| Dispatcher / worker | Render free tier | Mostly | Same cold-start caveat as the API. Poll interval `WORKER_POLL_MS`. |
| **n8n + tunnel** | **Owner's Windows laptop** | **No** | **Only while the laptop is on and the tunnel is up. This is the one deliberate non-24/7 piece. Events wait safely in the outbox while it is down.** |
| AI providers (Groq / Gemini) | Groq / Google free tiers | Yes (provider-side) | Free-tier quotas apply (Gemini free tier may be ~20 requests/day — see `docs/phase3-troubleshooting.md`). Quota errors are surfaced, never hidden. |

## Tenant isolation (summary)

- Every Phase 3 table (`knowledge_documents`, `knowledge_chunks`,
  `ai_executions`, plus the AI-mode/policy columns) carries
  `workspace_id` with RLS scoped to `workspace_members`, the same
  pattern as Phases 1–2. No `USING (true)` policies anywhere.
- The dispatcher re-fetches the conversation/ticket and the workspace
  policy from the database using the service-role key, scoped by the
  event's `workspace_id` — it never trusts the event payload for
  content or for which workspace the data belongs to.
- The n8n workflow never sees customer data beyond ids: the outbox
  payload is ids-only by database CHECK, and the workflow passes the
  event through without logging it.
- AI calls are per-workspace: retrieval only ever searches that
  workspace's Knowledge Base, and suggestions/replies are written
  only to that workspace's conversations. A two-user isolation test
  passed in Phase 2.1 for the Phase 2 tables; the same pattern is
  applied to the Phase 3 tables (see `docs/phase3-security.md`).

## Member invitations

**Deferred as a future enhancement.** Phase 3 does not add member
invitations — workspaces still gain members only through the existing
Phase 1 owner flow. Do not describe invitations as shipped.

## API/web response-shape contract (UI fixes, 2026-11-15)

The Phase 3 API list endpoints return generic keys — `items` for the
suggestions, AI-executions and knowledge lists, `settings` for
AI settings, `document` for single knowledge documents — while the web
client was typed for named keys (`ai_suggestions`, `ai_executions`,
`ai_settings`, `knowledge_document`). The mismatch was silent: the
suggestion panel never rendered (a pending suggestion existed but the
page read an empty list), the AI Settings page showed defaults
(AI enabled unchecked while the workspace was enabled), and the
Automations "Failed AI executions" section was always empty. The fix
is web-side normalization in `apps/web/src/lib/api.ts` (same pattern
the knowledge list already used), covered by live-shape regression
tests in `apps/web/src/__tests__/phase3.test.tsx` that mock the real
API payloads. Do not "fix" this by renaming the API keys — the
`items`/`settings` shapes are the tested contract (API tests, E2E
harness, n8n).

Two more UI bugs fixed in the same round: the KB search box sent `q=`
but the API reads `search` (`listQuerySchema`), so search never
filtered — the client now sends `search=`; and the Automation
Activity status filter offered `completed`, which the API rejects —
the stored status is `processed`, so the filter now offers that.

The authenticated rate limit was raised 300 → 1000 requests / 15 min
per user (`AUTHED_RATE_LIMIT_MAX` in `apps/api/src/app.ts`, API
0.3.3): ordinary dashboard use tripped 300 — the Inbox polls
messages every 5s and every view fires several queries. The public
widget per-IP limits are unchanged.

## Related docs

- Setup (laptop + tunnel + Render): `docs/phase3-n8n-setup.md`
- Security (HMAC, secrets, RLS, prompt injection): `docs/phase3-security.md`
- Troubleshooting (common failures): `docs/phase3-troubleshooting.md`
- Phase 2 migrations + outbox contract: `docs/phase2-migrations.md`
- Widget origin enforcement: `docs/phase2-1-origins.md`
- Roadmap (Phase 3 vs Phase 4 split): `docs/development-roadmap.md`
