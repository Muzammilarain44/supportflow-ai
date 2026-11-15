# Phase 3 — Security

Phase 3 adds three new trust boundaries to the Phase 1/2 model (see
`docs/security.md` and `docs/architecture.md` for the base): the
dispatcher → n8n webhook, the n8n → API `process-event` call, and the
AI providers. Everything below is additive — no Phase 1/2 control is
weakened, and turning automation off returns the product to its Phase 2
security posture.

## 1. Webhook authentication — HMAC + replay protection

Both hops use the **same scheme and the same shared secret**:

- **Dispatcher → n8n:** `POST N8N_WEBHOOK_URL` with headers
  `x-sf-signature` and `x-sf-timestamp`.
- **n8n → API:** `POST /api/automation/process-event` with the same
  two headers, re-signed by the `Sign request` node.

**Signature:** HMAC-SHA256 (hex) over the string
`${x-sf-timestamp}.${rawBody}`, where `rawBody` is the exact JSON bytes
sent. The receiver recomputes the HMAC with the shared secret and
compares with a constant-time comparison (`timingSafeEqual`).

**Replay protection:** the timestamp must be numeric and within
**±300 seconds** of the receiver's clock. A replayed delivery with a
stale timestamp is rejected even if its signature is valid. (This
assumes the laptop clock and Render's clock are roughly correct —
both use network time by default. A laptop clock that is hours wrong
will fail every delivery; fix the clock, do not widen the window.)

**Fail closed:** missing headers, a non-numeric or stale timestamp, an
empty body, a missing secret, or a signature mismatch all produce a
**401** and the event is not processed. The 401 response never says
which check failed beyond a generic reason — and the dispatcher treats
401 as a configuration error (see §7), not as a retryable delivery
failure.

**Raw body requirement.** The signature is over the exact bytes sent,
so the n8n Webhook node must have **Options → Raw Body** enabled
(it is, in `n8n/workflows/supportflow-ai-phase3.json`). If Raw Body
is off, n8n re-serialises the parsed JSON and the byte string can
differ (key order), which fails verification. If deliveries start
failing with 401 after someone re-creates the Webhook node, Raw Body
is the first thing to check.

## 2. The shared secret — two names, one value

| Name | Where | Notes |
|---|---|---|
| `AUTOMATION_WEBHOOK_SECRET` | Render, service `supportflow-api` env | The API and dispatcher side. |
| `N8N_WEBHOOK_SECRET` | n8n environment on the laptop | The workflow side. |

They must be **the same random value**. They are **not** the n8n
encryption key (`N8N_ENCRYPTION_KEY`), which is a different secret
that only protects n8n's own stored credentials on disk. Do not reuse
one for the other.

- **Generation:** `openssl rand -hex 32`, or the PowerShell equivalent
  in `docs/phase3-n8n-setup.md`. Minimum 32 random bytes.
- **Storage:** Render dashboard env vars, and the laptop's n8n
  environment (or permanent user env vars). Never in the repo, never
  in a chat message, never in a screenshot, never in the workflow JSON
  (the workflow reads `$env.N8N_WEBHOOK_SECRET`).
- **Rotation procedure:**
  1. Generate a new secret.
  2. Set it in Render (`AUTOMATION_WEBHOOK_SECRET`) **and** in n8n
     (`N8N_WEBHOOK_SECRET`) — update n8n first or Render first, but
     expect deliveries to 401 during the gap between the two updates;
     the dispatcher leaves those events `pending` and retries them,
     so nothing is lost.
  3. Restart n8n so it picks up the new env var.
  4. Send a test widget message and confirm an execution succeeds.
  5. There is no "old secret" grace period — rotation is atomic per
     side, and the retry/backoff design absorbs the switchover.
- **If the secret leaks:** rotate immediately using the steps above,
  and treat any executions from the leak window as untrusted (check
  n8n Executions and `ai_executions` for deliveries you do not
  recognise).

## 3. Service-role key handling

- The Supabase **service-role key** is used **server-side only** (API
  and dispatcher/worker) to re-fetch conversations/tickets and to
  update outbox rows. It bypasses RLS by design, so the code that uses
  it must scope every query by `workspace_id` itself.
