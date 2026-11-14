import 'dotenv/config';

export interface Env {
  PORT: number;
  FRONTEND_URL: string;
  SUPABASE_URL: string;
  SUPABASE_ANON_KEY: string;
  SUPABASE_SERVICE_ROLE_KEY?: string;
  NODE_ENV: string;
}

function required(name: string): string {
  const v = process.env[name];
  if (!v || v === 'your-anon-key-here' || v === 'your-service-role-key-here') {
    throw new Error(
      `Missing required environment variable ${name}. Copy .env.example to .env and set a real value (see README.md > Supabase setup).`,
    );
  }
  return v;
}

export function loadEnv(): Env {
  return {
    PORT: Number(process.env.PORT ?? 4000),
    FRONTEND_URL: process.env.FRONTEND_URL ?? 'http://localhost:5173',
    SUPABASE_URL: required('SUPABASE_URL'),
    SUPABASE_ANON_KEY: required('SUPABASE_ANON_KEY'),
    SUPABASE_SERVICE_ROLE_KEY: process.env.SUPABASE_SERVICE_ROLE_KEY,
    NODE_ENV: process.env.NODE_ENV ?? 'development',
  };
}
