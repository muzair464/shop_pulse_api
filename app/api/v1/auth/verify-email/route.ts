import { NextRequest } from 'next/server';
import { supabaseExchangeOtp } from '@/lib/auth.service';
import { verifySupabaseJwt } from '@/lib/verifyJwt';
import { getAuthPool } from '@/lib/db';
import { jsonWithCookies } from '@/lib/cookieHelpers';
import { handleErrors } from '@/lib/requireAuth';
import { logger } from '@/lib/logger';

export async function POST(req: NextRequest): Promise<Response> {
  return handleErrors(async () => {
    const { tokenHash } = await req.json() as { tokenHash?: string };
    if (!tokenHash) return Response.json({ error: 'tokenHash is required.' }, { status: 400 });

    const tokens  = await supabaseExchangeOtp(tokenHash, 'email');
    const userId  = tokens.user.id;
    const pool    = getAuthPool();

    const shopRes = await pool.query<{ id: string; name: string }>(
      `SELECT id, name FROM shops WHERE owner_user_id = $1 LIMIT 1`, [userId],
    );
    const shop = shopRes.rows[0] ?? null;

    // Extract the real Supabase session_id from the JWT (same fix as signin).
    let realSessionId: string | null = null;
    try {
      const payload = await verifySupabaseJwt(tokens.access_token);
      realSessionId = (payload['session_id'] as string | undefined) ?? null;
    } catch { /* degraded device tracking — sign-in still succeeds */ }

    const deviceName = (req.headers.get('user-agent') ?? 'Unknown Device').slice(0, 120);
    await pool.query(
      `INSERT INTO devices (user_id, session_id, device_name, last_active_at) VALUES ($1, $2::uuid, $3, now())`,
      [userId, realSessionId, deviceName],
    );

    logger.info('Email verified', { userId, shopId: shop?.id ?? null });
    // Email verification links don't have a "remember me" checkbox — default
    // to session-only cookies (rememberDevice = false).
    return jsonWithCookies(
      { ok: true, user: { id: userId, email: tokens.user.email }, shop: shop ? { id: shop.id, name: shop.name } : null },
      tokens.access_token, tokens.refresh_token, tokens.expires_in,
      200, false,
    );
  });
}