- It is **never** in the browser, never in `apps/web`, never in the
  n8n workflow, never in the repo, and never logged. It lives only in
  Render env vars (`SUPABASE_SERVICE_ROLE_KEY`).
- Rotation: generate a new key in Supabase Dashboard → Project
  Settings → API, update Render env, redeploy. The anon key is a
  separate key and is not a substitute.

## 4. RLS on all new tables

Every Phase 3 table carries `workspace_id` and RLS scoped to
`workspace_members` through the existing SECURITY DEFINER helper
`is_workspace_member()` — the same pattern as Phases 1–2, and the
same rule: **no policy queries `workspace_members` directly** (that
caused the infinite recursion fixed by migration 0002), and no
`USING (true)` policy anywhere. New tables:

- `knowledge_documents`, `knowledge_chunks` (migration 0009) —
  member SELECT/INSERT/UPDATE/DELETE, workspace-scoped.
- `ai_executions` (migration 0009) — member SELECT (read-only audit
  log for members); rows are written server-side only.
- `knowledge_chunks.embedding` (migration 0010) is a column, not a
  table — it inherits the chunk row's RLS. Nothing in Phase 3 reads or
  writes it.

## 5. Workspace scoping in the dispatcher re-fetch

The dispatcher and `process-event` **never trust the event payload
for content**. The outbox payload is ids-only by database CHECK
constraint (migration 0003), so it cannot carry a message body, an
email, or a phone number even if a caller tried. On receipt,
`process-event`:

1. Verifies the HMAC signature (401 on failure).
2. Loads the conversation/ticket, the workspace AI mode, and the
   workspace policy **from the database, by id**.
3. Verifies the loaded rows belong to the event's `workspace_id`
   before acting; a mismatch is rejected and logged.
4. Retrieval searches **only that workspace's** Knowledge Base, and
   any suggestion/reply is written **only to that workspace's**
   conversation.

A forged event naming another workspace's ids therefore cannot read or
write that workspace's data — the re-fetch is the enforcement point,
and the payload is treated as an untrusted hint.

## 6. Prompt-injection defences

Visitor message text is **untrusted input** and is treated as data,
never as instructions, at every layer:

- **System prompt separation.** The AI is called with a system prompt
  that states its role (support agent for this workspace), the
  grounding rule (answer only from the retrieved Knowledge Base
  snippets and the conversation; if the answer is not in them, say so
  and escalate), and that visitor text is data. Visitor text is never
  concatenated into the system prompt.
- **Grounding, not general knowledge.** If no Knowledge Base snippet
  is retrieved, the suggestion says the answer was not found instead
  of answering from the model's general knowledge.
- **No tool execution from visitor text.** The AI step has no tools
  that change data (no ticket mutation, no settings change, no
  outbound calls) — it only produces text. Suggestions are stored for
  agent review; automatic replies are sent only where the workspace
  policy explicitly permits them (see §8).
- **Output handling.** AI output is stored as a message/suggestion
  and rendered as text in the inbox UI. It is never executed, never
  used as a database query, and never echoed into a log.
- **Logging.** AI inputs (visitor text) and outputs are **not** logged
  to the application logs. `ai_executions` records the provider,
  model, mode, outcome, latency, token counts if returned, and error
  text on failure — not the message content.

These are defences in depth, not a guarantee: a sufficiently crafted
message can still try to steer the model. The controls that bound the
damage are the grounding rule, the absence of AI-controlled tools, and
the default Suggestion Only mode (a human reviews before anything
reaches a visitor).

## 7. Rate limits and abuse handling

- **Dispatcher → n8n:** one event per delivery, small poll batches
  (`WORKER_BATCH_SIZE`), poll interval `WORKER_POLL_MS`. A flood of
  events is spread over time by the outbox, not delivered in a burst.
- **AI provider calls:** bounded by `AI_REQUEST_TIMEOUT_MS` and by
  the providers' own free-tier quotas. A 429 (quota) from Groq or
  Gemini is recorded in `ai_executions` and surfaced — never silently
  swallowed, never retried in a tight loop. The dispatcher backoff
  applies before any retry.
