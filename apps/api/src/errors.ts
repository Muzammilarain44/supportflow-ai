import type { NextFunction, Request, Response } from 'express';
import { logger } from './logger.js';

export class ApiError extends Error {
  constructor(public status: number, message: string) { super(message); }
}
export const notFound = (_req: Request, res: Response) => res.status(404).json({ error: 'Not found' });
// eslint-disable-next-line @typescript-eslint/no-unused-vars
export function errorHandler(err: unknown, _req: Request, res: Response, _next: NextFunction) {
  if (err instanceof ApiError) return res.status(err.status).json({ error: err.message });
  logger.error('Unhandled error', { error: err instanceof Error ? err.message : String(err) });
  return res.status(500).json({ error: 'Internal server error' });
}
