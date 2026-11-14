import { Router, type Response } from 'express';
import { z } from 'zod';
import { widgetMessageSchema, widgetSessionSchema } from '@supportflow/shared';
import type { Env } from '../env.js';
import { ApiError } from '../errors.js';
import { getSupabase } from '../lib/supabase.js';
import { rateLimit } from '../middleware/rateLimit.js';
import { validateBody } from '../middleware/validate.js';
import type { Request } from 'express';

// Public widget router — NO authMiddleware. Strict per-IP rate limits.
// Structured logging must never log tokens or message bodies (this file
// logs nothing at all about request payloads).

const perIp = (req: Request) => req.ip ?? 'unknown';

const sessionBodySchema = z.object({
  key: z.string().trim().min(1, 'Widget key is required'),
  ...widgetSessionSchema.shape,
});
const messageBodySchema = z.object({
  token: z.string().trim().min(1, 'Session token is required'),
  ...widgetMessageSchema.shape,
  client_message_id: z.string().max(100).optional(),
});

function rpcErrorMessage(error: { message: string }): string {
  return error.message ?? '';
}

export function widgetRouter(env: Env) {
  const router = Router();

  // GET /config?key=<public_key> — public display config only.
  router.get(
    '/config',
    rateLimit({ windowMs: 10 * 60 * 1000, max: 60, key: perIp }),
    async (req: Request, res: Response, next) => {
      try {
        const key = typeof req.query.key === 'string' ? req.query.key : '';
        if (!key) throw new ApiError(400, 'Widget key is required');
        const supabase = getSupabase(env);
        const { data, error } = await supabase.rpc('get_widget_config', { p_public_key: key });
        if (error) throw new ApiError(500, 'Failed to load widget config');
        const rows = (data ?? []) as Array<{
          business_name: string;
          welcome_message: string;
          primary_color: string;
          enabled: boolean;
        }>;
        const config = rows[0];
        if (!config || !config.enabled) throw new ApiError(404, 'Widget not found');
        return res.json({
          business_name: config.business_name,
          welcome_message: config.welcome_message,
          primary_color: config.primary_color,
          enabled: config.enabled,
        });
      } catch (e) {
        return next(e);
      }
    },
  );

  // POST /sessions — create a visitor session. The raw token is returned
  // ONCE here and never logged or stored by the API.
  router.post(
    '/sessions',
    rateLimit({ windowMs: 10 * 60 * 1000, max: 10, key: perIp }),
    validateBody(sessionBodySchema),
    async (req: Request, res: Response, next) => {
      try {
        const supabase = getSupabase(env);
        const { data, error } = await supabase.rpc('create_widget_visitor_session', {
          p_public_key: req.body.key,
          p_visitor_name: req.body.name ?? null,
          p_visitor_email: req.body.email ?? null,
        });
        if (error) {
          const msg = rpcErrorMessage(error as { message: string });
          if (msg.includes('Unknown widget key') || msg.includes('Widget is disabled')) {
            throw new ApiError(404, 'Widget not found');
          }
          throw new ApiError(400, 'Failed to create widget session');
        }
        const rows = (Array.isArray(data) ? data : [data]) as Array<{
          session_token: string;
          conversation_id: string;
          customer_id: string;
          expires_at: string;
        }>;
        const session = rows[0];
        if (!session?.session_token) throw new ApiError(400, 'Failed to create widget session');
        return res.status(201).json({
          token: session.session_token,
          conversation_id: session.conversation_id,
          customer_id: session.customer_id,
          expires_at: session.expires_at,
        });
      } catch (e) {
        return next(e);
      }
    },
  );

  // POST /messages — visitor message via the guest RPC (which also records
  // the customer.message.created outbox event — do not double-record).
  router.post(
    '/messages',
    rateLimit({ windowMs: 10 * 60 * 1000, max: 30, key: perIp }),
    validateBody(messageBodySchema),
    async (req: Request, res: Response, next) => {
      try {
        const supabase = getSupabase(env);
        const { data, error } = await supabase.rpc('post_widget_visitor_message', {
          p_token: req.body.token,
          p_body: req.body.body,
        });
        if (error) {
          const msg = rpcErrorMessage(error as { message: string });
          if (msg.includes('Invalid or expired session')) {
            throw new ApiError(401, 'Invalid or expired session');
          }
          throw new ApiError(400, 'Failed to send message');
        }
        return res.status(201).json({ message_id: data });
      } catch (e) {
        return next(e);
      }
    },
  );

  // GET /history?token=... — only the caller's own session messages.
  // Unknown/expired token returns an empty list with 200 (per RPC design).
  router.get(
    '/history',
    rateLimit({ windowMs: 10 * 60 * 1000, max: 60, key: perIp }),
    async (req: Request, res: Response, next) => {
      try {
        const token = typeof req.query.token === 'string' ? req.query.token : '';
        if (!token) throw new ApiError(400, 'Session token is required');
        const supabase = getSupabase(env);
        const { data, error } = await supabase.rpc('get_widget_visitor_history', {
          p_token: token,
        });
        if (error) throw new ApiError(500, 'Failed to load message history');
        const rows = (data ?? []) as Array<{
          message_id: string;
          sender_type: string;
          body: string;
          created_at: string;
        }>;
        return res.json({
          messages: rows.map((m) => ({
            id: m.message_id,
            sender_type: m.sender_type,
            body: m.body,
            created_at: m.created_at,
          })),
        });
      } catch (e) {
        return next(e);
      }
    },
  );

  return router;
}
