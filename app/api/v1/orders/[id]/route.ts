import { NextRequest } from 'next/server';
import { getAuthPool, setJwtClaims } from '@/lib/db';
import { requireAuth, handleErrors } from '@/lib/requireAuth';

type Context = { params: Promise<{ id: string }> };

export async function GET(req: NextRequest, { params }: Context): Promise<Response> {
  return handleErrors(async () => {
    const user   = await requireAuth(req);
    const { id } = await params;
    const client = await getAuthPool().connect();
    try {
      await setJwtClaims(client, user.claims);
      const { rows } = await client.query(
        `SELECT o.*, COALESCE(json_agg(json_build_object(
           'id',oi.id,'inventory_item_id',oi.inventory_item_id,'name_snapshot',oi.name_snapshot,
           'qty',oi.qty,'unit_price',oi.unit_price,'line_total',oi.line_total
         )) FILTER (WHERE oi.id IS NOT NULL),'[]'::json) AS order_items
         FROM orders o LEFT JOIN order_items oi ON oi.order_id=o.id
         WHERE o.id=$1 AND o.shop_id=$2 GROUP BY o.id`,
        [id, user.shopId],
      );
      if (!rows[0]) return Response.json({ error: 'Order not found.' }, { status: 404 });
      return Response.json(rows[0]);
    } finally { client.release(); }
  });
}
