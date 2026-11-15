import express, { type Express } from 'express';
import cors from 'cors';
import type { Env } from './env.js';
import { authMiddleware } from './middleware/auth.js';
import { rateLimit } from './middleware/rateLimit.js';
import { requireWorkspaceMember } from './middleware/workspaceAuth.js';
import { workspacesRouter } from './routes/workspaces.js';
import { profilesRouter } from './routes/profiles.js';
import { customersRouter } from './routes/customers.js';
import { conversationsRouter } from './routes/conversations.js';
import { ticketsRouter } from './routes/tickets.js';
import { widgetSettingsRouter } from './routes/widgetSettings.js';
import { widgetRouter } from './routes/widget.js';
import { knowledgeRouter } from './routes/knowledge.js';
import { aiSettingsRouter } from './routes/aiSettings.js';
import { automationEventsRouter } from './routes/automationEvents.js';
import { handoffsRouter } from './routes/handoffs.js';
import { automationRouter, aiWorkspaceRouter } from './routes/automation.js';
import { errorHandler, notFound } from './errors.js';
import { logger } from './logger.js';

export function createApp(env: Env): Express {
  const app = express();
  app.use(cors({ origin: env.FRONTEND_URL, credentials: true }));
  // Phase 3 automation webhook FIRST, before the global JSON parser:
  // POST /api/automation/process-event verifies an HMAC over the exact
  // raw request bytes, so this mount uses express.raw() and the route
  // handler parses the JSON itself. Mounting it after express.json()
  // would make verification run over a re-serialized body and fail.
  app.use('/api/automation', express.raw({ type: 'application/json', limit: '1mb' }), automationRouter(env));
  app.use(express.json({ limit: '1mb' }));
  app.use((req, _res, next) => { logger.info(`${req.method} ${req.path}`); next(); });
  app.get('/health', (_req, res) => res.json({ status: 'ok', service: 'supportflow-api', version: '0.3.2' }));

  // Generous limit for the authenticated API: 300 requests / 15 min per user.
  // Runs AFTER authMiddleware so the limiter key includes the user id.
  const authedRateLimit = rateLimit({ windowMs: 15 * 60 * 1000, max: 300 });
  const authed = [authMiddleware(env), authedRateLimit, requireWorkspaceMember(env)] as const;

  app.use('/api/workspaces', authMiddleware(env), authedRateLimit, workspacesRouter(env));
  // Own profile (Phase 2.1, Issue 2) — auth only, NOT workspace-scoped.
  app.use('/api/profile', authMiddleware(env), authedRateLimit, profilesRouter(env));
  // Workspace-scoped Phase 2 routers (membership enforced by requireWorkspaceMember,
  // which reads :workspaceId — see middleware/workspaceAuth.ts).
  app.use('/api/workspaces/:workspaceId/customers', ...authed, customersRouter(env));
  app.use('/api/workspaces/:workspaceId/conversations', ...authed, conversationsRouter(env));
  app.use('/api/workspaces/:workspaceId/tickets', ...authed, ticketsRouter(env));
  app.use('/api/workspaces/:workspaceId/widget-settings', ...authed, widgetSettingsRouter(env));
  // Phase 3 workspace-scoped routers.
  app.use('/api/workspaces/:workspaceId/knowledge', ...authed, knowledgeRouter(env));
  app.use('/api/workspaces/:workspaceId/ai-settings', ...authed, aiSettingsRouter(env));
  app.use('/api/workspaces/:workspaceId/automation-events', ...authed, automationEventsRouter(env));
  app.use('/api/workspaces/:workspaceId', ...authed, aiWorkspaceRouter(env));
  app.use('/api/workspaces/:workspaceId/conversations/:conversationId', ...authed, handoffsRouter(env));

  // Public widget router — no auth; each endpoint has its own strict
  // per-IP rate limit (see routes/widget.ts).
  // Widget CORS reflects ONLY the app's own frontend origin (the iframe's
  // origin) and never credentials: the iframe is served from the same app
  // as the dashboard. It deliberately does NOT reflect embedding sites'
  // origins — CORS preflight cannot know the widget key, so embedding
  // policy is enforced separately via the parent_origin parameter (see
  // docs/phase2-1-origins.md). No wildcard CORS anywhere on widget routes.
  const widgetCors = cors({ origin: env.FRONTEND_URL, credentials: false });
  app.use('/api/widget', widgetCors, widgetRouter(env));

  app.use(notFound);
  app.use(errorHandler);
  return app;
}
