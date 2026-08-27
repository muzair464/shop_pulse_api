import { NextRequest } from 'next/server';
import { supabaseSignIn } from '@/lib/auth.service';
import { verifySupabaseJwt } from '@/lib/verifyJwt';
import { getAuthPool } from '@/lib/db';
import { jsonWithCookies } from '@/lib/cookieHelpers';
import { sendNewDeviceAlert } from '@/lib/email.service';
import { handleErrors } from '@/lib/requireAuth';
import { checkRateLimit, rateLimitKey, tooManyRequests } from '@/lib/rateLimit';
import { env } from '@/lib/env';
import { logger } from '@/lib/logger';

// 10 attempts per 15 minutes, keyed by IP + email.
const SIGNIN_MAX      = 10;
const SIGNIN_WINDOW   = 15 * 60 * 1_000;

export async function POST(req: NextRequest): Promise<Response> {
  return handleErrors(async () => {
    const { email, password, rememberDevice } = await req.json() as {
      email?: string; password?: string; rememberDevice?: boolean;
    };
    if (!email || !password) {
      return Response.json({ error: 'Email and password are required.' }, { status: 400 });
    }

    // Rate limit: 10 attempts / 15 min per IP+email.
    const rlKey    = rateLimitKey(req, email);
    const rlResult = checkRateLimit(rlKey, SIGNIN_MAX, SIGNIN_WINDOW);
    if (!rlResult.allowed) {
      logger.warn('signin rate-limited', { email, key: rlKey });
      return tooManyRequests(rlResult.retryAfterMs!);
    }

    const tokens = await supabaseSignIn(email, password);
    const userId = tokens.user.id;
    const pool   = getAuthPool();

    const shopResult = await pool.query<{ id: string; name: string }>(
      `SELECT id, name FROM shops WHERE owner_user_id = $1 LIMIT 1`, [userId],
    );
    if (shopResult.rows.length === 0) {
      return Response.json({ error: 'No shop found for this account.' }, { status: 404 });
    }
    const shop = shopResult.rows[0];

    // ── Extract the real Supabase session_id from the JWT ─────────────────
    // The access_token is a JWT Supabase just issued over TLS — we verify it
    // (reusing existing verifySupabaseJwt) to get the real session_id claim,
    // which matches auth.sessions.id. Storing this instead of uuidv4() makes
    // the device-revocation join in requireAuth work correctly.
    let realSessionId: string | null = null;
    try {
      const payload = await verifySupabaseJwt(tokens.access_token);
      realSessionId = (payload['session_id'] as string | undefined) ?? null;
    } catch (err) {
      // Should never happen — the token came directly from Supabase over TLS.
      // Log and continue; device revocation will be degraded but sign-in works.
      logger.warn('signin: could not decode session_id from access_token', err);
    }

    const deviceName = (req.headers.get('user-agent') ?? 'Unknown Device').slice(0, 120);
    const deviceResult = await pool.query<{ id: string }>(
      `INSERT INTO devices (user_id, session_id, device_name, last_active_at)
       VALUES ($1, $2::uuid, $3, now()) RETURNING id`,
      [userId, realSessionId, deviceName],
    );
    const deviceId = deviceResult.rows[0]?.id;

    logger.info('User signed in', { userId, shopId: shop.id, deviceId });
    if (deviceId && tokens.user.email) {
      try {
        sendNewDeviceAlert(tokens.user.email, deviceName, `${env.FRONTEND_URL}/settings`);
      } catch { /* fire-and-forget — never let email failure crash signin */ }
    }

    return jsonWithCookies(
      { user: { id: userId, email: tokens.user.email }, shop: { id: shop.id, name: shop.name } },
      tokens.access_token,
      tokens.refresh_token,
      tokens.expires_in,
      200,
      rememberDevice === true,
    );
  });
}
