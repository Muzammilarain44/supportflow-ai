import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import type { Env } from '../env.js';

let client: SupabaseClient | null = null;
export function getSupabase(env: Env): SupabaseClient {
  if (!client) client = createClient(env.SUPABASE_URL, env.SUPABASE_ANON_KEY);
  return client;
}
/** Client bound to a user's JWT, so RLS / RPC run as that user. Never use the service key here. */
export function getUserSupabase(env: Env, token: string): SupabaseClient {
  return createClient(env.SUPABASE_URL, env.SUPABASE_ANON_KEY, {
    global: { headers: { Authorization: `Bearer ${token}` } },
    auth: { persistSession: false, autoRefreshToken: false },
  });
}
