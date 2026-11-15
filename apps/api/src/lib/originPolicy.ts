/**
 * Origin validation / normalisation for the public chat widget (Phase 2.1,
 * Issue 4). Pure functions — no I/O, no framework dependency — so they are
 * unit-testable in isolation.
 *
 * ARCHITECTURAL FACT: the widget is an iframe served from the SAME app as
 * the dashboard (the /widget-embed page on the frontend origin). API calls
 * made from inside the iframe therefore carry the IFRAME's origin (the app's
 * own frontend origin), NOT the embedding site's origin. A naive
 * Origin-header check on widget endpoints would check the wrong origin and
 * break legitimate use. The embedding page's origin is only available to
 * the iframe as a client-asserted value (document.referrer, or a
 * postMessage hint). These helpers validate and normalise that claimed
 * origin; they cannot prove it. See docs/phase2-1-origins.md for the full
 * design and the honest limitations (spoofing, no frame-ancestors).
 */

/** Maximum length of a single origin string (matches the shared schema). */
export const MAX_ORIGIN_LENGTH = 200;

/**
 * Normalise a claimed origin to its canonical `scheme://host[:port]` form,
 * or return null when the value is not a usable origin.
 *
 * Rules:
 * - Parsed with the URL constructor; anything unparsable is rejected.
 * - https is required, EXCEPT http for `localhost` (local dev only).
 * - Host is lowercased; the default port is dropped by URL.origin, a
 *   non-default port is kept, so `https://example.com:8443` and
 *   `https://example.com` are different origins (exact scheme+host+port
 *   match).
 * - No wildcards (`https://*.example.com` is unparsable and rejected).
 * - A trailing slash, path, query or fragment is stripped (only the
 *   origin part is kept), so `https://example.com/` and
 *   `https://example.com` normalise to the same value.
 * - Userinfo / embedded credentials (`https://user:pass@example.com`)
 *   are rejected.
 * - Empty / non-string / over-length values are rejected.
 */
export function normalizeOrigin(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const trimmed = raw.trim();
  if (!trimmed || trimmed.length > MAX_ORIGIN_LENGTH) return null;
  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    return null;
  }
  if (url.username !== '' || url.password !== '') return null;
  const protocol = url.protocol.toLowerCase();
  const host = url.hostname.toLowerCase();
  if (!host || host.includes('*')) return null;
  const isLocalhost = host === 'localhost' || host.endsWith('.localhost');
  if (isLocalhost) {
    if (protocol !== 'http:' && protocol !== 'https:') return null;
  } else if (protocol !== 'https:') {
    return null;
  }
  return url.origin;
}

/** True when `claimed` (already normalised, or raw) is the app's own frontend origin. */
export function isOwnOrigin(claimed: string | null, frontendUrl: string): boolean {
  if (!claimed) return false;
  const own = normalizeOrigin(frontendUrl);
  return own !== null && claimed === own;
}

export interface ParentOriginCheck {
  /** Claimed parent origin, already normalised (null when absent/invalid). */
  claimed: string | null;
  /** The widget's stored allow-list (raw values; normalised here). */
  allowedOrigins: string[];
  /** The app's own frontend origin (env.FRONTEND_URL). */
  frontendUrl: string;
}

/**
 * Decide whether a claimed parent origin may use a widget.
 *
 * - Empty allow-list (secure default): ONLY the app's own frontend origin
 *   is allowed (this is what the in-app /widget-demo preview uses). Any
 *   foreign origin — or no claimed origin at all — is rejected.
 * - Non-empty allow-list: the claimed origin must exactly match one entry
 *   (after normalisation). No claimed origin at all is rejected: membership
 *   cannot be proven without a claim.
 */
export function isAllowedParentOrigin(check: ParentOriginCheck): boolean {
  const { claimed, allowedOrigins, frontendUrl } = check;
  if (!claimed) return false;
  const normalisedList = allowedOrigins
    .map((o) => normalizeOrigin(o))
    .filter((o): o is string => o !== null);
  if (normalisedList.length === 0) {
    return isOwnOrigin(claimed, frontendUrl);
  }
  return normalisedList.includes(claimed);
}

/**
 * Normalise a whole allow-list for storage (widget-settings save).
 * Throws an Error naming the first invalid entry; the caller converts it
 * to a 400. Duplicates (after normalisation) are removed, order kept.
 */
export function normalizeAllowedOrigins(origins: unknown): string[] {
  if (!Array.isArray(origins)) {
    throw new Error('allowed_origins must be an array of origins');
  }
  const out: string[] = [];
  for (const entry of origins) {
    const normalised = normalizeOrigin(entry);
    if (!normalised) {
      throw new Error(`Invalid allowed origin: ${typeof entry === 'string' ? entry : 'not a valid origin'}`);
    }
    if (!out.includes(normalised)) out.push(normalised);
  }
  return out;
}
