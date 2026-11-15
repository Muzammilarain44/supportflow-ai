// ============================================================================
// SupportFlow AI — Phase 3: lexical RAG (Worker B)
//
// LEXICAL ONLY — no vector / embedding retrieval in Phase 3. Retrieval is
// PostgreSQL full-text search (two-tier: strict plainto_tsquery AND match
// first, then an explicitly OR-joined tsquery built from the query's
// lexemes — see migration 0012) against knowledge_chunks.search_vector,
// ordered by ts_rank with tier-1 matches first, workspace filtered, and
// only chunks whose document is enabled and not archived.
//
// The ts_rank query runs through the SECURITY DEFINER RPC
// `search_knowledge_chunks(p_workspace_id, p_query, p_limit)` — see
// docs/phase3-rag.md for the exact SQL Worker A must include in migration
// 0009. If that RPC is absent (e.g. the migration has not been applied),
// retrieveKnowledge falls back to the PostgREST textSearch() query and a
// client-side term-overlap rank, so retrieval still works, only with a
// cruder ranking. Both paths enforce the same workspace / enabled /
// not-archived filters.
// ============================================================================

import type { SupabaseClient } from '@supabase/supabase-js';

export interface ChunkItem {
  index: number;
  content: string;
  sourceTitle: string;
}

export interface RetrievedChunk {
  chunk: string;
  documentTitle: string;
  documentId: string;
  rank: number;
}

export interface ChunkOptions {
  /** Target chunk size in characters. Default 1000. */
  size?: number;
  /** Overlap carried into the next chunk, in characters. Default 200. */
  overlap?: number;
}

