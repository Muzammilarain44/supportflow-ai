import { Router, type Response } from 'express';
import {
  addConversationNoteSchema,
  conversationStatusEnum,
  createConversationSchema,
  priorityEnum,
  sendMessageSchema,
  updateConversationSchema,
} from '@supportflow/shared';
import type { Env } from '../env.js';
import { ApiError } from '../errors.js';
import { getUserSupabase } from '../lib/supabase.js';
import { recordOutbox } from '../lib/outbox.js';
import { pageOffset, parseListQuery } from '../lib/pagination.js';
import { getWorkspaceMember, isWorkspaceMember } from '../lib/workspaceMembers.js';
import { validateBody } from '../middleware/validate.js';
import type { AuthedRequest } from '../middleware/auth.js';

const CONVERSATION_STATUSES = conversationStatusEnum.options;
const PRIORITIES = priorityEnum.options;

export function conversationsRouter(env: Env) {
  const router = Router({ mergeParams: true });

  // GET / — list with search (customer name/email), status/priority/assignedTo filters.
  // Each row includes customer {id, full_name, email}, last message preview
  // (truncated to 200 chars) + last_message_at, and unread_count.
  router.get('/', async (req: AuthedRequest, res: Response, next) => {
    try {
      const workspaceId = req.params.workspaceId as string;
      const { page, pageSize, search, status, priority, assignedTo } = parseListQuery(req);
      if (status && !CONVERSATION_STATUSES.includes(status as (typeof CONVERSATION_STATUSES)[number])) {
        throw new ApiError(400, `Invalid status filter: ${status}`);
      }
      if (priority && !PRIORITIES.includes(priority as (typeof PRIORITIES)[number])) {
        throw new ApiError(400, `Invalid priority filter: ${priority}`);
      }
      const supabase = getUserSupabase(env, req.token!);

      // Search runs against customers first (name/email), then filters by customer id.
      let customerIds: string[] | null = null;
      if (search) {
        const { data: matched, error: searchError } = await supabase
          .from('customers')
          .select('id')
          .eq('workspace_id', workspaceId)
          .or(`full_name.ilike.%${search}%,email.ilike.%${search}%`);
        if (searchError) throw new ApiError(500, 'Failed to list conversations');
        customerIds = (matched ?? []).map((c: { id: string }) => c.id);
        if (customerIds.length === 0) {
          return res.json({ conversations: [], total: 0, page, pageSize });
        }
      }

      let query = supabase
        .from('conversations')
        .select('*', { count: 'exact' })
        .eq('workspace_id', workspaceId);
      if (customerIds) query = query.in('customer_id', customerIds);
      if (status) query = query.eq('status', status);
      if (priority) query = query.eq('priority', priority);
      if (assignedTo === 'unassigned') query = query.is('assigned_to', null);
      else if (assignedTo) query = query.eq('assigned_to', assignedTo);
      const offset = pageOffset(page, pageSize);
      const { data, count, error } = await query
        .order('last_message_at', { ascending: false, nullsFirst: false })
        .order('created_at', { ascending: false })
        .range(offset, offset + pageSize - 1);
      if (error) throw new ApiError(500, 'Failed to list conversations');
      const conversations = (data ?? []) as Array<Record<string, unknown>>;

      // Enrich the page: customers, last message preview, unread counts.
      const convIds = conversations.map((c) => c.id as string);
      const custIds = [...new Set(conversations.map((c) => c.customer_id as string))];
      const customerById = new Map<string, { id: string; full_name: string; email: string }>();
      if (custIds.length > 0) {
        const { data: customers } = await supabase
          .from('customers')
          .select('id,full_name,email')
          .eq('workspace_id', workspaceId)
          .in('id', custIds);
        for (const c of (customers ?? []) as Array<{ id: string; full_name: string; email: string }>) {
          customerById.set(c.id, c);
        }
      }
      const lastMessageByConv = new Map<string, { body: string; created_at: string }>();
      const unreadByConv = new Map<string, number>();
      if (convIds.length > 0) {
        const { data: recent } = await supabase
          .from('messages')
          .select('conversation_id,body,created_at')
          .eq('workspace_id', workspaceId)
          .in('conversation_id', convIds)
          .order('created_at', { ascending: false })
          .limit(500);
        for (const m of (recent ?? []) as Array<{ conversation_id: string; body: string; created_at: string }>) {
          if (!lastMessageByConv.has(m.conversation_id)) {
            lastMessageByConv.set(m.conversation_id, {
              body: m.body.length > 200 ? `${m.body.slice(0, 200)}…` : m.body,
              created_at: m.created_at,
            });
          }
        }
        const { data: unread } = await supabase
          .from('messages')
          .select('conversation_id')
          .eq('workspace_id', workspaceId)
          .in('conversation_id', convIds)
          .eq('sender_type', 'customer')
          .is('read_at', null);
        for (const m of (unread ?? []) as Array<{ conversation_id: string }>) {
          unreadByConv.set(m.conversation_id, (unreadByConv.get(m.conversation_id) ?? 0) + 1);
        }
      }
      const enriched = conversations.map((c) => ({
        ...c,
        customer: customerById.get(c.customer_id as string) ?? null,
        last_message: lastMessageByConv.get(c.id as string) ?? null,
        unread_count: unreadByConv.get(c.id as string) ?? 0,
      }));
      return res.json({ conversations: enriched, total: count ?? 0, page, pageSize });
    } catch (e) {
      return next(e);
    }
  });

  // POST / — create a conversation for a customer in this workspace.
  router.post('/', validateBody(createConversationSchema), async (req: AuthedRequest, res: Response, next) => {
    try {
      const workspaceId = req.params.workspaceId as string;
      const supabase = getUserSupabase(env, req.token!);
      const { data: customer, error: customerError } = await supabase
        .from('customers')
        .select('id')
        .eq('workspace_id', workspaceId)
        .eq('id', req.body.customer_id)
        .maybeSingle();
      if (customerError || !customer) {
        throw new ApiError(400, 'Related record belongs to a different workspace');
      }
      const { data, error } = await supabase
        .from('conversations')
        .insert({
          workspace_id: workspaceId,
          customer_id: req.body.customer_id,
          priority: req.body.priority ?? 'medium',
          tags: req.body.tags ?? [],
        })
        .select()
        .single();
      if (error || !data) throw new ApiError(500, 'Failed to create conversation');
      await recordOutbox(supabase, workspaceId, 'conversation.created', 'conversation', (data as { id: string }).id, {
        workspace_id: workspaceId,
        conversation_id: (data as { id: string }).id,
        customer_id: req.body.customer_id,
      });
      return res.status(201).json({ conversation: data });
    } catch (e) {
      return next(e);
    }
  });

  // GET /:conversationId — conversation + customer + assigned member info.
  router.get('/:conversationId', async (req: AuthedRequest, res: Response, next) => {
    try {
      const workspaceId = req.params.workspaceId as string;
      const supabase = getUserSupabase(env, req.token!);
      const { data: conversation, error } = await supabase
        .from('conversations')
        .select('*')
        .eq('workspace_id', workspaceId)
        .eq('id', req.params.conversationId)
        .single();
      if (error || !conversation) throw new ApiError(404, 'Conversation not found');
      const conv = conversation as { customer_id: string; assigned_to: string | null };
      const { data: customer } = await supabase
        .from('customers')
        .select('id,full_name,email,phone,tags')
        .eq('workspace_id', workspaceId)
        .eq('id', conv.customer_id)
        .maybeSingle();
      const assignedMember = conv.assigned_to
        ? await getWorkspaceMember(supabase, workspaceId, conv.assigned_to)
        : null;
      return res.json({ conversation, customer: customer ?? null, assigned_member: assignedMember });
    } catch (e) {
      return next(e);
    }
  });

  // GET /:conversationId/messages — paginated, chronological ASC (oldest first).
  router.get('/:conversationId/messages', async (req: AuthedRequest, res: Response, next) => {
    try {
      const workspaceId = req.params.workspaceId as string;
      const { page, pageSize } = parseListQuery(req);
      const supabase = getUserSupabase(env, req.token!);
      const { data: conversation, error: convError } = await supabase
        .from('conversations')
        .select('id')
        .eq('workspace_id', workspaceId)
        .eq('id', req.params.conversationId)
        .maybeSingle();
      if (convError || !conversation) throw new ApiError(404, 'Conversation not found');
      const offset = pageOffset(page, pageSize);
      const { data, count, error } = await supabase
        .from('messages')
        .select('*', { count: 'exact' })
        .eq('workspace_id', workspaceId)
        .eq('conversation_id', req.params.conversationId)
        .order('created_at', { ascending: true })
        .range(offset, offset + pageSize - 1);
      if (error) throw new ApiError(500, 'Failed to list messages');
      return res.json({ messages: data ?? [], total: count ?? 0, page, pageSize });
    } catch (e) {
      return next(e);
    }
  });

  // POST /:conversationId/messages — agent reply. Idempotent on client_message_id.
  router.post(
    '/:conversationId/messages',
    validateBody(sendMessageSchema),
    async (req: AuthedRequest, res: Response, next) => {
      try {
        const workspaceId = req.params.workspaceId as string;
        const supabase = getUserSupabase(env, req.token!);
        const { data: conversation, error: convError } = await supabase
          .from('conversations')
          .select('*')
          .eq('workspace_id', workspaceId)
          .eq('id', req.params.conversationId)
          .single();
        if (convError || !conversation) throw new ApiError(404, 'Conversation not found');
        const conv = conversation as { id: string; customer_id: string };

        // Idempotency: same client key in this conversation returns the existing message.
        if (req.body.client_message_id) {
          const { data: existing } = await supabase
            .from('messages')
            .select('*')
            .eq('workspace_id', workspaceId)
            .eq('conversation_id', conv.id)
            .eq('client_message_id', req.body.client_message_id)
            .maybeSingle();
          if (existing) return res.status(200).json({ message: existing });
        }

        const { data, error } = await supabase
          .from('messages')
          .insert({
            workspace_id: workspaceId,
            conversation_id: conv.id,
            customer_id: conv.customer_id,
            sender_type: 'agent',
            sender_id: req.user!.id,
            body: req.body.body,
            client_message_id: req.body.client_message_id ?? null,
          })
          .select()
          .single();
        if (error) {
          // Unique-index race on (conversation_id, client_message_id): return the existing row.
          if ((error as { code?: string }).code === '23505' && req.body.client_message_id) {
            const { data: existing } = await supabase
              .from('messages')
              .select('*')
              .eq('conversation_id', conv.id)
              .eq('client_message_id', req.body.client_message_id)
              .maybeSingle();
            if (existing) return res.status(200).json({ message: existing });
          }
          throw new ApiError(500, 'Failed to send message');
        }
        // Bump last_message_at. Status is left unchanged (a closed
        // conversation stays closed); no outbox event for agent replies.
        await supabase
          .from('conversations')
          .update({ last_message_at: new Date().toISOString() })
          .eq('workspace_id', workspaceId)
          .eq('id', conv.id);
        return res.status(201).json({ message: data });
      } catch (e) {
        return next(e);
      }
    },
  );

  // PATCH /:conversationId — status/priority/assigned_to/tags.
  router.patch(
    '/:conversationId',
    validateBody(updateConversationSchema),
    async (req: AuthedRequest, res: Response, next) => {
      try {
        const workspaceId = req.params.workspaceId as string;
        const supabase = getUserSupabase(env, req.token!);
        if (req.body.assigned_to) {
          const member = await isWorkspaceMember(supabase, workspaceId, req.body.assigned_to);
          if (!member) throw new ApiError(400, 'Assignee must be a member of this workspace');
        }
        const patch: Record<string, unknown> = {};
        for (const key of ['status', 'priority', 'assigned_to', 'tags'] as const) {
          if (req.body[key] !== undefined) patch[key] = req.body[key];
        }
        if (Object.keys(patch).length === 0) {
          throw new ApiError(400, 'No fields to update');
        }
        const { data, error } = await supabase
          .from('conversations')
          .update(patch)
          .eq('workspace_id', workspaceId)
          .eq('id', req.params.conversationId)
          .select()
          .single();
        if (error) {
          if ((error as { code?: string }).code === 'PGRST116') {
            throw new ApiError(404, 'Conversation not found');
          }
          throw new ApiError(500, 'Failed to update conversation');
        }
        if (!data) throw new ApiError(404, 'Conversation not found');
        return res.json({ conversation: data });
      } catch (e) {
        return next(e);
      }
    },
  );

  // POST /:conversationId/read — mark all customer messages read.
  router.post('/:conversationId/read', async (req: AuthedRequest, res: Response, next) => {
    try {
      const workspaceId = req.params.workspaceId as string;
      const supabase = getUserSupabase(env, req.token!);
      const { data: conversation, error: convError } = await supabase
        .from('conversations')
        .select('id')
        .eq('workspace_id', workspaceId)
        .eq('id', req.params.conversationId)
        .maybeSingle();
      if (convError || !conversation) throw new ApiError(404, 'Conversation not found');
      const { data, error } = await supabase
        .from('messages')
        .update({ read_at: new Date().toISOString() })
        .eq('workspace_id', workspaceId)
        .eq('conversation_id', req.params.conversationId)
        .eq('sender_type', 'customer')
        .is('read_at', null)
        .select('id');
      if (error) throw new ApiError(500, 'Failed to mark messages as read');
      return res.json({ read_count: (data ?? []).length });
    } catch (e) {
      return next(e);
    }
  });

  // POST /:conversationId/notes — internal note (never shown to customers).
  router.post(
    '/:conversationId/notes',
    validateBody(addConversationNoteSchema),
    async (req: AuthedRequest, res: Response, next) => {
      try {
        const workspaceId = req.params.workspaceId as string;
        const supabase = getUserSupabase(env, req.token!);
        const { data: conversation, error: convError } = await supabase
          .from('conversations')
          .select('id')
          .eq('workspace_id', workspaceId)
          .eq('id', req.params.conversationId)
          .maybeSingle();
        if (convError || !conversation) throw new ApiError(404, 'Conversation not found');
        const { data, error } = await supabase
          .from('conversation_notes')
          .insert({
            workspace_id: workspaceId,
            conversation_id: req.params.conversationId,
            author_id: req.user!.id,
            body: req.body.body,
          })
          .select()
          .single();
        if (error || !data) throw new ApiError(500, 'Failed to add note');
        return res.status(201).json({ note: data });
      } catch (e) {
        return next(e);
      }
    },
  );

  // GET /:conversationId/notes — chronological (oldest first).
  router.get('/:conversationId/notes', async (req: AuthedRequest, res: Response, next) => {
    try {
      const workspaceId = req.params.workspaceId as string;
      const { page, pageSize } = parseListQuery(req);
      const supabase = getUserSupabase(env, req.token!);
      const { data: conversation, error: convError } = await supabase
        .from('conversations')
        .select('id')
        .eq('workspace_id', workspaceId)
        .eq('id', req.params.conversationId)
        .maybeSingle();
      if (convError || !conversation) throw new ApiError(404, 'Conversation not found');
      const offset = pageOffset(page, pageSize);
      const { data, count, error } = await supabase
        .from('conversation_notes')
        .select('*', { count: 'exact' })
        .eq('workspace_id', workspaceId)
        .eq('conversation_id', req.params.conversationId)
        .order('created_at', { ascending: true })
        .range(offset, offset + pageSize - 1);
      if (error) throw new ApiError(500, 'Failed to list notes');
      return res.json({ notes: data ?? [], total: count ?? 0, page, pageSize });
    } catch (e) {
      return next(e);
    }
  });

  return router;
}
