-- ============================================================================
-- SupportFlow AI — Phase 3 migration: AI platform
-- File: 0009_phase3_ai_platform.sql
-- Apply AFTER 0008_phase2_1_widget_origins.sql, in order,
-- in Supabase Dashboard > SQL Editor.
-- Idempotent: safe to re-run (create table/index if not exists,
-- drop policy/trigger if exists, create or replace function).
--
-- Tables created:
--   knowledge_documents, knowledge_chunks, knowledge_index_jobs,
--   ai_settings, ai_executions, ai_suggestions, handoffs.
-- Columns added:
--   conversations.ai_paused, conversations.handoff_reason,
--   conversations.handed_off_at,
--   tickets.escalation_reason, tickets.escalated_at,
--   automation_events.claimed_at, automation_events.next_attempt_at.
-- RPCs created:
--   claim_automation_events, reclaim_stale_automation_events,
--   ack_automation_event (service_role ONLY — the outbox dispatcher),
--   search_knowledge_chunks (authenticated + service_role — RAG
--     retrieval, Worker B).
--
-- VERIFICATION NOTE — public.is_workspace_member(uuid):
--   Defined in 0001 and re-asserted in 0002 as:
--     language sql, SECURITY DEFINER, STABLE, set search_path = public,
--     granted EXECUTE to `authenticated` only (revoked from public).
--   It is NOT re-created here. Membership is checked ONLY through this
--   helper. No policy in this file queries workspace_members directly
--   (that caused infinite recursion, fixed by 0002). No policy uses
--   USING (true) anywhere.
--
-- VERIFICATION NOTE — pgcrypto / extensions schema:
--   This file uses no digest()/gen_random_bytes() calls (unlike 0004,
--   where pgcrypto lives in the `extensions` schema and must be qualified
--   as extensions.digest / extensions.gen_random_bytes). gen_random_uuid()
--   is built-in on Supabase Postgres and needs no qualification.
--   Vector search is NOT part of this file; see 0010 (optional).
-- ============================================================================

create extension if not exists "pgcrypto";

