import { NextRequest } from 'next/server';
import { v4 as uuidv4 } from 'uuid';
import { supabaseSignIn } from '@/lib/auth.service';
import { getAuthPool } from '@/lib/db';
import { jsonWithCookies } from '@/lib/cookieHelpers';
import { sendNewDeviceAlert } from '@/lib/email.service';
import { handleErrors } from '@/lib/requireAuth';
import { env } from '@/lib/env';
import { logger } from '@/lib/logger';

export async function POST(req: NextRequest): Promise<Response> {
  return handleErrors(async () => {
    const { email, password, rememberDevice } = await req.json() as { email?: string; password?: string; rememberDevice?: boolean };
    if (!email || !password) return Response.json({ error: 'Email and password are required.' }, { status: 400 });

    const tokens = await supabaseSignIn(email, password);
    const userId = tokens.user.id;
    const pool   = getAuthPool();

    const shopResult = await pool.query<{ id: string; name: string }>(
      `SELECT id, name FROM shops WHERE owner_user_id = $1 LIMIT 1`, [userId],
    );
    if (shopResult.rows.length === 0) return Response.json({ error: 'No shop found for this account.' }, { status: 404 });
    const shop = shopResult.rows[0];

    const deviceName = (req.headers.get('user-agent') ?? 'Unknown Device').slice(0, 120);
    const sessionId  = uuidv4();
    const deviceResult = await pool.query<{ id: string }>(
      `INSERT INTO devices (user_id, session_id, device_name, last_active_at) VALUES ($1, $2::uuid, $3, now()) RETURNING id`,
      [userId, sessionId, deviceName],
    );
    const deviceId = deviceResult.rows[0]?.id;

    logger.info('User signed in', { userId, shopId: shop.id, deviceId });
    if (deviceId && tokens.user.email) {
      try { sendNewDeviceAlert(tokens.user.email, deviceName, `${env.FRONTEND_URL}/settings`); }
      catch { /* fire-and-forget — never let email failure crash signin */ }
    }
    return jsonWithCookies(
      { user: { id: userId, email: tokens.user.email }, shop: { id: shop.id, name: shop.name } },
      tokens.access_token, tokens.refresh_token, tokens.expires_in, 200, rememberDevice === true,
    );
  });
}