- **Widget rate limits (unchanged from Phase 2.1):** sessions 10/10
  min, messages 30/10 min, history and config 60/10 min, per IP. The
  widget is the main untrusted ingress; these limits are what stop a
  single visitor from generating unbounded AI calls.
- **n8n execution retention:** n8n keeps execution records in its
  local SQLite database under n8n defaults. This workflow never logs
  message bodies, emails, or phone numbers (the dispatcher only ever
  sends ids). If the owner wants executions pruned sooner, change it
  in n8n → Settings → Executions (data retention) — do not edit the
  workflow JSON for this.

## 8. Automatic replies — policy gate

Automatic replies are **off by default**. The default AI mode for new
workspaces is **Suggestion Only**. Automatic Reply is sent only where
a workspace policy **explicitly** permits it (a per-workspace setting
stored in the database and checked on every event). There is no global
"auto-reply on" switch, and enabling it for one workspace never
affects another. If the policy check fails or the policy row is
missing, the event falls back to Suggestion Only — never to an
automatic send.

## 9. No secrets in responses or logs

- API error responses never include keys, tokens, signatures, or
  stack traces (central error handler, unchanged from Phase 1).
- The n8n workflow's Respond nodes return only `{received}` /
  `{error}` shapes — never the event payload, never a secret.
- Application logs (API, worker) contain event ids, event types, and
  workspace ids — never message bodies, emails, phone numbers, keys,
  or signatures. The outbox payload CHECK constraint (§5) is the
  backstop that keeps PII out of the queue in the first place.
- `.env` files are gitignored; `.env.example` contains placeholders
  only. Keys are supplied by the owner via Secure Vault and set in
  Render — never pasted in chat, never committed.

## 10. Widget origin enforcement — current behaviour (0008)

Migration 0008 **is applied live** on the SupportFlow AI project, and
origin enforcement was **verified live in Phase 2.1** (origins
200/403/404 matrix, empty allow-list default = app origin only,
session binding). Current behaviour:

- The API enforces `allowed_origins` on the public widget endpoints
  via `parent_origin` (see `docs/phase2-1-origins.md`); a mismatched
  or missing origin gets a generic 403 that never leaks the allow-list.
- The fallback matters only if 0008 were **not** applied: the API
  detects the missing policy RPCs and falls back to the previous
  **unenforced** behaviour rather than breaking the widget. That
  fallback is not active on the live project, because 0008 is applied.
  If the project is ever restored from an older backup that predates
  0008, enforcement is silently off until 0008 is re-applied — check
  the migration state before relying on the allow-list.
- This was reviewed in Phase 3: **no change was made to the 0008
  fallback**. The behaviour described here is the current behaviour;
  it was not altered, and no claim is made that it was.

Honest limitations carried forward from Phase 2.1 (unchanged): a
non-browser client can spoof `parent_origin`; there is no
`postMessage` handshake and no per-widget dynamic `frame-ancestors`
(CSP) on the static Vercel hosting; direct Supabase RPC calls bypass
the API-side origin check. The real widget protections remain the
visitor-session token (SHA-256 hash stored, raw token returned once),
per-IP rate limits, and the fact that widget endpoints expose no
secrets and no cross-visitor data.

## 11. Audit logging — `ai_executions`

Every AI attempt writes one row to `ai_executions` (migration 0009):
workspace, event id, provider (`groq` / `gemini`), model, AI mode,
outcome (`suggestion` / `auto_reply` / `escalated` / `failed` /
`skipped`), latency, and error text on failure. Members can read their
own workspace's rows (RLS, SELECT only). This is the audit trail for
"what did the AI do, and why" — check it before believing any claim
about an automatic reply. It contains no message content.

## 12. What Phase 3 deliberately does NOT add

- **Member invitations** — deferred as a future enhancement (see
  `docs/phase3-architecture.md`). Workspaces still gain members only
  through the Phase 1 owner flow.
- **Vector retrieval** — migration 0010 adds an optional embedding
  column, but nothing in Phase 3 writes or queries embeddings.
- **Live webhooks / outbound integrations** beyond the dispatcher →
  n8n → API loop. No third-party service receives customer data.