-- ============================================================================
-- 1. knowledge_documents — source articles / FAQs the AI grounds on.
-- ============================================================================
create table if not exists public.knowledge_documents (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces (id) on delete cascade,
  title text not null,
  content text not null default '',
  kind text not null default 'article' check (kind in ('article', 'faq')),
  enabled boolean not null default true,
  archived boolean not null default false,
  created_by uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists knowledge_documents_workspace_idx
  on public.knowledge_documents (workspace_id);
create index if not exists knowledge_documents_workspace_created_idx
  on public.knowledge_documents (workspace_id, created_at desc);

-- ============================================================================
-- 2. knowledge_chunks — searchable text chunks of a document.
--    search_vector is maintained by a BEFORE INSERT OR UPDATE trigger
--    (to_tsvector('english', content)); full-text search only, no
--    embeddings in this file (see 0010, optional).
-- ============================================================================
create table if not exists public.knowledge_chunks (
  id uuid primary key default gen_random_uuid(),
  document_id uuid not null references public.knowledge_documents (id) on delete cascade,
  workspace_id uuid not null references public.workspaces (id) on delete cascade,
  chunk_index int not null,
  content text not null,
  source_title text not null,
  search_vector tsvector,
  created_at timestamptz not null default now()
);
create index if not exists knowledge_chunks_search_vector_idx
  on public.knowledge_chunks using gin (search_vector);
create index if not exists knowledge_chunks_workspace_idx
  on public.knowledge_chunks (workspace_id);
create index if not exists knowledge_chunks_document_idx
  on public.knowledge_chunks (document_id, chunk_index);

-- Maintains search_vector from content on every insert/update.
create or replace function public.set_knowledge_chunk_search_vector()
returns trigger
language plpgsql
as $$
begin
  new.search_vector := to_tsvector('english', coalesce(new.content, ''));
  return new;
end;
$$;

drop trigger if exists knowledge_chunks_search_vector on public.knowledge_chunks;
create trigger knowledge_chunks_search_vector
  before insert or update on public.knowledge_chunks
  for each row execute function public.set_knowledge_chunk_search_vector();

-- ============================================================================
-- 3. knowledge_index_jobs — async chunking/indexing work queue.
-- ============================================================================
create table if not exists public.knowledge_index_jobs (
  id uuid primary key default gen_random_uuid(),
  document_id uuid references public.knowledge_documents (id) on delete cascade,
  workspace_id uuid not null references public.workspaces (id) on delete cascade,
  status text not null default 'pending'
    check (status in ('pending', 'processing', 'done', 'failed')),
  error text,
  attempts int not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists knowledge_index_jobs_workspace_idx
  on public.knowledge_index_jobs (workspace_id);
create index if not exists knowledge_index_jobs_status_created_idx
  on public.knowledge_index_jobs (status, created_at);

-- ============================================================================
-- 4. ai_settings — one AI configuration row per workspace.
-- ============================================================================
create table if not exists public.ai_settings (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null unique references public.workspaces (id) on delete cascade,
  enabled boolean not null default false,
  mode text not null default 'suggestion'
    check (mode in ('disabled', 'suggestion', 'auto', 'human_only')),
  provider_order text[] not null default '{groq,gemini}',
  auto_reply_require_grounding boolean not null default true,
  escalation_on_low_confidence boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- ============================================================================
-- 5. ai_executions — audit log of every AI provider call.
-- ============================================================================
create table if not exists public.ai_executions (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces (id) on delete cascade,
  conversation_id uuid references public.conversations (id) on delete set null,
  message_id uuid references public.messages (id) on delete set null,
  event_id uuid references public.automation_events (id) on delete set null,
  provider text,
  model text,
  mode text,
  status text not null default 'pending'
    check (status in ('pending', 'success', 'failed', 'escalated', 'skipped')),
  prompt_tokens int,
  completion_tokens int,
  latency_ms int,
  error text,
  suggestion text,
  created_at timestamptz not null default now()
);
create index if not exists ai_executions_workspace_created_idx
  on public.ai_executions (workspace_id, created_at desc);

-- ============================================================================
-- 6. ai_suggestions — agent-reviewable AI draft replies.
-- ============================================================================
create table if not exists public.ai_suggestions (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces (id) on delete cascade,
  conversation_id uuid not null references public.conversations (id) on delete cascade,
  message_id uuid references public.messages (id) on delete set null,
  suggestion text not null,
  sources jsonb not null default '[]'::jsonb,
  status text not null default 'pending'
    check (status in ('pending', 'accepted', 'edited', 'rejected')),
  reviewed_by uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists ai_suggestions_workspace_idx
  on public.ai_suggestions (workspace_id);
create index if not exists ai_suggestions_conversation_created_idx
  on public.ai_suggestions (conversation_id, created_at desc);

-- ============================================================================
-- 7. handoffs — AI -> human handoff records.
-- ============================================================================
create table if not exists public.handoffs (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces (id) on delete cascade,
  conversation_id uuid not null references public.conversations (id) on delete cascade,
  ticket_id uuid references public.tickets (id) on delete set null,
  reason text not null,
  triggered_by text not null default 'ai'
    check (triggered_by in ('ai', 'agent', 'system')),
  ai_paused boolean not null default true,
  resumed_at timestamptz,
  created_at timestamptz not null default now()
);
create index if not exists handoffs_conversation_idx
  on public.handoffs (conversation_id);
create index if not exists handoffs_workspace_idx
  on public.handoffs (workspace_id);

-- ============================================================================
-- 8. Columns added to existing Phase 2 tables.
-- ============================================================================
alter table public.conversations
  add column if not exists ai_paused boolean not null default false,
  add column if not exists handoff_reason text,
  add column if not exists handed_off_at timestamptz;

alter table public.tickets
  add column if not exists escalation_reason text,
  add column if not exists escalated_at timestamptz;

alter table public.automation_events
  add column if not exists claimed_at timestamptz,
  add column if not exists next_attempt_at timestamptz;

create index if not exists automation_events_claim_due_idx
  on public.automation_events (status, next_attempt_at, created_at);

-- ============================================================================
-- Cross-workspace safety: extend public.enforce_workspace_consistency()
-- (defined in 0003) with the knowledge_chunks branch. The full function
-- is re-created here so a re-run of this file alone is still correct;
-- every 0003 branch is reproduced verbatim below, plus the new one.
-- Plain (not SECURITY DEFINER) trigger function: triggers run as the
-- table owner and bypass RLS, so the lookups below are not
-- policy-filtered.
-- ============================================================================
create or replace function public.enforce_workspace_consistency()
returns trigger
language plpgsql
as $$
declare
  v_ws uuid;
begin
  if tg_table_name = 'conversations' then
    select workspace_id into v_ws from public.customers where id = new.customer_id;
    if v_ws is null then
      raise exception 'conversations: customer % not found', new.customer_id;
    end if;
    if v_ws <> new.workspace_id then
      raise exception 'conversations: customer belongs to a different workspace';
    end if;

  elsif tg_table_name = 'messages' then
    select workspace_id into v_ws from public.conversations where id = new.conversation_id;
    if v_ws is null then
      raise exception 'messages: conversation % not found', new.conversation_id;
    end if;
    if v_ws <> new.workspace_id then
      raise exception 'messages: conversation belongs to a different workspace';
    end if;
    if new.customer_id is not null then
      select workspace_id into v_ws from public.customers where id = new.customer_id;
      if v_ws is null then
        raise exception 'messages: customer % not found', new.customer_id;
      end if;
      if v_ws <> new.workspace_id then
        raise exception 'messages: customer belongs to a different workspace';
      end if;
    end if;

  elsif tg_table_name = 'tickets' then
    if new.customer_id is not null then
      select workspace_id into v_ws from public.customers where id = new.customer_id;
      if v_ws is null then
        raise exception 'tickets: customer % not found', new.customer_id;
      end if;
      if v_ws <> new.workspace_id then
        raise exception 'tickets: customer belongs to a different workspace';
      end if;
    end if;
    if new.conversation_id is not null then
      select workspace_id into v_ws from public.conversations where id = new.conversation_id;
      if v_ws is null then
        raise exception 'tickets: conversation % not found', new.conversation_id;
      end if;
      if v_ws <> new.workspace_id then
        raise exception 'tickets: conversation belongs to a different workspace';
      end if;
    end if;

  elsif tg_table_name = 'ticket_events' then
    select workspace_id into v_ws from public.tickets where id = new.ticket_id;
    if v_ws is null then
      raise exception 'ticket_events: ticket % not found', new.ticket_id;
    end if;
    if v_ws <> new.workspace_id then
      raise exception 'ticket_events: ticket belongs to a different workspace';
    end if;

  elsif tg_table_name = 'conversation_notes' then
    select workspace_id into v_ws from public.conversations where id = new.conversation_id;
    if v_ws is null then
      raise exception 'conversation_notes: conversation % not found', new.conversation_id;
    end if;
    if v_ws <> new.workspace_id then
      raise exception 'conversation_notes: conversation belongs to a different workspace';
    end if;

  elsif tg_table_name = 'widget_visitor_sessions' then
    select workspace_id into v_ws from public.widget_settings where id = new.widget_settings_id;
    if v_ws is null then
      raise exception 'widget_visitor_sessions: widget_settings % not found', new.widget_settings_id;
    end if;
    if v_ws <> new.workspace_id then
      raise exception 'widget_visitor_sessions: widget_settings belongs to a different workspace';
    end if;
    if new.customer_id is not null then
      select workspace_id into v_ws from public.customers where id = new.customer_id;
      if v_ws is null then
        raise exception 'widget_visitor_sessions: customer % not found', new.customer_id;
      end if;
      if v_ws <> new.workspace_id then
        raise exception 'widget_visitor_sessions: customer belongs to a different workspace';
      end if;
    end if;
    if new.conversation_id is not null then
      select workspace_id into v_ws from public.conversations where id = new.conversation_id;
      if v_ws is null then
        raise exception 'widget_visitor_sessions: conversation % not found', new.conversation_id;
      end if;
      if v_ws <> new.workspace_id then
        raise exception 'widget_visitor_sessions: conversation belongs to a different workspace';
      end if;
    end if;

  elsif tg_table_name = 'knowledge_chunks' then
    select workspace_id into v_ws from public.knowledge_documents where id = new.document_id;
    if v_ws is null then
      raise exception 'knowledge_chunks: document % not found', new.document_id;
    end if;
    if v_ws <> new.workspace_id then
      raise exception 'knowledge_chunks: document belongs to a different workspace';
    end if;
  end if;

  return new;
end;
$$;

drop trigger if exists knowledge_chunks_workspace_consistency on public.knowledge_chunks;
create trigger knowledge_chunks_workspace_consistency
  before insert or update on public.knowledge_chunks
  for each row execute function public.enforce_workspace_consistency();

-- ============================================================================
-- updated_at triggers (uses public.set_updated_at() from 0001, re-asserted
-- here so this file is self-contained if 0001 was ever edited).
-- ============================================================================
create or replace function public.set_updated_at()
returns trigger language plpgsql as $$
begin new.updated_at = now(); return new; end; $$;

drop trigger if exists knowledge_documents_updated_at on public.knowledge_documents;
create trigger knowledge_documents_updated_at before update on public.knowledge_documents
  for each row execute function public.set_updated_at();

drop trigger if exists knowledge_index_jobs_updated_at on public.knowledge_index_jobs;
create trigger knowledge_index_jobs_updated_at before update on public.knowledge_index_jobs
  for each row execute function public.set_updated_at();

drop trigger if exists ai_settings_updated_at on public.ai_settings;
create trigger ai_settings_updated_at before update on public.ai_settings
  for each row execute function public.set_updated_at();

drop trigger if exists ai_suggestions_updated_at on public.ai_suggestions;
create trigger ai_suggestions_updated_at before update on public.ai_suggestions
  for each row execute function public.set_updated_at();

-- ============================================================================
-- Row Level Security — enable on ALL new tables.
-- Member tables: every policy goes through public.is_workspace_member().
-- No USING (true) policy anywhere.
-- ============================================================================
alter table public.knowledge_documents enable row level security;
alter table public.knowledge_chunks enable row level security;
alter table public.knowledge_index_jobs enable row level security;
alter table public.ai_settings enable row level security;
alter table public.ai_executions enable row level security;
alter table public.ai_suggestions enable row level security;
alter table public.handoffs enable row level security;

-- ---------- knowledge_documents ----------
drop policy if exists "knowledge_documents_select_members" on public.knowledge_documents;
create policy "knowledge_documents_select_members" on public.knowledge_documents for select
  using (public.is_workspace_member(knowledge_documents.workspace_id));
drop policy if exists "knowledge_documents_insert_members" on public.knowledge_documents;
create policy "knowledge_documents_insert_members" on public.knowledge_documents for insert
  with check (public.is_workspace_member(knowledge_documents.workspace_id));
drop policy if exists "knowledge_documents_update_members" on public.knowledge_documents;
create policy "knowledge_documents_update_members" on public.knowledge_documents for update
  using (public.is_workspace_member(knowledge_documents.workspace_id))
  with check (public.is_workspace_member(knowledge_documents.workspace_id));
drop policy if exists "knowledge_documents_delete_members" on public.knowledge_documents;
create policy "knowledge_documents_delete_members" on public.knowledge_documents for delete
  using (public.is_workspace_member(knowledge_documents.workspace_id));

-- ---------- knowledge_chunks ----------
drop policy if exists "knowledge_chunks_select_members" on public.knowledge_chunks;
create policy "knowledge_chunks_select_members" on public.knowledge_chunks for select
  using (public.is_workspace_member(knowledge_chunks.workspace_id));
drop policy if exists "knowledge_chunks_insert_members" on public.knowledge_chunks;
create policy "knowledge_chunks_insert_members" on public.knowledge_chunks for insert
  with check (public.is_workspace_member(knowledge_chunks.workspace_id));
drop policy if exists "knowledge_chunks_update_members" on public.knowledge_chunks;
create policy "knowledge_chunks_update_members" on public.knowledge_chunks for update
  using (public.is_workspace_member(knowledge_chunks.workspace_id))
  with check (public.is_workspace_member(knowledge_chunks.workspace_id));
drop policy if exists "knowledge_chunks_delete_members" on public.knowledge_chunks;
create policy "knowledge_chunks_delete_members" on public.knowledge_chunks for delete
  using (public.is_workspace_member(knowledge_chunks.workspace_id));

-- ---------- knowledge_index_jobs ----------
drop policy if exists "knowledge_index_jobs_select_members" on public.knowledge_index_jobs;
create policy "knowledge_index_jobs_select_members" on public.knowledge_index_jobs for select
  using (public.is_workspace_member(knowledge_index_jobs.workspace_id));
drop policy if exists "knowledge_index_jobs_insert_members" on public.knowledge_index_jobs;
create policy "knowledge_index_jobs_insert_members" on public.knowledge_index_jobs for insert
  with check (public.is_workspace_member(knowledge_index_jobs.workspace_id));
drop policy if exists "knowledge_index_jobs_update_members" on public.knowledge_index_jobs;
create policy "knowledge_index_jobs_update_members" on public.knowledge_index_jobs for update
  using (public.is_workspace_member(knowledge_index_jobs.workspace_id))
  with check (public.is_workspace_member(knowledge_index_jobs.workspace_id));
drop policy if exists "knowledge_index_jobs_delete_members" on public.knowledge_index_jobs;
create policy "knowledge_index_jobs_delete_members" on public.knowledge_index_jobs for delete
  using (public.is_workspace_member(knowledge_index_jobs.workspace_id));

-- ---------- ai_settings ----------
drop policy if exists "ai_settings_select_members" on public.ai_settings;
create policy "ai_settings_select_members" on public.ai_settings for select
  using (public.is_workspace_member(ai_settings.workspace_id));
drop policy if exists "ai_settings_insert_members" on public.ai_settings;
create policy "ai_settings_insert_members" on public.ai_settings for insert
  with check (public.is_workspace_member(ai_settings.workspace_id));
drop policy if exists "ai_settings_update_members" on public.ai_settings;
create policy "ai_settings_update_members" on public.ai_settings for update
  using (public.is_workspace_member(ai_settings.workspace_id))
  with check (public.is_workspace_member(ai_settings.workspace_id));
drop policy if exists "ai_settings_delete_members" on public.ai_settings;
create policy "ai_settings_delete_members" on public.ai_settings for delete
  using (public.is_workspace_member(ai_settings.workspace_id));

-- ---------- ai_executions ----------
drop policy if exists "ai_executions_select_members" on public.ai_executions;
create policy "ai_executions_select_members" on public.ai_executions for select
  using (public.is_workspace_member(ai_executions.workspace_id));
drop policy if exists "ai_executions_insert_members" on public.ai_executions;
create policy "ai_executions_insert_members" on public.ai_executions for insert
  with check (public.is_workspace_member(ai_executions.workspace_id));
drop policy if exists "ai_executions_update_members" on public.ai_executions;
create policy "ai_executions_update_members" on public.ai_executions for update
  using (public.is_workspace_member(ai_executions.workspace_id))
  with check (public.is_workspace_member(ai_executions.workspace_id));
drop policy if exists "ai_executions_delete_members" on public.ai_executions;
create policy "ai_executions_delete_members" on public.ai_executions for delete
  using (public.is_workspace_member(ai_executions.workspace_id));

-- ---------- ai_suggestions ----------
drop policy if exists "ai_suggestions_select_members" on public.ai_suggestions;
create policy "ai_suggestions_select_members" on public.ai_suggestions for select
  using (public.is_workspace_member(ai_suggestions.workspace_id));
drop policy if exists "ai_suggestions_insert_members" on public.ai_suggestions;
create policy "ai_suggestions_insert_members" on public.ai_suggestions for insert
  with check (public.is_workspace_member(ai_suggestions.workspace_id));
drop policy if exists "ai_suggestions_update_members" on public.ai_suggestions;
create policy "ai_suggestions_update_members" on public.ai_suggestions for update
  using (public.is_workspace_member(ai_suggestions.workspace_id))
  with check (public.is_workspace_member(ai_suggestions.workspace_id));
drop policy if exists "ai_suggestions_delete_members" on public.ai_suggestions;
create policy "ai_suggestions_delete_members" on public.ai_suggestions for delete
  using (public.is_workspace_member(ai_suggestions.workspace_id));

-- ---------- handoffs ----------
drop policy if exists "handoffs_select_members" on public.handoffs;
create policy "handoffs_select_members" on public.handoffs for select
  using (public.is_workspace_member(handoffs.workspace_id));
drop policy if exists "handoffs_insert_members" on public.handoffs;
create policy "handoffs_insert_members" on public.handoffs for insert
  with check (public.is_workspace_member(handoffs.workspace_id));
drop policy if exists "handoffs_update_members" on public.handoffs;
create policy "handoffs_update_members" on public.handoffs for update
  using (public.is_workspace_member(handoffs.workspace_id))
  with check (public.is_workspace_member(handoffs.workspace_id));
drop policy if exists "handoffs_delete_members" on public.handoffs;
create policy "handoffs_delete_members" on public.handoffs for delete
  using (public.is_workspace_member(handoffs.workspace_id));

-- ============================================================================
-- SECURITY DEFINER RPCs — outbox claim / ack / reclaim (Phase 3 dispatcher)
-- All use `set search_path = public`, are revoked from public, and are
-- granted ONLY to service_role. The dispatcher (apps/worker) is the only
-- caller; it authenticates with the service-role key. RLS does not apply
-- inside a SECURITY DEFINER function.
-- ============================================================================

-- ---------- claim_automation_events ----------
-- Atomically claims up to p_limit of the oldest 'pending' rows whose
-- next_attempt_at is null or due (<= now()). FOR UPDATE SKIP LOCKED
-- inside the CTE makes concurrent dispatchers safe: two workers can
-- never claim the same row. Claiming sets status='processing',
-- attempts=attempts+1 and claimed_at=now(). Returns the claimed rows.
create or replace function public.claim_automation_events(p_limit int default 10)
returns setof public.automation_events
language sql
security definer
set search_path = public
as $$
  with claimed as (
    select id
    from public.automation_events
    where status = 'pending'
      and (next_attempt_at is null or next_attempt_at <= now())
    order by created_at asc
    limit p_limit
    for update skip locked
  )
  update public.automation_events e
  set status = 'processing',
      attempts = e.attempts + 1,
      claimed_at = now()
  from claimed c
  where e.id = c.id
  returning e.*;
$$;
revoke all on function public.claim_automation_events(int) from public;
grant execute on function public.claim_automation_events(int) to service_role;

-- ---------- reclaim_stale_automation_events ----------
-- Crash recovery: resets 'processing' rows whose claimed_at is older
-- than p_timeout_seconds back to 'pending' (attempts are KEPT, so a
-- repeatedly crashing event still reaches the dead-letter threshold).
-- claimed_at is cleared; next_attempt_at is left as-is (it was already
-- due when the row was claimed). Returns the number of rows reclaimed.
create or replace function public.reclaim_stale_automation_events(p_timeout_seconds int default 300)
returns int
language plpgsql
security definer
set search_path = public
as $$
declare
  v_count int;
begin
  update public.automation_events
  set status = 'pending',
      claimed_at = null
  where status = 'processing'
    and claimed_at is not null
    and claimed_at < now() - make_interval(secs => p_timeout_seconds);
  get diagnostics v_count = row_count;
  return v_count;
end;
$$;
revoke all on function public.reclaim_stale_automation_events(int) from public;
grant execute on function public.reclaim_stale_automation_events(int) to service_role;

-- ---------- ack_automation_event ----------
-- Final disposition for a claimed event. p_status must be one of:
--   'processed' — delivered (2xx). Sets processed_at=now().
--   'failed'    — transient failure. Back to 'pending' with
--                 exponential backoff: next_attempt_at = now() +
--                 least(2^attempts * 5s, 300s) + up to 5s random
--                 jitter. attempts is NOT incremented here — it was
--                 already incremented by the claim.
--   'dead'      — permanent failure (attempts exhausted). Sets
--                 processed_at=now() so it is never retried.
create or replace function public.ack_automation_event(p_event_id uuid, p_status text)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if p_status not in ('processed', 'failed', 'dead') then
    raise exception 'Invalid ack status: %', p_status;
  end if;

  if p_status = 'processed' then
    update public.automation_events
    set status = 'processed',
        processed_at = now()
    where id = p_event_id;

  elsif p_status = 'failed' then
    update public.automation_events
    set status = 'pending',
        next_attempt_at = now()
          + least(power(2, attempts) * interval '5 seconds', interval '300 seconds')
          + (random() * interval '5 seconds')
    where id = p_event_id;

  else -- 'dead'
    update public.automation_events
    set status = 'dead',
        processed_at = now()
    where id = p_event_id;
  end if;
end;
$$;
revoke all on function public.ack_automation_event(uuid, text) from public;
grant execute on function public.ack_automation_event(uuid, text) to service_role;

-- ---------- search_knowledge_chunks ----------
-- RAG lexical retrieval (Worker B, apps/api/src/lib/rag.ts).
-- Primary path for retrieveKnowledge(); if this RPC does not exist
-- yet (migration not applied), the API falls back to a PostgREST
-- textSearch query with the same filters — the RPC is the preferred
-- path, not a hard dependency, and the fallback keeps working
-- regardless. SECURITY DEFINER so the service-role processor can read
-- across RLS; workspace filtering is enforced inside the function
-- (p_workspace_id on the chunks table). Only chunks whose document is
-- enabled and not archived are returned, best ts_rank first.
-- Exact SQL as documented in docs/phase3-rag.md (Worker B).
create or replace function public.search_knowledge_chunks(
  p_workspace_id uuid,
  p_query text,
  p_limit int default 5
)
returns table (
  chunk text,
  document_title text,
  document_id uuid,
  rank real
)
language sql
stable
security definer
set search_path = public
as $$
  select
    c.content,
    d.title,
    c.document_id,
    ts_rank(c.search_vector, plainto_tsquery('english', p_query)) as rank
  from public.knowledge_chunks c
  join public.knowledge_documents d on d.id = c.document_id
  where c.workspace_id = p_workspace_id
    and d.enabled = true
    and d.archived = false
    and c.search_vector @@ plainto_tsquery('english', p_query)
  order by rank desc
  limit p_limit;
$$;
revoke all on function public.search_knowledge_chunks(uuid, text, int) from public;
grant execute on function public.search_knowledge_chunks(uuid, text, int) to authenticated, service_role;
