import { NextRequest } from 'next/server';
import { getAuthPool, setJwtClaims } from '@/lib/db';
import { requireAuth, handleErrors } from '@/lib/requireAuth';

// Large page size — the full order history is needed for local persistence.
// RLS ensures users only ever see their own shop's orders.
const PAGE_SIZE = 500;

export async function GET(req: NextRequest): Promise<Response> {
  return handleErrors(async () => {
    const user = await requireAuth(req);
    const sp   = new URL(req.url).searchParams;

    // Delta sync cursor — only return orders created after this timestamp.
    // When absent, the full history is returned (first-ever sync).
    const createdAfter = sp.get('createdAfter'); // ISO-8601 or null

    const page   = Math.max(1, parseInt(sp.get('page') ?? '1', 10));
    const offset = (page - 1) * PAGE_SIZE;

    const client = await getAuthPool().connect();
    try {
      await setJwtClaims(client, user.claims);
      const { rows } = await client.query(
        `SELECT * FROM orders
         WHERE  shop_id = $1
         AND    ($2::text IS NULL OR channel = $2::order_channel)
         AND    ($3::timestamptz IS NULL OR created_at > $3::timestamptz)
         ORDER  BY created_at DESC
         LIMIT  $4 OFFSET $5`,
        [
          user.shopId,
          sp.get('channel') ?? null,
          createdAfter      ?? null,
          PAGE_SIZE,
          offset,
        ],
      );

      // Return server-side now() as the next sync cursor to avoid
      // client/server clock skew.
      const { rows: tsRows } = await client.query<{ now: string }>('SELECT now() AS now');
      return Response.json({ orders: rows, syncedAt: tsRows[0].now });
    } finally { client.release(); }
  });
}
