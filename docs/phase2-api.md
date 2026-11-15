# SupportFlow AI — Phase 2 API

Backend API for the Phase 2 support platform: customers, conversations,
tickets, internal notes, and the public embeddable chat widget. Built on
the Phase 1 workspace model and the Phase 2 schema
(`supabase/migrations/0003_phase2_support_platform.sql`).

Base URL: the API service (Render). Authenticated routes require a
Supabase JWT in `Authorization: Bearer <token>`.

## Authentication & tenancy

- All `/api/workspaces/:workspaceId/*` routes require:
  1. `authMiddleware` — validates the Bearer JWT via Supabase Auth and
     sets `req.user` / `req.token`.
  2. `requireWorkspaceMember` — the user must be a row in
     `workspace_members` for `:workspaceId`, otherwise **403**.
- Every query also filters by `workspace_id` (defense in depth on top of
  RLS). Ids supplied in a request body are never trusted: referenced
  customers/conversations are verified to belong to the same workspace
  (otherwise **400** `Related record belongs to a different workspace`),
  and assignees are verified to be members of the workspace (otherwise
  **400** `Assignee must be a member of this workspace`).
- The API uses the Supabase **anon key only**. No service-role key is
  configured or used; all DB access runs as the user so RLS applies.
- Assignment lists reuse the existing `GET /api/workspaces/:id/members`
  (Phase 1) — it is not duplicated in the Phase 2 routers.

## Endpoints

### Workspaces (Phase 1, unchanged)

| Method | Path | Auth | Notes |
| --- | --- | --- | --- |
| GET | `/health` | — | `{status, service, version}` — version is now `0.2.1` (Phase 2.1) |
| GET | `/api/workspaces` | Bearer | Workspaces the user belongs to |
| POST | `/api/workspaces` | Bearer | Create via `create_workspace_with_owner` RPC |
| GET | `/api/workspaces/:id` | Bearer + member | One workspace |
| GET | `/api/workspaces/:id/members` | Bearer + member | Members with profile display info (Phase 2.1): `display_name` (or `"Unnamed member"`), `avatar_url`, `initials`, `member_since`, role. No emails. Used for assignment pickers |

### Profiles — `/api/profile` (Phase 2.1, Issue 2)

| Method | Path | Auth | Notes |
| --- | --- | --- | --- |
| GET | `/me` | Bearer | Own profile; lazily created on first read (display name derived from JWT `user_metadata` `full_name`/`name` when present, else `null` → UI shows "Unnamed member") |
| PATCH | `/me` | Bearer | Self only — the route has no target id, so one user can never edit another's profile. Only `display_name` (trim, max 100, empty → `null`) and `avatar_url` (https-only or empty, max 500). An injected `id` field is rejected (400) |

Profile visibility is workspace-scoped by RLS (migration 0006): a profile is readable only by its owner or by users who share a workspace with that member (`shares_workspace_with()` helper). See `docs/phase2-1-profiles.md`.

### Customers — `/api/workspaces/:workspaceId/customers`

| Method | Path | Auth | Notes |
| --- | --- | --- | --- |
| GET | `/` | Bearer + member | List, server-side pagination. `?search=` matches name/email, `?tag=` filters by tag. Returns `{customers, total, page, pageSize}` |
| POST | `/` | Bearer + member | Create. Duplicate email in the workspace → **409** `A customer with this email already exists in this workspace` (Postgres 23505) |
| GET | `/:customerId` | Bearer + member | Customer + `{tickets: {total}, conversations: {total}, recent_conversations: [...]}` (last 5) |
| PATCH | `/:customerId` | Bearer + member | Update name/email/phone/tags/notes. Does **not** bump `last_activity_at` — only message inserts do (DB trigger, migration 0007) |

### Conversations — `/api/workspaces/:workspaceId/conversations`

