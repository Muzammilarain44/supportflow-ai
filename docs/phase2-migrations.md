# Phase 2 Migrations — Support Platform

Migration file: `supabase/migrations/0003_phase2_support_platform.sql`
(one file, clearly sectioned). It is additive only: it does not touch
`0001_phase1_workspaces.sql` or `0002_fix_rls_recursion.sql`, deletes no
data, and never disables RLS.

## 0004 — RPC fix (live failure, 2026-11-14)

`supabase/migrations/0004_phase2_fix_widget_rpcs.sql` re-creates the 5
SECURITY DEFINER RPCs from 0003 with identical logic, except pgcrypto
calls are schema-qualified (`extensions.digest(...)`,
`extensions.gen_random_bytes(...)`). 0003 partially applied live:
tables, triggers, RLS and policies applied fine, but the RPC batch
failed and rolled back with `ERROR 42883: function digest(text, unknown)
does not exist`, because pgcrypto is installed in the `extensions`
schema on this project, not `public`, and the RPCs set
`search_path = public`. 0 of the 5 RPCs existed live; no data was
touched. 0004 is idempotent (`create or replace function`) and safe to
re-run. 0003 itself was not edited. Apply 0004 after 0003 (step 4 below).

## 0005 — Widget message idempotency (live bug, 2026-11-14)

`supabase/migrations/0005_phase2_widget_message_idempotency.sql` fixes a
live-tested bug: posting the same widget visitor message twice with the
same `client_message_id` stored two identical rows. The messages table
already had a partial unique index on `(conversation_id,
client_message_id)` and the widget embed already sent a per-message
`client_message_id` — but the RPC
`post_widget_visitor_message(text, text)` never accepted or stored it.
0005 drops the 2-arg function and re-creates it as
`post_widget_visitor_message(p_token, p_body, p_client_message_id
DEFAULT NULL)` returning `TABLE(message_id uuid, is_duplicate
boolean)`: a repeat with the same key in the same conversation returns
the existing message as a duplicate (no second insert, no second
`customer.message.created` outbox event); a concurrent-retry race is
covered by a `unique_violation` handler that returns the row the other
transaction inserted. The API returns **200** for a duplicate and **201**
for a new message. 0003 and 0004 are not edited. Apply 0005 after 0004
(step 5 below).

## Phase 2.1 — 0006 profiles (Issue 2), 0007 last activity (Issue 3), 0008 widget origins (Issue 4)

All three are additive, idempotent, and do not edit 0001–0005. Apply in
order after 0005 (steps 6–8 below). None has been applied to live
Supabase yet — the parent applies them live and verifies.

### 0006 — `public.profiles` (real member names, not UUIDs)

`supabase/migrations/0006_phase2_1_profiles.sql` adds `profiles`
(`id` UUID PK → `auth.users`, `display_name`, `avatar_url` NULL,
timestamps, reuses `set_updated_at()`). **No email column by design.**
RLS uses a new SECURITY DEFINER helper
`public.shares_workspace_with(uuid)` (same pattern as
`is_workspace_member`): SELECT is allowed for self or anyone sharing a
workspace with the caller; INSERT/UPDATE/DELETE are self-only. Profile
creation is three-layered: (1) PRIMARY — lazy creation in the API
(`GET /api/profile/me` upserts from the JWT's `user_metadata`
`full_name`/`name`); (2) idempotent backfill for existing `auth.users`
rows (`display_name` NULL — names are never invented); (3) safety-net
trigger on `auth.users` that copies `full_name`/`name` from
`raw_user_meta_data` and swallows its own errors so signup can never
fail. See `docs/phase2-1-profiles.md`.

### 0007 — customer `last_activity_at` trigger (Issue 3)

