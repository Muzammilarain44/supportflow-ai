import type { Request } from 'express';
import { listQuerySchema, type ListQuery } from '@supportflow/shared';
import { ApiError } from '../errors.js';

/** Parse + validate the shared list-query params (?page=&pageSize=&search=…). Throws ApiError(400) on bad input. */
export function parseListQuery(req: Request): ListQuery {
  const result = listQuerySchema.safeParse(req.query);
  if (!result.success) {
    throw new ApiError(
      400,
      result.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; '),
    );
  }
  return result.data;
}

export function pageOffset(page: number, pageSize: number): number {
  return (page - 1) * pageSize;
}
