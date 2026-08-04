/**
 * lib/cookieHelpers.ts — httpOnly cookie management for Next.js Route Handlers.
 *
 * Next.js 15 uses the Web API Response — we set cookies via the Set-Cookie
 * header rather than via res.cookie() as in Express.
 */

import { env } from './env';

const ACCESS_COOKIE  = 'access_token';
const REFRESH_COOKIE = 'refresh_token';

function cookieString(
  name: string,
  value: string,
  maxAgeSeconds: number,
): string {
  const parts = [
    `${name}=${encodeURIComponent(value)}`,
    `Max-Age=${maxAgeSeconds}`,
    'Path=/',
    'HttpOnly',
    `SameSite=${env.COOKIE_SAME_SITE}`,
  ];
  if (env.COOKIE_SECURE)                           parts.push('Secure');
  if (env.COOKIE_DOMAIN && env.COOKIE_DOMAIN !== 'none') parts.push(`Domain=${env.COOKIE_DOMAIN}`);
  return parts.join('; ');
}

function clearCookieString(name: string): string {
  const parts = [`${name}=`, 'Max-Age=0', 'Path=/', 'HttpOnly', `SameSite=${env.COOKIE_SAME_SITE}`];
  if (env.COOKIE_SECURE)                           parts.push('Secure');
  if (env.COOKIE_DOMAIN && env.COOKIE_DOMAIN !== 'none') parts.push(`Domain=${env.COOKIE_DOMAIN}`);
  return parts.join('; ');
}

/** Append Set-Cookie headers for both tokens onto an existing Response headers object. */
export function appendAuthCookies(
  headers: Headers,
  accessToken:  string,
  refreshToken: string,
  expiresInSeconds: number,
  rememberDevice = false,
): void {
  // When "remember this device" is checked keep the access token for 30 days,
  // otherwise honour the server-supplied expiry (typically 1 hour).
  const accessMaxAge  = rememberDevice ? 30 * 24 * 60 * 60 : expiresInSeconds;
  const refreshMaxAge = 30 * 24 * 60 * 60;
  headers.append('Set-Cookie', cookieString(ACCESS_COOKIE,  accessToken,  accessMaxAge));
  headers.append('Set-Cookie', cookieString(REFRESH_COOKIE, refreshToken, refreshMaxAge));
}

/** Append clearing Set-Cookie headers to sign the user out. */
export function appendClearCookies(headers: Headers): void {
  headers.append('Set-Cookie', clearCookieString(ACCESS_COOKIE));
  headers.append('Set-Cookie', clearCookieString(REFRESH_COOKIE));
}

/** Convenience: build a JSON Response that also sets auth cookies. */
export function jsonWithCookies(
  body: unknown,
  accessToken:  string,
  refreshToken: string,
  expiresInSeconds: number,
  status = 200,
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
