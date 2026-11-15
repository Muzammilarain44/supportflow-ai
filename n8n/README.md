# n8n — Phase 3

n8n is live in Phase 3 — on the owner's own Windows laptop, not on a
server. The Community Edition runs at `http://localhost:5678` and is
exposed to the Render backend through a **free Cloudflare Tunnel** at a
public `https://…` URL. The dispatcher posts automation events to that
URL; the workflow verifies them and forwards them to the API.

**This is NOT a 24/7 production service.** Automation only runs while
the laptop is on and the tunnel is up. When it is off/asleep/offline,
the dispatcher leaves events `pending` with backoff — nothing is lost,
nothing is duplicated.

## Workflows

| File | Status |
|---|---|
| `workflows/supportflow-ai-phase3.json` | **Live Phase 3 workflow — import this one.** Webhook → Verify signature → Validate event → Sign request → Call process-event → Respond 200/500. |
| `workflows/ticket-routing.placeholder.json` | Phase 1 skeleton only. **Do not import.** Kept as a record. |

## The workflow (summary)

1. **Webhook — SupportFlow event** (`POST /webhook/supportflow-message`,
   `responseMode: responseNode`, **Raw Body ON** — the signature is
   verified over the exact bytes sent).
2. **Verify signature** — HMAC-SHA256 over
   `${x-sf-timestamp}.${rawBody}`, secret from `$env.N8N_WEBHOOK_SECRET`,
   timestamp tolerance ±300 s. Failure → Respond 401.
3. **Validate event** — `event_id` / `event_type` / `workspace_id`
   present, `event_type` in the known outbox set; duplicates dropped
   on `event_id` (workflow static data, 24 h). Malformed → Respond
   400; duplicate → Respond 200 `{received: true, duplicate: true}`.
4. **Sign request** — re-signs with the same secret for the API call.
5. **Call process-event** — `POST {{$env.API_BASE_URL}}/api/automation/process-event`,
   timeout 20 s, retry on network failure (2 tries). Never Error is on
   so HTTP 5xx reaches the delivery check instead of failing the node.
6. **Delivery OK?** — HTTP 200/202 → Respond 200 `{received: true}`;
   anything else → Respond 500 so the dispatcher retries with backoff.

No URLs are hardcoded (API base URL from `$env.API_BASE_URL`), no
secrets are in the file (secret from `$env.N8N_WEBHOOK_SECRET`), and no
customer data is logged (the dispatcher only ever sends ids).

## Setup

Full step-by-step for a non-expert Windows user (install Node.js LTS,
install n8n, create the secrets, start the tunnel, set the Render env
vars, import + activate, test):
**`docs/phase3-n8n-setup.md`**

Architecture, AI modes, RAG, operational status:
**`docs/phase3-architecture.md`**

Security (HMAC, secret rotation, RLS, prompt injection, 0008 fallback):
**`docs/phase3-security.md`**

Troubleshooting (unreachable n8n, 401, provider 429, stuck events):
**`docs/phase3-troubleshooting.md`**

## Environment variables (n8n side)

| Variable | Value |
|---|---|
| `N8N_ENCRYPTION_KEY` | Random secret for n8n's own stored credentials (laptop only; losing it means stored n8n credentials cannot be decrypted). |
| `N8N_WEBHOOK_SECRET` | Shared webhook secret — **same value** as Render `AUTOMATION_WEBHOOK_SECRET`. |
| `API_BASE_URL` | `https://supportflow-api-q0md.onrender.com` |

Never expose a private n8n webhook URL publicly; store it server-side
only (Render env `N8N_WEBHOOK_URL`).
