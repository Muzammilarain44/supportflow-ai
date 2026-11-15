-- ============================================================================
-- SupportFlow AI — Migration 0012: KB retrieval explicit-OR tier (Phase 3 fix)
--
-- Migration 0011's tier 2 used websearch_to_tsquery('english', p_query)
-- on the assumption that unquoted space-separated terms are OR'd. That
-- assumption is WRONG: PostgreSQL's websearch_to_tsquery ANDs unquoted
-- terms (only an explicit OR keyword ORs), so tier 2 was effectively
-- identical to tier 1. Live proof (2026-11-15): "refund policy" -> 1
-- row, but "refund policy confirm" / "refund policy please" /
-- "confirm refund policy" -> 0 rows; natural questions -> 0 rows.
-- Consequence: suggestions had sources=[] and auto mode escalated on
-- missing grounding before drafting, so the unsafe-promise draft guard
-- never ran.
--
-- Tier 2 now builds an EXPLICITLY OR-joined tsquery from the query's
-- lexemes: to_tsvector('english', p_query) yields the lexemes (stop
-- words already dropped), tsvector_to_array exposes them, and they are
-- joined with ' | ' — each lexeme single-quoted, so it is taken as an
-- already-normalized lexeme that matches the chunk search_vector
-- exactly (chunk vectors are built with the same to_tsvector call).
-- Any lexeme matching a chunk counts, so natural questions retrieve.
-- Tier 1 (strict plainto_tsquery AND) is unchanged and still runs
-- first; workspace filtering and enabled / non-archived-only documents
-- are unchanged in both tiers; ranking stays ts_rank, tier 1 first.
--
-- Idempotent: DROP first, then CREATE — CREATE OR REPLACE alone fails
-- live with ERROR 42P13 ("cannot change return type of existing
-- function") when the live return type differs (lesson from 0011).
-- DROP removes the old grants too; they are re-applied below. No
-- tables, columns, policies or data change.
-- ============================================================================

drop function if exists public.search_knowledge_chunks(uuid, text, int);

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
  with params as (
    select
      plainto_tsquery('english', p_query) as q_and,
      coalesce(
        (
          select to_tsquery('english', string_agg('''' || lexeme || '''', ' | '))
          from unnest(tsvector_to_array(to_tsvector('english', p_query))) as lexeme
        ),
        ''::tsquery
      ) as q_or
  ),
  tiered as (
    -- Tier 1: strict AND match (unchanged 0009 behaviour for keywords).
    select
      c.content,
      d.title,
      c.document_id,
      ts_rank(c.search_vector, p.q_and) as rank,
      1 as tier
    from public.knowledge_chunks c
    join public.knowledge_documents d on d.id = c.document_id
    cross join params p
    where c.workspace_id = p_workspace_id
      and d.enabled = true
      and d.archived = false
      and c.search_vector @@ p.q_and
    union all
    -- Tier 2: explicit-OR match on the query's lexemes, excluding rows
    -- already in tier 1.
    select
      c.content,
      d.title,
      c.document_id,
      ts_rank(c.search_vector, p.q_or) as rank,
      2 as tier
    from public.knowledge_chunks c
    join public.knowledge_documents d on d.id = c.document_id
    cross join params p
    where c.workspace_id = p_workspace_id
      and d.enabled = true
      and d.archived = false
      and c.search_vector @@ p.q_or
      and not (c.search_vector @@ p.q_and)
  )
  select content, title, document_id, rank
  from tiered
  order by tier asc, rank desc
  limit p_limit;
$$;

revoke all on function public.search_knowledge_chunks(uuid, text, int) from public;
grant execute on function public.search_knowledge_chunks(uuid, text, int) to authenticated, service_role;
