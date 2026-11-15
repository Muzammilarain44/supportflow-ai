-- ============================================================================
-- SupportFlow AI — Migration 0011: KB retrieval OR fallback (Phase 3 fix)
--
-- search_knowledge_chunks (0009) used plainto_tsquery('english', p_query),
-- which ANDs every lexeme: natural questions ("Hi, can you please
-- confirm your refund policy?") returned 0 rows because the chunk
-- contains none of hi / please / confirm / get, so suggestions had
-- sources=[] and auto mode escalated on missing grounding.
--
-- The function now tries the strict AND query first (tier 1 — keyword
-- queries behave exactly as before), then fills any remaining slots with
-- websearch_to_tsquery('english', p_query) matches (tier 2 — natural
-- language: unquoted terms are OR'd, quoted phrases are AND'd).
-- Workspace filtering and enabled / non-archived-only documents are
-- unchanged in both tiers; ranking stays ts_rank, tier 1 first.
--
-- Idempotent: DROP first, then CREATE — CREATE OR REPLACE alone fails
-- live with ERROR 42P13 ("cannot change return type of existing
-- function") because the live function's row type differs from this
-- definition (verified 2026-11-15 when 0011 first ran). DROP removes the
-- old grants too; they are re-applied below. No tables, columns,
-- policies or data change.
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
      websearch_to_tsquery('english', p_query) as q_or
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
    -- Tier 2: natural-language OR match, excluding rows already in tier 1.
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
