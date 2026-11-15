# SupportFlow AI — Phase 2.1: Widget Origin Enforcement (Issue 4)

How `allowed_origins` is enforced for the public chat widget, what it can
and cannot protect against, and what is still not done. Read this before
relying on the allow-list for anything.

## The architectural fact that shapes everything

The widget is an **iframe served from the same Vercel app as the
dashboard** (`/widget-embed?key=…` on the frontend origin, e.g.
`https://supportflow-ai-delta.vercel.app`). API calls made from inside
the iframe therefore carry the **iframe's origin** (the app's own
frontend origin), **not** the embedding site's origin. A naive
`Origin`-header check on the widget API endpoints would check the wrong
origin and break every legitimate embed.

The embedding page's origin is only available to the iframe as a
**client-asserted** value:

- `document.referrer` inside the iframe (the parent page URL; browsers
  send only its origin cross-origin under the default referrer policy),
  which the embed reads and sends as an explicit `parent_origin`
  parameter, or
- a `postMessage` handshake from the parent page.

Both are hints, not proof. A non-browser client can claim any origin it
likes. Nothing in this design pretends otherwise.

## What is enforced (server-side, in the API)

### 1. Validation and normalisation — `apps/api/src/lib/originPolicy.ts`

Pure functions, unit-tested:

- Parsed with the `URL` constructor; unparsable values rejected.
- `https` required, except `http` for `localhost` (local dev only, with
  an explicit note in the code).
- Exact scheme + host + port match. Host lowercased; the default port is
  dropped by `URL.origin`, a non-default port is kept, so
  `https://example.com:8443` ≠ `https://example.com`.
- No wildcards (`https://*.example.com` is unparsable and rejected).
- A trailing slash, path, query or fragment is stripped — only the
  origin part is kept, so `https://example.com/` and
  `https://example.com` normalise to the same value.
- Userinfo / embedded credentials (`https://user:pass@example.com`)
  rejected. Empty, non-string and over-200-character values rejected.
- Origins are **normalised on save** in the widget-settings endpoints
  (POST and PATCH): an invalid origin is rejected with 400 and nothing
  is stored. Stored values are canonical
  `scheme://host[:port]`.

### 2. Enforcement on the public widget endpoints — `apps/api/src/routes/widget.ts`

Every public widget call accepts an explicit `parent_origin`:

- `GET /api/widget/config?key=…&parent_origin=…` (query param)
- `POST /api/widget/sessions {key, name?, email?, parent_origin?}` (body)
- `POST /api/widget/messages {token, body, client_message_id?, parent_origin?}` (body)
- `GET /api/widget/history?token=…&parent_origin=…` (query param)

The server loads the widget's policy through the new SECURITY DEFINER
RPC `get_widget_origin_policy(p_public_key)` (migration 0008), which
returns only `enabled` + `allowed_origins` — the API cannot read
`widget_settings` as the anon client (no public SELECT policy), and the
public config RPC still returns display fields only. Decision table:

| Situation | Result |
|---|---|
| Widget unknown or disabled | 404, exactly as before |
| `allowed_origins` empty (secure default) | Only the app's own frontend origin (`FRONTEND_URL`, i.e. the `/widget-demo` preview) is allowed. Any foreign origin — or no claimed origin at all — → **403** |
| `allowed_origins` non-empty | Claimed origin must exactly match one entry, else **403** |
| Claimed origin absent or unparsable | **403** (membership cannot be proven without a claim) |
| Claimed origin present but invalid | **403** |

The 403 error is always the generic `Embedding origin not allowed` —
the allow-list is never leaked in an error message, and
`allowed_origins` is never added to the public config response.

### 3. Session binding — migration 0008

On session creation the validated parent origin is **stored** on
`widget_visitor_sessions.parent_origin` (new nullable column; the
`create_widget_visitor_session` RPC gained an optional 4th parameter,
`p_parent_origin`). Message and history calls must then claim **that
same origin**:

- Claimed origin ≠ stored origin → 403. A body-supplied origin is never
  trusted without this binding.
- Sessions created before 0008 have `parent_origin = NULL` and fall back
  to the widget's allow-list check (empty list → own origin only).
- History enforces the **same** check as messages: the visitor-session
  token alone does not bypass origin policy. An unknown/expired token
  still returns an empty list with 200 (unchanged); a known token with a
  mismatched origin returns 403.

### 4. CORS — `apps/api/src/app.ts`

- The global CORS for the authenticated API is unchanged
  (`origin: FRONTEND_URL, credentials: true`).
- `/api/widget` routes additionally apply a stricter CORS that reflects
  **only the app's own frontend origin**, with `credentials: false`.
- **No wildcard CORS anywhere** on widget routes. Preflight (OPTIONS)
  keeps working for the iframe origin, because the iframe is same-origin
  with the app. (Implementation note: the `cors` package emits the
  *fixed* configured origin as the header value even for a foreign
  request — the browser still blocks that request, because the header
  value does not match the requesting origin. The guarantee is that the
  foreign origin itself is never reflected and `*` is never used.)
