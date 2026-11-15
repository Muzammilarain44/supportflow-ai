// ============================================================================
// SupportFlow AI — Phase 3: provider-independent AI layer (Worker B)
//
// Two OpenAI-compatible chat-completion providers, tried in order:
//   Groq   https://api.groq.com/openai/v1/chat/completions
//   Gemini https://generativelanguage.googleapis.com/v1beta/openai/chat/completions
//
// Rules enforced here:
//   * NEVER invent a response. If every provider fails, throw AiUnavailableError.
//   * Quota / rate-limit (429) and 5xx / network errors fall through to the
//     next provider (and, for Gemini, to the next model in its fallback
//     chain); the failure is surfaced, never hidden.
//   * API keys are never logged, never returned, and never appear in any
//     error message (only the provider name and HTTP status are reported).
//   * Model names are defaults only — verify them live in the Groq /
//     Google AI Studio consoles before production use (see
//     docs/phase3-ai-providers.md). Gemini's free tier may allow only
//     ~20 requests/day; a quota error is surfaced as retryable, not swallowed.
//   * Every provider request carries the shared browser-like User-Agent
//     (AI_HTTP_USER_AGENT): Groq sits behind Cloudflare and rejects bare
//     requests with HTTP 403 (error 1010). Verified live 2026-11-15.
// ============================================================================

import { AI_HTTP_USER_AGENT } from '../env.js';

export type AiProvider = 'groq' | 'gemini';

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface AiConfig {
  providerOrder: AiProvider[];
  groqApiKey?: string;
  geminiApiKey?: string;
  groqModel: string;
  /** Quality-tier Groq model, used when a call requests quality over speed. */
  groqQualityModel: string;
  geminiModel: string;
  /** Gemini fallback models, tried in order after geminiModel on failure. */
  geminiFallbackModels: string[];
  /** Per-provider request timeout in ms. */
  timeoutMs: number;
}

export interface CompletionResult {
  text: string;
  provider: AiProvider;
  model: string;
  promptTokens: number | null;
  completionTokens: number | null;
  latencyMs: number;
}

export interface GenerateCompletionInput {
  messages: ChatMessage[];
  /** Override the provider's default model for this call. */
  model?: string;
  /** When true, Groq uses the quality-tier model instead of the default. */
  quality?: boolean;
  maxTokens?: number;
}

/** Typed failure: every configured provider failed (or none was configured). */
export class AiUnavailableError extends Error {
  /** Provider that failed last (or 'none' when no provider was configured). */
  readonly provider: AiProvider | 'none';
  /** HTTP status of the last failure, when the provider answered at all. */
  readonly status: number | null;
  /** True for 429/quota, 5xx and network/timeout failures. */
  readonly retryable: boolean;
  /** True when the last failure was a quota / rate-limit (429) response. */
  readonly quotaExceeded: boolean;

  constructor(
    message: string,
    opts: { provider: AiProvider | 'none'; status?: number | null; retryable?: boolean; quotaExceeded?: boolean },
  ) {
    super(message);
    this.name = 'AiUnavailableError';
    this.provider = opts.provider;
    this.status = opts.status ?? null;
    this.retryable = opts.retryable ?? true;
    this.quotaExceeded = opts.quotaExceeded ?? false;
  }
}

const PROVIDER_URLS: Record<AiProvider, string> = {
  groq: 'https://api.groq.com/openai/v1/chat/completions',
  gemini: 'https://generativelanguage.googleapis.com/v1beta/openai/chat/completions',
};

/**
 * Pure provider-order selector (unit-tested). Keeps only known providers,
 * de-duplicates, preserves order; falls back to the default order when the
 * input is empty or contains nothing usable.
 */
export function selectProviders(order: readonly string[]): AiProvider[] {
  const seen = new Set<AiProvider>();
  const out: AiProvider[] = [];
  for (const p of order) {
    const v = String(p).trim().toLowerCase();
    if ((v === 'groq' || v === 'gemini') && !seen.has(v)) {
      seen.add(v);
      out.push(v);
    }
  }
  return out.length > 0 ? out : ['groq', 'gemini'];
}

/** Providers configured (order + model + key presence) for status reporting. Never includes keys. */
export function listProviders(config: AiConfig): Array<{ provider: AiProvider; model: string; configured: boolean }> {
  return selectProviders(config.providerOrder).map((provider) => ({
    provider,
    model: provider === 'groq' ? config.groqModel : config.geminiModel,
    configured: Boolean(provider === 'groq' ? config.groqApiKey : config.geminiApiKey),
  }));
}

/** Build an AiConfig from the API Env object (keys stay server-side). */
export function aiConfigFromEnv(env: {
  AI_PROVIDER_ORDER: string;
  GROQ_API_KEY?: string;
  GEMINI_API_KEY?: string;
  AI_MODEL_GROQ: string;
  AI_MODEL_GROQ_QUALITY: string;
  AI_MODEL_GEMINI: string;
  AI_MODEL_GEMINI_FALLBACKS: string;
  AI_REQUEST_TIMEOUT_MS: number;
}): AiConfig {
  return {
    providerOrder: selectProviders(env.AI_PROVIDER_ORDER.split(',')),
    groqApiKey: env.GROQ_API_KEY,
    geminiApiKey: env.GEMINI_API_KEY,
    groqModel: env.AI_MODEL_GROQ,
    groqQualityModel: env.AI_MODEL_GROQ_QUALITY,
    geminiModel: env.AI_MODEL_GEMINI,
    geminiFallbackModels: env.AI_MODEL_GEMINI_FALLBACKS.split(',')
      .map((m) => m.trim())
      .filter((m) => m.length > 0),
    timeoutMs: env.AI_REQUEST_TIMEOUT_MS,
  };
}

