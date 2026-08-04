import { NextRequest } from 'next/server';
import { getAuthPool, setJwtClaims } from '@/lib/db';
import { requireAuth, handleErrors } from '@/lib/requireAuth';

const PAGE_SIZE = 500; // larger page for full-catalog loads

export async function GET(req: NextRequest): Promise<Response> {
  return handleErrors(async () => {
    const user  = await requireAuth(req);
    const sp    = new URL(req.url).searchParams;

    // Delta sync: only return rows updated after this ISO timestamp.
    // When absent, returns ALL rows for the shop (initial load).
    const updatedAfter = sp.get('updatedAfter'); // e.g. "2026-08-03T10:00:00.000Z"

    const page   = Math.max(1, parseInt(sp.get('page') ?? '1', 10));
    const offset = (page - 1) * PAGE_SIZE;

    const client = await getAuthPool().connect();
    try {
      await setJwtClaims(client, user.claims);
      const { rows } = await client.query(
        `SELECT * FROM inventory_items
         WHERE  shop_id = $1
         AND    ($2::timestamptz IS NULL OR updated_at > $2::timestamptz)
         AND    ($3::text IS NULL OR category          = $3)
         AND    ($4::text IS NULL OR classification    = $4::item_classification)
         AND    ($5::text IS NULL OR name ILIKE '%'||$5||'%'
                                  OR category ILIKE '%'||$5||'%'
                                  OR imei = $5)
         ORDER  BY updated_at DESC, name
         LIMIT  $6 OFFSET $7`,
        [
          user.shopId,
          updatedAfter ?? null,
          sp.get('category')       ?? null,
          sp.get('classification') ?? null,
          sp.get('search')         ?? null,
          PAGE_SIZE,
          offset,
        ],
      );
      // Return the server's current time so the client can store it as
      // next sync cursor — avoids client/server clock skew.
      const { rows: tsRows } = await client.query<{ now: string }>('SELECT now() AS now');
      return Response.json({ items: rows, syncedAt: tsRows[0].now });
    } finally { client.release(); }
  });
}

export async function POST(req: NextRequest): Promise<Response> {
  return handleErrors(async () => {
    const user = await requireAuth(req);
    const body = await req.json() as {
      classification?: string; name?: string; description?: string | null;
      category?: string; imei?: string | null; sku?: string | null;
      stock?: number; cost_price?: number; selling_price?: number;
    };
    const { classification, name, category, stock, cost_price, selling_price } = body;
    if (!classification || !name || !category || stock === undefined || !cost_price || !selling_price)
      return Response.json({ error: 'classification, name, category, stock, cost_price, and selling_price are required.' }, { status: 400 });

    const client = await getAuthPool().connect();
    try {
      await setJwtClaims(client, user.claims);
      const { rows } = await client.query(
        `INSERT INTO inventory_items
           (shop_id, classification, name, description, category, imei, sku, stock, cost_price, selling_price)
         VALUES ($1,$2::item_classification,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING *`,
        [user.shopId, classification, name, body.description ?? null, category,
         body.imei ?? null, body.sku ?? null, Number(stock), Number(cost_price), Number(selling_price)],
      );
      return Response.json(rows[0], { status: 201 });
    } finally { client.release(); }
  });
}
