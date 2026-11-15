import { createHmac, timingSafeEqual } from 'node:crypto';

/**
 * HMAC webhook signing shared by the API and the outbox dispatcher
 * (apps/worker). The signed payload is `${timestamp}.${rawBody}` and
 * the signature is HMAC-SHA256 hex, returned with the `sha256=` prefix
 * (the exact wire format — the value goes straight into the
 * `x-sf-signature` header). Only dependency is node:crypto.
 *
 * Verification never throws on malformed input: bad timestamps, missing
 * or wrong-length signatures and stale timestamps all return false.
 * Timestamps are Unix seconds; a request older than `toleranceSeconds`
 * (or that far in the future, allowing for clock skew) is rejected
 * (replay window). The signature comparison is constant time
 * (crypto.timingSafeEqual with an equal-length guard).
 */

/** Header names carried on every signed webhook delivery. */
export const WEBHOOK_HEADERS = {
  signature: 'x-sf-signature',
  timestamp: 'x-sf-timestamp',
} as const;

/**
 * Sign a raw request body. Returns the header value `sha256=<hex>`.
 * `timestamp` defaults to now (Unix seconds); pass it explicitly when
 * the caller also needs the timestamp value (e.g. to set the
 * `x-sf-timestamp` header alongside the signature).
 */
export function signWebhook(secret: string, rawBody: string, timestamp?: number): string {
  const ts = timestamp ?? Math.floor(Date.now() / 1000);
  const hmac = createHmac('sha256', secret)
    .update(`${Math.floor(ts)}.${rawBody}`)
    .digest('hex');
  return `sha256=${hmac}`;
}

/**
 * Verify a signature produced by signWebhook. Returns false (never
 * throws) when the secret or signature is missing, the timestamp is
 * non-numeric, in the future beyond the tolerance, or older than
 * `toleranceSeconds`, or when the signature does not match.
 */
export function verifyWebhook(
  secret: string,
  rawBody: string,
  signature: string | null | undefined,
  timestamp: string | number | null | undefined,
  toleranceSeconds = 300,
): boolean {
  try {
    if (!secret || !signature || typeof signature !== 'string') return false;
    const ts = typeof timestamp === 'string' ? Number(timestamp) : timestamp;
    if (typeof ts !== 'number' || !Number.isFinite(ts)) return false;
    const now = Math.floor(Date.now() / 1000);
    // Reject timestamps too far in the past OR the future (clock skew).
    if (Math.abs(now - ts) > toleranceSeconds) return false;
    const expected = signWebhook(secret, rawBody, Math.floor(ts));
    const a = Buffer.from(signature, 'utf8');
    const b = Buffer.from(expected, 'utf8');
    if (a.length !== b.length) return false;
    return timingSafeEqual(a, b);
  } catch {
    return false;
  }
}

export type WebhookHeadersInput = Record<string, string | string[] | undefined>;

/**
 * Verify a signed inbound webhook request from its headers + raw body.
 * Header lookup is case-insensitive. Missing headers, a bad signature,
 * or a stale timestamp all return false — the caller should answer 401
 * and never process the body.
 */
export function verifyWebhookRequest(
  headers: WebhookHeadersInput,
  rawBody: string,
  secret: string,
  toleranceSeconds = 300,
): boolean {
  const pick = (name: string): string | undefined => {
    for (const [key, value] of Object.entries(headers)) {
      if (key.toLowerCase() === name) {
        return Array.isArray(value) ? value[0] : value;
      }
    }
    return undefined;
  };
  return verifyWebhook(
    secret,
    rawBody,
    pick(WEBHOOK_HEADERS.signature),
    pick(WEBHOOK_HEADERS.timestamp),
    toleranceSeconds,
  );
}
