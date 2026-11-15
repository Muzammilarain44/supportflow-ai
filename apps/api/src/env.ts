import 'dotenv/config';

export interface Env {
  PORT: number;
  FRONTEND_URL: string;
  SUPABASE_URL: string;
  SUPABASE_ANON_KEY: string;
  SUPABASE_SERVICE_ROLE_KEY?: string;
  NODE_ENV: string;
  // ---- Phase 3: AI agent layer + RAG (all optional; see docs/phase3-ai-providers.md) ----
  /** Comma-separated provider order, e.g. 'groq,gemini'. Default 'groq,gemini'. */
  AI_PROVIDER_ORDER: string;
  GROQ_API_KEY?: string;
  GEMINI_API_KEY?: string;
  AI_MODEL_GROQ: string;
  /** Quality-tier Groq model, used when a call requests quality over speed. */
  AI_MODEL_GROQ_QUALITY: string;
  AI_MODEL_GEMINI: string;
  /** Comma-separated Gemini fallback models, tried in order after AI_MODEL_GEMINI. */
  AI_MODEL_GEMINI_FALLBACKS: string;
  /** Per-provider request timeout in ms. Default 30000. */
  AI_REQUEST_TIMEOUT_MS: number;
  /** Outbound n8n webhook URL (optional). */
  N8N_WEBHOOK_URL?: string;
  /** HMAC secret for POST /api/automation/process-event. Min 32 chars when set. */
  AUTOMATION_WEBHOOK_SECRET?: string;
  /** When 'true', automation events are processed inline instead of via n8n. Default 'false'. */
  AI_DIRECT_PROCESSING: boolean;
  /** Public base URL of this API, used to build callback URLs. Default 'http://localhost:4000'. */
  API_BASE_URL: string;
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

/**
 * Browser-like User-Agent every AI provider request MUST carry.
 * Groq sits behind Cloudflare: requests without a browser User-Agent are
 * rejected with HTTP 403 error code 1010. Verified live 2026-11-15.
 * See docs/phase3-ai-providers.md.
 */
export const AI_HTTP_USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';

export function loadEnv(): Env {
  const secret = process.env.AUTOMATION_WEBHOOK_SECRET;
  if (secret !== undefined && secret.length > 0 && secret.length < 32) {
    // Warn only — do not fail boot, so a short secret in dev never blocks
    // the server, but the operator is told plainly it is too short.
    console.warn(
      '[env] WARNING: AUTOMATION_WEBHOOK_SECRET is set but shorter than 32 characters. ' +
        'HMAC verification for /api/automation/process-event is weak. Set a secret of at least 32 characters.',
    );
  }
  return {
    PORT: Number(process.env.PORT ?? 4000),
    FRONTEND_URL: process.env.FRONTEND_URL ?? 'http://localhost:5173',
    SUPABASE_URL: required('SUPABASE_URL'),
    SUPABASE_ANON_KEY: required('SUPABASE_ANON_KEY'),
    SUPABASE_SERVICE_ROLE_KEY: process.env.SUPABASE_SERVICE_ROLE_KEY,
    NODE_ENV: process.env.NODE_ENV ?? 'development',
    AI_PROVIDER_ORDER: process.env.AI_PROVIDER_ORDER ?? 'groq,gemini',
    GROQ_API_KEY: process.env.GROQ_API_KEY || undefined,
    GEMINI_API_KEY: process.env.GEMINI_API_KEY || undefined,
    // Verified 2026-11-15 — see docs/phase3-ai-providers.md. No Llama
    // chat models exist on this Groq key's free roster; never default to one.
    AI_MODEL_GROQ: process.env.AI_MODEL_GROQ ?? 'openai/gpt-oss-20b',
    AI_MODEL_GROQ_QUALITY: process.env.AI_MODEL_GROQ_QUALITY ?? 'openai/gpt-oss-120b',
    AI_MODEL_GEMINI: process.env.AI_MODEL_GEMINI ?? 'gemini-3.8-flash',
    AI_MODEL_GEMINI_FALLBACKS:
      process.env.AI_MODEL_GEMINI_FALLBACKS ?? 'gemini-3.6-flash,gemini-3.5-flash-lite,gemini-3.1-flash-lite',
    AI_REQUEST_TIMEOUT_MS: Number(process.env.AI_REQUEST_TIMEOUT_MS ?? 30000),
    N8N_WEBHOOK_URL: process.env.N8N_WEBHOOK_URL || undefined,
    AUTOMATION_WEBHOOK_SECRET: secret || undefined,
    AI_DIRECT_PROCESSING: process.env.AI_DIRECT_PROCESSING === 'true',
    API_BASE_URL: process.env.API_BASE_URL ?? 'http://localhost:4000',
  };
}
