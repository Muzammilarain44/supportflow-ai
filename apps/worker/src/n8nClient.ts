import { signWebhook, WEBHOOK_HEADERS } from '../../api/src/lib/webhookAuth.js';

/**
 * Signed HTTP delivery to a webhook destination (n8n, or the API's
 * direct-processing endpoint). The body is signed with the shared
 * WEBHOOK_SECRET (HMAC-SHA256 over `${timestamp}.${rawBody}`) and the
 * signature + timestamp travel as x-sf-signature / x-sf-timestamp
 * headers so the receiver can verify the sender and reject replays.
 *
 * Network errors and timeouts are NOT thrown: they are reported as
 * { ok: false, status: null } so the dispatcher can ack 'failed' and
 * let the RPC backoff retry the event. Only a 2xx response counts as
 * delivered — anything else is a failure.
 */

export interface DeliveryResult {
  ok: boolean;
  /** HTTP status, or null when the request never got a response. */
  status: number | null;
}

export type FetchFn = typeof fetch;

export async function postSignedJson(
  url: string,
  payload: Record<string, unknown>,
  secret: string,
  timeoutMs = 15000,
  fetchFn: FetchFn = fetch,
): Promise<DeliveryResult> {
  const rawBody = JSON.stringify(payload);
  const timestamp = Math.floor(Date.now() / 1000);
  const signature = signWebhook(secret, rawBody, timestamp);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetchFn(url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        [WEBHOOK_HEADERS.signature]: signature,
        [WEBHOOK_HEADERS.timestamp]: String(timestamp),
      },
      body: rawBody,
      signal: controller.signal,
    });
    return { ok: res.status >= 200 && res.status < 300, status: res.status };
  } catch {
    // Network error, DNS failure, or AbortController timeout.
    return { ok: false, status: null };
  } finally {
    clearTimeout(timer);
  }
}
