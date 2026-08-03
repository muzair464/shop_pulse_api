import { NextRequest } from 'next/server';
import { getAuthPool, setJwtClaims } from '@/lib/db';
import { requireAuth, handleErrors } from '@/lib/requireAuth';

export async function GET(req: NextRequest): Promise<Response> {
  return handleErrors(async () => {
    const user   = await requireAuth(req);
    const client = await getAuthPool().connect();
    try {
      await setJwtClaims(client, user.claims);
      const { rows } = await client.query(
        `SELECT id, classification, name, description, category, imei, sku,
                stock, cost_price, selling_price, version, created_at, updated_at
         FROM   inventory_items WHERE shop_id = $1 ORDER BY name`,
        [user.shopId],
      );
      const header = 'id,classification,name,description,category,imei,sku,stock,cost_price,selling_price,version,created_at,updated_at\n';
      const body   = rows.map(r => [r.id, r.classification,
        `"${(r.name as string).replace(/"/g, '""')}"`,
        `"${(r.description ?? '').replace(/"/g, '""')}"`,
        r.category, r.imei ?? '', r.sku ?? '',
        r.stock, r.cost_price, r.selling_price, r.version, r.created_at, r.updated_at].join(',')).join('\n');
      const filename = `inventory-${new Date().toISOString().slice(0, 10)}.csv`;
      return new Response(header + body, {
        headers: { 'Content-Type': 'text/csv', 'Content-Disposition': `attachment; filename="${filename}"` },
      });
    } finally { client.release(); }
  });
}
