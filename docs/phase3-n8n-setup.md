# Phase 3 — n8n Setup Guide (Windows laptop + free Cloudflare Tunnel)

This guide sets up the n8n half of SupportFlow AI Phase 3 on the owner's
own Windows laptop. No paid service is needed anywhere in this guide:
n8n Community Edition is free, and the Cloudflare Tunnel used to expose
it is free. Follow the steps in order; each step says how to check it
worked before moving on.

> **Read this first — the honest limitation.** n8n runs on the laptop,
> not on a server. Automation only runs while the laptop is **on** and
> the tunnel is **up**. When the laptop is off, asleep, or offline, the
> dispatcher on Render cannot reach the webhook and leaves events
> `pending` with backoff — **nothing is lost and nothing is duplicated**;
> the events are delivered when the laptop and tunnel are back. This is
> NOT a 24/7 production service. If 24/7 automation is ever needed, n8n
> would have to move to an always-on host — that is a future decision,
> not part of Phase 3. See `docs/phase3-architecture.md` for the full
> status table.

## What you will have at the end

- n8n running on the laptop at `http://localhost:5678`
- The Phase 3 workflow imported and **active** in n8n
- A public `https://…` URL (Cloudflare Tunnel) that Render can reach
- Render configured with `N8N_WEBHOOK_URL` and `AUTOMATION_WEBHOOK_SECRET`
- A test widget message that flows end-to-end: widget → outbox →
  dispatcher → n8n → API `process-event` → AI suggestion / auto-reply

## 0. What you need before you start