interface ProviderFailure {
  provider: AiProvider;
  status: number | null;
  retryable: boolean;
  quotaExceeded: boolean;
  message: string;
}

function errorMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/**
 * Models to try for one provider, in order. An explicit input.model wins.
 * Gemini gets its per-model fallback chain (verified roster 2026-11-15:
 * gemini-3.8-flash → 3.6-flash → 3.5-flash-lite → 3.1-flash-lite) because a
 * single Gemini generate call returned HTTP 503 once — generation through
 * any one model is not yet proven live. Groq gets the quality-tier model
 * when the caller asks for quality.
 */
function modelsFor(provider: AiProvider, config: AiConfig, input: GenerateCompletionInput): string[] {
  if (input.model) return [input.model];
  if (provider === 'groq') {
    return [input.quality ? config.groqQualityModel : config.groqModel];
  }
  return [config.geminiModel, ...config.geminiFallbackModels];
}

async function callProvider(
  provider: AiProvider,
  config: AiConfig,
  input: GenerateCompletionInput,
  fetchFn: typeof fetch,
  model: string,
): Promise<CompletionResult> {
  const apiKey = provider === 'groq' ? config.groqApiKey : config.geminiApiKey;
  if (!apiKey) {
    const failure: ProviderFailure = {
      provider,
      status: null,
      retryable: false,
      quotaExceeded: false,
      message: `Provider ${provider} is not configured (no API key)`,
    };
    throw failure;
  }
  const started = Date.now();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), config.timeoutMs);
  try {
    const res = await fetchFn(PROVIDER_URLS[provider], {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        // Groq sits behind Cloudflare: requests without a browser-like
        // User-Agent are rejected with HTTP 403 (error 1010). Verified
        // live 2026-11-15 — the AI client MUST send one.
        'User-Agent': AI_HTTP_USER_AGENT,
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model,
        messages: input.messages,
        temperature: 0.3,
        max_tokens: input.maxTokens ?? 500,
      }),
      signal: controller.signal,
    });
    const latencyMs = Date.now() - started;
    if (!res.ok) {
      const status = res.status;
      const failure: ProviderFailure = {
        provider,
        status,
        retryable: status === 429 || status >= 500,
        quotaExceeded: status === 429,
        message: `Provider ${provider} returned HTTP ${status}`,
      };
      throw failure;
    }
    const body = (await res.json()) as {
      choices?: Array<{ message?: { content?: unknown } }>;
      usage?: { prompt_tokens?: number; completion_tokens?: number };
    };
    const text = body?.choices?.[0]?.message?.content;
    if (typeof text !== 'string' || text.trim().length === 0) {
      const failure: ProviderFailure = {
        provider,
        status: null,
        retryable: true,
        quotaExceeded: false,
        message: `Provider ${provider} returned an empty or invalid response`,
      };
      throw failure;
    }
    return {
      text: text.trim(),
      provider,
      model,
      promptTokens: body.usage?.prompt_tokens ?? null,
      completionTokens: body.usage?.completion_tokens ?? null,
      latencyMs,
    };
  } catch (e) {
    if (e && typeof e === 'object' && 'provider' in (e as Record<string, unknown>)) {
      throw e as ProviderFailure;
    }
    const isAbort =
      (e as Error)?.name === 'AbortError' || errorMessage(e).toLowerCase().includes('abort');
    const failure: ProviderFailure = {
      provider,
      status: null,
      retryable: true,
      quotaExceeded: false,
      message: isAbort
        ? `Provider ${provider} timed out after ${config.timeoutMs}ms`
        : `Provider ${provider} request failed: ${errorMessage(e)}`,
    };
    throw failure;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Generate a completion, trying providers in config order. A 429/quota,
 * 5xx, network, timeout or empty-response failure falls through to the
 * next provider. When every provider fails (or none is configured) an
 * AiUnavailableError is thrown — the caller must escalate, never invent.
 */
export async function generateCompletion(
  input: GenerateCompletionInput,
  config: AiConfig,
  fetchFn: typeof fetch = fetch,
): Promise<CompletionResult> {
  const providers = selectProviders(config.providerOrder);
  const configured = providers.filter(
    (p) => (p === 'groq' ? config.groqApiKey : config.geminiApiKey),
  );
  if (configured.length === 0) {
    throw new AiUnavailableError('No AI provider is configured', {
      provider: 'none',
      status: null,
      retryable: false,
      quotaExceeded: false,
    });
  }
  let lastFailure: ProviderFailure | null = null;
  for (const provider of providers) {
    // Per-model chain (Gemini fallbacks): a 429/quota, 5xx, network,
    // timeout or empty-response failure moves to the next model, then to
    // the next provider.
    const models = modelsFor(provider, config, input);
    for (const model of models) {
      try {
        return await callProvider(provider, config, input, fetchFn, model);
      } catch (e) {
        lastFailure = e as ProviderFailure;
        if (!lastFailure.retryable && lastFailure.status === null) {
          // Unconfigured provider (no key): do not waste calls on its
          // fallback models; move to the next provider.
          break;
        }
        // Fall through to the next model / provider.
      }
    }
  }
  if (!lastFailure) {
    throw new AiUnavailableError('No AI provider is configured', {
      provider: 'none',
      status: null,
      retryable: false,
      quotaExceeded: false,
    });
  }
  const detail = lastFailure.quotaExceeded
    ? ' (quota / rate limit exceeded — the provider refused the request; this is surfaced, not hidden)'
    : '';
  throw new AiUnavailableError(
    `All AI providers failed. Last failure: ${lastFailure.message}${detail}`,
    {
      provider: lastFailure.provider,
      status: lastFailure.status,
      retryable: lastFailure.retryable,
      quotaExceeded: lastFailure.quotaExceeded,
    },
  );
}
