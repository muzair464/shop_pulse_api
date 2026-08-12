import { NextRequest } from 'next/server';
import { getAuthPool, setJwtClaims } from '@/lib/db';
import { requireAuth, handleErrors, AppError } from '@/lib/requireAuth';

// POST /api/v1/customers/:id/transactions/:txId/void
export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string; txId: string }> },
): Promise<Response> {
  return handleErrors(async () => {
    const user = await requireAuth(req);
    const { id, txId } = await params;

    const client = await getAuthPool().connect();
    try {
      await setJwtClaims(client, user.claims);

      const { rows } = await client.query(
        `UPDATE khata_transactions
           SET voided_at = now()
         WHERE id = $1 AND customer_id = $2 AND shop_id = $3 AND voided_at IS NULL
         RETURNING *`,
        [txId, id, user.shopId],
      );

      if (!rows.length) throw new AppError('Transaction not found or already voided.', 404);

      const { rows: cust } = await client.query(
        `SELECT id, name, balance FROM customers WHERE id = $1`, [id],
      );

      return Response.json({ transaction: rows[0], customer: cust[0] });
    } finally { client.release(); }
  });
}
