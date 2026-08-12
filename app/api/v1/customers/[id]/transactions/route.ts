import { NextRequest } from 'next/server';
import { getAuthPool, setJwtClaims } from '@/lib/db';
import { requireAuth, handleErrors, AppError } from '@/lib/requireAuth';

// GET /api/v1/customers/:id/transactions?page=1
export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  return handleErrors(async () => {
    const user = await requireAuth(req);
    const { id } = await params;
    const page   = Math.max(1, parseInt(new URL(req.url).searchParams.get('page') ?? '1', 10));
    const limit  = 30;
    const offset = (page - 1) * limit;

    const client = await getAuthPool().connect();
    try {
      await setJwtClaims(client, user.claims);

      const { rows: check } = await client.query(
        `SELECT id FROM customers WHERE id = $1 AND shop_id = $2`,
        [id, user.shopId],
      );
      if (!check.length) throw new AppError('Customer not found.', 404);

      const [txRows, countRow] = await Promise.all([
        client.query(
          `SELECT kt.*, o.order_number
           FROM   khata_transactions kt
           LEFT JOIN orders o ON o.id = kt.order_id
           WHERE  kt.customer_id = $1 AND kt.shop_id = $2
           ORDER  BY kt.created_at DESC
           LIMIT  $3 OFFSET $4`,
          [id, user.shopId, limit, offset],
        ),
        client.query<{ total: string }>(
          `SELECT COUNT(*)::text AS total
           FROM khata_transactions
           WHERE customer_id = $1 AND shop_id = $2`,
          [id, user.shopId],
        ),
      ]);

      return Response.json({
        transactions: txRows.rows,
        total:        parseInt(countRow.rows[0].total, 10),
        page,
        limit,
      });
    } finally { client.release(); }
  });
}

// POST /api/v1/customers/:id/transactions
export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  return handleErrors(async () => {
    const user = await requireAuth(req);
    const { id } = await params;
    const body = await req.json() as {
      tx_type?: string; amount?: number; notes?: string | null; order_id?: string | null;
    };

    if (!body.tx_type || !['CREDIT', 'REPAYMENT'].includes(body.tx_type))
      throw new AppError('tx_type must be CREDIT or REPAYMENT.', 400);
    const amount = Number(body.amount);
    if (!amount || amount <= 0) throw new AppError('amount must be a positive number.', 400);

    const client = await getAuthPool().connect();
    try {
      await setJwtClaims(client, user.claims);

      const { rows: check } = await client.query(
        `SELECT id FROM customers WHERE id = $1 AND shop_id = $2`,
        [id, user.shopId],
      );
      if (!check.length) throw new AppError('Customer not found.', 404);

      if (body.tx_type === 'REPAYMENT') {
        const { rows: bal } = await client.query(
          `SELECT balance FROM customers WHERE id = $1`, [id],
        );
        if (amount > Number(bal[0].balance))
          throw new AppError('Repayment amount exceeds outstanding balance.', 409);
      }

      const { rows } = await client.query(
        `INSERT INTO khata_transactions
           (shop_id, customer_id, order_id, tx_type, amount, notes)
         VALUES ($1, $2, $3, $4::khata_tx_type, $5, $6)
         RETURNING *`,
        [user.shopId, id, body.order_id || null,
         body.tx_type, amount, body.notes?.trim() || null],
      );

      const { rows: cust } = await client.query(
        `SELECT id, name, balance FROM customers WHERE id = $1`, [id],
      );

      return Response.json({ transaction: rows[0], customer: cust[0] }, { status: 201 });
    } finally { client.release(); }
  });
}
