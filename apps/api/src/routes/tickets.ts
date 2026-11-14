import { Router, type Response } from 'express';
import {
  addTicketNoteSchema,
  createTicketSchema,
  priorityEnum,
  ticketCategoryEnum,
  ticketStatusEnum,
  updateTicketSchema,
} from '@supportflow/shared';
import type { Env } from '../env.js';
import { ApiError } from '../errors.js';
import { getUserSupabase } from '../lib/supabase.js';
import { recordOutbox } from '../lib/outbox.js';
import { pageOffset, parseListQuery } from '../lib/pagination.js';
import { getWorkspaceMember, isWorkspaceMember } from '../lib/workspaceMembers.js';
import { validateBody } from '../middleware/validate.js';
import type { AuthedRequest } from '../middleware/auth.js';

const TICKET_STATUSES = ticketStatusEnum.options;
const TICKET_CATEGORIES = ticketCategoryEnum.options;
const PRIORITIES = priorityEnum.options;
const TERMINAL_STATUSES = new Set(['resolved', 'closed']);
const OPEN_STATUSES = new Set(['open', 'in_progress', 'waiting_for_customer']);

async function insertTicketEvent(
  supabase: ReturnType<typeof getUserSupabase>,
  workspaceId: string,
  ticketId: string,
  actorId: string,
  event: {
    event_type: string;
    field_name?: string | null;
    old_value?: string | null;
    new_value?: string | null;
    note?: string | null;
  },
): Promise<void> {
  await supabase.from('ticket_events').insert({
    workspace_id: workspaceId,
    ticket_id: ticketId,
    actor_id: actorId,
    event_type: event.event_type,
    field_name: event.field_name ?? null,
    old_value: event.old_value ?? null,
    new_value: event.new_value ?? null,
    note: event.note ?? null,
  });
}

