# SupportFlow AI — Phase 3: AI providers

How the AI agent layer calls external LLM providers, what can go wrong,
and what the operator must verify before production use.

Last verified: **2026-11-15** (live checks; see below).
Defaults live in `apps/api/src/env.ts` (`AI_MODEL_*`); the browser-like
User-Agent every provider request must carry is exported from the same
file as `AI_HTTP_USER_AGENT`.

`apps/api/src/lib/ai.ts` is provider-independent. It tries providers in
`AI_PROVIDER_ORDER` order (default `groq,gemini`) using the OpenAI-compatible
chat-completions shape (`{model, messages, temperature: 0.3, max_tokens}`).

| Provider | Endpoint | Key env var | Default model |
|---|---|---|---|
| Groq | `https://api.groq.com/openai/v1/chat/completions` | `GROQ_API_KEY` | `openai/gpt-oss-20b` (`AI_MODEL_GROQ`) |
| Gemini | `https://generativelanguage.googleapis.com/v1beta/openai/chat/completions` | `GEMINI_API_KEY` | `gemini-3.8-flash` (`AI_MODEL_GEMINI`) |

A provider with no key configured is skipped (not an error by itself).
Each provider call has its own timeout via `AbortController`
(`AI_REQUEST_TIMEOUT_MS`, default 30000).

## Groq — VERIFIED LIVE

- A real chat completion works against
  `https://api.groq.com/openai/v1/chat/completions` (OpenAI-compatible).
  Verified response: `"Hello!"` in ~0.05s, 122 tokens, model
  `openai/gpt-oss-20b`.
- Roster for this key (chat-capable): `openai/gpt-oss-120b`,
  `openai/gpt-oss-20b`, `qwen/qwen3.8-27b`, `allam-2-7b`, plus
  whisper / prompt-guard models.
- **NO Llama chat models on the free roster.** Never use any Llama chat
  model anywhere in code, docs, tests, or defaults.
- Defaults:
  - Primary (default): `AI_MODEL_GROQ=openai/gpt-oss-20b`
  - Quality tier (only where quality matters, configurable, never the
    default): `AI_MODEL_GROQ_QUALITY=openai/gpt-oss-120b`
- **Cloudflare gate:** Groq sits behind Cloudflare. Requests WITHOUT a
  browser User-Agent get HTTP **403 error code 1010**. The AI client MUST
  send a browser-like User-Agent header on every provider request
  (exported as `AI_HTTP_USER_AGENT` from `apps/api/src/env.ts`; a test
  asserts the header is present on outgoing provider calls). Do not
  remove it.

## Gemini — model list verified, generation NOT yet proven live

- Model listing verified: 50 models, including `gemini-3.8-flash`,
  `gemini-3.6-flash`, `gemini-3.5-flash-lite`, `gemini-3.1-flash-lite`.
- **Generation is unproven:** one `generateContent` call to
  `gemini-3.8-flash` returned HTTP **503**. Do not claim live verification
  of the Gemini generation path; tests mock it until a live generation
  succeeds (retest at live verification).
- Fallback chain (per-model, in order — try each on 503 / 429 / 5xx
  before giving up to the next provider or failing):
  `gemini-3.8-flash` → `gemini-3.6-flash` → `gemini-3.5-flash-lite` →
  `gemini-3.1-flash-lite` (implemented in `apps/api/src/lib/ai.ts` via
  `AI_MODEL_GEMINI_FALLBACKS`).
- Defaults:
  - `AI_MODEL_GEMINI=gemini-3.8-flash`
  - `AI_MODEL_GEMINI_FALLBACKS=gemini-3.6-flash,gemini-3.5-flash-lite,gemini-3.1-flash-lite`
- Note that the Gemini model used by the sibling VU StudyMate project had
  to be changed when `gemini-2.5-flash` was retired for new users — the
  same can happen here. Re-check the roster in Google AI Studio before
  enabling auto-reply in production, and run one real suggestion-mode
  request to confirm an `ai_executions` row with `status='success'` and
  the expected `model`.

## Provider order

Groq first, Gemini fallback (`provider_order: ['groq', 'gemini']` in the
workspace `ai_settings` defaults). The order is read-only in the
dashboard AI settings page; no provider keys are ever shown there.

## Quota errors are surfaced, never hidden

- A **429** (rate limit / quota) from a provider falls through to the
  next provider (and, for Gemini, to the next model in its fallback
  chain), and the final `AiUnavailableError` carries `status: 429`,
  `retryable: true`, `quotaExceeded: true`.
- **Gemini free tier may allow only ~20 requests/day.** When that quota
  is exhausted every Gemini call returns 429; the processor records an
  `ai_executions` row with `status='failed'` and **escalates the
  conversation to a human** — it never silently drops the customer
  message and never invents a reply.
- The same applies to 5xx and network/timeout failures: fall through,
  then `AiUnavailableError`, then escalation.
- No API key ever appears in a response, log, or error message — only
  the provider name and HTTP status are reported.

## Keys — Secure Vault only