/** Split text into sentences on . ! ? boundaries (keeps the punctuation). */
function splitSentences(text: string): string[] {
  const parts = text.match(/[^.!?]+[.!?]+["')\]]*\s*|[^.!?]+$/g) ?? [];
  return parts.map((s) => s.trim()).filter(Boolean);
}

/** Hard-split a single over-long sentence at word boundaries. */
function splitLongSentence(sentence: string, size: number): string[] {
  const words = sentence.split(/\s+/).filter(Boolean);
  const out: string[] = [];
  let current = '';
  for (const word of words) {
    const next = current ? `${current} ${word}` : word;
    if (next.length > size && current) {
      out.push(current);
      current = word;
    } else {
      current = next;
    }
  }
  if (current) out.push(current);
  return out;
}

/**
 * Chunk content on paragraph / sentence boundaries, never mid-word where
 * avoidable. Consecutive chunks overlap by roughly `overlap` characters
 * (the tail sentences of the previous chunk are repeated at the start of
 * the next one). Returns chunks in order with 0-based indexes.
 */
export function chunkText(content: string, options: ChunkOptions & { sourceTitle: string }): ChunkItem[] {
  const size = options.size ?? 1000;
  const overlap = Math.min(options.overlap ?? 200, Math.max(0, size - 1));
  const paragraphs = content.split(/\n\s*\n/).map((p) => p.trim()).filter(Boolean);
  const sentences: string[] = [];
  for (const paragraph of paragraphs) {
    for (const sentence of splitSentences(paragraph)) {
      if (sentence.length > size) sentences.push(...splitLongSentence(sentence, size));
      else sentences.push(sentence);
    }
  }
  if (sentences.length === 0) return [];

  const chunks: string[] = [];
  let current = '';
  let carry: string[] = [];
  for (const sentence of sentences) {
    const next = current ? `${current} ${sentence}` : sentence;
    if (next.length > size && current) {
      chunks.push(current);
      // Overlap: carry the tail sentences of this chunk into the next one.
      carry = [];
      let carried = 0;
      const tail = current.split(/(?<=[.!?])\s+/).filter(Boolean);
      for (let i = tail.length - 1; i >= 0 && carried < overlap; i--) {
        carry.unshift(tail[i]!);
        carried += tail[i]!.length + 1;
      }
      current = [...carry, sentence].join(' ');
      if (current.length > size) {
        // Single sentence + carry still too long: emit the carry alone first.
        chunks.push(carry.join(' '));
        current = sentence;
      }
    } else {
      current = next;
    }
  }
  if (current.trim()) chunks.push(current);
  return chunks.map((content, index) => ({ index, content, sourceTitle: options.sourceTitle }));
}

// ---------------------------------------------------------------------------
// Retrieval
// ---------------------------------------------------------------------------

export interface KnowledgeDocumentRow {
  id: string;
  workspace_id: string;
  title: string;
  content: string;
  kind: string;
  enabled: boolean;
  archived: boolean;
}

function termOverlapRank(query: string, text: string): number {
  const terms = query.toLowerCase().split(/\W+/).filter((t) => t.length > 2);
  if (terms.length === 0) return 0;
  const hay = text.toLowerCase();
  let hits = 0;
  for (const term of terms) {
    if (hay.includes(term)) hits += 1;
  }
  return hits / terms.length;
}

/**
 * Build an explicit-OR websearch query from a natural-language question.
 * PostgreSQL's websearch_to_tsquery ANDs unquoted space-separated terms
 * (verified live 2026-11-15 — the migration 0011 assumption that they
 * are OR'd is wrong), so the fallback joins the query's terms with the
 * OR keyword: websearch_to_tsquery('english', 'refund OR policy OR
 * confirm') is 'refund' | 'polici' | 'confirm'. Terms use the same split
 * as termOverlapRank (length > 2); stop words are dropped by the
 * websearch parser itself. Returns '' when the query has no usable
 * terms. This mirrors migration 0012's explicit-OR tier 2 (which builds
 * the OR tsquery from the query's lexemes server-side) for the
 * PostgREST path, where no OR tsquery can be passed directly.
 */
export function buildOrWebsearchQuery(query: string): string {
  return query
    .toLowerCase()
    .split(/\W+/)
    .filter((t) => t.length > 2)
    .join(' OR ');
}

/**
 * Lexical retrieval: full-text search over knowledge_chunks, workspace
 * filtered, only chunks of enabled + non-archived documents, best rank
 * first. Returns at most `limit` chunks (default 5).
 */
export async function retrieveKnowledge(
  supabase: SupabaseClient,
  workspaceId: string,
  query: string,
  limit = 5,
): Promise<RetrievedChunk[]> {
  if (!query.trim()) return [];
  // Primary path: ts_rank RPC (exact SQL in docs/phase3-rag.md).
  const { data, error } = await supabase.rpc('search_knowledge_chunks', {
    p_workspace_id: workspaceId,
    p_query: query,
    p_limit: limit,
  });
  if (!error && Array.isArray(data)) {
    return (data as Array<{ chunk: string; document_title: string; document_id: string; rank: number }>)
      .slice(0, limit)
      .map((row) => ({
        chunk: row.chunk,
        documentTitle: row.document_title,
        documentId: row.document_id,
        rank: typeof row.rank === 'number' ? row.rank : 0,
      }));
  }
  // Fallback path: PostgREST textSearch with an explicit-OR websearch
  // query (see buildOrWebsearchQuery — a raw natural question would be
  // ANDed by websearch_to_tsquery and retrieve nothing) and the same
  // filters; rank is a client-side term-overlap score. The fallback is
  // unit-tested with a mocked client only — it runs only when the RPC
  // is absent, which is not the live configuration.
  const orQuery = buildOrWebsearchQuery(query);
  if (!orQuery) return [];
  const { data: rows, error: fallbackError } = await supabase
    .from('knowledge_chunks')
    .select('content,document_id,source_title,knowledge_documents!inner(title,enabled,archived)')
    .eq('workspace_id', workspaceId)
    .textSearch('search_vector', orQuery, { type: 'websearch', config: 'english' });
  if (fallbackError || !rows) return [];
  const scored = (rows as Array<{
    content: string;
    document_id: string;
    source_title: string;
    knowledge_documents?: { title: string; enabled: boolean; archived: boolean } | Array<{ title: string; enabled: boolean; archived: boolean }>;
  }>)
    .map((row) => {
      const doc = Array.isArray(row.knowledge_documents) ? row.knowledge_documents[0] : row.knowledge_documents;
      return { row, doc };
    })
    .filter(({ doc }) => doc && doc.enabled && !doc.archived)
    .map(({ row, doc }) => ({
      chunk: row.content,
      documentTitle: doc!.title,
      documentId: row.document_id,
      rank: termOverlapRank(query, row.content),
    }))
    .filter((r) => r.rank > 0)
    .sort((a, b) => b.rank - a.rank);
  return scored.slice(0, limit);
}

// ---------------------------------------------------------------------------
// Indexing
// ---------------------------------------------------------------------------

/**
 * Re-index one document: delete its existing chunks, re-chunk the content,
 * insert the new chunks, and mark the document's index job done (or failed
 * with the error message). Throws on failure after marking the job failed.
 */
export async function reindexDocument(
  supabase: SupabaseClient,
  workspaceId: string,
  document: KnowledgeDocumentRow,
): Promise<void> {
  const markJob = async (status: 'done' | 'failed', error: string | null) => {
    await supabase
      .from('knowledge_index_jobs')
      .update({ status, error })
      .eq('document_id', document.id)
      .eq('workspace_id', workspaceId)
      .in('status', ['pending', 'processing']);
  };
  try {
    const { error: deleteError } = await supabase
      .from('knowledge_chunks')
      .delete()
      .eq('document_id', document.id)
      .eq('workspace_id', workspaceId);
    if (deleteError) throw new Error(deleteError.message);
    const chunks = chunkText(document.content, { sourceTitle: document.title });
    if (chunks.length > 0) {
      const { error: insertError } = await supabase.from('knowledge_chunks').insert(
        chunks.map((c) => ({
          document_id: document.id,
          workspace_id: workspaceId,
          chunk_index: c.index,
          content: c.content,
          source_title: c.sourceTitle,
        })),
      );
      if (insertError) throw new Error(insertError.message);
    }
    await markJob('done', null);
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    await markJob('failed', message);
    throw e;
  }
}