export function ticketsRouter(env: Env) {
  const router = Router({ mergeParams: true });

  // GET / — list, server-side pagination, filters, sort.
  router.get('/', async (req: AuthedRequest, res: Response, next) => {
    try {
      const workspaceId = req.params.workspaceId as string;
      const { page, pageSize, search, status, priority, assignedTo, sort } = parseListQuery(req);
      const category =
        typeof req.query.category === 'string' && req.query.category.length > 0
          ? req.query.category
          : undefined;
      if (status && !TICKET_STATUSES.includes(status as (typeof TICKET_STATUSES)[number])) {
        throw new ApiError(400, `Invalid status filter: ${status}`);
      }
      if (priority && !PRIORITIES.includes(priority as (typeof PRIORITIES)[number])) {
        throw new ApiError(400, `Invalid priority filter: ${priority}`);
      }
      if (category && !TICKET_CATEGORIES.includes(category as (typeof TICKET_CATEGORIES)[number])) {
        throw new ApiError(400, `Invalid category filter: ${category}`);
      }
      if (sort && !['created_at', 'priority', 'status'].includes(sort)) {
        throw new ApiError(400, `Invalid sort: ${sort}`);
      }
      const supabase = getUserSupabase(env, req.token!);
      let query = supabase
        .from('tickets')
        .select('*', { count: 'exact' })
        .eq('workspace_id', workspaceId);
      if (status) query = query.eq('status', status);
      if (priority) query = query.eq('priority', priority);
      if (category) query = query.eq('category', category);
      if (assignedTo === 'unassigned') query = query.is('assigned_to', null);
      else if (assignedTo) query = query.eq('assigned_to', assignedTo);
      if (search) query = query.ilike('subject', `%${search}%`);
      const offset = pageOffset(page, pageSize);
      if (sort === 'priority') {
        query = query.order('priority', { ascending: true }).order('created_at', { ascending: false });
      } else if (sort === 'status') {
        query = query.order('status', { ascending: true }).order('created_at', { ascending: false });
      } else {
        query = query.order('created_at', { ascending: false });
      }
      const { data, count, error } = await query.range(offset, offset + pageSize - 1);
      if (error) throw new ApiError(500, 'Failed to list tickets');
      return res.json({ tickets: data ?? [], total: count ?? 0, page, pageSize });
    } catch (e) {
      return next(e);
    }
  });

  // GET /stats — counts by status and by priority (real DB queries, grouped here).
  // Declared BEFORE /:ticketId so 'stats' is never treated as an id.
  router.get('/stats', async (req: AuthedRequest, res: Response, next) => {
    try {
      const workspaceId = req.params.workspaceId as string;
      const supabase = getUserSupabase(env, req.token!);
      const { data, error } = await supabase
        .from('tickets')
        .select('status,priority')
        .eq('workspace_id', workspaceId);
      if (error) throw new ApiError(500, 'Failed to load ticket stats');
      const byStatus: Record<string, number> = Object.fromEntries(
        TICKET_STATUSES.map((s) => [s, 0]),
      );
      const byPriority: Record<string, number> = Object.fromEntries(
        PRIORITIES.map((p) => [p, 0]),
      );
      for (const t of (data ?? []) as Array<{ status: string; priority: string }>) {
        if (t.status in byStatus) byStatus[t.status] += 1;
        if (t.priority in byPriority) byPriority[t.priority] += 1;
      }
      return res.json({
        by_status: byStatus,
        by_priority: byPriority,
        total: (data ?? []).length,
      });
    } catch (e) {
      return next(e);
    }
  });

  // POST / — create + 'created' ticket event + ticket.created outbox event.
  router.post('/', validateBody(createTicketSchema), async (req: AuthedRequest, res: Response, next) => {
    try {
      const workspaceId = req.params.workspaceId as string;
      const supabase = getUserSupabase(env, req.token!);
      if (req.body.customer_id) {
        const { data: customer } = await supabase
          .from('customers')
          .select('id')
          .eq('workspace_id', workspaceId)
          .eq('id', req.body.customer_id)
          .maybeSingle();
        if (!customer) {
          throw new ApiError(400, 'Related record belongs to a different workspace');
        }
      }
      if (req.body.conversation_id) {
        const { data: conversation } = await supabase
          .from('conversations')
          .select('id')
          .eq('workspace_id', workspaceId)
          .eq('id', req.body.conversation_id)
          .maybeSingle();
        if (!conversation) {
          throw new ApiError(400, 'Related record belongs to a different workspace');
        }
      }
      const { data, error } = await supabase
        .from('tickets')
        .insert({
          workspace_id: workspaceId,
          customer_id: req.body.customer_id ?? null,
          conversation_id: req.body.conversation_id ?? null,
          subject: req.body.subject,
          description: req.body.description ?? null,
          category: req.body.category ?? 'general',
          priority: req.body.priority ?? 'medium',
          status: 'open',
          created_by: req.user!.id,
        })
        .select()
        .single();
      if (error || !data) throw new ApiError(500, 'Failed to create ticket');
      const ticket = data as { id: string; priority: string };
      await insertTicketEvent(supabase, workspaceId, ticket.id, req.user!.id, {
        event_type: 'created',
      });
      await recordOutbox(supabase, workspaceId, 'ticket.created', 'ticket', ticket.id, {
        workspace_id: workspaceId,
        ticket_id: ticket.id,
        status: 'open',
        priority: ticket.priority,
      });
      return res.status(201).json({ ticket: data });
    } catch (e) {
      return next(e);
    }
  });

  // GET /:ticketId — ticket + customer + conversation summary + assigned member.
  router.get('/:ticketId', async (req: AuthedRequest, res: Response, next) => {
    try {
      const workspaceId = req.params.workspaceId as string;
      const supabase = getUserSupabase(env, req.token!);
      const { data: ticket, error } = await supabase
        .from('tickets')
        .select('*')
        .eq('workspace_id', workspaceId)
        .eq('id', req.params.ticketId)
        .single();
      if (error || !ticket) throw new ApiError(404, 'Ticket not found');
      const t = ticket as { customer_id: string | null; conversation_id: string | null; assigned_to: string | null };
      const { data: customer } = t.customer_id
        ? await supabase
            .from('customers')
            .select('id,full_name,email')
            .eq('workspace_id', workspaceId)
            .eq('id', t.customer_id)
            .maybeSingle()
        : { data: null };
      const { data: conversation } = t.conversation_id
        ? await supabase
            .from('conversations')
            .select('id,status,priority,customer_id')
            .eq('workspace_id', workspaceId)
            .eq('id', t.conversation_id)
            .maybeSingle()
        : { data: null };
      const assignedMember = t.assigned_to
        ? await getWorkspaceMember(supabase, workspaceId, t.assigned_to)
        : null;
      return res.json({
        ticket,
        customer: customer ?? null,
        conversation: conversation ?? null,
        assigned_member: assignedMember,
      });
    } catch (e) {
      return next(e);
    }
  });

  // PATCH /:ticketId — partial update, audit events, resolved_at handling, outbox.
  router.patch(
    '/:ticketId',
    validateBody(updateTicketSchema),
    async (req: AuthedRequest, res: Response, next) => {
      try {
        const workspaceId = req.params.workspaceId as string;
        const supabase = getUserSupabase(env, req.token!);
        const { data: existing, error: fetchError } = await supabase
          .from('tickets')
          .select('*')
          .eq('workspace_id', workspaceId)
          .eq('id', req.params.ticketId)
          .single();
        if (fetchError || !existing) throw new ApiError(404, 'Ticket not found');
        const old = existing as {
          id: string;
          status: string;
          priority: string;
          assigned_to: string | null;
        };

        if (req.body.assigned_to) {
          const member = await isWorkspaceMember(supabase, workspaceId, req.body.assigned_to);
          if (!member) throw new ApiError(400, 'Assignee must be a member of this workspace');
        }

        const patch: Record<string, unknown> = {};
        for (const key of ['subject', 'description', 'category', 'priority', 'status', 'assigned_to'] as const) {
          if (req.body[key] !== undefined) patch[key] = req.body[key];
        }
        if (Object.keys(patch).length === 0) {
          throw new ApiError(400, 'No fields to update');
        }
        // resolved_at: set when entering resolved/closed, cleared when reopened.
        if (patch.status !== undefined) {
          if (TERMINAL_STATUSES.has(patch.status as string) && !TERMINAL_STATUSES.has(old.status)) {
            patch.resolved_at = new Date().toISOString();
          } else if (OPEN_STATUSES.has(patch.status as string) && TERMINAL_STATUSES.has(old.status)) {
            patch.resolved_at = null;
          }
        }

        const { data, error } = await supabase
          .from('tickets')
          .update(patch)
          .eq('workspace_id', workspaceId)
          .eq('id', req.params.ticketId)
          .select()
          .single();
        if (error || !data) throw new ApiError(500, 'Failed to update ticket');
        const updated = data as { id: string; status: string; priority: string; assigned_to: string | null };

        // Audit trail: one event per detected change.
        const actorId = req.user!.id;
        if (patch.status !== undefined && patch.status !== old.status) {
          await insertTicketEvent(supabase, workspaceId, old.id, actorId, {
            event_type: 'status_changed',
            field_name: 'status',
            old_value: old.status,
            new_value: patch.status as string,
          });
          if (TERMINAL_STATUSES.has(patch.status as string) && !TERMINAL_STATUSES.has(old.status)) {
            await insertTicketEvent(supabase, workspaceId, old.id, actorId, {
              event_type: 'resolved',
              field_name: 'status',
              old_value: old.status,
              new_value: patch.status as string,
            });
          } else if (OPEN_STATUSES.has(patch.status as string) && TERMINAL_STATUSES.has(old.status)) {
            await insertTicketEvent(supabase, workspaceId, old.id, actorId, {
              event_type: 'reopened',
              field_name: 'status',
              old_value: old.status,
              new_value: patch.status as string,
            });
          }
        }
        if (patch.priority !== undefined && patch.priority !== old.priority) {
          await insertTicketEvent(supabase, workspaceId, old.id, actorId, {
            event_type: 'priority_changed',
            field_name: 'priority',
            old_value: old.priority,
            new_value: patch.priority as string,
          });
        }
        if (patch.assigned_to !== undefined && patch.assigned_to !== old.assigned_to) {
          if (patch.assigned_to === null) {
            await insertTicketEvent(supabase, workspaceId, old.id, actorId, {
              event_type: 'unassigned',
              field_name: 'assigned_to',
              old_value: old.assigned_to,
              new_value: null,
            });
          } else {
            await insertTicketEvent(supabase, workspaceId, old.id, actorId, {
              event_type: 'assigned',
              field_name: 'assigned_to',
              old_value: old.assigned_to,
              new_value: patch.assigned_to as string,
            });
          }
        }
        for (const key of ['subject', 'description', 'category'] as const) {
          if (patch[key] !== undefined) {
            await insertTicketEvent(supabase, workspaceId, old.id, actorId, {
              event_type: 'updated',
              field_name: key,
            });
          }
        }

        // Outbox (ids/status only, never bodies or emails). Failures never fail the update.
        if (patch.priority !== undefined && patch.priority !== old.priority) {
          await recordOutbox(supabase, workspaceId, 'ticket.priority.changed', 'ticket', old.id, {
            workspace_id: workspaceId,
            ticket_id: old.id,
            priority: updated.priority,
          });
        }
        if (patch.assigned_to !== undefined && patch.assigned_to !== old.assigned_to && patch.assigned_to !== null) {
          await recordOutbox(supabase, workspaceId, 'ticket.assigned', 'ticket', old.id, {
            workspace_id: workspaceId,
            ticket_id: old.id,
            assigned_to: updated.assigned_to,
          });
        }
        if (
          patch.status !== undefined &&
          TERMINAL_STATUSES.has(patch.status as string) &&
          !TERMINAL_STATUSES.has(old.status)
        ) {
          await recordOutbox(supabase, workspaceId, 'ticket.resolved', 'ticket', old.id, {
            workspace_id: workspaceId,
            ticket_id: old.id,
            status: updated.status,
          });
        }

        return res.json({ ticket: data });
      } catch (e) {
        return next(e);
      }
    },
  );

  // GET /:ticketId/events — audit trail, chronological.
  router.get('/:ticketId/events', async (req: AuthedRequest, res: Response, next) => {
    try {
      const workspaceId = req.params.workspaceId as string;
      const { page, pageSize } = parseListQuery(req);
      const supabase = getUserSupabase(env, req.token!);
      const { data: ticket, error: ticketError } = await supabase
        .from('tickets')
        .select('id')
        .eq('workspace_id', workspaceId)
        .eq('id', req.params.ticketId)
        .maybeSingle();
      if (ticketError || !ticket) throw new ApiError(404, 'Ticket not found');
      const offset = pageOffset(page, pageSize);
      const { data, count, error } = await supabase
        .from('ticket_events')
        .select('*', { count: 'exact' })
        .eq('workspace_id', workspaceId)
        .eq('ticket_id', req.params.ticketId)
        .order('created_at', { ascending: true })
        .range(offset, offset + pageSize - 1);
      if (error) throw new ApiError(500, 'Failed to list ticket events');
      return res.json({ events: data ?? [], total: count ?? 0, page, pageSize });
    } catch (e) {
      return next(e);
    }
  });

  // POST /:ticketId/notes — internal note stored as a ticket_events row.
  router.post(
    '/:ticketId/notes',
    validateBody(addTicketNoteSchema),
    async (req: AuthedRequest, res: Response, next) => {
      try {
        const workspaceId = req.params.workspaceId as string;
        const supabase = getUserSupabase(env, req.token!);
        const { data: ticket, error: ticketError } = await supabase
          .from('tickets')
          .select('id')
          .eq('workspace_id', workspaceId)
          .eq('id', req.params.ticketId)
          .maybeSingle();
        if (ticketError || !ticket) throw new ApiError(404, 'Ticket not found');
        const { data, error } = await supabase
          .from('ticket_events')
          .insert({
            workspace_id: workspaceId,
            ticket_id: req.params.ticketId,
            actor_id: req.user!.id,
            event_type: 'note_added',
            note: req.body.body,
          })
          .select()
          .single();
        if (error || !data) throw new ApiError(500, 'Failed to add note');
        return res.status(201).json({ event: data });
      } catch (e) {
        return next(e);
      }
    },
  );

  return router;
}
