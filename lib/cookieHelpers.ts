/**
 * lib/cookieHelpers.ts — httpOnly cookie management for Next.js Route Handlers.
 *
 * Next.js 15 uses the Web API Response — we set cookies via the Set-Cookie
 * header rather than via res.cookie() as in Express.
 *
 * Remember-Me semantics:
 *   rememberDevice = true  → both access_token and refresh_token get a
 *                            Max-Age (30 days for refresh, expiresInSeconds
 *                            for access), so they survive browser restarts.
 *   rememberDevice = false → neither cookie gets Max-Age or Expires — they
 *                            become true browser session cookies that the
 *                            browser discards when fully closed.
 *
 * A companion non-httpOnly cookie `remember=1` (with the same lifetime as
 * the refresh cookie when rememberDevice=true, session-only otherwise) is
 * set so GET /api/v1/auth/session can detect whether to reissue persistent
 * or session-only cookies after a silent token refresh.
 */

import { env } from './env';

export const ACCESS_COOKIE   = 'access_token';
export const REFRESH_COOKIE  = 'refresh_token';
export const REMEMBER_COOKIE = 'remember';  // non-httpOnly marker

const THIRTY_DAYS = 30 * 24 * 60 * 60;

/**
 * Build a Set-Cookie header value.
 * @param maxAgeSeconds  Pass null/undefined for a session cookie (no Max-Age).
 * @param httpOnly       Whether to include the HttpOnly flag.
 */
function cookieString(
  name:          string,
  value:         string,
  maxAgeSeconds: number | null | undefined,
  httpOnly = true,
): string {
  const parts = [
    `${name}=${encodeURIComponent(value)}`,
    'Path=/',
    `SameSite=${env.COOKIE_SAME_SITE}`,
  ];
  if (maxAgeSeconds != null) parts.push(`Max-Age=${maxAgeSeconds}`);
  if (httpOnly)               parts.push('HttpOnly');
  if (env.COOKIE_SECURE)      parts.push('Secure');
  if (env.COOKIE_DOMAIN && env.COOKIE_DOMAIN !== 'none') {
    parts.push(`Domain=${env.COOKIE_DOMAIN}`);
  }
  return parts.join('; ');
}

function clearCookieString(name: string, httpOnly = true): string {
  const parts = [`${name}=`, 'Max-Age=0', 'Path=/', `SameSite=${env.COOKIE_SAME_SITE}`];
  if (httpOnly)          parts.push('HttpOnly');
  if (env.COOKIE_SECURE) parts.push('Secure');
  if (env.COOKIE_DOMAIN && env.COOKIE_DOMAIN !== 'none') {
    parts.push(`Domain=${env.COOKIE_DOMAIN}`);
  }
  return parts.join('; ');
}

/**
 * Append Set-Cookie headers for access_token, refresh_token, and the
 * non-httpOnly remember marker cookie onto an existing Headers object.
 *
 * rememberDevice = true  → persistent cookies (30-day refresh, server-expiry access)
 * rememberDevice = false → session cookies (no Max-Age on either)
 */
export function appendAuthCookies(
  headers:          Headers,
  accessToken:      string,
  refreshToken:     string,
  expiresInSeconds: number,
  rememberDevice  = false,
): void {
  const accessMaxAge  = rememberDevice ? expiresInSeconds : null;
  const refreshMaxAge = rememberDevice ? THIRTY_DAYS : null;

  headers.append('Set-Cookie', cookieString(ACCESS_COOKIE,  accessToken,  accessMaxAge));
  headers.append('Set-Cookie', cookieString(REFRESH_COOKIE, refreshToken, refreshMaxAge));
  // Non-httpOnly marker so /session can decide how to reissue cookies on silent refresh.
  headers.append('Set-Cookie', cookieString(REMEMBER_COOKIE, '1', refreshMaxAge, false));
}

/** Append clearing Set-Cookie headers to sign the user out. */
export function appendClearCookies(headers: Headers): void {
  headers.append('Set-Cookie', clearCookieString(ACCESS_COOKIE));
  headers.append('Set-Cookie', clearCookieString(REFRESH_COOKIE));
  headers.append('Set-Cookie', clearCookieString(REMEMBER_COOKIE, false));
}

/** Convenience: build a JSON Response that also sets auth cookies. */
export function jsonWithCookies(
  body:             unknown,
  accessToken:      string,
  refreshToken:     string,
  expiresInSeconds: number,
  status         = 200,
  rememberDevice = false,
): Response {
  const headers = new Headers({ 'Content-Type': 'application/json' });
  appendAuthCookies(headers, accessToken, refreshToken, expiresInSeconds, rememberDevice);
  return new Response(JSON.stringify(body), { status, headers });
}

/** Convenience: build a JSON Response that clears auth cookies (sign-out). */
export function jsonClearCookies(body: unknown, status = 200): Response {
  const headers = new Headers({ 'Content-Type': 'application/json' });
  appendClearCookies(headers);
  return new Response(JSON.stringify(body), { status, headers });
}
