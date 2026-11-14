# SupportFlow AI — Phase 2 Frontend

React 18 + Vite + TypeScript + Tailwind frontend for the Phase 2 support
platform (customers, inbox, tickets, team, chat widget). It talks only to
the Phase 2 API in `docs/phase2-api.md`; no data is invented anywhere —
empty workspaces honestly show `0` and empty states.

## Routes

All routes except `/widget-embed` are protected (`ProtectedRoute`) and
render inside `Layout` (collapsible desktop sidebar + mobile bottom nav).

| Route | Page | Notes |
| --- | --- | --- |
| `/` | `pages/Dashboard.tsx` | Real counts (see below); `/dashboard` redirects to `/` |
| `/onboarding` | `pages/Onboarding.tsx` | Phase 1 workspace creation |
| `/inbox` | `pages/Inbox.tsx` | Conversation list |
| `/inbox/:conversationId` | `pages/Inbox.tsx` | Same page, thread + detail panel open |
| `/tickets` | `pages/Tickets.tsx` | Table / Kanban, filters, server pagination |
| `/tickets/:ticketId` | `pages/Tickets.tsx` (`TicketDetailPage`) | Edit, assign, notes, event history |
| `/customers` | `pages/Customers.tsx` | Search + tag filter + pagination, add/edit modal |
| `/customers/:customerId` | `pages/Customers.tsx` (`CustomerDetailPage`) | Profile, notes, linked conversations/tickets |
| `/team` | `pages/Team.tsx` | Real member list; invitations explicitly not supported yet |
| `/widget-demo` | `pages/WidgetDemo.tsx` | Widget settings form, embed snippet, live preview iframe |
| `/knowledge`, `/automations`, `/analytics` | `pages/Placeholders.tsx` | Still "Soon" (Phases 3–5) |
| `/settings` | `pages/Placeholders.tsx` | Phase 1 shell |
| `/widget-embed` | `pages/WidgetEmbed.tsx` | **Public**, no auth, no Layout (see `docs/widget-embed.md`) |

"Soon" badges were removed from Inbox, Tickets, Customers and Team in the
sidebar; they remain on Knowledge Base, Automations and Analytics.

## Workspace selector

`context/WorkspaceContext.tsx` (`WorkspaceProvider`, mounted in `main.tsx`
inside `AuthProvider`, outside the router):

- Loads the user's workspaces once via `api.listWorkspaces`.
- Selected id is persisted in `localStorage` under
  `supportflow.workspaceId` and defaults to the first workspace.
- A stored id that no longer belongs to the user is dropped and replaced
  with the first workspace.
- The selector is a `<select>` in the `Layout` header (with a
  "Create workspace" button when the user has none).
- Every Phase 2 page reads `useWorkspace()`; with no workspace selected
  it renders `NoWorkspaceState`, which links to `/onboarding`.
- Pages re-query whenever the selected workspace changes (workspace id is
  part of every react-query key).

## Components (`components/`)

- `ui.tsx` — `Skeleton`, `EmptyState`, `Modal` (Esc to close, focus
  trap-lite, `role="dialog"` + `aria-modal`), `StatusBadge`,
  `PriorityBadge`, `RoleBadge`, `Pagination`, `NoWorkspaceState`, and
  shared `inputCls` / `selectCls` / `btnPrimary` / `btnSecondary` classes.
  Badge colours: open=primary, in_progress=warning,
  waiting_for_customer=warning, pending=warning, resolved=success,
  closed=slate; urgent=danger, high=warning, medium=primary, low=slate.
- `Toast.tsx` — `ToastProvider` + `useToast()` (`success` / `error`).
  Toasts auto-dismiss after 5s. All mutations report through it.
- `Layout.tsx` — sidebar + header (workspace selector + user menu) +
  mobile bottom nav.
- `ProtectedRoute.tsx` — unchanged from Phase 1.

## API client (`lib/api.ts`)

Typed wrappers around `apiFetch` (Supabase session token in
`Authorization: Bearer …`, errors thrown as `Error` with the server's
message) for every Phase 2 endpoint: workspaces, members, customers,
conversations (+ messages, read, notes), tickets (+ `/stats`, events,
notes) and widget settings. Public widget calls use a separate
`widgetFetch` with **no** auth header. Response shapes follow the route
files exactly (`{customers, total, page, pageSize}`, `{tickets, …}`,
`{conversations, …}`, `{messages, …}`, `{notes, …}`, `{events, …}`,
`{by_status, by_priority, total}` for stats, `{widget_settings}` for
widget settings).

## Dashboard (real data)

- Total tickets + Open tickets (open + in_progress + waiting_for_customer)
  from `GET /tickets/stats`; Total customers from the customers list
  total; Open conversations from the conversations list total with
  `status=open`. Empty workspaces show `0`.
