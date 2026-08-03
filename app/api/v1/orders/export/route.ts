import { getAuthPool, setJwtClaims } from '@/lib/db';
import { withAuth } from '@/lib/requireAuth';

export const GET = withAuth(async (_req, user) => {
  const client = await getAuthPool().connect();
  try {
    await setJwtClaims(client, user.claims);
    const { rows } = await client.query(
      `SELECT id, order_number, customer_name, customer_phone, channel,
              payment_method, subtotal, discount, total, payment_verified, created_at
       FROM orders WHERE shop_id=$1 ORDER BY created_at DESC`,
      [user.shopId],
    );
    const header = 'id,order_number,customer_name,customer_phone,channel,payment_method,subtotal,discount,total,payment_verified,created_at\n';
    const body   = rows.map(r =>
      [r.id, r.order_number, `"${(r.customer_name??'').replace(/"/g,'""')}"`,
       r.customer_phone??'', r.channel, r.payment_method,
       r.subtotal, r.discount, r.total, r.payment_verified, r.created_at].join(',')
    ).join('\n');
    const filename = `orders-${new Date().toISOString().slice(0,10)}.csv`;
    return new Response(header + body, {
      headers: { 'Content-Type': 'text/csv', 'Content-Disposition': `attachment; filename="${filename}"` },
    });
  } finally { client.release(); }
});
