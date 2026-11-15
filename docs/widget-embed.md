# SupportFlow AI — Chat Widget Embed

The public, embeddable chat widget. Visitors chat as guests from any
website; their messages land in the workspace Inbox as a conversation
with a new (or email-matched) customer. No login is needed on the
visitor's side.

## Installation

1. In SupportFlow, open **Chat Widget** (`/widget-demo`) for your
   workspace and save the widget settings once. Copy the **public key**
   (it looks like `wgt_<32 hex characters>`) or the whole snippet.
2. Paste this snippet on any page where the chat should appear,
   replacing `YOUR_PUBLIC_KEY`:

```html
<iframe
  src="https://YOUR-APP-DOMAIN/widget-embed?key=YOUR_PUBLIC_KEY"
  title="Support chat"
  style="position:fixed;right:16px;bottom:16px;width:380px;height:560px;max-width:calc(100vw - 32px);border:0;z-index:9999"
></iframe>
```

Use your own deployed frontend origin in place of
`https://YOUR-APP-DOMAIN` (for local testing: `http://localhost:5173`).
The `/widget-demo` page generates the exact snippet for your workspace.

### Sizing

- The widget is a floating button (bottom-right) that expands into a
  chat panel. The recommended iframe size is **380 × 560 px**; on small
  screens the panel shrinks to `calc(100vw - 32px)` wide and stays
  usable.
- The iframe needs no special permissions. If you sandbox it, allow
  `allow-scripts allow-same-origin allow-forms` (the live preview on
  `/widget-demo` uses exactly that).

## How the visitor session works

1. The embed page reads `?key=` from the URL and calls
   `GET /api/widget/config?key=…&parent_origin=…` for the business name, welcome
   message, primary colour and `enabled` flag. An unknown key or a
   disabled widget returns 404 and the widget shows an error instead of
   a chat box; an embedding origin that is not allowed returns 403 (see
   "Allowed origins" below).
2. The visitor clicks the floating button. If no session exists yet, a
   short form asks for name and email — **both optional** — and
   "Start chat" calls `POST /api/widget/sessions {key, name?, email?, parent_origin?}`,
   which returns `{token, conversation_id, customer_id, expires_at}`.
   `parent_origin` is the origin of the page embedding the iframe, read
   from `document.referrer` (see "Allowed origins" below); it is stored
   on the session so later calls are bound to it.
3. The raw token is stored in the visitor's browser
   `localStorage` under `supportflow.widget.<public_key>` and reused on
   later visits, so the conversation continues. The token is never sent
   anywhere except back to the widget API.
4. Messages go through `POST /api/widget/messages
   {token, body, client_message_id?, parent_origin?}`. The panel polls
   `GET /api/widget/history?token=…&parent_origin=…` every 5 seconds, so agent replies
   from the Inbox appear without a reload. The first message from the
   visitor creates the customer/conversation on the SupportFlow side
   (an existing customer is reused when the visitor email matches one
   in the same workspace).
5. Closing the panel (button or `Esc`) hides the chat; the session and
   history persist in `localStorage` until the token expires (the API
   returns `expires_at` at session creation).

## Security notes

- **The public key is an identifier only.** It grants no data access by
  itself: it only selects which widget's branding to show. Visitor
  data is reachable only through the token-validated SECURITY DEFINER
  RPCs behind the widget API, and the token is validated per session.
- **Raw tokens are never stored server-side.** Only a SHA-256 hash of
  the visitor token is stored in the database; the raw token is
  returned once at session creation and is never logged by the API.
  The frontend keeps it only in the visitor's own `localStorage`.
- **Widget responses never include internal fields** — no
  `workspace_id`, no other visitors' emails, no token except the one
  just created.
- **Rate limits** (per IP, in-memory on the API): session creation
  10 / 10 min, messages 30 / 10 min, history 60 / 10 min, config
  60 / 10 min. Exceeding a limit returns 429 with a `Retry-After`
  header; the embed shows the error and the visitor can retry.
- **Allowed origins are enforced server-side (Phase 2.1).** The
  `allowed_origins` you set in `/widget-demo` are validated on save
  (normalised to `scheme://host[:port]`, `https` except `http` for
  `localhost`; invalid entries are rejected with 400) and enforced by
  the API on every public widget call, using an explicit `parent_origin`
  parameter — the origin of the page embedding the iframe, read from
  `document.referrer`. The iframe is served from the app's own origin,
  so the `Origin` header alone cannot tell the API where the widget is
  embedded; that is why `parent_origin` exists. Rules: an empty
  allow-list allows **only** the app's own frontend origin (the
  `/widget-demo` preview) and rejects everything else with 403; a
  non-empty list requires an exact match, else 403; a session's origin
  is stored at creation and later message/history calls must claim that
  same origin. The 403 error never reveals the allow-list, and the
  public config response never includes it. Full design, including the
  deliberate `postMessage` and `frame-ancestors` non-decisions and the
  spoofing caveat, is in `docs/phase2-1-origins.md`.
- **CORS on widget routes reflects only the app's own frontend origin**
  (the iframe's origin, no credentials, no wildcard). CORS cannot
  enforce the allow-list — a preflight cannot know the widget key — so
  it is not the enforcement mechanism; `parent_origin` is.
- **What origin enforcement does NOT do.** A non-browser client can
  spoof `parent_origin` (or call the Supabase RPCs directly) and the
  API cannot tell. The allow-list stops an arbitrary *website* from
  embedding your widget in visitors' browsers; it does not stop a
  script from calling the API. The widget stays safe without it,
  because the public key alone grants no data access (see above) and
  the token, rate limits and guest isolation still apply.
- The embed page itself is a public route (`/widget-embed`) outside
  auth and outside the app layout, so it can be iframed from any site.
  It is keyboard accessible (focus moves into the panel on open, `Esc`
  collapses it, `aria-label`s on the button, panel and composer).
