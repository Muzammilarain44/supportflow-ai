import { Router, type Response } from 'express';
import { createCustomerSchema, updateCustomerSchema } from '@supportflow/shared';
import type { Env } from '../env.js';
import { ApiError } from '../errors.js';
import { getUserSupabase } from '../lib/supabase.js';
import { pageOffset, parseListQuery } from '../lib/pagination.js';
import { validateBody } from '../middleware/validate.js';
import type { AuthedRequest } from '../middleware/auth.js';

export function customersRouter(env: Env) {
  const router = Router({ mergeParams: true });

  // GET / — list with server-side pagination, search (name/email), tag filter.
  router.get('/', async (req: AuthedRequest, res: Response, next) => {
    try {
      const workspaceId = req.params.workspaceId as string;
      const { page, pageSize, search } = parseListQuery(req);
      const tagFilter =
        typeof req.query.tag === 'string' && req.query.tag.length > 0
          ? req.query.tag
          : undefined;
      const supabase = getUserSupabase(env, req.token!);
      let query = supabase
        .from('customers')
        .select('*', { count: 'exact' })
        .eq('workspace_id', workspaceId);
      if (search) {
        query = query.or(`full_name.ilike.%${search}%,email.ilike.%${search}%`);
      }
      if (tagFilter) {
        query = query.contains('tags', [tagFilter]);
      }
      const offset = pageOffset(page, pageSize);
      const { data, count, error } = await query
        .order('created_at', { ascending: false })
        .range(offset, offset + pageSize - 1);
      if (error) throw new ApiError(500, 'Failed to list customers');
      return res.json({ customers: data ?? [], total: count ?? 0, page, pageSize });
    } catch (e) {
      return next(e);
    }
  });

  // POST / — create. Duplicate email in this workspace (Postgres 23505) -> 409.
  router.post('/', validateBody(createCustomerSchema), async (req: AuthedRequest, res: Response, next) => {
    try {
      const workspaceId = req.params.workspaceId as string;
      const supabase = getUserSupabase(env, req.token!);
      const { data, error } = await supabase
        .from('customers')
        .insert({
          workspace_id: workspaceId,
          full_name: req.body.full_name,
          email: req.body.email,
          phone: req.body.phone ?? null,
          tags: req.body.tags ?? [],
          notes: req.body.notes ?? null,
        })
        .select()
        .single();
      if (error) {
        if ((error as { code?: string }).code === '23505') {
          throw new ApiError(409, 'A customer with this email already exists in this workspace');
        }
        throw new ApiError(500, 'Failed to create customer');
      }
      return res.status(201).json({ customer: data });
    } catch (e) {
      return next(e);
    }
  });

  // GET /:customerId — customer + linked tickets + recent conversations summary.
  router.get('/:customerId', async (req: AuthedRequest, res: Response, next) => {
    try {
      const workspaceId = req.params.workspaceId as string;
      const supabase = getUserSupabase(env, req.token!);
      const { data: customer, error } = await supabase
        .from('customers')
        .select('*')
        .eq('workspace_id', workspaceId)
        .eq('id', req.params.customerId)
        .single();
      if (error || !customer) throw new ApiError(404, 'Customer not found');
      const { count: ticketCount } = await supabase
        .from('tickets')
        .select('id', { count: 'exact', head: true })
        .eq('workspace_id', workspaceId)
        .eq('customer_id', req.params.customerId);
      const { count: conversationCount } = await supabase
        .from('conversations')
        .select('id', { count: 'exact', head: true })
        .eq('workspace_id', workspaceId)
        .eq('customer_id', req.params.customerId);
      const { data: recentConversations } = await supabase
        .from('conversations')
        .select('id,status,priority,last_message_at,created_at')
        .eq('workspace_id', workspaceId)
        .eq('customer_id', req.params.customerId)
        .order('created_at', { ascending: false })
        .limit(5);
      return res.json({
        customer,
        tickets: { total: ticketCount ?? 0 },
        conversations: { total: conversationCount ?? 0 },
        recent_conversations: recentConversations ?? [],
      });
    } catch (e) {
      return next(e);
    }
  });

  // PATCH /:customerId — update name/phone/tags/notes. Does NOT bump last_activity_at.
  router.patch(
    '/:customerId',
    validateBody(updateCustomerSchema),
    async (req: AuthedRequest, res: Response, next) => {
      try {
        const workspaceId = req.params.workspaceId as string;
        const supabase = getUserSupabase(env, req.token!);
        const patch: Record<string, unknown> = {};
        for (const key of ['full_name', 'email', 'phone', 'tags', 'notes'] as const) {
          if (req.body[key] !== undefined) patch[key] = req.body[key];
        }
        if (Object.keys(patch).length === 0) {
          throw new ApiError(400, 'No fields to update');
        }
        const { data, error } = await supabase
          .from('customers')
          .update(patch)
          .eq('workspace_id', workspaceId)
          .eq('id', req.params.customerId)
          .select()
          .single();
        if (error) {
          if ((error as { code?: string }).code === '23505') {
            throw new ApiError(409, 'A customer with this email already exists in this workspace');
          }
          if ((error as { code?: string }).code === 'PGRST116') {
            throw new ApiError(404, 'Customer not found');
          }
          throw new ApiError(500, 'Failed to update customer');
        }
        if (!data) throw new ApiError(404, 'Customer not found');
        return res.json({ customer: data });
      } catch (e) {
        return next(e);
      }
    },
  );

  return router;
}
