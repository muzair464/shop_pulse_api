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
    const category = sp.get('category');
    const classification = sp.get('classification');
    const search = sp.get('search');

    const page   = Math.max(1, parseInt(sp.get('page') ?? '1', 10));
    const offset = (page - 1) * PAGE_SIZE;

    // Build conditional WHERE clauses to help the planner use indexes
    const conditions: string[] = ['shop_id = $1'];
    const params: unknown[] = [user.shopId];
    let paramIndex = 2;

    if (updatedAfter) {
      conditions.push(`updated_at > $${paramIndex}::timestamptz`);
      params.push(updatedAfter);
      paramIndex++;
    }

    if (category) {
      conditions.push(`category = $${paramIndex}`);
      params.push(category);
      paramIndex++;
    }

    if (classification) {
      conditions.push(`classification = $${paramIndex}::item_classification`);
      params.push(classification);
      paramIndex++;
    }

    if (search) {
      // Separate OR condition for search - this way the planner can use the trigram index on name
      conditions.push(
        `(name ILIKE $${paramIndex} OR category ILIKE $${paramIndex} OR imei = $${paramIndex} OR imei2 = $${paramIndex})`
      );
      params.push(`%${search}%`);
      paramIndex++;
    }

    const whereClause = conditions.join(' AND ');

    const client = await getAuthPool().connect();
    try {
      await setJwtClaims(client, user.claims);

      // Total matching rows (same filters, no LIMIT/OFFSET) so the client
      // knows when it has fetched the complete dataset across pages.
      const { rows: countRows } = await client.query<{ count: string }>(
        `SELECT COUNT(*) AS count FROM inventory_items WHERE ${whereClause}`,
        params,
      );
      const total = parseInt(countRows[0].count, 10);

      const { rows } = await client.query(
        `SELECT * FROM inventory_items
         WHERE  ${whereClause}
         ORDER  BY updated_at DESC, name
         LIMIT  $${paramIndex} OFFSET $${paramIndex + 1}`,
        [...params, PAGE_SIZE, offset],
      );
      // Return the server's current time so the client can store it as
      // next sync cursor — avoids client/server clock skew.
      const { rows: tsRows } = await client.query<{ now: string }>('SELECT now() AS now');
      return Response.json({ items: rows, total, syncedAt: tsRows[0].now });
    } finally { client.release(); }
  });
}

export async function POST(req: NextRequest): Promise<Response> {
  return handleErrors(async () => {
    const user = await requireAuth(req);
    const body = await req.json() as {
      classification?: string; name?: string; description?: string | null;
      category?: string; imei?: string | null; imei2?: string | null; sku?: string | null;
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
           (shop_id, classification, name, description, category, imei, imei2, sku, stock, cost_price, selling_price)
         VALUES ($1,$2::item_classification,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING *`,
        [user.shopId, classification, name, body.description ?? null, category,
         body.imei ?? null, body.imei2 ?? null, body.sku ?? null, Number(stock), Number(cost_price), Number(selling_price)],
      );
      return Response.json(rows[0], { status: 201 });
    } finally { client.release(); }
  });
}
