import { Router, type Response } from 'express';
import { z } from 'zod';
import { widgetMessageSchema, widgetSessionSchema } from '@supportflow/shared';
import type { Env } from '../env.js';
import { ApiError } from '../errors.js';
import { getSupabase } from '../lib/supabase.js';
import type { SupabaseClient } from '@supabase/supabase-js';
import {
  isAllowedParentOrigin,
  normalizeOrigin,
} from '../lib/originPolicy.js';
import { rateLimit } from '../middleware/rateLimit.js';
import { validateBody } from '../middleware/validate.js';
import type { Request } from 'express';

// Public widget router — NO authMiddleware. Strict per-IP rate limits.
// Structured logging must never log tokens or message bodies (this file
// logs nothing at all about request payloads).
//
// ORIGIN ENFORCEMENT (Phase 2.1, Issue 4 — see docs/phase2-1-origins.md):
// The widget is an iframe served from the app's own frontend origin, so
// the Origin header on these calls is the IFRAME's origin, not the
// embedding site's. Enforcement therefore uses an explicit, client-
// asserted `parent_origin` (the iframe reads it from document.referrer)
// validated against the widget's stored allow-list:
//   * disabled widget -> 404, exactly as before;
//   * empty allow-list -> only the app's own frontend origin is allowed
//     (the /widget-demo preview); any foreign origin, or no claimed
//     origin at all, -> 403 with a generic error (the allow-list is
//     never leaked);
//   * non-empty allow-list -> the claimed origin must exactly match one
//     entry, else 403;
//   * on session creation the validated origin is STORED on the session
//     (migration 0008); message/history calls must claim that same
//     origin — a body-supplied origin is never trusted on its own.
// A non-browser client can spoof parent_origin, so this is embedding
// policy for real browsers, not a security boundary: the real
// protections remain the visitor-session token, per-IP rate limits, and
// the fact that widget endpoints expose no secrets or cross-visitor data.
// Until migration 0008 is applied live, the policy RPCs do not exist and
// the endpoints fall back to their previous (unenforced) behaviour rather
// than breaking the widget; the fallback is explicit below.

const perIp = (req: Request) => req.ip ?? 'unknown';

const parentOriginField = z.string().trim().max(200).optional();

const sessionBodySchema = z.object({
  key: z.string().trim().min(1, 'Widget key is required'),
  parent_origin: parentOriginField,
  ...widgetSessionSchema.shape,
});
const messageBodySchema = z.object({
  token: z.string().trim().min(1, 'Session token is required'),
  parent_origin: parentOriginField,
  ...widgetMessageSchema.shape,
});

function rpcErrorMessage(error: { message: string }): string {
  return error.message ?? '';
}

const ORIGIN_FORBIDDEN = 'Embedding origin not allowed';

interface OriginPolicy {
  enabled: boolean;
  allowed_origins: string[];
}

interface SessionPolicy extends OriginPolicy {
  parent_origin: string | null;
}

/**
 * Load a widget's origin policy by public key. Returns null for an
 * unknown key, 'unavailable' when the 0008 RPC does not exist yet (the
 * migration has not been applied — caller falls back to legacy behaviour
 * instead of breaking the widget).
 */
async function loadOriginPolicy(
  supabase: SupabaseClient,
  publicKey: string,
): Promise<OriginPolicy | 'unavailable' | null> {
  const { data, error } = await supabase.rpc('get_widget_origin_policy', {
    p_public_key: publicKey,
  });
  if (error) return 'unavailable';
  const rows = (data ?? []) as Array<{
    enabled: boolean;
    allowed_origins: string[] | null;
  }>;
  const row = rows[0];
  if (!row) return null;
  return { enabled: row.enabled, allowed_origins: row.allowed_origins ?? [] };
}

/**
 * Load a live session's origin policy by token. Returns null for an
 * unknown/expired token (the caller then applies the endpoint's existing
 * token behaviour — 401 for messages, empty history), 'unavailable' when
 * the 0008 RPC does not exist yet.
 */
async function loadSessionPolicy(
  supabase: SupabaseClient,
  token: string,
): Promise<SessionPolicy | 'unavailable' | null> {
  const { data, error } = await supabase.rpc('get_widget_session_policy', {
    p_token: token,
  });
  if (error) return 'unavailable';
  const rows = (data ?? []) as Array<{
    parent_origin: string | null;
    allowed_origins: string[] | null;
    enabled: boolean;
  }>;
  const row = rows[0];
  if (!row) return null;
  return {
    parent_origin: row.parent_origin,
    allowed_origins: row.allowed_origins ?? [],
    enabled: row.enabled,
  };
}

/**
 * Enforce the allow-list for a key-based endpoint (config, session
 * creation). Throws 404 for an unknown/disabled widget, 403 for a
 * disallowed or absent/invalid claimed origin. Returns the normalised
 * claimed origin (null only when enforcement is unavailable).
 */
function enforceKeyPolicy(
  policy: OriginPolicy | 'unavailable' | null,
  claimedRaw: string | undefined,
  frontendUrl: string,
): string | null {
  if (policy === 'unavailable') return null;
  if (policy === null) throw new ApiError(404, 'Widget not found');
  if (!policy.enabled) throw new ApiError(404, 'Widget not found');
  const claimed = claimedRaw ? normalizeOrigin(claimedRaw) : null;
  if (
    !claimed ||
    !isAllowedParentOrigin({
      claimed,
      allowedOrigins: policy.allowed_origins,
      frontendUrl,
    })
  ) {
    throw new ApiError(403, ORIGIN_FORBIDDEN);
  }
  return claimed;
}

