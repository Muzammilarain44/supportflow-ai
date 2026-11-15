// ============================================================================
// SupportFlow AI — Phase 3: knowledge-base routes (Worker B)
//
// Mounted by the coordinator (app.ts is NOT edited by Worker B) as:
//   app.use('/api/workspaces/:workspaceId/knowledge', ...authed, knowledgeRouter(env))
// Auth + workspace membership are enforced by the coordinator's middleware;
// this router only enforces workspace scoping on every query.
//
// DELETE is an archive (archived=true), not a hard delete — archived docs
// are excluded from retrieval and from the default list, but their chunks
// and history are kept. There is intentionally no hard-delete endpoint.
// ============================================================================

import { Router, type Response } from 'express';
import {
  createKnowledgeDocumentSchema,
  updateKnowledgeDocumentSchema,
} from '@supportflow/shared';
import type { Env } from '../env.js';
import { ApiError } from '../errors.js';
import { getUserSupabase } from '../lib/supabase.js';
import { reindexDocument } from '../lib/rag.js';
import { pageOffset, parseListQuery } from '../lib/pagination.js';
import { validateBody } from '../middleware/validate.js';
import type { AuthedRequest } from '../middleware/auth.js';

export function knowledgeRouter(env: Env) {
  const router = Router({ mergeParams: true });

  // GET / — list workspace docs. ?q= searches title/content, ?kind=,
  // ?enabled=. Archived docs are excluded by default (?archived=true to
  // list them instead).
  router.get('/', async (req: AuthedRequest, res: Response, next) => {
    try {
      const workspaceId = req.params.workspaceId as string;
      const { page, pageSize, search } = parseListQuery(req);
      const kind = typeof req.query.kind === 'string' ? req.query.kind : undefined;
      const enabledParam = typeof req.query.enabled === 'string' ? req.query.enabled : undefined;
      const archivedParam = typeof req.query.archived === 'string' ? req.query.archived : undefined;
      if (kind && kind !== 'article' && kind !== 'faq') {
        throw new ApiError(400, `Invalid kind filter: ${kind}`);
      }
      const supabase = getUserSupabase(env, req.token!);
      let query = supabase
        .from('knowledge_documents')
        .select('*', { count: 'exact' })
        .eq('workspace_id', workspaceId);
      if (archivedParam === 'true') query = query.eq('archived', true);
      else query = query.eq('archived', false);
      if (search) query = query.or(`title.ilike.%${search}%,content.ilike.%${search}%`);
      if (kind) query = query.eq('kind', kind);
      if (enabledParam === 'true') query = query.eq('enabled', true);
      else if (enabledParam === 'false') query = query.eq('enabled', false);
      const offset = pageOffset(page, pageSize);
      const { data, count, error } = await query
        .order('updated_at', { ascending: false })
        .range(offset, offset + pageSize - 1);
      if (error) throw new ApiError(500, 'Failed to list knowledge documents');
      return res.json({ items: data ?? [], total: count ?? 0, page, pageSize });
    } catch (e) {
      return next(e);
    }
  });

  // POST / — create a doc, queue an index job, then chunk + index it.
  router.post('/', validateBody(createKnowledgeDocumentSchema), async (req: AuthedRequest, res: Response, next) => {
    try {
      const workspaceId = req.params.workspaceId as string;
      const supabase = getUserSupabase(env, req.token!);
      const { data, error } = await supabase
        .from('knowledge_documents')
        .insert({
          workspace_id: workspaceId,
          title: req.body.title,
          content: req.body.content,
          kind: req.body.kind,
          enabled: true,
          archived: false,
          created_by: req.user!.id,
        })
        .select()
        .single();
      if (error || !data) throw new ApiError(500, 'Failed to create knowledge document');
      const doc = data as { id: string };
      await supabase.from('knowledge_index_jobs').insert({
        document_id: doc.id,
        workspace_id: workspaceId,
        status: 'pending',
        attempts: 0,
      });
      // Indexing failure marks the job failed (inside reindexDocument) but
      // does not fail the create — the doc exists and can be re-indexed.
      try {
        await reindexDocument(supabase, workspaceId, {
          ...(data as Record<string, unknown>),
          enabled: true,
          archived: false,
        } as Parameters<typeof reindexDocument>[2]);
      } catch {
        // Job row already marked failed; the create itself succeeded.
      }
      return res.status(201).json({ document: data });
    } catch (e) {
      return next(e);
    }
  });

  // GET /:id — one document (never returns another workspace's doc).
  router.get('/:id', async (req: AuthedRequest, res: Response, next) => {
    try {
      const workspaceId = req.params.workspaceId as string;
      const supabase = getUserSupabase(env, req.token!);
      const { data, error } = await supabase
        .from('knowledge_documents')
        .select('*')
        .eq('workspace_id', workspaceId)
        .eq('id', req.params.id)
        .single();
      if (error || !data) throw new ApiError(404, 'Knowledge document not found');
      return res.json({ document: data });
    } catch (e) {
      return next(e);
    }
  });

  // PATCH /:id — title/content/kind/enabled. A content change re-chunks
  // the document and queues a new index job.
  router.patch('/:id', validateBody(updateKnowledgeDocumentSchema), async (req: AuthedRequest, res: Response, next) => {
    try {
      const workspaceId = req.params.workspaceId as string;
      const supabase = getUserSupabase(env, req.token!);
      const patch: Record<string, unknown> = {};
      for (const key of ['title', 'content', 'kind', 'enabled'] as const) {
        if (req.body[key] !== undefined) patch[key] = req.body[key];
      }
      if (Object.keys(patch).length === 0) {
        throw new ApiError(400, 'No fields to update');
      }
      const { data, error } = await supabase
        .from('knowledge_documents')
        .update(patch)
        .eq('workspace_id', workspaceId)
        .eq('id', req.params.id)
        .select()
        .single();
      if (error) {
        if ((error as { code?: string }).code === 'PGRST116') {
          throw new ApiError(404, 'Knowledge document not found');
        }
        throw new ApiError(500, 'Failed to update knowledge document');
      }
      if (!data) throw new ApiError(404, 'Knowledge document not found');
      if (req.body.content !== undefined) {
        await supabase.from('knowledge_index_jobs').insert({
          document_id: req.params.id,
          workspace_id: workspaceId,
          status: 'pending',
          attempts: 0,
        });
        try {
          await reindexDocument(supabase, workspaceId, data as Parameters<typeof reindexDocument>[2]);
        } catch {
          // Job row already marked failed; the update itself succeeded.
        }
      }
      return res.json({ document: data });
    } catch (e) {
      return next(e);
    }
  });

  // DELETE /:id — archive only (archived=true). No hard delete exists.
  router.delete('/:id', async (req: AuthedRequest, res: Response, next) => {
    try {
      const workspaceId = req.params.workspaceId as string;
      const supabase = getUserSupabase(env, req.token!);
      const { data, error } = await supabase
        .from('knowledge_documents')
        .update({ archived: true })
        .eq('workspace_id', workspaceId)
        .eq('id', req.params.id)
        .select()
        .single();
      if (error) {
        if ((error as { code?: string }).code === 'PGRST116') {
          throw new ApiError(404, 'Knowledge document not found');
        }
        throw new ApiError(500, 'Failed to archive knowledge document');
      }
      if (!data) throw new ApiError(404, 'Knowledge document not found');
      return res.json({ document: data });
    } catch (e) {
      return next(e);
    }
  });

  // POST /:id/reindex — queue a new index job and re-chunk the document.
  router.post('/:id/reindex', async (req: AuthedRequest, res: Response, next) => {
    try {
      const workspaceId = req.params.workspaceId as string;
      const supabase = getUserSupabase(env, req.token!);
      const { data, error } = await supabase
        .from('knowledge_documents')
        .select('*')
        .eq('workspace_id', workspaceId)
        .eq('id', req.params.id)
        .single();
      if (error || !data) throw new ApiError(404, 'Knowledge document not found');
      const { data: job } = await supabase
        .from('knowledge_index_jobs')
        .insert({
          document_id: req.params.id,
          workspace_id: workspaceId,
          status: 'pending',
          attempts: 0,
        })
        .select()
        .single();
      try {
        await reindexDocument(supabase, workspaceId, data as Parameters<typeof reindexDocument>[2]);
      } catch {
        // Job row already marked failed.
      }
      return res.json({ job: job ?? null, document: data });
    } catch (e) {
      return next(e);
    }
  });

  return router;
}
