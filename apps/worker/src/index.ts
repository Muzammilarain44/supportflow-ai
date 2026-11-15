import { createClient } from '@supabase/supabase-js';
import { loadWorkerEnv } from './env.js';
import { startDispatcher, type DispatcherConfig } from './dispatcher.js';

const log = (msg: string, meta?: Record<string, unknown>): void => {
  console.log(JSON.stringify({ level: 'info', msg, ...meta, ts: new Date().toISOString() }));
};

function main(): void {
  const env = loadWorkerEnv();
  const supabase = createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const config: DispatcherConfig = {
    n8nWebhookUrl: env.N8N_WEBHOOK_URL,
    webhookSecret: env.WEBHOOK_SECRET,
    apiBaseUrl: env.API_BASE_URL,
    aiDirectProcessing: env.AI_DIRECT_PROCESSING,
    batchSize: env.WORKER_BATCH_SIZE,
    pollMs: env.WORKER_POLL_MS,
    staleTimeoutSeconds: env.WORKER_STALE_TIMEOUT_SECONDS,
    fetchTimeoutMs: env.WORKER_FETCH_TIMEOUT_MS,
  };
  log('SupportFlow outbox dispatcher starting', {
    poll_ms: config.pollMs,
    batch_size: config.batchSize,
    destination: config.n8nWebhookUrl
      ? 'n8n'
      : config.aiDirectProcessing
        ? 'api-direct'
        : 'none (events stay pending)',
  });
  const { stop } = startDispatcher(supabase, config, fetch, log);

  let shuttingDown = false;
  const shutdown = (signal: string): void => {
    if (shuttingDown) return;
    shuttingDown = true;
    log('Shutting down dispatcher', { signal });
    stop();
    // Give an in-flight batch a moment to finish its acks, then exit.
    // In-flight deliveries have a 15s fetch timeout, so this is bounded.
    setTimeout(() => process.exit(0), 1000);
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}

main();
