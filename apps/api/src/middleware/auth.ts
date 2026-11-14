import type { NextFunction, Request, Response } from 'express';
import type { Env } from '../env.js';
import { getSupabase } from '../lib/supabase.js';
import { ApiError } from '../errors.js';

export interface AuthUser { id: string; email?: string }
export interface AuthedRequest extends Request { user?: AuthUser; token?: string }

export function authMiddleware(env: Env) {
  return async (req: AuthedRequest, _res: Response, next: NextFunction) => {
    const header = req.headers.authorization;
    if (!header?.startsWith('Bearer ')) return next(new ApiError(401, 'Missing or invalid Authorization header'));
    const token = header.slice('Bearer '.length);
    try {
      const { data, error } = await getSupabase(env).auth.getUser(token);
      if (error || !data.user) return next(new ApiError(401, 'Invalid or expired token'));
      req.user = { id: data.user.id, email: data.user.email };
      req.token = token;
      return next();
    } catch {
      return next(new ApiError(401, 'Invalid or expired token'));
    }
  };
}
