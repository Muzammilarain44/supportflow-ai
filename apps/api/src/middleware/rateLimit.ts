import type { NextFunction, Request, Response } from 'express';
import { ApiError } from '../errors.js';

export interface RateLimitOptions {
  /** Sliding window length in milliseconds. */
  windowMs: number;
  /** Maximum requests allowed per key inside the window. */
  max: number;
  /** How to bucket requests. Defaults to client IP + authenticated user id. */
  key?: (req: Request) => string;
}

function defaultKey(req: Request): string {
  const userId = (req as Request & { user?: { id: string } }).user?.id ?? 'anon';
  return `${req.ip ?? 'unknown'}:${userId}`;
}

/**
 * In-memory sliding-window rate limiter (no external dependency).
 * Old timestamps are pruned lazily on every request and by a periodic
 * sweep (unref'd so it never keeps the process alive). State lives in
 * the factory closure, so each app instance gets its own buckets.
 * On breach: 429 {error} + a Retry-After header (seconds).
 */
export function rateLimit(options: RateLimitOptions) {
  const hits = new Map<string, number[]>();
  const prune = (now: number) => {
    for (const [k, timestamps] of hits) {
      const fresh = timestamps.filter((t) => now - t < options.windowMs);
      if (fresh.length > 0) hits.set(k, fresh);
      else hits.delete(k);
    }
  };
  const timer = setInterval(() => prune(Date.now()), options.windowMs);
  if (typeof timer === 'object' && 'unref' in timer) {
    (timer as unknown as { unref: () => void }).unref();
  }

  return (req: Request, res: Response, next: NextFunction) => {
    const key = options.key ? options.key(req) : defaultKey(req);
    const now = Date.now();
    const timestamps = (hits.get(key) ?? []).filter((t) => now - t < options.windowMs);
    if (timestamps.length >= options.max) {
      const retryAfter = Math.max(1, Math.ceil((timestamps[0] + options.windowMs - now) / 1000));
      res.setHeader('Retry-After', String(retryAfter));
      return next(new ApiError(429, 'Too many requests, please try again later'));
    }
    timestamps.push(now);
    hits.set(key, timestamps);
    return next();
  };
}
