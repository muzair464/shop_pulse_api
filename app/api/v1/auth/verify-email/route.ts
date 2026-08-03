import { NextRequest } from 'next/server';
import { v4 as uuidv4 } from 'uuid';
import { supabaseExchangeOtp } from '@/lib/auth.service';
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

    const deviceName = (req.headers.get('user-agent') ?? 'Unknown Device').slice(0, 120);
    await pool.query(
      `INSERT INTO devices (user_id, session_id, device_name, last_active_at) VALUES ($1, $2::uuid, $3, now())`,
      [userId, uuidv4(), deviceName],
    );

    logger.info('Email verified', { userId, shopId: shop?.id ?? null });
    return jsonWithCookies(
      { ok: true, user: { id: userId, email: tokens.user.email }, shop: shop ? { id: shop.id, name: shop.name } : null },
      tokens.access_token, tokens.refresh_token, tokens.expires_in,
    );
  });
}
