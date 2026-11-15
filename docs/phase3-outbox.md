# Phase 3 outbox dispatcher

The transactional outbox (`public.automation_events`, created in 0003)
is consumed by a standalone poller: `apps/worker`. It delivers each
event once to **one** destination — n8n, or the API's direct-processing
endpoint — and acks it. Nothing in the database sends webhooks.

> **Status: UNVERIFIED live.** The dispatcher has never run against
> the live Supabase project or a live n8n instance. Its behaviour is
> covered by unit tests with mocked Supabase + mocked `fetch`
> (`apps/worker/src/__tests__/dispatcher.test.ts`).

## How it works

1. **Startup — crash recovery.** The worker calls
   `reclaim_stale_automation_events(300)`: any row left `processing`
   by a crashed run (claimed > 5 minutes ago) goes back to `pending`
   with its attempt count intact.
2. **Poll.** Every `WORKER_POLL_MS` (default 15 000 ms) it calls
   `claim_automation_events(WORKER_BATCH_SIZE)` (default 10). The RPC
   atomically claims the oldest due `pending` rows with
   `FOR UPDATE SKIP LOCKED` and bumps `attempts`.
3. **Deliver.** For each claimed event it builds the payload
   `{event_id, event_type, workspace_id, entity_type, entity_id,
   payload, correlation_id: event id}` — ids and status values only,
   never message bodies, emails or phone numbers (the DB CHECK on
   `automation_events.payload` enforces this) — and POSTs it signed
   (see Signing below) with a 15 s timeout.
4. **Ack.**
   - `2xx` → `ack 'processed'`.
   - Any other status, network error, or timeout → `ack 'failed'`.
     The RPC puts the row back to `pending` with exponential backoff
     (`least(2^attempts * 5s, 300s)` + up to 5 s jitter).
   - If the event's claim-time `attempts` is already ≥ 8 and the
     delivery fails → `ack 'dead'` (never retried).
   - A claimed event id that appears twice in one batch is delivered
     and acked only once; the duplicate is skipped.
5. **Shutdown.** `SIGINT` / `SIGTERM` stop the poll loop; the process
   exits after a short grace period so an in-flight batch can finish
   its acks. A batch that is killed mid-flight is safe: its rows stay
   `processing` and are reclaimed on the next startup.

**Never mark delivered without a 2xx ack.** The worker only calls
`ack 'processed'` after a 2xx response.

## Signing

`apps/api/src/lib/webhookAuth.ts` (shared by the API and the
dispatcher — the worker imports it from the API package) implements
HMAC-SHA256 over `` `${timestamp}.${rawBody}` `` with the shared
`WEBHOOK_SECRET`, returned as the header value `sha256=<hex>`. The
signature and Unix-second timestamp travel as `x-sf-signature` /
`x-sf-timestamp` headers. The receiver verifies
with `verifyWebhook` / `verifyWebhookRequest`: non-numeric, stale
(> 300 s) or future timestamps, missing/malformed signatures and
tampered bodies are all rejected (never throws).

## Destinations (in priority order)

1. `N8N_WEBHOOK_URL` set → POST there.
2. Otherwise `AI_DIRECT_PROCESSING === 'true'` → POST to
   `API_BASE_URL + '/api/automation/process-event'`.
3. **Neither set → no-destination path.** The event is reset to
   `pending` via a direct service-role table update
   (`resetEventToPending` in `apps/worker/src/dispatcher.ts` — the
   service role bypasses RLS, so no RPC is needed). This is
   deliberately **not** `ack 'failed'`: the event was never attempted,
   so it must not consume a retry or schedule backoff. The claim's
   `attempts +1` stands (the SQL increments on claim), the reset adds
   nothing further, and the event is picked up again on a later run
   once a destination exists. Nothing is lost, nothing is duplicated.

## n8n hosting context — read this before expecting 24/7 delivery

n8n runs on **the user's Windows laptop**, exposed via a **free
Cloudflare Tunnel** at `N8N_WEBHOOK_URL`. **The laptop is NOT always
on.** When it is off, asleep, or offline, the tunnel endpoint is
unreachable and the dispatcher treats that as a transient failure:
events stay `pending` and retry with backoff — nothing is lost and
nothing is duplicated — but **nothing is delivered until the laptop
is back on and n8n is running**. This is NOT a 24/7 production
service. If delivery latency matters, keep the laptop awake while
n8n should be processing, or move n8n to an always-on host later
(a separate decision; nothing here assumes it).

## Configuration (worker env)

| Variable | Required | Default | Notes |
|---|---|---|---|
| `SUPABASE_URL` | yes | — | |
| `SUPABASE_SERVICE_ROLE_KEY` | yes | — | Bypasses RLS; server-side only, never in frontend code. Missing key fails fast with a clear error (`getServiceSupabase`). |
| `N8N_WEBHOOK_URL` | no | — | Cloudflare Tunnel URL to the laptop's n8n webhook. |
| `WEBHOOK_SECRET` | when a destination is set | — | Shared HMAC secret; the worker refuses to start a destination without it. |
| `API_BASE_URL` | no | `http://localhost:4000` | Used only for direct processing. |
| `AI_DIRECT_PROCESSING` | no | `false` | `'true'` enables the API direct-processing destination. |
| `WORKER_POLL_MS` | no | `15000` | |
| `WORKER_BATCH_SIZE` | no | `10` | Passed as `p_limit` to the claim RPC. |
| `WORKER_STALE_TIMEOUT_SECONDS` | no | `300` | Stale-claim reclaim window. |
| `WORKER_FETCH_TIMEOUT_MS` | no | `15000` | Per-delivery HTTP timeout. |

## Running it

```bash
npm --workspace apps/worker run build
npm --workspace apps/worker start   # needs the env vars above
```

## Logging

Every delivery attempt is logged with event id, event type, outcome
(`processed` / `failed` / `dead` / `no-destination`), HTTP status and
attempt count — and nothing else. Payload bodies, emails and message
text are never logged.

## API side (this worker's scope)

- `apps/api/src/lib/webhookAuth.ts` — `signWebhook`, `verifyWebhook`,
  `verifyWebhookRequest`, `WEBHOOK_HEADERS`. No dependencies beyond
  `node:crypto`.
- `apps/api/src/lib/serviceSupabase.ts` — `getServiceSupabase(env)`,
  throws a clear error when `SUPABASE_SERVICE_ROLE_KEY` is missing.
  Other workers import this helper.
- `apps/api/src/routes/automationEvents.ts` — `GET
  /api/workspaces/:workspaceId/automation-events`, member-only
  (via the existing `requireWorkspaceMember`), `status` filter +
  pagination, response `{automation_events, total, page, pageSize}`.
  **Not mounted in `app.ts` yet** — this worker was told not to touch
  `app.ts`; mounting is left to the integration step.