- CORS preflight cannot know the widget key, so it cannot vary per
  widget — that is exactly why embedding policy is enforced via
  `parent_origin` (above), not via CORS. CORS here only stops a foreign
  *browser page* from reading widget responses directly; it does not
  stop the iframe from working and does not, by itself, enforce the
  allow-list.

### 5. Client — `apps/web/src/pages/WidgetEmbed.tsx`

- `getParentOrigin(document.referrer)` computes the embedding page's
  origin once (`new URL(referrer).origin`; `undefined` when the referrer
  is empty or unparsable).
- `parent_origin` is sent on config, session creation, message send and
  history calls (see `apps/web/src/lib/api.ts` widget functions).
- Empty referrer → nothing is sent → the server applies the
  empty-origin default (403 unless the policy RPCs are unavailable —
  see fallback below).

## What was deliberately NOT implemented

### postMessage handshake

Not implemented. The embed snippet on `/widget-demo` could post the
parent origin into the iframe, and the iframe could accept it as a hint
— but it would be the *same* client-asserted value as `document.referrer`,
with the same spoofability, and it would add a second channel that must
be kept in sync (including an origin check on the receiving side, which
is itself easy to get wrong). It adds complexity without enforcement
value: the server validates whatever is claimed either way. If a future
need arises (e.g. referrer stripped by a strict referrer-policy on the
embedding site), the snippet + iframe handshake is the place to add it —
as a *hint transport*, never as proof.

### Per-widget dynamic `frame-ancestors` (CSP)

**Not achievable with the current hosting.** The frontend is a static
Vercel deployment; its headers (`vercel.json`) are static and cannot
vary per widget key — there is no server in front of the iframe page
that could emit `Content-Security-Policy: frame-ancestors <this
widget's allow-list>`. This is recorded as a limitation, not claimed.
A dynamic `frame-ancestors` would require serving `/widget-embed`
through a server/edge function that looks up the widget key — a future
change, not part of Phase 2.1.

## Honest limitations — read before relying on this

1. **A non-browser client can spoof `Origin` and `parent_origin` and
   call the widget endpoints directly.** Nothing here prevents that.
   The allow-list is embedding policy for real browsers: it stops an
   *arbitrary website* from embedding your widget in a visitor's browser
   and collecting chats there. It does not stop a script from calling
   the API with a forged origin.
2. **The real protections are unchanged and are what make the widget
   safe without origin enforcement**: the visitor-session token (only
   its SHA-256 hash is stored; the raw token is returned once), per-IP
   rate limits (sessions 10/10 min, messages 30/10 min, history and
   config 60/10 min), and the fact that widget endpoints expose no
   secrets and no cross-visitor data (config returns
   business_name/welcome/primary_color/enabled only; history returns
   only the caller's own session messages).
3. **Directly opening `/widget-embed` in a browser tab has no referrer**,
   so with an empty allow-list it is rejected (403) under the secure
   default. That is intended: the widget is meant to be embedded, or
   previewed through `/widget-demo` (which supplies the app's own
   origin as the referrer). To allow a specific site, add its origin to
   the allow-list.
4. **Direct Supabase RPC calls bypass the API.** The widget RPCs are
   callable by anon with a valid token/key; the origin check lives in
   the API, not in the RPCs. A caller going straight to Supabase is
   outside this enforcement — same spoofing caveat as (1).
5. **Pre-0008 fallback.** Until migration 0008 is applied live, the
   policy RPCs do not exist; the API detects the missing RPCs and falls
   back to the previous unenforced behaviour rather than breaking the
   widget. Enforcement is live only after 0008 is applied. (The
   coordinator verifies this live; the mocked tests cover the enforced
   path by mocking the RPCs.)

## Related: Issue 3 — customer `last_activity_at`

Migration 0007 adds an `AFTER INSERT` trigger on `messages` that bumps
`customers.last_activity_at` to the newest message timestamp. Both
message paths insert into the same `messages` table (visitor RPC and
agent-reply endpoint), so one trigger covers both; profile edits
(PATCH customer) never touch the column. The trigger only runs in real
Postgres — the mocked API tests assert the list response carries
`last_activity_at` and that PATCH leaves it unchanged, and the live
trigger behaviour is explicitly NOT TESTED in this release (see the
skipped test in `app-phase2-1-activity.test.ts`).

## Verification checklist (live, by the coordinator)

- [ ] Apply 0007 + 0008 in the Supabase SQL Editor, in order.
- [ ] Widget with an allow-list entry: embed on the approved domain
      works; embed on an unapproved domain gets 403 on config/session.
- [ ] Widget with an empty allow-list: `/widget-demo` preview works;
      a foreign embed gets 403.
- [ ] A session started on the approved origin keeps working for
      messages/history; the same token with a different claimed origin
      gets 403.
- [ ] Saving an invalid origin in `/widget-demo` is rejected with 400;
      a valid origin is stored normalised (lowercased host, no trailing
      slash).
- [ ] Live trigger: visitor message and agent reply both move
      `last_activity_at` forward; an older message never moves it back;
      PATCH customer does not move it.
