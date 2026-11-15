import { AI_HTTP_USER_AGENT } from '../env.js';

/**
 * Shared POST helper for AI provider calls (Groq, Gemini).
 *
 * Groq sits behind Cloudflare: requests WITHOUT a browser User-Agent are
 * rejected with HTTP 403 error code 1010. Every provider request MUST
 * carry the browser-like User-Agent exported as AI_HTTP_USER_AGENT —
 * this helper is the single place that sets it, so provider clients
 * should route their outgoing calls through here instead of calling
 * fetch() directly. See docs/phase3-ai-providers.md.
 */
export async function postToProvider(
  url: string,
  opts: { apiKey?: string; body: unknown },
): Promise<Response> {
  return fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'User-Agent': AI_HTTP_USER_AGENT,
      ...(opts.apiKey ? { Authorization: `Bearer ${opts.apiKey}` } : {}),
    },
    body: JSON.stringify(opts.body),
  });
}
