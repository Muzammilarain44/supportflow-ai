-- ============================================================================
-- SupportFlow AI — Phase 3 migration (OPTIONAL): pgvector embeddings
-- File: 0010_phase3_vector_optional.sql
-- Apply AFTER 0009_phase3_ai_platform.sql, in order,
-- in Supabase Dashboard > SQL Editor. OPTIONAL — 0009 works fully
-- without this file.
--
-- Adds a single `embedding` column (halfvec(3072)) to knowledge_chunks
-- so a future vector-search step can store embeddings. Vector search is
-- NOT wired in Phase 3: no code reads or writes this column, no index
-- on it is created here, and nothing in 0009 depends on it. Applying
-- this file only requires the pgvector extension to be available on the
-- project; skipping it changes nothing about Phase 3 behaviour.
--
-- Status: OPTIONAL, UNAPPLIED and UNVERIFIED live (see
-- docs/phase3-migrations.md). Do not assume it has been applied.
-- ============================================================================

create extension if not exists vector;

alter table public.knowledge_chunks
  add column if not exists embedding halfvec(3072);
