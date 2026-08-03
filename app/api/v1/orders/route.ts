import { NextRequest } from 'next/server';
import { getAuthPool, setJwtClaims } from '@/lib/db';
import { requireAuth, handleErrors } from '@/lib/requireAuth';

const PAGE_SIZE = 20;

export async function GET(req: NextRequest): Promise<Response> {
  return handleErrors(async () => {
    const user   = await requireAuth(req);
    const sp     = new URL(req.url).searchParams;
    const page   = Math.max(1, parseInt(sp.get('page') ?? '1', 10));
    const offset = (page - 1) * PAGE_SIZE;

    const client = await getAuthPool().connect();
    try {
      await setJwtClaims(client, user.claims);
      const { rows } = await client.query(
        `SELECT * FROM orders WHERE shop_id=$1 AND ($2::text IS NULL OR channel=$2::order_channel)
         ORDER BY created_at DESC LIMIT $3 OFFSET $4`,
        [user.shopId, sp.get('channel'), PAGE_SIZE, offset],
      );
      return Response.json(rows);
    } finally { client.release(); }
  });
}