`supabase/migrations/0007_phase2_1_last_activity.sql` adds one
`AFTER INSERT` trigger on `messages`
(`bump_customer_last_activity()`, SECURITY DEFINER,
`set search_path = public`). Both message paths insert into the same
`messages` table — visitor messages via
`post_widget_visitor_message()` and agent replies via
`POST /api/workspaces/:id/conversations/:id/messages` — so one trigger
covers both. It resolves the owning customer from `NEW.customer_id`
(fallback: the conversation's `customer_id`) and sets
`last_activity_at = GREATEST(current, NEW.created_at)`, guarded so an
older timestamp can never overwrite a newer one. PATCH customer never
touches the column, so profile edits do not bump activity. Live trigger
behaviour is NOT TESTED by the mocked API tests (see the `it.skip` in
`app-phase2-1-activity.test.ts`) — verify live after applying.

### 0008 — widget origin policy (Issue 4)

`supabase/migrations/0008_phase2_1_widget_origins.sql` adds
`widget_visitor_sessions.parent_origin` (nullable; NULL for sessions
created before the migration) and two SECURITY DEFINER RPCs:
`get_widget_origin_policy(p_public_key)` → `(enabled,
allowed_origins)` and `get_widget_session_policy(p_token)` →
`(parent_origin, allowed_origins, enabled)` (zero rows for an unknown
or expired token). It also re-creates
`create_widget_visitor_session()` as a 4-arg function (old 3-arg
dropped, 0005 pattern) with identical logic plus an optional
`p_parent_origin` that is stored on the session. All pgcrypto calls
are `extensions.`-qualified. The public config response is unchanged:
`allowed_origins` is never exposed to unauthenticated callers. See
`docs/phase2-1-origins.md` for the full enforcement design and its
honest limitations (no `postMessage` handshake, no per-widget dynamic
`frame-ancestors` on static Vercel hosting, no protection against
non-browser spoofing beyond tokens + rate limits).

## How to apply

In Supabase Dashboard > SQL Editor, run the migrations **in order**:

1. `0001_phase1_workspaces.sql`
2. `0002_fix_rls_recursion.sql`
3. `0003_phase2_support_platform.sql`
4. `0004_phase2_fix_widget_rpcs.sql` (re-creates the 5 RPCs from 0003
   with `extensions.`-qualified pgcrypto calls — see the 0004 note above)
5. `0005_phase2_widget_message_idempotency.sql` (re-creates
   `post_widget_visitor_message` with `client_message_id` dedupe — see
   the 0005 note above)
6. `0006_phase2_1_profiles.sql` (Phase 2.1 Issue 2 — `profiles` table,
   `shares_workspace_with()` helper, RLS, backfill, signup trigger)
7. `0007_phase2_1_last_activity.sql` (Phase 2.1 Issue 3 — trigger that
   bumps `customers.last_activity_at` on message insert)
8. `0008_phase2_1_widget_origins.sql` (Phase 2.1 Issue 4 — session
   `parent_origin` column + origin-policy RPCs + 4-arg
   `create_widget_visitor_session`)

The file is idempotent (safe to re-run): `create table if not exists`,
`create index if not exists`, `drop policy if exists` before every
`create policy`, `drop trigger if exists` before every `create trigger`,
and `create or replace function` for all functions.

## Tables

All tables live in the `public` schema, carry `workspace_id uuid NOT NULL
REFERENCES workspaces(id) ON DELETE CASCADE`, and use
`id uuid PRIMARY KEY DEFAULT gen_random_uuid()`. Timestamps are
`timestamptz NOT NULL DEFAULT now()` unless noted.

### customers
One row per end-customer of a workspace.
`full_name text NOT NULL` (trimmed, min 2 chars), `email text NOT NULL`,
`phone text NULL`, `tags text[] NOT NULL DEFAULT '{}'`, `notes text NULL`,
`created_at`, `updated_at`, `last_activity_at timestamptz NULL`.
Email is unique per workspace, case-insensitively:
`UNIQUE INDEX (workspace_id, lower(email))`.
Indexes: `(workspace_id)`, `(workspace_id, created_at DESC)`.

### conversations
One chat thread between a workspace and a customer.
`customer_id uuid NOT NULL FK customers ON DELETE CASCADE`,
`status text NOT NULL DEFAULT 'open'` in
`open | pending | resolved | closed`,
`priority text NOT NULL DEFAULT 'medium'` in
`low | medium | high | urgent`,
`assigned_to uuid NULL REFERENCES auth.users(id) ON DELETE SET NULL`,
`tags text[] NOT NULL DEFAULT '{}'`, `created_at`, `updated_at`,
`last_message_at timestamptz NULL`.
Indexes: `(workspace_id, last_message_at DESC NULLS LAST)`,
`(workspace_id, status)`, `(workspace_id, assigned_to)`, `(customer_id)`.

### messages
One message inside a conversation.
`conversation_id uuid NOT NULL FK conversations ON DELETE CASCADE`,
`customer_id uuid NULL FK customers ON DELETE SET NULL`,
`sender_type text NOT NULL` in `customer | agent | system`,
`sender_id uuid NULL` (auth user id for agents, NULL for customers),
`body text NOT NULL CHECK (char_length(body) BETWEEN 1 AND 5000)`,
`client_message_id text NULL` (client-supplied idempotency key),
`created_at`, `read_at timestamptz NULL`.
Duplicate prevention: `UNIQUE INDEX (conversation_id, client_message_id)
WHERE client_message_id IS NOT NULL` — a retried send with the same key
cannot create a second row in the same conversation.
Indexes: `(conversation_id, created_at)`, `(workspace_id, created_at DESC)`.

### tickets
Support tickets, optionally linked to a customer and/or a conversation.
`customer_id uuid NULL FK customers ON DELETE SET NULL`,
`conversation_id uuid NULL FK conversations ON DELETE SET NULL`,
`subject text NOT NULL` (trimmed, 2–200 chars), `description text NULL`,
`category text NOT NULL DEFAULT 'general'` in
`general | billing | technical | feature | bug | other`,
`priority text NOT NULL DEFAULT 'medium'` in
`low | medium | high | urgent`,
`status text NOT NULL DEFAULT 'open'` in
`open | in_progress | waiting_for_customer | resolved | closed`,
`assigned_to uuid NULL REFERENCES auth.users(id) ON DELETE SET NULL`,
`created_by uuid NULL REFERENCES auth.users(id) ON DELETE SET NULL`,
`created_at`, `updated_at`, `resolved_at timestamptz NULL`.
Indexes: `(workspace_id, status)`, `(workspace_id, priority)`,
`(workspace_id, assigned_to)`, `(workspace_id, created_at DESC)`,
`(customer_id)`, `(conversation_id)`.

### ticket_events
Audit trail for tickets (one row per change/note).
`ticket_id uuid NOT NULL FK tickets ON DELETE CASCADE`,
`actor_id uuid NULL REFERENCES auth.users(id) ON DELETE SET NULL`,
`event_type text NOT NULL` in
`created | status_changed | priority_changed | assigned | unassigned |
note_added | comment_added | resolved | reopened | updated`,
`field_name text NULL`, `old_value text NULL`, `new_value text NULL`,
`note text NULL`, `created_at`.
Index: `(ticket_id, created_at)`.

### conversation_notes
Internal agent notes on a conversation. Never shown to customers.
`conversation_id uuid NOT NULL FK conversations ON DELETE CASCADE`,
`author_id uuid NULL REFERENCES auth.users(id) ON DELETE SET NULL`,
`body text NOT NULL CHECK (char_length(body) BETWEEN 1 AND 5000)`,
`created_at`, `updated_at`.
Index: `(conversation_id, created_at)`.

### widget_settings
One embeddable chat widget per workspace.
`workspace_id uuid NOT NULL UNIQUE FK workspaces ON DELETE CASCADE`,
`public_key text NOT NULL UNIQUE` — format `wgt_` + 32 lowercase hex
chars, default `'wgt_' || encode(gen_random_bytes(16), 'hex')`,
`enabled boolean NOT NULL DEFAULT true`,
`business_name text NOT NULL DEFAULT 'Support'`,
`welcome_message text NOT NULL DEFAULT 'Hi! How can we help you today?'`,
`primary_color text NOT NULL DEFAULT '#7C3AED'`,
`allowed_origins text[] NOT NULL DEFAULT '{}'`,
`created_at`, `updated_at`.
The `public_key` is a **public identifier only** — it grants no data
access by itself. Visitor data access goes only through the guest RPCs
below, which validate the session token hash. (The UNIQUE constraint
creates the index on `public_key`.)

### widget_visitor_sessions
Guest chat sessions for the website widget.
`widget_settings_id uuid NOT NULL FK widget_settings ON DELETE CASCADE`,
`visitor_token_hash text NOT NULL UNIQUE` — the SHA-256 hex of the raw
visitor token. **The raw token is NEVER stored in the database.**
`customer_id uuid NULL FK customers ON DELETE SET NULL`,
`conversation_id uuid NULL FK conversations ON DELETE SET NULL`,
`expires_at timestamptz NOT NULL` (24 hours after creation),
`created_at`, `last_seen_at timestamptz NULL`.
Indexes: `(workspace_id, expires_at)`; the UNIQUE constraint on
`visitor_token_hash` provides its index.

### automation_events (transactional outbox — Phase 3 n8n-ready)
Record only. **No webhooks are sent from the database.**
`event_type text NOT NULL` in
`customer.message.created | conversation.created | ticket.created |
ticket.priority.changed | ticket.assigned | ticket.resolved`,
`entity_type text NOT NULL`, `entity_id uuid NOT NULL`,
`payload jsonb NOT NULL DEFAULT '{}'::jsonb`,
`status text NOT NULL DEFAULT 'pending'` in
`pending | processing | processed | failed | dead`,
`attempts int NOT NULL DEFAULT 0`,
`created_at`, `processed_at timestamptz NULL`.
Indexes: `(status, created_at)`, `(workspace_id, created_at DESC)`.

**Payload rule (enforced in the database):** payload may contain ids,
slugs, and status/priority values ONLY. It must NOT contain message
bodies, emails, or phone numbers. A CHECK constraint rejects payloads
containing any of the keys `body`, `email`, `phone`, `phone_number`,
`message`, `content`.

## Cross-workspace safety

Foreign keys alone cannot stop a row in workspace A from pointing at a
customer/conversation/ticket in workspace B (the referenced row exists,
just in the wrong workspace). One generic trigger function closes that
gap:

- `public.enforce_workspace_consistency()` — plain PL/pgSQL trigger
  function (not SECURITY DEFINER; triggers run as the table owner and
  bypass RLS, so its lookups are not policy-filtered). It branches on
  `TG_TABLE_NAME` and raises an exception on any workspace mismatch.
- BEFORE INSERT OR UPDATE triggers on: `conversations` (customer),
  `messages` (conversation + customer when set), `tickets` (customer +
  conversation when set), `ticket_events` (ticket),
  `conversation_notes` (conversation), `widget_visitor_sessions`
  (widget_settings + customer/conversation when set).
- `customers` has no parent row, so no trigger applies to it.

## RLS model

- RLS is enabled on **all nine** new tables.
- Membership is checked **only** through the Phase 1 SECURITY DEFINER
  helper `public.is_workspace_member(uuid)` (`set search_path = public`,
  `STABLE`, granted to `authenticated` only — re-asserted idempotently
  at the top of 0003, never re-created). **No policy queries
  `workspace_members` directly** — that caused the infinite recursion
  fixed by 0002. No `USING (true)` policy exists anywhere.
- Member tables — `customers`, `conversations`, `messages`, `tickets`,
  `ticket_events`, `conversation_notes` — get SELECT / INSERT / UPDATE /
  DELETE policies, each gated on
  `public.is_workspace_member(<table>.workspace_id)` (INSERT uses
  `WITH CHECK`, UPDATE uses both `USING` and `WITH CHECK`).
- `widget_settings` — member-only SELECT / INSERT / UPDATE. No DELETE
  policy (settings disappear with the workspace via ON DELETE CASCADE).
  No public/anon access; the widget reads config only through
  `get_widget_config()`.
- `widget_visitor_sessions` — **intentionally no policies at all**.
  RLS is enabled, so every direct SELECT / INSERT / UPDATE / DELETE by
  `anon` or `authenticated` is denied by default. Visitor access goes
  only through the SECURITY DEFINER RPCs below.
- `automation_events` — member SELECT only (read-only for members).
  No direct INSERT / UPDATE / DELETE policy: rows are written only by
  `record_automation_event()` and the widget RPCs (SECURITY DEFINER,
  bypassing RLS). Phase 3 status updates are a service-role concern,
  not a member policy.

## Guest RPCs (SECURITY DEFINER, `set search_path = public`)

All are revoked from `public` and granted only to the roles listed.
Each validates workspace consistency itself.

### record_automation_event(p_workspace_id, p_event_type, p_entity_type, p_entity_id, p_payload jsonb DEFAULT '{}') → uuid
Grant: `authenticated` only. Caller must be signed in **and** a member
of the workspace (`is_workspace_member` check inside the function).
Validates `p_event_type` against the allowed list, inserts one outbox
row, returns its id. Used by the backend when it creates/updates
tickets and conversations.

### create_widget_visitor_session(p_public_key, p_visitor_name DEFAULT NULL, p_visitor_email DEFAULT NULL) → TABLE(session_token text, conversation_id uuid, customer_id uuid, expires_at timestamptz)
Grant: `anon`, `authenticated`. Looks up `widget_settings` by
`public_key`; raises if the key is unknown or the widget is disabled.
If an email is given, reuses the existing customer in that workspace
with a case-insensitive email match; otherwise creates a customer.
Without an email the customer gets a placeholder address
`visitor-<hex>@widget.local` (because `customers.email` is NOT NULL).
Creates a fresh open conversation and a session expiring in 24 hours.
Generates a random token (`gen_random_bytes(32)`, hex-encoded), stores
**only** `encode(digest(token, 'sha256'), 'hex')`, and returns the
**raw token exactly once** — the caller must hand it to the visitor
(e.g. cookie / localStorage). The raw token is never stored and cannot
be recovered from the database afterwards. If the visitor loses it,
they must start a new session.

### post_widget_visitor_message(p_token text, p_body text, p_client_message_id text DEFAULT NULL) → TABLE(message_id uuid, is_duplicate boolean)
Grant: `anon`, `authenticated`. Hashes the token (SHA-256) and finds a
non-expired session; raises `Invalid or expired session` otherwise.
Validates the body (trimmed, 1–5000 chars), then — if a non-null client
key is supplied — returns the existing message with the same
`conversation_id` + `client_message_id` as a duplicate (`is_duplicate =
true`, no second insert, no second outbox event). Otherwise inserts a
`customer` message into the session's conversation (storing the client
key), updates `conversations.last_message_at` and the session's
`last_seen_at`, and records an `automation_events` row
(`customer.message.created`, payload with ids only — no message body).
A concurrent-retry race on the unique index is handled by a
`unique_violation` handler that returns the other transaction's row.
Returns the message id and whether it was a duplicate. (0005; the
2-arg version from 0003/0004 is dropped.)

