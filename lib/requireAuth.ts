/**
 * lib/requireAuth.ts — authentication helper for Next.js Route Handlers.
 *
 * Usage in a Route Handler:
 *   const user = await requireAuth(request);
 *   // throws a Response with 401 JSON if not authenticated
 */

import { cookies } from 'next/headers';
import { verifySupabaseJwt } from './verifyJwt';
import { getAuthPool } from './db';
import { logger } from './logger';

export interface AuthedUser {
  userId:   string;
  shopId:   string;
  email:    string;
  deviceId: string | null;
  claims:   Record<string, unknown>;
}

/** Thrown when authentication fails — caught by Route Handlers to return 401. */
export class AuthError extends Error {
  readonly status: number;
  constructor(message: string, status = 401) {
    super(message);
    this.name  = 'AuthError';
    this.status = status;
  }
}

export async function requireAuth(request: Request): Promise<AuthedUser> {
  // ── 1. Extract cookie from the request ────────────────────────────────────
  // In Next.js 15 Route Handlers we can read cookies either from the
  // incoming Request headers or via next/headers cookies() helper.
  // We read from the Request directly so this function is pure.
  const cookieHeader = request.headers.get('cookie') ?? '';
  const token        = parseCookie(cookieHeader, 'access_token');

  if (!token) throw new AuthError('Not authenticated.');

  // ── 2. Verify JWT ─────────────────────────────────────────────────────────
  let payload;
  try {
    payload = await verifySupabaseJwt(token);
  } catch (err) {
    logger.debug('JWT verification failed', err);
    throw new AuthError('Invalid or expired session.');
  }

  const userId = payload.sub;
  if (!userId) throw new AuthError('Invalid token claims.');

  const sessionId = payload['session_id'] as string | undefined;
  const claims    = payload as unknown as Record<string, unknown>;

  // ── 3. Resolve shop + check device revocation ─────────────────────────────
  const pool = getAuthPool();
  const { rows } = await pool.query<{
    shop_id: string; device_id: string | null; revoked_at: string | null; email: string;
  }>(
    `SELECT s.id AS shop_id, d.id AS device_id, d.revoked_at, u.email
     FROM   auth.users u
     JOIN   shops s ON s.owner_user_id = u.id
     LEFT JOIN devices d ON d.user_id = u.id AND d.session_id = $2::uuid
     WHERE  u.id = $1::uuid LIMIT 1`,
    [userId, sessionId ?? null],
  );

  if (rows.length === 0) throw new AuthError('User or shop not found.');
  const row = rows[0];
  if (row.revoked_at)  throw new AuthError('This device session has been revoked.');

  // ── 4. Bump last_active_at (fire-and-forget) ──────────────────────────────
  if (row.device_id) {
    pool.query(`UPDATE devices SET last_active_at = now() WHERE id = $1`, [row.device_id])
      .catch((err: unknown) => logger.warn('Failed to bump last_active_at', err));
  }

  return { userId, shopId: row.shop_id, email: row.email, deviceId: row.device_id, claims };
}

/** Wrap a Route Handler with error handling for AuthError and generic errors. */
export function withAuth(
  handler: (req: Request, user: AuthedUser, ctx?: { params: Promise<Record<string, string>> }) => Promise<Response>,
) {
  return async (req: Request, ctx?: { params: Promise<Record<string, string>> }): Promise<Response> => {
    try {
      const user = await requireAuth(req);
      return await handler(req, user, ctx);
    } catch (err) {
      if (err instanceof AuthError) {
        return Response.json({ error: err.message }, { status: err.status });
      }
      const appErr = err as { code?: string; statusCode?: number; message?: string };
      if (appErr.code === 'P0001') return Response.json({ error: appErr.message }, { status: 409 });
      if (appErr.statusCode)       return Response.json({ error: appErr.message }, { status: appErr.statusCode });
      logger.error('Unhandled Route Handler error', err);
      return Response.json({ error: 'An unexpected error occurred.' }, { status: 500 });
    }
  };
}

/** Wrap a public Route Handler (no auth) with generic error handling only. */
export function withHandler(
  handler: (req: Request, ctx?: { params: Promise<Record<string, string>> }) => Promise<Response>,
) {
  return async (req: Request, ctx?: { params: Promise<Record<string, string>> }): Promise<Response> => {
    try {
      return await handler(req, ctx);
    } catch (err) {
      const appErr = err as { statusCode?: number; message?: string };
      if (appErr.statusCode) return Response.json({ error: appErr.message }, { status: appErr.statusCode });
      logger.error('Unhandled Route Handler error', err);
      return Response.json({ error: 'An unexpected error occurred.' }, { status: 500 });
    }
  };
}

function parseCookie(header: string, name: string): string | undefined {
  const match = header.match(new RegExp(`(?:^|;\\s*)${name}=([^;]*)`));
  return match ? decodeURIComponent(match[1]) : undefined;
}