- AI resolution rate stays a labelled Phase 4 empty state (`—`, "AI agent
  arrives in Phase 4").
- Recent activity lists the 5 latest tickets and 5 latest conversations
  from the real list endpoints, with links. Nothing is fabricated.

## Inbox

- Desktop: 3 panels — conversation list | message thread | customer
  detail. Mobile: list first; tapping a conversation opens the thread
  with a back button (no forced 3 columns).
- List: search (customer name/email), status filter, assignee filter
  (including "Unassigned"), unread badge per conversation.
- Thread: customer/agent bubbles with timestamps, composer with sending
  state and error feedback (send uses a fresh `client_message_id` for
  idempotency), mark-as-read on open.
- Right panel: customer info, linked ticket (found by matching
  `conversation_id` in the ticket list), assignee / priority / status
  pickers, tags, internal notes (list + add; never shown to customers).

### Realtime + polling fallback

- On mount, the inbox subscribes to one Supabase Realtime channel
  (`messages-<workspaceId>`) for `postgres_changes` INSERTs on
  `public.messages`, **always filtered by `workspace_id=eq.<id>`** —
  never an unfiltered subscription. Inserts invalidate the open
  thread's message query and the conversation list.
- Independently, the open thread polls `GET …/messages` every 5 seconds
  (`refetchInterval: 5000`). If Realtime is unavailable, misconfigured,
  or the channel drops, polling still delivers new messages; the channel
  is unsubscribed on unmount/workspace change. No reconnection code of
  its own is needed — the channel is re-created by the effect when the
  workspace changes, and polling covers the gap either way.

## Tickets

- Stats cards on top from `GET /tickets/stats` (real grouped counts).
- Table view: subject, customer category, status, priority, assignee,
  updated; search, status/priority/assignee filters, sort
  (created_at / priority / status), server-side pagination (20/page).
- Kanban view: one column per status (5), cards with a status-change
  dropdown (no drag-and-drop — deliberate, to avoid risking the table).
- Create ticket: modal with subject, description, category, priority,
  customer select with search, optional conversation link.
- Detail: full fields, edit subject/description, assign via member
  dropdown, status/priority change, internal notes, history timeline
  from `GET /tickets/:id/events`, linked customer/conversation.

## Customers

- List: search (name/email), tag filter, server-side pagination.
- Add/edit via modal (name, email, phone, tags, notes). Duplicate email
  in the workspace surfaces the API's 409 message.
- Detail: profile (name/email/phone/tags/notes), conversation history
  (links to `/inbox/:id`), linked tickets (links to `/tickets/:id`),
  inline edit-notes form (notes live on `customers.notes`, saved via
  `PATCH /customers/:id`).

## Team

Real member list from `GET /api/workspaces/:id/members` (user id, role
badge, member since) plus an explicit note: "Invitations are not
supported yet — members join by creating a workspace or being added by
an owner in a later phase." No invitation UI is faked.

## Widget demo (`/widget-demo`)

Settings form (business name, welcome message, primary color, enabled
toggle, allowed origins list) wired to the widget-settings API:
`GET` returns 404 when none exist (form starts empty and saving creates
them via `POST`); existing settings update via `PATCH`. The public key
is shown read-only with the copyable iframe snippet, and a live preview
renders `/widget-embed?key=<public_key>` in an iframe.

## Backend addition (the only one)

`apps/api/src/routes/widgetSettings.ts` (mounted in `app.ts` under
`/api/workspaces/:workspaceId/widget-settings`, behind the same
auth + `requireWorkspaceMember` chain as the other workspace routers),
with schemas/types in `packages/shared`:

- `GET /` → `{widget_settings}` or 404 when none exist.
- `POST /` → 201 creates once; a second create is 409.
- `PATCH /` → updates `business_name` / `welcome_message` /
  `primary_color` / `enabled` / `allowed_origins` only. The update
  schema is strict, so `public_key` or `workspace_id` in the body is
  rejected with 400 — the public key can never be changed through it.
- No other backend file was changed. Mocked tests live in
  `apps/api/src/__tests__/app-phase2.test.ts` ("widget settings (admin)").

## Tests

Web (`apps/web/src/__tests__/`, vitest + Testing Library):

- `app.test.tsx` — Phase 1 protected-route tests + dashboard empty-state
  labels (unchanged).
- `phase2.test.tsx` — status/priority badge rendering, pagination
  controls (next/previous, disabled states), inbox unread badge (mocked
  fetch, unread_count 3), tickets list rendering from the mocked API,
  widget embed send flow (mocked fetch: config → session → message,
  token stored in localStorage), widget embed missing-key error.

API (`apps/api/src/__tests__/app-phase2.test.ts`) — 41 tests including
the 4 new widget-settings tests (404 → create 201 → second create 409,
PATCH branding + 400 on `public_key`/`workspace_id`, 403/401).

Run: `npm run build`, `npm run lint`,
`npm --workspace apps/web run test -- --run`,
`npm --workspace apps/api run test -- --run`.

## Known limitations

- The inbox's "linked ticket" lookup fetches up to 100 tickets and
  matches `conversation_id` client-side (there is no server filter for
  it); the customer detail page does the same for that customer's
  tickets/conversations. Fine at Phase 2 scale; a server filter would
  be better later.
- `allowed_origins` is stored but not enforced server-side (carried
  from `docs/phase2-api.md`); the demo page says so next to the field.
- No live Supabase/Vercel/Render calls were made for this step; API
  behaviour is covered by mocked tests only.