- Both keys (`GROQ_API_KEY`, `GEMINI_API_KEY`) live ONLY in the Secure
  Vault. Their values must NOT appear in code, docs, `.env` files,
  tests, or commits. The AI layer reads them from server env vars only
  (see `apps/api/src/env.ts`).
- **Deploy step (done by the user, not by Muse):** at Render deploy
  time, paste each key into the Render service's environment variables
  (`GROQ_API_KEY` and `GEMINI_API_KEY`). Key values are not readable
  from the vault, so Muse cannot paste them — the user does this step
  himself in the Render dashboard.

## Environment variables (all optional unless noted)

| Variable | Default | Notes |
|---|---|---|
| `AI_PROVIDER_ORDER` | `groq,gemini` | Comma-separated; unknown names ignored |
| `GROQ_API_KEY` | — | Groq console |
| `GEMINI_API_KEY` | — | Google AI Studio |
| `AI_MODEL_GROQ` | `openai/gpt-oss-20b` | Verified live (see above) |
| `AI_MODEL_GROQ_QUALITY` | `openai/gpt-oss-120b` | Quality tier; roster-listed, generation not yet verified live |
| `AI_MODEL_GEMINI` | `gemini-3.8-flash` | Verify live (see above) |
| `AI_MODEL_GEMINI_FALLBACKS` | `gemini-3.6-flash,gemini-3.5-flash-lite,gemini-3.1-flash-lite` | Per-model chain |
| `AI_REQUEST_TIMEOUT_MS` | `30000` | Per-provider timeout |
| `N8N_WEBHOOK_URL` | — | Outbound n8n webhook (see docs/phase3-n8n-setup.md) |
| `AUTOMATION_WEBHOOK_SECRET` | — | HMAC secret for `POST /api/automation/process-event`. **Minimum 32 characters when set** — `loadEnv()` warns clearly at boot if it is shorter. Missing secret → the endpoint returns 503. |
| `AI_DIRECT_PROCESSING` | `false` | `true` = process automation events inline instead of via n8n |
| `API_BASE_URL` | `http://localhost:4000` | Public base URL of this API |

API keys are **never** accepted or returned by any endpoint. The
`ai-settings` PATCH schema is strict and has no key fields.

## Modes (`ai_settings.mode`)

- `disabled` / `human_only` — AI never generates; the processor records
  an `ai_executions` row with `status='skipped'`.
- `suggestion` (default) — the AI drafts a suggestion (`ai_suggestions`,
  `status='pending'`); an agent reviews it in the dashboard before
  anything is sent.
- `auto` — the AI replies directly, but only when grounding is satisfied
  (see below). Unsafe drafts are never sent.

## Grounding and safety gates (auto mode)

- `auto_reply_require_grounding` (default `true`): with no retrieved
  knowledge excerpt, the conversation is escalated instead of answered.
- Unsafe-response guard (`apps/api/src/lib/prompts.ts`): a draft that
  promises a refund, discount, payment, or account change is rejected
  and the conversation is escalated with reason `unsafe_response`.
- **Loop prevention:** only `customer.message.created` events with
  `sender_type='customer'` trigger AI. Agent/system messages (including
  AI replies) never trigger it, and AI replies never record a new
  `customer.message.created` outbox event. Auto-replies are idempotent
  on `client_message_id = ai-<event id>`.
- `escalation_on_low_confidence` (default `true`): currently the
  providers return no confidence score, so there is no numeric
  low-confidence trigger in this phase; the flag is stored and honoured
  by the grounding / unsafe-response / provider-failure escalation paths.
  A future provider that returns confidence can wire into it.

## Process-event webhook (HMAC)

`POST /api/automation/process-event` (no user auth) verifies
`x-sf-signature` / `x-sf-timestamp` via
`apps/api/src/lib/webhookAuth.ts`. Missing/invalid signature → 401;
missing `AUTOMATION_WEBHOOK_SECRET` → 503; valid event → 200
`{outcome}`. The router is mounted in `app.ts` BEFORE the global
`express.json()` parser, with `express.raw({ type: 'application/json' })`,
so verification runs over the exact raw request bytes; the sender
(dispatcher / n8n) MUST sign those same bytes.

## Audit trail

Every AI path writes an `ai_executions` row (`status` pending / success /
failed / escalated / skipped, provider, model, token counts, latency,
error). Suggestion review (`accept` / `reject`) records `reviewed_by`.
Escalations create/reuse a ticket, a `handoffs` row, and set
`conversations.ai_paused=true`. AI is never auto-resumed; an agent
resumes it via `POST .../conversations/:id/ai-resume`, which the route
refuses (409) when the workspace policy forbids resuming.

## What is NOT verified yet

- Gemini generation end-to-end (503 observed once — retest at live
  verification; fallback chain exercised with mocks until then).
- Groq quality-tier model (`openai/gpt-oss-120b`) generation — listed on
  the roster, but only the 20b model has a verified live completion.
- No live Groq/Gemini calls were made from this codebase yet; provider
  behaviour is covered by mocked-fetch unit tests only.
- Migration 0009 is unapplied live; the `ai_*`, `knowledge_*` and
  `handoffs` tables do not exist on live Supabase until the parent
  applies it.
