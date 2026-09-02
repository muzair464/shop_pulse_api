import { NextRequest } from 'next/server';
import { getAuthPool, setJwtClaims } from '@/lib/db';
import { requireAuth, handleErrors } from '@/lib/requireAuth';

/**
 * GET /api/v1/backup/export — Full shop backup as JSON
 * 
 * This is intentionally NOT sub-100ms optimized - it's a bulk export operation.
 * Uses separate parallel connections to avoid blocking on one serial connection.
 * 
 * For very large datasets (>50k orders), consider paginating or moving to a
 * background job pattern via the cron endpoint.
 */
export async function GET(req: NextRequest): Promise<Response> {
  return handleErrors(async () => {
    const user = await requireAuth(req);
    const pool = getAuthPool();

    // Execute in parallel with separate connections for better performance
    const [shopRes, invRes, ordRes] = await Promise.all([
      (async () => {
        const client = await pool.connect();
        try {
          await setJwtClaims(client, user.claims);
          return await client.query(`SELECT * FROM shops WHERE owner_user_id=$1`, [user.userId]);
        } finally { client.release(); }
      })(),

      (async () => {
        const client = await pool.connect();
        try {
          await setJwtClaims(client, user.claims);
          return await client.query(
            `SELECT * FROM inventory_items WHERE shop_id=$1 ORDER BY name LIMIT 10000`,
            [user.shopId]
          );
        } finally { client.release(); }
      })(),

      (async () => {
        const client = await pool.connect();
        try {
          await setJwtClaims(client, user.claims);
          // Limit to most recent 10k orders to prevent timeout - older exports can use cron job
          return await client.query(
            `SELECT * FROM orders WHERE shop_id=$1 ORDER BY created_at DESC LIMIT 10000`,
            [user.shopId]
          );
        } finally { client.release(); }
      })(),
    ]);

    const backup = {
      exportedAt: new Date().toISOString(),
      shop:       shopRes.rows[0] ?? null,
      inventory:  invRes.rows,
      orders:     ordRes.rows,
      truncated:  {
        inventory: invRes.rows.length === 10000,
        orders:    ordRes.rows.length === 10000,
      },
    };

    const filename = `shoppulse-backup-${new Date().toISOString().slice(0, 10)}.json`;
    return new Response(JSON.stringify(backup), {
      headers: {
        'Content-Type': 'application/json',
        'Content-Disposition': `attachment; filename="${filename}"`,
      },
    });
  });
}
