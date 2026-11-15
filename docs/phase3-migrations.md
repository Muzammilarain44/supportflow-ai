# Phase 3 migrations — 0009 (required) + 0010 (optional)

Apply in Supabase Dashboard > SQL Editor, in order, after
`0008_phase2_1_widget_origins.sql`. Both files are idempotent
(`IF NOT EXISTS`, `DROP ... IF EXISTS`, `CREATE OR REPLACE`).

> **Status: UNAPPLIED and UNVERIFIED live.** Nothing in this document
> has been run against the live Supabase project. The statements below
> were reviewed by reading the SQL and by automated tests that assert
> on the file contents and on the RPC contract (see
> `apps/api/src/__tests__/app-phase3-outbox.test.ts`); they have not
> been executed against a real database.

## 0009 — `0009_phase3_ai_platform.sql` (required)

### New tables (7)

| Table | Purpose |
|---|---|
| `knowledge_documents` | Source articles / FAQs the AI grounds on (`kind` article/faq, `enabled`, `archived`). |
| `knowledge_chunks` | Searchable text chunks of a document. `search_vector` is a `tsvector` maintained by a `BEFORE INSERT OR UPDATE` trigger (`to_tsvector('english', content)`), with a GIN index. A workspace-consistency trigger rejects a chunk whose document belongs to another workspace (extends `enforce_workspace_consistency()` from 0003 — all 0003 branches are reproduced verbatim, plus the new `knowledge_chunks` branch). |
| `knowledge_index_jobs` | Async chunking/indexing work queue (`pending`/`processing`/`done`/`failed`, `attempts`, `error`). |
| `ai_settings` | One row per workspace (`workspace_id` UNIQUE): `enabled`, `mode` (`disabled`/`suggestion`/`auto`/`human_only`), `provider_order` default `{groq,gemini}`, `auto_reply_require_grounding`, `escalation_on_low_confidence`. |
| `ai_executions` | Audit log of every AI provider call (provider, model, mode, `pending`/`success`/`failed`/`escalated`/`skipped`, token counts, latency, error, suggestion). Index on `(workspace_id, created_at desc)`. |
| `ai_suggestions` | Agent-reviewable AI draft replies with `sources jsonb` and `pending`/`accepted`/`edited`/`rejected` status. |
| `handoffs` | AI → human handoff records (`triggered_by` ai/agent/system, `ai_paused`, `resumed_at`). Index on `conversation_id`. |

All 7 tables: RLS enabled, with member `SELECT`/`INSERT`/`UPDATE`/
`DELETE` policies that go through `public.is_workspace_member(workspace_id)`
only — mirroring the 0003 policy style exactly. No policy queries
`workspace_members` directly; no `USING (true)` policy anywhere.

`updated_at` is maintained by `public.set_updated_at()` (from 0001,
re-asserted in this file) on `knowledge_documents`,
`knowledge_index_jobs`, `ai_settings` and `ai_suggestions`.

### Columns added to existing tables

- `conversations`: `ai_paused boolean NOT NULL DEFAULT false`,
  `handoff_reason text`, `handed_off_at timestamptz`.
- `tickets`: `escalation_reason text`, `escalated_at timestamptz`.
- `automation_events`: `claimed_at timestamptz`,
  `next_attempt_at timestamptz`, plus an index on
  `(status, next_attempt_at, created_at)` for the claim query.

### Outbox RPCs (service_role only)

All three are `SECURITY DEFINER`, `set search_path = public`,
revoked from `public`, granted `EXECUTE` to `service_role` only.
They are the dispatcher's only interface to the outbox.

- **`claim_automation_events(p_limit int default 10)`** →
  `SETOF automation_events`. Atomically claims the oldest `pending`
  rows whose `next_attempt_at` is null or due, via a CTE with
  `FOR UPDATE SKIP LOCKED` (concurrent dispatchers can never claim
  the same row). Sets `status='processing'`, `attempts=attempts+1`,
  `claimed_at=now()`. Returns the claimed rows.
- **`reclaim_stale_automation_events(p_timeout_seconds int default 300)`**
  → `int`. Crash recovery: resets `processing` rows whose `claimed_at`
  is older than the timeout back to `pending` (attempts are **kept**,
  so a repeatedly crashing event still reaches the dead-letter
  threshold). Returns the number of rows reclaimed.
- **`ack_automation_event(p_event_id uuid, p_status text)`** → `void`.
  `p_status` must be `processed` / `failed` / `dead` (anything else
  raises). `processed` sets `processed_at=now()`. `failed` returns
  the row to `pending` with exponential backoff:
  `next_attempt_at = now() + least(2^attempts * 5s, 300s) + up to 5s
  random jitter` — `attempts` is **not** incremented here (the claim
  already did that). `dead` sets `status='dead'` and
  `processed_at=now()`; the row is never retried.

### RAG retrieval RPC (authenticated + service_role)

- **`search_knowledge_chunks(p_workspace_id uuid, p_query text, p_limit int default 5)`**
  → rows of `(chunk text, document_title text, document_id uuid, rank real)`.
  `SECURITY DEFINER`, `STABLE`, `set search_path = public`, revoked
  from `public`, granted to `authenticated` and `service_role`. Lexical
  full-text search only: `plainto_tsquery('english', p_query)` against
  `knowledge_chunks.search_vector`, joined to `knowledge_documents`,
  filtered to the given workspace with `enabled=true` and
  `archived=false`, ordered by `ts_rank` desc. This is Worker B's
  primary retrieval path (`retrieveKnowledge` in
  `apps/api/src/lib/rag.ts`, exact SQL in `docs/phase3-rag.md`); if the
  RPC does not exist yet, the API falls back to a PostgREST `textSearch`
  query with the same filters — the RPC is the preferred path, not a
  hard dependency, and the fallback keeps working regardless.

### pgcrypto note

This file calls no `digest()` / `gen_random_bytes()` (unlike 0004,
where pgcrypto lives in the `extensions` schema and must be qualified
as `extensions.digest` / `extensions.gen_random_bytes`).
`gen_random_uuid()` is built-in on Supabase Postgres.

## 0010 — `0010_phase3_vector_optional.sql` (OPTIONAL)

Adds `embedding halfvec(3072)` to `knowledge_chunks` and creates the
`vector` extension if missing. **Vector search is NOT wired in Phase 3:**
no code reads or writes this column, no index on it is created here,
and nothing in 0009 depends on it.

> **Status: OPTIONAL, UNAPPLIED and UNVERIFIED live.** Skip it unless
> a later phase actually implements vector search. Applying it only
> requires the pgvector extension to be available on the project.

## How to apply (live, by hand — not done by this worker)

1. Supabase Dashboard → SQL Editor → paste `0009_phase3_ai_platform.sql`
   → Run. Confirm no errors.
2. Optionally paste `0010_phase3_vector_optional.sql` → Run (only if
   vector search is planned; otherwise skip).
3. Verify: the 7 tables exist with RLS enabled; the 3 RPCs exist and
   are granted to `service_role` only; `select * from
   public.automation_events` as an authenticated member still works
   (member `SELECT` policy from 0003 is unchanged).