### get_widget_visitor_history(p_token text) → TABLE(message_id uuid, sender_type text, body text, created_at timestamptz)
Grant: `anon`, `authenticated`. Hashes the token and returns **only**
that session's conversation messages, oldest first. Returns zero rows
for an unknown or expired token (it does not reveal whether the token
ever existed).

### get_widget_config(p_public_key text) → TABLE(business_name text, welcome_message text, primary_color text, enabled boolean)
Grant: `anon`, `authenticated`. Returns the public display config only.
No secrets, no workspace ids, no member data. Returns zero rows for an
unknown key.

## updated_at triggers

`public.set_updated_at()` (from 0001) is attached to `customers`,
`conversations`, `tickets`, `conversation_notes`, and
`widget_settings`. `messages`, `ticket_events`,
`widget_visitor_sessions`, and `automation_events` have no `updated_at`
column by design (append-only / externally managed).

## The outbox pattern (how Phase 3 will consume automation_events)

1. **Poll:** a Phase 3 worker (n8n or a small service, service-role
   key) selects rows where `status = 'pending'` ordered by
   `created_at`, oldest first, in small batches.
2. **Claim:** for each row, atomically set
   `status = 'processing'` (e.g. `UPDATE ... WHERE id = $1 AND
   status = 'pending' RETURNING *`) so two workers never process the
   same event. Only the worker that wins the claim proceeds.
