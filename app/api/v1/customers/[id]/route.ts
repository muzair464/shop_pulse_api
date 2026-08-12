import { NextRequest } from 'next/server';
import { getAuthPool, setJwtClaims } from '@/lib/db';
import { requireAuth, handleErrors, AppError } from '@/lib/requireAuth';

type Ctx = { params: { id: string } };

// GET /api/v1/customers/:id  — customer detail + transaction history
export async function GET(req: NextRequest, ctx: Ctx): Promise<Response> {
  return handleErrors(async () => {
    const user = await requireAuth(req);
    const { id } = ctx.params;

    const client = await getAuthPool().connect();
    try {
      await setJwtClaims(client, user.claims);

      const [custRow, txRows, orderRows] = await Promise.all([
        client.query(
          `SELECT c.*, s.last_tx_at, s.last_repayment_at, s.tx_count
           FROM customer_khata_summary s JOIN customers c ON c.id = s.id
           WHERE c.id = $1 AND c.shop_id = $2`,
          [id, user.shopId],
        ),
        client.query(
          `SELECT * FROM khata_transactions
           WHERE customer_id = $1 AND shop_id = $2
           ORDER BY created_at DESC LIMIT 50`,
          [id, user.shopId],
        ),
        // Last 10 orders linked to this customer
        client.query(
          `SELECT id, order_number, total, payment_method, created_at
           FROM orders WHERE customer_id = $1 AND shop_id = $2
           ORDER BY created_at DESC LIMIT 10`,
          [id, user.shopId],
        ),
      ]);

      if (!custRow.rows.length) throw new AppError('Customer not found.', 404);

      return Response.json({
        customer:     custRow.rows[0],
        transactions: txRows.rows,
        orders:       orderRows.rows,
      });
    } finally { client.release(); }
  });
}

// PATCH /api/v1/customers/:id  — update profile
export async function PATCH(req: NextRequest, ctx: Ctx): Promise<Response> {
  return handleErrors(async () => {
    const user = await requireAuth(req);
    const { id } = ctx.params;
    const body = await req.json() as {
      name?: string; phone?: string | null; cnic?: string | null; notes?: string | null;
    };

    const client = await getAuthPool().connect();
    try {
      await setJwtClaims(client, user.claims);
      const { rows } = await client.query(
        `UPDATE customers SET
           name       = COALESCE($3, name),
           phone      = COALESCE($4, phone),
           cnic       = COALESCE($5, cnic),
           notes      = COALESCE($6, notes),
           updated_at = now()
         WHERE id = $1 AND shop_id = $2
         RETURNING *`,
        [id, user.shopId,
         body.name?.trim()  || null,
         body.phone?.trim() || null,
         body.cnic?.trim()  || null,
         body.notes?.trim() || null],
      );
      if (!rows.length) throw new AppError('Customer not found.', 404);
      return Response.json(rows[0]);
    } finally { client.release(); }
  });
}

// DELETE /api/v1/customers/:id  — only allowed when balance = 0
export async function DELETE(req: NextRequest, ctx: Ctx): Promise<Response> {
  return handleErrors(async () => {
    const user = await requireAuth(req);
    const { id } = ctx.params;

    const client = await getAuthPool().connect();
    try {
      await setJwtClaims(client, user.claims);
      // Guard: refuse deletion if outstanding balance exists
      const { rows: check } = await client.query(
        `SELECT balance FROM customers WHERE id = $1 AND shop_id = $2`,
        [id, user.shopId],
      );
      if (!check.length) throw new AppError('Customer not found.', 404);
      if (Number(check[0].balance) > 0)
        throw new AppError('Cannot delete a customer with an outstanding balance.', 409);

      await client.query(
        `DELETE FROM customers WHERE id = $1 AND shop_id = $2`,
        [id, user.shopId],
      );
      return new Response(null, { status: 204 });
    } finally { client.release(); }
  });
}