- A Windows 10/11 laptop with an internet connection.
- The shared webhook secret. It is a random string the owner generates
  (step 3 below shows how). It must be set to the **same value in two
  places**: Render (`AUTOMATION_WEBHOOK_SECRET`) and n8n
  (`N8N_WEBHOOK_SECRET`). If the two values differ, every delivery gets
  a 401 — see [Troubleshooting](#9-troubleshooting).
- The AI provider keys (Groq / Gemini) are **not** needed for this
  guide. They are set later in Render only, from the owner via Secure
  Vault. They are never pasted into n8n, never pasted in chat, and never
  committed. See `docs/phase3-security.md`.

## 1. Install Node.js LTS

1. Open https://nodejs.org in a browser.
2. Download the **LTS** version (the big green button — not "Current").
3. Run the installer. Accept the defaults. On the "Tools for Native
   Modules" screen you can leave the checkbox **unchecked** — n8n does
   not need it.
4. Check it worked — open **PowerShell** and run:

```powershell
node --version
npm --version
```

Both commands should print a version number (e.g. `v22.x.x` and
`10.x.x`). If PowerShell says `node` is not recognised, close and
re-open PowerShell (the installer updates PATH) and try again. If it
still fails, re-run the installer and make sure "Add to PATH" was
selected.

## 2. Install n8n

In the same PowerShell window:

```powershell
npm install -g n8n
```

This downloads n8n Community Edition (free, open source). It can take
a minute or two. Check it worked:

```powershell
n8n --version
```

It should print a version number. Ignore any `npm WARN` lines — they
do not stop the install.

## 3. Create the two secrets (do this once, store them safely)

You need **two different** random secrets. They are not the same thing,
and mixing them up is the most common setup mistake:

| Secret | Where it lives | What it protects |
|---|---|---|
| `N8N_ENCRYPTION_KEY` | Only on the laptop, in n8n's environment | Encrypts the credentials n8n stores on disk (its own database). If you lose it, n8n can no longer decrypt its stored credentials and you must recreate them. |
| `N8N_WEBHOOK_SECRET` (Render calls it `AUTOMATION_WEBHOOK_SECRET`) | Laptop (n8n env) **and** Render (API env), same value in both | The HMAC signature on every webhook delivery between the dispatcher and n8n, and between n8n and the API. If it leaks, anyone who has it can forge deliveries — rotate it (see `docs/phase3-security.md`). |

Generate both now. In PowerShell:

```powershell
# N8N_ENCRYPTION_KEY — for n8n itself
openssl rand -hex 32
# Webhook secret — same value goes in n8n AND in Render
openssl rand -hex 32
```

If `openssl` is not available on the laptop, use the PowerShell
equivalent instead (run it twice, once per secret):

```powershell
-join ((48..57) + (97..102) | Get-Random -Count 64 | ForEach-Object { [char]$_ })
```

**Write both values down somewhere safe** (a password manager, not a
chat message and not a file in the repo). Losing
`N8N_ENCRYPTION_KEY` means n8n's stored credentials cannot be
decrypted. Losing the webhook secret just means generating a new one
and updating both places.

## 4. Start n8n and create the owner account

Set the encryption key for this session, then start n8n. In PowerShell
(replace the value with the one you generated):

```powershell
$env:N8N_ENCRYPTION_KEY = "paste-your-n8n-encryption-key-here"
$env:N8N_WEBHOOK_SECRET = "paste-your-webhook-secret-here"
n8n start
```

Or, if you installed n8n with `npm install -g n8n`, `npx n8n` works the
same way. Leave this PowerShell window open — n8n runs in it. Closing
the window stops n8n.

When you see `Editor is now accessible via: http://localhost:5678`,
open that address in a browser. The first time, n8n asks you to create
the **owner account** (email + password). This account only exists on
the laptop; it is not shared with anyone and it is not the Supabase or
Render login. Remember the password — it is the only way back into
n8n. (If you forget it, see step 9 — there is a recovery path, but it
is fiddly; a password manager avoids it.)

Check it worked: you see the n8n canvas (empty workflows list). n8n
stores its data — workflows, credentials, execution history — in a
local SQLite database under `%USERPROFILE%\.n8n` (see step 8 for
backups). No external database is needed.

> **Making the key permanent (optional).** The two `$env:` lines above
> only last for that PowerShell window. Every time you restart n8n you
> must set them again before `n8n start`. If that gets annoying, set
> them as permanent user environment variables instead: search Windows
> for "Edit environment variables for your account" → New → variable
> name `N8N_ENCRYPTION_KEY` / `N8N_WEBHOOK_SECRET` with the values.
> Restart PowerShell afterwards. Do **not** put the secrets in a file
> in the repo, and do not share screenshots that show them.

## 5. Expose n8n with a free Cloudflare Tunnel

Render cannot reach `http://localhost:5678` — that address only exists
on the laptop. A Cloudflare Tunnel gives n8n a public `https://…` URL
without opening any port on the router and without a static IP.

### 5a. Install cloudflared

In PowerShell (as administrator if winget asks):

```powershell
winget install Cloudflare.cloudflared
```

If winget is not available, download `cloudflared-windows-amd64.exe`
from the Cloudflare website, rename it to `cloudflared.exe`, and put
it in a folder that is on PATH (or call it by its full path).
Close and re-open PowerShell after installing, then check:

```powershell
cloudflared --version
```

### 5b. Quick tunnel (for testing — URL changes on every restart)

In a **second** PowerShell window (keep the n8n window running):

```powershell
cloudflared tunnel --url http://localhost:5678
```

After a few seconds it prints a line like:

```
https://random-words-try.cloudflare-tunnel.com
```

That is the public URL of the laptop's n8n. Copy it. It works
immediately, needs **no Cloudflare account**, and is free. The catch:
**the URL changes every time you restart the tunnel**, so every
restart means updating `N8N_WEBHOOK_URL` in Render (step 6). That is
fine for a first test; for day-to-day use, set up a named tunnel
below.

### 5c. Named tunnel (recommended — stable URL)

A named tunnel keeps the same public URL across restarts. It needs a
free Cloudflare account (no card required for tunnels) and one DNS
record on a domain you control in Cloudflare. If you do not have a
domain on Cloudflare, stay on the quick tunnel for now and revisit
this later — the workflow works identically either way.

```powershell
# Log in once (opens a browser; pick the Cloudflare account)
cloudflared tunnel login

# Create the tunnel (once)
cloudflared tunnel create supportflow-n8n

# Route a subdomain to it (once; needs a domain on Cloudflare)
cloudflared tunnel route dns supportflow-n8n n8n.yourdomain.com

# Run it (every time you start n8n)
cloudflared tunnel run --url http://localhost:5678 supportflow-n8n
```

Your public URL is then `https://n8n.yourdomain.com` — stable across
restarts. The webhook URL becomes
`https://n8n.yourdomain.com/webhook/supportflow-message`.

## 6. Tell Render where n8n is (and set the shared secret there)

1. Take the public URL from step 5 and append
   `/webhook/supportflow-message`. That is the webhook URL, e.g.
   `https://random-words-try.cloudflare-tunnel.com/webhook/supportflow-message`
   (quick tunnel) or `https://n8n.yourdomain.com/webhook/supportflow-message`
   (named tunnel).
2. Open the Render dashboard → service **`supportflow-api`** →
   **Environment** → add / update these two variables:
   - `N8N_WEBHOOK_URL` = the webhook URL from step 1 above.
   - `AUTOMATION_WEBHOOK_SECRET` = the **same** webhook secret value
     you put in `N8N_WEBHOOK_SECRET` on the laptop. Not the encryption
     key. Not a different random string. The same value.
3. Save. Render redeploys the API automatically (free tier: the service
   may take ~a minute to wake up; that is the Render cold start, not an
   error — see `docs/phase3-troubleshooting.md`).

Also set `API_BASE_URL` for n8n's side (step 7): the workflow calls
`POST {{$env.API_BASE_URL}}/api/automation/process-event`, so n8n
needs `API_BASE_URL=https://supportflow-api-q0md.onrender.com`. Set it
in the same place you set the n8n env vars (step 4 / step 7).

## 7. Import the workflow and activate it

1. In n8n (`http://localhost:5678`), go to **Workflows → Import from
   file** and pick `n8n/workflows/supportflow-ai-phase3.json` from the
   repo. (Do **not** import the old
   `n8n/workflows/ticket-routing.placeholder.json` — it is a Phase 1
   skeleton with no nodes, kept only as a record.)
2. Open the workflow. Check the **Webhook node** shows the path
   `supportflow-message` and that **Options → Raw Body** is ON. If you
   ever re-create the Webhook node, turn Raw Body back on — without it
   every delivery fails signature verification (401).
3. Set the workflow's environment variables. In n8n, environment
   variables are read from the environment n8n starts with (the
   PowerShell `$env:` lines from step 4, or the permanent user
   variables). The workflow needs:
   - `N8N_WEBHOOK_SECRET` — the webhook secret (step 3).
   - `API_BASE_URL` — `https://supportflow-api-q0md.onrender.com`.
   If you added them as permanent user variables after starting n8n,
   restart n8n so it picks them up.
4. Click **Execute workflow** once (manual run) to check the workflow
   loads without a red error on a node. A manual run will not receive a
   real event — it just proves the nodes are configured.
5. Flip the **Active** toggle (top-right) to on. The workflow is now
   live. Click the **Webhook node** and copy the **Production URL** —
   it must match the `N8N_WEBHOOK_URL` you put in Render in step 6.
   (The **Test URL** is different and only works while you are
   listening for a test event in the editor — never put the Test URL in
   Render.)

## 8. Test end-to-end

1. Make sure n8n is running, the tunnel is running, and the workflow
   is **Active**.
2. Open the live site `https://supportflow-ai-delta.vercel.app/` and
   send a message through the chat widget (or the `/widget-demo`
   page). This creates a `customer.message.created` outbox event.
3. Watch two places:
   - **n8n → Executions** (left sidebar): a new execution should
     appear within a few seconds, with all nodes green. Click it to see
     each node's input/output. A 401 there means the secret mismatches
     (step 9).
   - **Render → service `supportflow-api` → Logs**: you should see the
     dispatcher deliver the event and the API log the `process-event`
     call. On the free tier, if the API was asleep, the first call can
     take ~a minute (cold start) — wait before concluding it failed.
4. Check the result in the app: depending on the workspace's AI mode
   (default: **Suggestion Only**), an AI suggestion should appear on
   the conversation for an agent to review — or, only where the
   workspace policy explicitly allows Automatic Reply, an automatic
   reply. See `docs/phase3-architecture.md` for the modes.
5. If nothing arrives in n8n after a minute, work through
   `docs/phase3-troubleshooting.md` (dispatcher can't reach n8n is the
   first entry).

### Start / stop / restart (the daily routine)

- **Stop n8n:** focus the n8n PowerShell window and press `Ctrl+C`.
- **Stop the tunnel:** `Ctrl+C` in the cloudflared window.
- **Start again:** set the env vars (step 4) → `n8n start` → in the
  second window, re-run the cloudflared command (step 5). If you use
  the **quick tunnel**, the public URL changed — update
  `N8N_WEBHOOK_URL` in Render (step 6) and wait for the redeploy.
  With a **named tunnel** the URL is stable and nothing needs
  updating.
- **Laptop sleep:** closing the lid / sleep stops both n8n and the
  tunnel. Events stay `pending` in the outbox and are delivered when
  you start everything again. Nothing is lost.

### Where n8n data lives, and backups

Everything n8n stores — workflows, credentials, execution history —
lives in `%USERPROFILE%\.n8n` on the laptop (a local SQLite database
plus config). **Back up that folder** (e.g. copy it to an external
drive or cloud folder) whenever you change a workflow or add a
credential. If the laptop is lost or Windows is reinstalled without
that folder, the workflows and the encryption key are gone. The
workflow JSON in the repo (`n8n/workflows/supportflow-ai-phase3.json`)
is the recoverable copy of the workflow itself — re-importing it is
enough to rebuild the flow, but the n8n-side credentials and execution
history live only in `%USERPROFILE%\.n8n`.

### Inspecting and deactivating

- **Inspect executions:** n8n → **Executions** (left sidebar) → click
  an execution to see every node's input and output. Failed executions
  are shown in red. This is the first place to look when automation
  does not run.
- **Deactivate the workflow:** open it and flip the **Active** toggle
  off. The dispatcher will then fail to reach the webhook, leave
  events `pending`, and retry — so deactivating pauses automation
  without losing events. To stop automation entirely, also clear
  `N8N_WEBHOOK_URL` in Render (or set the workspace AI mode to
  **Disabled** — see `docs/phase3-architecture.md`).

## 9. Troubleshooting

| Symptom | Likely cause | Fix |
|---|---|---|
| Every execution fails at `Verify signature` (401) | `N8N_WEBHOOK_SECRET` (laptop) ≠ `AUTOMATION_WEBHOOK_SECRET` (Render), or Raw Body is off | Check both values match exactly (no trailing space); restart n8n after changing env vars; confirm Webhook node Options → Raw Body is ON |
| No executions appear at all in n8n | Tunnel URL changed (quick tunnel) and Render still has the old URL, or the tunnel / n8n is not running | Re-run cloudflared, copy the new URL, update `N8N_WEBHOOK_URL` in Render, wait for redeploy; or switch to a named tunnel (step 5c) |
| `localhost:5678` refuses to connect | n8n is not running, or port 5678 is in use by something else | Start n8n (step 4); if the port is taken, stop the other program or start n8n with `$env:N8N_PORT = "5679"` and use `http://localhost:5679` (and point the tunnel at 5679) |
| `n8n` is not recognised in PowerShell | Node.js PATH not picked up | Close and re-open PowerShell; if it still fails, reinstall Node.js LTS with "Add to PATH" |
| `cloudflared` is not recognised | winget install did not finish / PATH not picked up | Close and re-open PowerShell; check `winget list Cloudflare.cloudflared` |
| Events stay `pending` for hours | Laptop asleep/off, or tunnel down | Start n8n + tunnel; pending events are delivered on the next dispatcher poll — nothing needs re-sending |
| First delivery is very slow, then fine | Render free-tier cold start (~1 min after 15 min idle) | Wait; this is expected on the free tier |
| n8n asks for the owner account again / workflows are gone | n8n started with a different home / `%USERPROFILE%\.n8n` was deleted, or `N8N_ENCRYPTION_KEY` changed | Restore `%USERPROFILE%\.n8n` from backup; the encryption key must be the same one used when the data was created |
| 500 from `Call process-event` | API error (see Render logs) or provider quota (429) | See `docs/phase3-troubleshooting.md` — the dispatcher retries, so check Render logs before re-sending anything |

Full failure catalogue (including provider quota, stuck events, and
Supabase pause): `docs/phase3-troubleshooting.md`.
Security details (secret rotation, HMAC, replay protection):
`docs/phase3-security.md`.
