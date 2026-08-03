import { NextRequest } from 'next/server';
import { getAuthPool } from '@/lib/db';
import { requireAuth, handleErrors } from '@/lib/requireAuth';

export async function GET(req: NextRequest): Promise<Response> {
  return handleErrors(async () => {
    const user   = await requireAuth(req);
    const { rows } = await getAuthPool().query(
      `SELECT id AS "deviceId", device_name AS "deviceName", last_active_at AS "lastActiveAt",
              created_at AS "createdAt", ($2::uuid IS NOT NULL AND id=$2::uuid) AS current
       FROM devices WHERE user_id=$1 AND revoked_at IS NULL ORDER BY last_active_at DESC`,
      [user.userId, user.deviceId],
    );
    return Response.json(rows);
  });
}
