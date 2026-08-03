import { NextRequest } from 'next/server';
import { getAuthPool, setJwtClaims } from '@/lib/db';
import { requireAuth, handleErrors } from '@/lib/requireAuth';
import { maybeSendLowStockAlert } from '@/lib/email.service';

type Context = { params: Promise<{ id: string }> };

export async function PATCH(req: NextRequest, { params }: Context): Promise<Response> {
  return handleErrors(async () => {
    const user     = await requireAuth(req);
    const { id }   = await params;
    const body = await req.json() as {
      name?: string; description?: string | null; category?: string;
      stock?: number; sku?: string | null; cost_price?: number; selling_price?: number; version?: number;
    };
    if (body.version === undefined) return Response.json({ error: 'version is required.' }, { status: 400 });

    const client = await getAuthPool().connect();
    try {
      await setJwtClaims(client, user.claims);
      const { rows } = await client.query(
        `UPDATE inventory_items SET
           name          = COALESCE($3, name),
           description   = COALESCE($4, description),
           category      = COALESCE($5, category),
           stock         = COALESCE($6, stock),
           sku           = COALESCE($7, sku),
           cost_price    = COALESCE($8, cost_price),
           selling_price = COALESCE($9, selling_price),
           version = version + 1, updated_at = now()
         WHERE id = $1 AND shop_id = $2 AND version = $10 RETURNING *`,
        [id, user.shopId,
         body.name ?? null, body.description ?? null, body.category ?? null,
         body.stock !== undefined ? Number(body.stock) : null,
         body.sku ?? null,
         body.cost_price !== undefined ? Number(body.cost_price) : null,
         body.selling_price !== undefined ? Number(body.selling_price) : null,
         body.version],
      );
      if (rows.length === 0) {
        const exists = await client.query(`SELECT 1 FROM inventory_items WHERE id=$1 AND shop_id=$2`, [id, user.shopId]);
        return exists.rows.length === 0
          ? Response.json({ error: 'Item not found.' }, { status: 404 })
          : Response.json({ error: 'Version conflict — item was modified on another device.' }, { status: 409 });
      }
      const updated = rows[0] as { stock: number; name: string };
      if (updated.stock <= 5) maybeSendLowStockAlert(user.email, [{ name: updated.name, stock: updated.stock }]);
      return Response.json(updated);
    } finally { client.release(); }
  });
}

export async function DELETE(req: NextRequest, { params }: Context): Promise<Response> {
  return handleErrors(async () => {
    const user   = await requireAuth(req);
    const { id } = await params;
    const client = await getAuthPool().connect();
    try {
      await setJwtClaims(client, user.claims);
      const { rowCount } = await client.query(`DELETE FROM inventory_items WHERE id=$1 AND shop_id=$2`, [id, user.shopId]);
      if ((rowCount ?? 0) === 0) return Response.json({ error: 'Item not found.' }, { status: 404 });
      return new Response(null, { status: 204 });
    } finally { client.release(); }
  });
}
