import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import type { Env } from '../env.js';

/**
 * Service-role Supabase client. Bypasses RLS — use ONLY in trusted
 * server-side code (the outbox dispatcher, admin jobs), never in a
 * request handler that acts for a single user. Throws a clear error
 * when SUPABASE_SERVICE_ROLE_KEY is not configured instead of failing
 * later with an opaque auth error.
 */
export function getServiceSupabase(
  env: Pick<Env, 'SUPABASE_URL' | 'SUPABASE_SERVICE_ROLE_KEY'>,
): SupabaseClient {
  if (!env.SUPABASE_SERVICE_ROLE_KEY) {
    throw new Error(
      'Missing SUPABASE_SERVICE_ROLE_KEY. Set it in the environment (Render dashboard > Environment, or .env for local dev). The service-role key bypasses RLS — keep it server-side only, never in frontend code.',
    );
  }
  return createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}
