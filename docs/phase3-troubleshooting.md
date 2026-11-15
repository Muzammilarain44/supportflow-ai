# Phase 3 — Troubleshooting

Common Phase 3 failures, in the order to check them. For n8n setup
problems (install, tunnel, first run), see
`docs/phase3-n8n-setup.md` §9 first — this page is for failures in the
running system.

How to tell where a failure is: check the three logs in order —
**n8n → Executions** (did the event reach n8n?), **Render → service
`supportflow-api` → Logs** (did the dispatcher deliver / did
`process-event` run?), and **`ai_executions`** in Supabase (did the AI
step run, and with what outcome?). The first log that has no entry
tells you which hop failed.

## 1. Dispatcher can't reach n8n

**Symptoms:** events stay `pending` in `automation_events`;
`ai_executions` has no new rows; n8n Executions shows nothing new.

**Causes (most likely first):**

1. The laptop is off / asleep, or n8n is not running. Automation only
   runs while the laptop is on and n8n is up — this is expected, not a
   bug. Start n8n (`docs/phase3-n8n-setup.md` §8) and the pending
   events are delivered on the next dispatcher poll. Nothing needs
   re-sending.
2. The tunnel is not running, or the **quick-tunnel URL changed** and
   Render still has the old `N8N_WEBHOOK_URL`. Re-run cloudflared,
   copy the new URL, update `N8N_WEBHOOK_URL` in Render (service
   `supportflow-api` → Environment), wait for the redeploy. A named
   tunnel (stable URL) avoids this entirely.
3. The workflow is not **Active** in n8n (toggle off). Activate it.
4. The wrong URL is in Render — the **Test URL** instead of the
   **Production URL**. The Test URL only works while listening for a
   test event in the editor. Use the Production URL.
5. `N8N_WEBHOOK_URL` is missing entirely — the dispatcher has nowhere
   to deliver to. Set it (step 6 of the setup guide). If direct
   processing is intended instead, set `AI_DIRECT_PROCESSING=true`
   and confirm the worker picked it up (Render logs).

**Check:** `curl` the webhook URL from any machine (no body needed —
you expect a 401/400/405, which proves the tunnel reaches n8n; a
timeout or connection error proves it does not).

## 2. 401 — signature mismatch

**Symptoms:** n8n executions fail at `Verify signature`, or
`process-event` returns 401; dispatcher logs show 401.

**Causes:**

1. `N8N_WEBHOOK_SECRET` (laptop) ≠ `AUTOMATION_WEBHOOK_SECRET`
   (Render). The two values must be identical, with no trailing space
   or newline. Fix one side, restart n8n, and re-test. Events that
   401'd stay `pending` and are retried — nothing is lost.
2. The n8n **Webhook node's Raw Body option is off.** The signature
   is computed over the exact bytes sent; without Raw Body, n8n
   re-serialises the body and the signature fails. Turn Raw Body on
   (Webhook node → Options → Raw Body). If the node was re-created,
   this is the first thing to check.
3. The laptop clock is wrong. The replay window is ±300 s; a clock
   that is hours off fails every delivery. Fix the clock (Windows
   Settings → Time → Sync now). Do not widen the window.
4. The secret was rotated on one side only. Complete the rotation
   (`docs/phase3-security.md` §2) and re-test.

**Do not** "fix" a 401 by disabling verification, removing the
signature check, or hardcoding the secret into the workflow — that
removes the only authentication on the webhook.

## 3. Provider quota — 429 (Groq / Gemini)

**Symptoms:** `ai_executions` rows with outcome `failed` and a 429 /
quota error; suggestions stop appearing; no crash, no data loss.

**What it means:** the free tier is exhausted for now.

- **Gemini free tier** may be around ~20 requests/day (Google AI
  Studio quota; verify the live number in AI Studio — it changes).
  When it is used up, calls fail until the quota resets.
- **Groq free tier** also has rate limits (requests/minute and
  tokens/day — verify the live numbers in the Groq console).

**What to do:**

1. Check `ai_executions` for which provider failed — the fallback only
   triggers when Groq fails, so a Gemini 429 means Groq already failed
   too (or was skipped). Read both errors.
2. Wait for the quota reset; events that failed are recorded as
   `failed` in `ai_executions` and the underlying outbox event is
   already `processed` (the AI step ran and failed — it is not
   re-queued automatically). If a failed event needs an AI attempt,
   an agent can handle the conversation manually, or the event can be
   re-queued by support (reset the outbox row to `pending` — a manual
   database step, not something the UI does).
3. Do not "fix" quota errors by hiding them, retrying in a tight loop,
   or switching to a paid tier without the owner's explicit approval.
   Quota errors are surfaced by design (`docs/phase3-security.md`
   §7). If quota is hit daily, the honest options are: fewer AI
   calls (Human Only / Disabled for low-priority workspaces), or the
   owner deciding to pay — his decision, not an automatic upgrade.

## 4. No knowledge retrieved (empty grounding)

**Symptoms:** suggestions say the answer was not found, or escalate,
even though the answer exists in the Knowledge Base.

**Causes:**

1. The Knowledge Base is empty for that workspace — no documents have
   been added yet. Add documents (dashboard → Knowledge Base) and
   re-test.
