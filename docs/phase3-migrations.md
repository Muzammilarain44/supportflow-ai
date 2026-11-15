# Phase 3 migrations — 0009 (required) + 0010 (optional) + 0011 (required fix, superseded by 0012) + 0012 (required fix)

Apply in Supabase Dashboard > SQL Editor, in order, after
`0008_phase2_1_widget_origins.sql`. All files are idempotent
(`IF NOT EXISTS`, `DROP ... IF EXISTS`, `CREATE OR REPLACE`).

> **Status: 0009–0011 APPLIED live 2026-11-15 and verified. 0012 NOT
> YET APPLIED — the parent applies it (SQL Editor) and redeploys the
> backend. The 0012 statements below were reviewed by reading the SQL
> and by automated tests that assert on the file contents (see
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
  full-text search only: tier 1 is the strict `plainto_tsquery`
  AND match, tier 2 (migration 0012, replacing the 0011 attempt — see
  below) fills remaining slots with an explicitly OR-joined tsquery
  built from the query's lexemes, for natural questions — see
  `0012_phase3_kb_retrieval_explicit_or.sql` and `docs/phase3-rag.md`.
  Filtered to the given workspace with `enabled=true` and
  `archived=false`, ordered by tier then `ts_rank` desc. This is Worker B's
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

## 0011 — `0011_phase3_kb_retrieval_or_fallback.sql` (required fix, SUPERSEDED by 0012)

Replaces `search_knowledge_chunks` (same signature, same grants) with a
two-tier version. Live E2E found the 0009 version returned 0 rows for
natural questions: `plainto_tsquery` ANDs every lexeme, so "Hi, can you
please confirm your refund policy?" matched nothing. Tier 1 is the
unchanged strict AND query (keyword queries behave exactly as before);
tier 2 was meant to fill remaining slots with `websearch_to_tsquery`
OR matches — **but that assumption was wrong**: `websearch_to_tsquery`
ANDs unquoted terms (only an explicit OR keyword ORs), so tier 2 was
effectively identical to tier 1 and natural questions still returned
0 rows live ("refund policy" -> 1 row, "refund policy confirm" ->
0 rows). Do not reintroduce `websearch_to_tsquery` for this. Workspace
filtering and enabled / non-archived-only documents are unchanged in
both tiers. No tables, columns, policies or data change. Applied live
2026-11-15 (DROP-first — `CREATE OR REPLACE` alone failed live with
ERROR 42P13 on the first attempt). **Superseded by 0012**, which keeps
tier 1 and rebuilds tier 2 as an explicit OR over the query's lexemes.

## 0012 — `0012_phase3_kb_retrieval_explicit_or.sql` (required fix)

Replaces `search_knowledge_chunks` again (same signature, same
grants). Tier 1 is the unchanged strict AND query. Tier 2 now builds
an EXPLICITLY OR-joined tsquery from the query's lexemes:
`to_tsvector('english', p_query)` yields the lexemes (stop words
already dropped), `tsvector_to_array` exposes them, and they are
joined with `' | '` (each single-quoted, so it is taken as an
already-normalized lexeme matching the chunk `search_vector`
exactly) and parsed with `to_tsquery`. Any lexeme matching a chunk
counts, so natural questions retrieve. Workspace filtering and
enabled / non-archived-only documents are unchanged in both tiers.
No tables, columns, policies or data change. Idempotent (DROP first,
then CREATE — `CREATE OR REPLACE` alone fails live with ERROR 42P13
when the live return type differs, lesson from 0011; grants are
re-applied after the DROP). The `rag.ts` PostgREST fallback is
aligned the same way: it now sends the question's terms joined with
the explicit `OR` keyword (`buildOrWebsearchQuery`) instead of the
raw question. **Not yet applied live** — apply it before re-running
the live retrieval / grounding / unsafe-guard checks.

## How to apply (live, by hand — not done by this worker)

1. Supabase Dashboard → SQL Editor → paste `0009_phase3_ai_platform.sql`
   → Run. Confirm no errors.
2. Optionally paste `0010_phase3_vector_optional.sql` → Run (only if
   vector search is planned; otherwise skip).
3. Paste `0011_phase3_kb_retrieval_or_fallback.sql` → Run. Confirm no
   errors. (Required: without it, natural-language questions retrieve
   nothing.)
4. Paste `0012_phase3_kb_retrieval_explicit_or.sql` → Run. Confirm no
   errors. (Required: 0011's tier 2 is a no-op — without 0012, natural
   questions still retrieve nothing.)
5. Verify: the 7 tables exist with RLS enabled; the 3 RPCs exist and
   are granted to `service_role` only; `select * from
   public.automation_events` as an authenticated member still works
   (member `SELECT` policy from 0003 is unchanged).
