import { createClient } from '@supabase/supabase-js';
const url = import.meta.env.VITE_SUPABASE_URL as string | undefined;
const anonKey = import.meta.env.VITE_SUPABASE_ANON_KEY as string | undefined;
if (!url || !anonKey || anonKey === 'your-anon-key-here') {
  console.warn('SupportFlow: VITE_SUPABASE_URL / VITE_SUPABASE_ANON_KEY are not set. Copy .env.example to apps/web/.env and add the real anon key (Supabase Dashboard > Project Settings > API). Auth will not work until then.');
}
export const supabase = createClient(url ?? 'https://placeholder.supabase.co', anonKey ?? 'placeholder-anon-key');
