import { NextRequest } from 'next/server';
import { getAuthPool } from '@/lib/db';
import { supabaseRevokeUserSession } from '@/lib/auth.service';
import { requireAuth, handleErrors } from '@/lib/requireAuth';
import { logger } from '@/lib/logger';

type Context = { params: Promise<{ deviceId: string }> };

export async function DELETE(req: NextRequest, { params }: Context): Promise<Response> {
  return handleErrors(async () => {
    const user           = await requireAuth(req);
    const { deviceId }   = await params;
    const pool           = getAuthPool();

    const { rows } = await pool.query<{ id: string; session_id: string | null }>(
      `SELECT id, session_id FROM devices WHERE id=$1 AND user_id=$2`,
      [deviceId, user.userId],
    );
    if (!rows[0]) return Response.json({ error: 'Device not found.' }, { status: 404 });

    await pool.query(`UPDATE devices SET revoked_at=now() WHERE id=$1`, [deviceId]);
    if (rows[0].session_id) void supabaseRevokeUserSession(rows[0].session_id);

    logger.info('Device revoked', { deviceId, revokedBy: user.userId });
    return new Response(null, { status: 204 });
  });
}