| Method | Path | Auth | Notes |
| --- | --- | --- | --- |
| GET | `/` | Bearer + member | List. Filters: `search` (customer name/email), `status`, `priority`, `assignedTo` (`unassigned` or a user id). Each row includes `customer {id, full_name, email}`, `last_message` (body truncated to 200 chars) + `last_message_at`, and `unread_count` (customer messages with `read_at IS NULL`) |
| POST | `/` | Bearer + member | Create for a `customer_id` in this workspace (400 if the customer belongs to another workspace). Records a `conversation.created` outbox event |
| GET | `/:conversationId` | Bearer + member | Conversation + customer + `assigned_member` |
| GET | `/:conversationId/messages` | Bearer + member | Paginated, chronological ASC (oldest first) |
| POST | `/:conversationId/messages` | Bearer + member | Agent reply (`sender_type: agent`, `sender_id` = caller). Idempotent on `client_message_id`: a repeat returns the existing message with **200**. Bumps `last_message_at`; status is left unchanged (a closed conversation stays closed). Records **no** outbox event (agent replies are not customer messages) |
| PATCH | `/:conversationId` | Bearer + member | Update `status` / `priority` / `assigned_to` / `tags`. Assignee must be a workspace member (400 otherwise) |
| POST | `/:conversationId/read` | Bearer + member | Marks all customer messages `read_at = now()`. Returns `{read_count}` |
| POST | `/:conversationId/notes` | Bearer + member | Internal note (never shown to customers). Returns **201** `{note}` |
| GET | `/:conversationId/notes` | Bearer + member | Notes, chronological ASC |

### Tickets — `/api/workspaces/:workspaceId/tickets`

| Method | Path | Auth | Notes |
| --- | --- | --- | --- |
| GET | `/` | Bearer + member | List, server-side pagination. Filters: `status`, `priority`, `category`, `assignedTo` (`unassigned` or user id), `search` (subject). `sort=created_at` (default, newest first) / `priority` / `status` |
| GET | `/stats` | Bearer + member | `{by_status, by_priority, total}` — real DB query, counts grouped by the API. Declared before `/:ticketId` so `stats` is not treated as an id |
| POST | `/` | Bearer + member | Create. `status` is **not** settable on create (strict schema → 400). `customer_id` / `conversation_id` must belong to this workspace (400 otherwise). Writes a `created` ticket event and a `ticket.created` outbox event |
| GET | `/:ticketId` | Bearer + member | Ticket + customer + conversation summary + `assigned_member` |
| PATCH | `/:ticketId` | Bearer + member | Partial update. Writes `ticket_events` rows for each detected change: `status_changed`, `priority_changed`, `assigned` / `unassigned`, `updated`, plus `resolved` when entering `resolved`/`closed` and `reopened` when leaving them. Sets `resolved_at = now()` on resolve/close, clears it on reopen. Assignee must be a workspace member (400 otherwise). Outbox: `ticket.priority.changed`, `ticket.assigned`, `ticket.resolved` (ids/status only) |
| GET | `/:ticketId/events` | Bearer + member | Audit trail, chronological ASC |
| POST | `/:ticketId/notes` | Bearer + member | Internal note stored as a `ticket_events` row (`event_type: note_added`). Returns **201** `{event}` |

### Widget (public, no auth) — `/api/widget`

| Method | Path | Auth | Notes |
| --- | --- | --- | --- |
| GET | `/config?key=<public_key>` | — | `{business_name, welcome_message, primary_color, enabled}` via RPC `get_widget_config`. Unknown key or disabled widget → **404** `Widget not found`. Phase 2.1: accepts `?parent_origin=`; if the widget's allow-list is non-empty the claimed parent origin must match it, and an empty allow-list allows only the app's own frontend origin — otherwise **403** `Embedding origin not allowed` (see `docs/phase2-1-origins.md`) |
| POST | `/sessions` | — | `{key, name?, email?, parent_origin?}` via RPC `create_widget_visitor_session` (4-arg since migration 0008). Returns `{token, conversation_id, customer_id, expires_at}`. The raw token is returned **once** here and is never logged or stored by the API. The validated parent origin is stored on the session; unapproved origin → **403** |
| POST | `/messages` | — | `{token, body, client_message_id?, parent_origin?}` via RPC `post_widget_visitor_message`. Body 1–5000 chars (Zod). **Idempotent on `client_message_id` (migration 0005):** a repeat with the same key in the same conversation returns the existing message with **200** (no second row, no second outbox event); a new message returns **201** with `{message_id}`. Invalid/expired token → **401**. The claimed parent origin must equal the session's stored origin (or pass the allow-list check for legacy sessions) — otherwise **403**. The RPC also records the `customer.message.created` outbox event — the API does not double-record it |
| GET | `/history?token=...` | — | `{messages}` via RPC `get_widget_visitor_history`, oldest first, only the caller's own session. Unknown/expired token → `{messages: []}` with **200** (per RPC design). Phase 2.1: same parent-origin binding as `/messages` (`?parent_origin=`) |

Widget responses never include internal fields: no `workspace_id`, no
other visitors' emails, and no token except the one just created.
Structured logging never logs tokens or message bodies.

## Pagination

