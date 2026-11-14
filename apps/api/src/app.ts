import express, { type Express } from 'express';
import cors from 'cors';
import type { Env } from './env.js';
import { authMiddleware } from './middleware/auth.js';
import { workspacesRouter } from './routes/workspaces.js';
import { errorHandler, notFound } from './errors.js';
import { logger } from './logger.js';

export function createApp(env: Env): Express {
  const app = express();
  app.use(cors({ origin: env.FRONTEND_URL, credentials: true }));
  app.use(express.json({ limit: '1mb' }));
  app.use((req, _res, next) => { logger.info(`${req.method} ${req.path}`); next(); });
  app.get('/health', (_req, res) => res.json({ status: 'ok', service: 'supportflow-api', version: '0.1.0' }));
  app.use('/api/workspaces', authMiddleware(env), workspacesRouter(env));
  app.use(notFound);
  app.use(errorHandler);
  return app;
}
