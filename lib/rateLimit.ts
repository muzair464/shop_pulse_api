/**
 * lib/rateLimit.ts — lightweight in-process rate limiter.
 *
 * Uses a sliding-window counter stored in module-level memory.
 * Works correctly within a single Vercel function instance (warm reuse).
 * Across cold starts / multiple instances each gets its own counter,
 * so the effective limit is per-instance rather than globally enforced.
 *
 * For a single-shop app with a single owner this is sufficient protection
 * against brute-force from a single source. If stronger global enforcement
 * is needed, swap the Map for an Upstash Redis store using
 * @upstash/ratelimit — the interface below is designed to be drop-in
 * replaceable without changing the call sites.
 */

interface Window {
  count:     number;
  resetAt:   number;  // Unix ms
}

const store = new Map<string, Window>();

/** Clean up expired windows to prevent unbounded memory growth. */
function evictExpired(): void {
  const now = Date.now();
  for (const [key, win] of store) {
    if (win.resetAt <= now) store.delete(key);
  }
}

/**
 * Check whether `key` has exceeded `maxRequests` in `windowMs`.
 * Returns `{ allowed: true }` or `{ allowed: false, retryAfterMs }`.
 */
export function checkRateLimit(
  key:         string,
  maxRequests: number,
  windowMs:    number,
): { allowed: boolean; retryAfterMs?: number } {
  evictExpired();

  const now = Date.now();
  const existing = store.get(key);

  if (!existing || existing.resetAt <= now) {
    // Start a fresh window.
    store.set(key, { count: 1, resetAt: now + windowMs });
    return { allowed: true };
  }

  existing.count += 1;
  if (existing.count > maxRequests) {
    return { allowed: false, retryAfterMs: existing.resetAt - now };
  }
  return { allowed: true };
}

/**
 * Build a rate-limit key from an IP address and an optional secondary
 * discriminator (e.g. email) so per-account brute-force is caught even
 * when the attacker rotates IPs.
 */
export function rateLimitKey(req: Request, secondary?: string): string {
  // Vercel sets x-forwarded-for; fall back to a constant so the limiter
  // still works in local dev where no proxy header exists.
  const forwarded = (req.headers as Headers).get('x-forwarded-for') ?? 'local';
  const ip        = forwarded.split(',')[0].trim();
  return secondary ? `${ip}:${secondary.toLowerCase()}` : ip;
}

/** Return a 429 response with Retry-After header. */
export function tooManyRequests(retryAfterMs: number): Response {
  const retryAfterSec = Math.ceil(retryAfterMs / 1_000);
  return Response.json(
    { error: `Too many requests. Please try again in ${retryAfterSec} seconds.` },
    {
      status: 429,
      headers: { 'Retry-After': String(retryAfterSec) },
    },
  );
}
