import { NextRequest } from 'next/server';
import { getAuthPool, setJwtClaims } from '@/lib/db';
import { withAuth } from '@/lib/requireAuth';

const PAGE_SIZE = 20;

export const GET = withAuth(async (req: NextRequest, user) => {
  const { searchParams } = new URL(req.url);
  const category       = searchParams.get('category');
  const classification = searchParams.get('classification');
  const search         = searchParams.get('search');
  const page           = Math.max(1, parseInt(searchParams.get('page') ?? '1', 10));
  const offset         = (page - 1) * PAGE_SIZE;

  const client = await getAuthPool().connect();
  try {
    await setJwtClaims(client, user.claims);
    const { rows } = await client.query(
      `SELECT * FROM inventory_items
       WHERE  shop_id = $1
       AND    ($2::text IS NULL OR category       = $2)
       AND    ($3::text IS NULL OR classification = $3::item_classification)
       AND    ($4::text IS NULL OR name ILIKE '%'||$4||'%' OR category ILIKE '%'||$4||'%' OR imei = $4)
       ORDER  BY name LIMIT $5 OFFSET $6`,
      [user.shopId, category, classification, search, PAGE_SIZE, offset],
    );
    return Response.json(rows);
  } finally { client.release(); }
});

export const POST = withAuth(async (req: NextRequest, user) => {
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
      `INSERT INTO inventory_items (shop_id, classification, name, description, category, imei, sku, stock, cost_price, selling_price)
       VALUES ($1,$2::item_classification,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING *`,
      [user.shopId, classification, name, body.description ?? null, category, body.imei ?? null, body.sku ?? null, Number(stock), Number(cost_price), Number(selling_price)],
    );
    return Response.json(rows[0], { status: 201 });
  } finally { client.release(); }
});
