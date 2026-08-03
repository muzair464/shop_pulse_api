import { NextRequest } from 'next/server';
import { getAuthPool, setJwtClaims } from '@/lib/db';
import { withAuth } from '@/lib/requireAuth';

const PAGE_SIZE = 20;

export const GET = withAuth(async (req: NextRequest, user) => {
  const { searchParams } = new URL(req.url);
  const channel = searchParams.get('channel');
  const page    = Math.max(1, parseInt(searchParams.get('page') ?? '1', 10));
  const offset  = (page - 1) * PAGE_SIZE;

  const client = await getAuthPool().connect();
  try {
    await setJwtClaims(client, user.claims);
    const { rows } = await client.query(
      `SELECT * FROM orders WHERE shop_id=$1 AND ($2::text IS NULL OR channel=$2::order_channel)
       ORDER BY created_at DESC LIMIT $3 OFFSET $4`,
      [user.shopId, channel, PAGE_SIZE, offset],
    );
    return Response.json(rows);
  } finally { client.release(); }
});
