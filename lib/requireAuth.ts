/**
 * lib/requireAuth.ts — authentication helper for Next.js Route Handlers.
 *
 * Pattern: call requireAuth(request) at the top of each Route Handler.
 * It returns AuthedUser on success, or throws AuthError on failure.
 * Each Route Handler wraps its body in handleErrors() for consistent
 * error responses — no wrapper functions needed, so Next.js types stay clean.
 *
 * Usage:
 *   export async function GET(req: NextRequest) {
 *     return handleErrors(async () => {
 *       const user = await requireAuth(req);
 *       ...
 *     });
 *   }
 */

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

/** Thrown when authentication fails — caught by handleErrors() to return 401. */
export class AuthError extends Error {
  readonly status: number;
  constructor(message: string, status = 401) {
    super(message);
    this.name   = 'AuthError';
    this.status = status;
  }
}

/** Thrown by route logic to return a specific HTTP status. */
export class AppError extends Error {
  readonly status: number;
  constructor(message: string, status: number) {
    super(message);
    this.name   = 'AppError';
    this.status = status;
  }
}

/**
 * Verify the httpOnly access_token cookie and resolve the user + shop.
 * Throws AuthError on any failure — never returns null.
 */
export async function requireAuth(request: Request): Promise<AuthedUser> {
  const cookieHeader = request.headers.get('cookie') ?? '';
  const token        = parseCookie(cookieHeader, 'access_token');
  if (!token) throw new AuthError('Not authenticated.');

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
  if (rows[0].revoked_at) throw new AuthError('This device session has been revoked.');

  // Bump last_active_at fire-and-forget.
  if (rows[0].device_id) {
    pool.query(`UPDATE devices SET last_active_at = now() WHERE id = $1`, [rows[0].device_id])
      .catch((e: unknown) => logger.warn('Failed to bump last_active_at', e));
  }

  return {
    userId,
    shopId:   rows[0].shop_id,
    email:    rows[0].email,
    deviceId: rows[0].device_id,
    claims,
  };
}

/**
 * Wraps Route Handler logic with consistent error handling.
 * Catches AuthError → 401, AppError → custom status, pg P0001 → 409, else 500.
 */
export async function handleErrors(fn: () => Promise<Response>): Promise<Response> {
  try {
    return await fn();
  } catch (err) {
    if (err instanceof AuthError) {
      return Response.json({ error: err.message }, { status: err.status });
    }
    if (err instanceof AppError) {
      return Response.json({ error: err.message }, { status: err.status });
    }
    const pgErr = err as { code?: string; statusCode?: number; message?: string };
    if (pgErr.code === 'P0001') return Response.json({ error: pgErr.message }, { status: 409 });
    // Unique constraint violation — surface as 409 rather than 500.
    if (pgErr.code === '23505') return Response.json({ error: 'A record with this value already exists.' }, { status: 409 });
    if (pgErr.statusCode)       return Response.json({ error: pgErr.message }, { status: pgErr.statusCode });
    // Use console.error so it always appears in Vercel function logs.
    console.error('[handleErrors] Unhandled Route Handler error:', err);
    logger.error('Unhandled Route Handler error', err);
    return Response.json({ error: 'An unexpected error occurred.' }, { status: 500 });
  }
}

export function parseCookie(header: string, name: string): string | undefined {
  const match = header.match(new RegExp(`(?:^|;\\s*)${name}=([^;]*)`));
  return match ? decodeURIComponent(match[1]) : undefined;
}