/**
 * Enforce the origin binding for a token-based endpoint (messages,
 * history). Throws 403 when the claimed origin does not match the
 * session's stored origin, or — for pre-0008 sessions with no stored
 * origin — when it fails the widget's allow-list. Returns without
 * throwing when there is no live session (unknown/expired token: the
 * endpoint's own token handling applies) or when enforcement is
 * unavailable.
 */
function enforceSessionPolicy(
  policy: SessionPolicy | 'unavailable' | null,
  claimedRaw: string | undefined,
  frontendUrl: string,
): void {
  if (policy === 'unavailable' || policy === null) return;
  if (!policy.enabled) throw new ApiError(403, ORIGIN_FORBIDDEN);
  const claimed = claimedRaw ? normalizeOrigin(claimedRaw) : null;
  if (!claimed) throw new ApiError(403, ORIGIN_FORBIDDEN);
  const stored = policy.parent_origin
    ? normalizeOrigin(policy.parent_origin)
    : null;
  if (stored) {
    if (claimed !== stored) throw new ApiError(403, ORIGIN_FORBIDDEN);
    return;
  }
  // Legacy session (created before 0008, no stored origin): fall back to
  // the widget's allow-list.
  if (
    !isAllowedParentOrigin({
      claimed,
      allowedOrigins: policy.allowed_origins,
      frontendUrl,
    })
  ) {
    throw new ApiError(403, ORIGIN_FORBIDDEN);
  }
}

function claimedFromQuery(req: Request): string | undefined {
  return typeof req.query.parent_origin === 'string'
    ? req.query.parent_origin
    : undefined;
}

export function widgetRouter(env: Env) {
  const router = Router();

  // GET /config?key=<public_key>&parent_origin=<embedding origin> —
  // public display config only. Never exposes allowed_origins.
  router.get(
    '/config',
    rateLimit({ windowMs: 10 * 60 * 1000, max: 60, key: perIp }),
    async (req: Request, res: Response, next) => {
      try {
        const key = typeof req.query.key === 'string' ? req.query.key : '';
        if (!key) throw new ApiError(400, 'Widget key is required');
        const supabase = getSupabase(env);
        enforceKeyPolicy(
          await loadOriginPolicy(supabase, key),
          claimedFromQuery(req),
          env.FRONTEND_URL,
        );
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
  // ONCE here and never logged or stored by the API. The validated
  // parent origin is stored on the session (migration 0008) so later
  // calls can be bound to it.
  router.post(
    '/sessions',
    rateLimit({ windowMs: 10 * 60 * 1000, max: 10, key: perIp }),
    validateBody(sessionBodySchema),
    async (req: Request, res: Response, next) => {
      try {
        const supabase = getSupabase(env);
        const claimed = enforceKeyPolicy(
          await loadOriginPolicy(supabase, req.body.key as string),
          typeof req.body.parent_origin === 'string' ? req.body.parent_origin : undefined,
          env.FRONTEND_URL,
        );
        const { data, error } = await supabase.rpc('create_widget_visitor_session', {
          p_public_key: req.body.key,
          p_visitor_name: req.body.name ?? null,
          p_visitor_email: req.body.email ?? null,
          p_parent_origin: claimed ?? null,
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
  // Idempotent on client_message_id: a repeat returns the existing message
  // with 200; a new message returns 201. The claimed parent origin must
  // match the session's stored origin (or the allow-list for legacy
  // sessions) — the token alone does not bypass origin policy.
  router.post(
    '/messages',
    rateLimit({ windowMs: 10 * 60 * 1000, max: 30, key: perIp }),
    validateBody(messageBodySchema),
    async (req: Request, res: Response, next) => {
      try {
        const supabase = getSupabase(env);
        enforceSessionPolicy(
          await loadSessionPolicy(supabase, req.body.token as string),
          typeof req.body.parent_origin === 'string' ? req.body.parent_origin : undefined,
          env.FRONTEND_URL,
        );
        const { data, error } = await supabase.rpc('post_widget_visitor_message', {
          p_token: req.body.token,
          p_body: req.body.body,
          p_client_message_id: req.body.client_message_id ?? null,
        });
        if (error) {
          const msg = rpcErrorMessage(error as { message: string });
          if (msg.includes('Invalid or expired session')) {
            throw new ApiError(401, 'Invalid or expired session');
          }
          throw new ApiError(400, 'Failed to send message');
        }
        const rows = (Array.isArray(data) ? data : [data]) as Array<{
          message_id: string;
          is_duplicate: boolean;
        }>;
        const row = rows[0];
        if (!row?.message_id) throw new ApiError(400, 'Failed to send message');
        return res.status(row.is_duplicate ? 200 : 201).json({ message_id: row.message_id });
      } catch (e) {
        return next(e);
      }
    },
  );

  // GET /history?token=...&parent_origin=... — only the caller's own
  // session messages. Unknown/expired token returns an empty list with
  // 200 (per RPC design). The same origin check as /messages applies:
  // a mismatched claimed origin returns 403.
  router.get(
    '/history',
    rateLimit({ windowMs: 10 * 60 * 1000, max: 60, key: perIp }),
    async (req: Request, res: Response, next) => {
      try {
        const token = typeof req.query.token === 'string' ? req.query.token : '';
        if (!token) throw new ApiError(400, 'Session token is required');
        const supabase = getSupabase(env);
        enforceSessionPolicy(
          await loadSessionPolicy(supabase, token),
          claimedFromQuery(req),
          env.FRONTEND_URL,
        );
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
