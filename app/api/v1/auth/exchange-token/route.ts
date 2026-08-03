import { NextRequest } from 'next/server';
import { supabaseExchangeOtp } from '@/lib/auth.service';
import { getAuthPool } from '@/lib/db';
import { jsonWithCookies } from '@/lib/cookieHelpers';
import { handleErrors } from '@/lib/requireAuth';
import { logger } from '@/lib/logger';

export async function POST(req: NextRequest): Promise<Response> {
  return handleErrors(async () => {
    const { tokenHash, type } = await req.json() as { tokenHash?: string; type?: string };
    if (!tokenHash || !type) return Response.json({ error: 'tokenHash and type are required.' }, { status: 400 });

    const valid = ['invite', 'recovery', 'email'];
    if (!valid.includes(type)) return Response.json({ error: `type must be one of: ${valid.join(', ')}.` }, { status: 400 });

    const tokens  = await supabaseExchangeOtp(tokenHash, type as 'invite' | 'recovery' | 'email');
    const userId  = tokens.user.id;
    const shopRes = await getAuthPool().query<{ id: string; name: string }>(
      `SELECT id, name FROM shops WHERE owner_user_id = $1 LIMIT 1`, [userId],
    );
    const shop = shopRes.rows[0] ?? null;

    logger.info('Token exchanged', { userId, type });
    return jsonWithCookies(
      { ok: true, user: { id: userId, email: tokens.user.email }, shop: shop ? { id: shop.id, name: shop.name } : null },
      tokens.access_token, tokens.refresh_token, tokens.expires_in,
    );
  });
}