List endpoints accept `?page=` (≥ 1, default 1), `?pageSize=` (1–100,
default 20), `?search=`, `?status=`, `?priority=`, `?assignedTo=`,
`?sort=`. Invalid values → **400**. Responses carry
`{<items>, total, page, pageSize}` where `<items>` is named per
resource (`customers`, `conversations`, `messages`, `tickets`,
`notes`, `events`).

## Errors

All errors use the consistent shape `{error: "<message>"}`:

| Status | Meaning |
| --- | --- |
| 400 | Validation failed (Zod message), bad filter, cross-workspace reference, or non-member assignee |
| 401 | Missing/invalid Bearer token (authed routes) or invalid/expired widget session token |
| 403 | Authenticated but not a member of the requested workspace |
| 404 | Unknown workspace/customer/conversation/ticket, or unknown/disabled widget key |
| 409 | Duplicate customer email in the workspace (or duplicate workspace slug, Phase 1) |
| 429 | Rate limit exceeded — see below; response includes a `Retry-After` header (seconds) |
| 500 | Unexpected server error |

## Rate limits

In-memory sliding-window limiter (`middleware/rateLimit.ts`, no new
dependency). Buckets are per user for authed routes (key = IP + user
id, evaluated after auth) and per IP for the public widget.

| Scope | Limit |
| --- | --- |
| Authenticated API (`/api/workspaces/*`) | 300 requests / 15 min per user |
| Widget session creation (`POST /api/widget/sessions`) | 10 / 10 min per IP |
| Widget messages (`POST /api/widget/messages`) | 30 / 10 min per IP |
| Widget history (`GET /api/widget/history`) | 60 / 10 min per IP |
| Widget config (`GET /api/widget/config`) | 60 / 10 min per IP |

State lives in memory per process: limits reset on restart and are not
shared across instances. That is acceptable for Phase 2; a distributed
store (e.g. Redis) would be needed for multi-instance deployments.

## Outbox (`automation_events`) and Phase 3

`lib/outbox.ts` (`recordOutbox`) writes one row via the SECURITY
DEFINER RPC `record_automation_event`. Payloads contain **ids, slugs
and status/priority values only** — never message bodies, emails or
phone numbers (the DB CHECK enforces this). A failure to record never
fails the main operation: the error is logged and the request
continues.

Events recorded by the API:

| Event | When |
| --- | --- |
| `conversation.created` | Agent-created conversation (`POST /conversations`) |
| `ticket.created` | Ticket created |
| `ticket.priority.changed` | Ticket priority changed |
| `ticket.assigned` | Ticket assigned to a member |
| `ticket.resolved` | Ticket status becomes `resolved` or `closed` |

`customer.message.created` is recorded **inside** the widget RPC
`post_widget_visitor_message` — the API does not double-record it —
and agent replies record no outbox event at all.

Phase 3 consumes the outbox by polling `automation_events` where
`status = 'pending'` (oldest first, small batches), atomically claiming
each row (`status = 'processing'`), delivering it to the n8n webhook /
handler with the event id as the idempotency key, then marking it
`processed` (or `failed` with `attempts` incremented, `dead` after the
retry budget). Full protocol: `docs/phase2-migrations.md`.

**No live webhooks or n8n flows are connected in Phase 2.** Nothing in
this step sends an HTTP request to n8n or any other external service.

## Known limitations

- **Widget `allowed_origins` is enforced server-side since Phase 2.1**
  (migrations 0008, API 0.2.1): the widget API validates the claimed
  embedding parent origin against the widget's allow-list on config,
  session creation, message submission and history, and binds sessions
  to their validated origin. Empty allow-list = only the app's own
  frontend origin (widget-demo previews). Full design, including the
  honest limits (no `postMessage` handshake, no per-widget dynamic
  `frame-ancestors` on static hosting, non-browser spoofing possible),
  is in `docs/phase2-1-origins.md`. Live iframe behaviour on approved
  vs unapproved domains is NOT TESTED yet — the parent verifies it live
  after applying 0008.
- **Rate limits are in-memory** (see above): per-process, reset on
  restart, not shared across instances.
- **True two-user isolation PASSED live on 2026-11-14** (Phase 2
  verification): a second user got 403 on all of the first user's
  workspace/customer/ticket/messages, and workspace-scoped email
  uniqueness was confirmed. The mocked tests cover the same 403s.
- **No service-role key**: the API cannot do anything RLS forbids for
  the calling user. Phase 3 workers that poll the outbox will need
  their own service-role access; that is out of scope here.
- Tests are offline/mocked (`apps/api/src/__tests__/app-phase2.test.ts`).
  No live Supabase, Vercel or Render calls were made in this step.
