import { NextRequest } from 'next/server';
import { getAuthPool, setJwtClaims } from '@/lib/db';
import { requireAuth, handleErrors } from '@/lib/requireAuth';

export async function GET(req: NextRequest): Promise<Response> {
  return handleErrors(async () => {
    const user   = await requireAuth(req);
    const client = await getAuthPool().connect();
    try {
      await setJwtClaims(client, user.claims);
      const [shopRes, invRes, ordRes] = await Promise.all([
        client.query(`SELECT * FROM shops WHERE owner_user_id=$1`, [user.userId]),
        client.query(`SELECT * FROM inventory_items WHERE shop_id=$1 ORDER BY name`, [user.shopId]),
        client.query(`SELECT * FROM orders WHERE shop_id=$1 ORDER BY created_at DESC`, [user.shopId]),
      ]);
      const backup = {
        exportedAt: new Date().toISOString(),
        shop:       shopRes.rows[0] ?? null,
        inventory:  invRes.rows,
        orders:     ordRes.rows,
      };
      const filename = `shoppulse-backup-${new Date().toISOString().slice(0, 10)}.json`;
      return new Response(JSON.stringify(backup), {
        headers: { 'Content-Type': 'application/json', 'Content-Disposition': `attachment; filename="${filename}"` },
      });
    } finally { client.release(); }
  });
}