2. The question uses words that do not appear in the chunks. Phase 3
   retrieval is **lexical** (Postgres full-text search), not semantic:
   it matches words, not meaning. Rewording the document to use the
   words visitors use is the fix. Vector retrieval (Phase 4) is the
   long-term answer, not a Phase 3 fix.
3. Retrieval searched the wrong workspace — check the workspace id on
   the event and on the documents. (If this is actually happening, it
   is a bug, not a tuning issue — report it with the event id.)
4. Chunks were never created for a document (ingestion failed). Check
   the document's chunk count in the dashboard / database.

## 5. Events stuck `pending`

**Symptoms:** `automation_events` rows stay `pending` for a long time;
nothing in n8n Executions; no error anywhere.

**Causes:**

1. n8n is down (see §1) — the most common cause. Events wait safely;
   they are not lost.
2. The dispatcher/worker is down or asleep (Render free-tier cold
   start). Check Render → worker service → Logs. A cold start adds
   ~1 min; longer than that means the service is crashed or the poll
   loop stopped — check the logs for the startup error.
3. `N8N_WEBHOOK_URL` is unset and `AI_DIRECT_PROCESSING` is not
   `true` — the dispatcher has no delivery target. Set one of them.
4. A previous claim never released: a row stuck in `processing` (not
   `pending`) means a worker claimed it and crashed before
   acknowledging. It is re-polled after the claim lease expires; if it
   stays in `processing` for hours, reset it to `pending` manually in
   Supabase (SQL Editor) and watch the next poll.

**Do not** delete `pending` rows to "clear" the queue — that deletes
the record that the event ever happened. `dead` rows are the ones for
manual inspection; `pending` rows are work waiting to happen.

## 6. Render cold start

**Symptoms:** the first delivery after ~15 min of inactivity takes
~1 minute, then everything is fast again. The n8n HTTP node may hit
its 20 s timeout on that first call and answer 500; the dispatcher
retries and the second attempt succeeds.

**What it is:** the Render free tier sleeps idle services. It is
expected, not an error. If the 20 s timeout is hit repeatedly on cold
starts, the retry (dispatcher backoff + n8n `retryOnFail`) covers it.
Do not raise the timeout to minutes to "fix" a cold start — the retry
path is the correct handling, and a long timeout holds the webhook
connection open while the dispatcher waits.

## 7. Supabase pause after 7 days of inactivity

**Symptoms:** everything fails at once — API 500s, logins fail,
dashboard empty, "project paused" in the Supabase dashboard.

**What it is:** Supabase free-tier projects pause after 7 days of
inactivity. **Fix:** Supabase Dashboard → select the project →
**Restore / Resume**. It takes a few minutes. Nothing is deleted by a
pause. To avoid it, make sure the project sees some activity at least
weekly (any login or API call counts).

## 8. Duplicate suggestions / duplicate auto-replies

**Symptoms:** the same suggestion (or auto-reply) appears twice for
one visitor message.

**Causes:**

1. The event was legitimately delivered twice (worker crash between
   claim and acknowledge, or an n8n retry after a timeout) and
   `process-event` did not dedupe on `event_id`. Check
   `ai_executions` for two rows with the same event id. If dedupe is
   missing, that is a bug in `process-event` — report it with the
   event id; do not work around it by deleting rows.
2. The visitor sent the same message twice (two widget sends, two
   `client_message_id`s). That is two real events, not a duplicate —
   the widget idempotency (migration 0005) only dedupes the same
   `client_message_id`.

## 9. n8n workflow fails on a node other than the webhook

| Node | Likely cause | Fix |
|---|---|---|
| `Verify signature` | See §2 (401) | Secret / Raw Body / clock |
| `Validate event` → 400 | Event shape wrong or unknown `event_type` | Check the dispatcher is sending the outbox event shape (`event_id`, `event_type`, `workspace_id`); a new event type needs adding to the known list in the workflow **and** in `apps/api/src/lib/outbox.ts` |
| `Sign request` | `N8N_WEBHOOK_SECRET` unset in n8n env | Set it and restart n8n |
| `Call process-event` → 500 | API error (see Render logs) or provider quota (§3) | Read the Render log line for that event id; do not re-send — the dispatcher retries |
| `Call process-event` → timeout | Render cold start (§6) or API down | Wait for the dispatcher retry; check Render service status |
| `Respond 500` loop | API persistently failing | Fix the API-side cause first; the dispatcher backs off and marks the event `dead` after its retry budget — inspect the `dead` row |

## 10. Where to look (quick reference)

| Question | Where |
|---|---|
| Did the event reach n8n? | n8n → Executions |
| Did the dispatcher deliver? | Render → `supportflow-api` → Logs (search the event id) |
| Did the AI step run? | Supabase → `ai_executions` (filter by event id / workspace) |
| Is the event stuck? | Supabase → `automation_events` (filter by `status`) |
| Is the API awake? | `GET https://supportflow-api-q0md.onrender.com/health` |
| Is the widget origin blocked? | 403 `Embedding origin not allowed` — see `docs/phase2-1-origins.md` (Phase 2.1, unchanged in Phase 3) |