3. **Deliver:** call the n8n webhook / handler with the event id and
   payload. The payload contains ids, slugs, and status/priority
   values only — the handler fetches any display data it needs through
   the API with proper auth; it never trusts the payload for content.
4. **Acknowledge:** on success set `status = 'processed'` and
   `processed_at = now()`. On a transient failure set
   `status = 'failed'`, increment `attempts`, and retry later with
   backoff; after the retry budget is exhausted set `status = 'dead'`
   for manual inspection.
5. **Idempotency:** the event `id` is the idempotency key. Handlers
   must dedupe on it — a row claimed but never acknowledged (worker
   crash) will be re-polled, so the same event id can legitimately be
   delivered twice.

## Known limitations

- **True two-user isolation test is still pending.** The Supabase
  email rate limit blocked creating a second test user, so cross-user
  isolation has been proven only at the API level (403 for a foreign
  workspace) and the RLS mechanism level in Phase 1 — not by two real
  users exercising these Phase 2 tables live. Do not claim it passed
  until that test runs.
- 0003 was partially applied to live Supabase on 2026-11-14 (tables,
  triggers, RLS and policies live; the RPC batch failed with error
  42883 and was superseded by 0004 — see the 0004 note above). 0004 has
  been written and reviewed as SQL only; it has not been applied to live
  Supabase or executed against a database in this step. The parent
  applies it live later.
