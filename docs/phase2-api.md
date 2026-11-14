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
| GET | `/health` | — | `{status, service, version}` — version is now `0.2.0` |
| GET | `/api/workspaces` | Bearer | Workspaces the user belongs to |
| POST | `/api/workspaces` | Bearer | Create via `create_workspace_with_owner` RPC |
| GET | `/api/workspaces/:id` | Bearer + member | One workspace |
| GET | `/api/workspaces/:id/members` | Bearer + member | Members (used for assignment pickers) |

### Customers — `/api/workspaces/:workspaceId/customers`

| Method | Path | Auth | Notes |
| --- | --- | --- | --- |
| GET | `/` | Bearer + member | List, server-side pagination. `?search=` matches name/email, `?tag=` filters by tag. Returns `{customers, total, page, pageSize}` |
| POST | `/` | Bearer + member | Create. Duplicate email in the workspace → **409** `A customer with this email already exists in this workspace` (Postgres 23505) |
| GET | `/:customerId` | Bearer + member | Customer + `{tickets: {total}, conversations: {total}, recent_conversations: [...]}` (last 5) |
| PATCH | `/:customerId` | Bearer + member | Update name/email/phone/tags/notes. Does **not** bump `last_activity_at` (only message/ticket activity does) |

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
| GET | `/config?key=<public_key>` | — | `{business_name, welcome_message, primary_color, enabled}` via RPC `get_widget_config`. Unknown key or disabled widget → **404** `Widget not found` |
| POST | `/sessions` | — | `{key, name?, email?}` via RPC `create_widget_visitor_session`. Returns `{token, conversation_id, customer_id, expires_at}`. The raw token is returned **once** here and is never logged or stored by the API |
| POST | `/messages` | — | `{token, body, client_message_id?}` via RPC `post_widget_visitor_message`. Body 1–5000 chars (Zod). **Idempotent on `client_message_id` (migration 0005):** a repeat with the same key in the same conversation returns the existing message with **200** (no second row, no second outbox event); a new message returns **201** with `{message_id}`. Invalid/expired token → **401**. The RPC also records the `customer.message.created` outbox event — the API does not double-record it |
| GET | `/history?token=...` | — | `{messages}` via RPC `get_widget_visitor_history`, oldest first, only the caller's own session. Unknown/expired token → `{messages: []}` with **200** (per RPC design) |

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

- **`allowed_origins` is stored but not enforced server-side yet.**
  `widget_settings.allowed_origins` exists in the schema, but the
  public config RPC (`get_widget_config`) does not return it, and
  `widget_settings` has no public SELECT policy, so the API cannot read
  it as the anon client and must not invent a bypass. Origin
  enforcement is deferred to **Phase 3** (embed docs should treat the
  list as best-effort until then). The widget is still safe without it:
  the public key alone grants no data access — visitor data is only
  reachable through the token-validated SECURITY DEFINER RPCs.
- **Rate limits are in-memory** (see above): per-process, reset on
  restart, not shared across instances.
- **True two-user isolation is still unproven live** (carried over
  from Phase 1): cross-workspace isolation is enforced by RLS + the
  workspace-consistency triggers + API-level checks, and is covered by
  mocked tests (403 for non-members), but has not yet been exercised by
  two real users against live Supabase on these Phase 2 tables.
- **No service-role key**: the API cannot do anything RLS forbids for
  the calling user. Phase 3 workers that poll the outbox will need
  their own service-role access; that is out of scope here.
- Tests are offline/mocked (`apps/api/src/__tests__/app-phase2.test.ts`).
  No live Supabase, Vercel or Render calls were made in this step.
