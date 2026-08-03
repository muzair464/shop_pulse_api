import { NextRequest } from 'next/server';
import { getAuthPool } from '@/lib/db';
import { supabaseRevokeUserSession } from '@/lib/auth.service';
import { withAuth } from '@/lib/requireAuth';
import { logger } from '@/lib/logger';

type Ctx = { params: Promise<{ deviceId: string }> };

export const DELETE = withAuth(async (_req, user, ctx) => {
  const { deviceId } = await ctx!.params;
  const pool = getAuthPool();

  const { rows } = await pool.query<{ id: string; session_id: string | null }>(
    `SELECT id, session_id FROM devices WHERE id=$1 AND user_id=$2`,
    [deviceId, user.userId],
  );
  if (!rows[0]) return Response.json({ error: 'Device not found.' }, { status: 404 });

  await pool.query(`UPDATE devices SET revoked_at=now() WHERE id=$1`, [deviceId]);
  if (rows[0].session_id) void supabaseRevokeUserSession(rows[0].session_id);

  // Signal via Supabase Realtime broadcast — Angular client listens on
  // channel "device:{deviceId}" for the session_revoked event.
  // The Angular RealtimeSyncService handles this and signs the user out.
  logger.info('Device revoked', { deviceId, revokedBy: user.userId });

  return new Response(null, { status: 204 });
}) as (req: NextRequest, ctx: Ctx) => Promise<Response>;
