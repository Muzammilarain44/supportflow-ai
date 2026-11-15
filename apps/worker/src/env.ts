import 'dotenv/config';

export interface WorkerEnv {
  SUPABASE_URL: string;
  SUPABASE_SERVICE_ROLE_KEY: string;
  /** n8n webhook URL (Cloudflare Tunnel to the laptop). Unset = no n8n destination. */
  N8N_WEBHOOK_URL?: string;
  /** Shared HMAC secret for signing deliveries. Required when a destination is set. */
  WEBHOOK_SECRET?: string;
  /** Base URL of the SupportFlow API (direct-processing fallback). */
  API_BASE_URL: string;
  /** When 'true' and no N8N_WEBHOOK_URL, POST events to the API's /api/automation/process-event. */
  AI_DIRECT_PROCESSING: boolean;
  WORKER_POLL_MS: number;
  WORKER_BATCH_SIZE: number;
  /** Seconds after which a 'processing' row is reclaimed as stale (crash recovery). */
  WORKER_STALE_TIMEOUT_SECONDS: number;
  /** Per-delivery HTTP timeout in ms. */
  WORKER_FETCH_TIMEOUT_MS: number;
}

function required(name: string): string {
  const v = process.env[name];
  if (!v) {
    throw new Error(
      `Missing required environment variable ${name}. See docs/phase3-outbox.md for the full list.`,
    );
  }
  return v;
}

function optionalInt(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) {
    throw new Error(`Environment variable ${name} must be a positive number, got: ${raw}`);
  }
  return Math.floor(n);
}

export function loadWorkerEnv(): WorkerEnv {
  const n8nWebhookUrl = process.env.N8N_WEBHOOK_URL || undefined;
  const webhookSecret = process.env.WEBHOOK_SECRET || undefined;
  const aiDirectProcessing = process.env.AI_DIRECT_PROCESSING === 'true';
  if ((n8nWebhookUrl || aiDirectProcessing) && !webhookSecret) {
    throw new Error(
      'Missing WEBHOOK_SECRET: a delivery destination is configured (N8N_WEBHOOK_URL or AI_DIRECT_PROCESSING=true) but no signing secret is set. Deliveries must be HMAC-signed.',
    );
  }
  return {
    SUPABASE_URL: required('SUPABASE_URL'),
    SUPABASE_SERVICE_ROLE_KEY: required('SUPABASE_SERVICE_ROLE_KEY'),
    N8N_WEBHOOK_URL: n8nWebhookUrl,
    WEBHOOK_SECRET: webhookSecret,
    API_BASE_URL: process.env.API_BASE_URL ?? 'http://localhost:4000',
    AI_DIRECT_PROCESSING: aiDirectProcessing,
    WORKER_POLL_MS: optionalInt('WORKER_POLL_MS', 15000),
    WORKER_BATCH_SIZE: optionalInt('WORKER_BATCH_SIZE', 10),
    WORKER_STALE_TIMEOUT_SECONDS: optionalInt('WORKER_STALE_TIMEOUT_SECONDS', 300),
    WORKER_FETCH_TIMEOUT_MS: optionalInt('WORKER_FETCH_TIMEOUT_MS', 15000),
  };
}
