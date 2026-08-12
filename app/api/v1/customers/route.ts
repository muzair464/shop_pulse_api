import { NextRequest } from 'next/server';
import { getAuthPool, setJwtClaims } from '@/lib/db';
import { requireAuth, handleErrors, AppError } from '@/lib/requireAuth';

// GET /api/v1/customers?search=&status=all|overdue|settled&page=1
export async function GET(req: NextRequest): Promise<Response> {
  return handleErrors(async () => {
    const user = await requireAuth(req);
    const sp     = new URL(req.url).searchParams;
    const search = sp.get('search')?.trim() || null;
    const status = sp.get('status') || 'all';   // all | overdue | settled
    const page   = Math.max(1, parseInt(sp.get('page') ?? '1', 10));
    const limit  = 20;
    const offset = (page - 1) * limit;

    // status filter:
    //   overdue  = balance > 0
    //   settled  = balance <= 0
    //   all      = no filter
    const statusClause =
      status === 'overdue' ? 'AND c.balance > 0' :
      status === 'settled' ? 'AND c.balance <= 0' : '';

    const client = await getAuthPool().connect();
    try {
      await setJwtClaims(client, user.claims);

      const [rows, countRow] = await Promise.all([
        client.query(
          `SELECT
             c.id, c.shop_id, c.name, c.phone, c.cnic, c.notes,
             c.balance, c.created_at, c.updated_at,
             s.last_tx_at, s.last_repayment_at, s.tx_count
           FROM   customer_khata_summary s
           JOIN   customers c ON c.id = s.id
           WHERE  c.shop_id = $1
             ${statusClause}
             AND  ($2::text IS NULL
                   OR c.name  ILIKE '%' || $2 || '%'
                   OR c.phone ILIKE '%' || $2 || '%'
                   OR c.cnic  ILIKE '%' || $2 || '%')
           ORDER  BY c.balance DESC, c.name ASC
           LIMIT  $3 OFFSET $4`,
          [user.shopId, search, limit, offset],
        ),
        client.query<{ total: string }>(
          `SELECT COUNT(*)::text AS total FROM customers c
           WHERE  c.shop_id = $1
             ${statusClause}
             AND  ($2::text IS NULL
                   OR c.name  ILIKE '%' || $2 || '%'
                   OR c.phone ILIKE '%' || $2 || '%'
                   OR c.cnic  ILIKE '%' || $2 || '%')`,
          [user.shopId, search],
        ),
      ]);

      // KPI totals for the header cards
      const { rows: kpi } = await client.query(
        `SELECT
           COUNT(*)::int                              AS total_customers,
           COUNT(*) FILTER (WHERE balance > 0)::int  AS overdue_count,
           COALESCE(SUM(balance) FILTER (WHERE balance > 0), 0)::numeric AS total_outstanding,
           COALESCE(SUM(balance) FILTER (WHERE balance < 0), 0)::numeric AS total_advance
         FROM customers WHERE shop_id = $1`,
        [user.shopId],
      );

      return Response.json({
        customers:  rows.rows,
        total:      parseInt(countRow.rows[0].total, 10),
        page,
        limit,
        kpi:        kpi[0],
      });
    } finally { client.release(); }
  });
}

// POST /api/v1/customers  — create a new customer
export async function POST(req: NextRequest): Promise<Response> {
  return handleErrors(async () => {
    const user = await requireAuth(req);
    const body = await req.json() as {
      name?: string; phone?: string | null; cnic?: string | null; notes?: string | null;
    };

    if (!body.name?.trim()) throw new AppError('Customer name is required.', 400);

    const client = await getAuthPool().connect();
    try {
      await setJwtClaims(client, user.claims);
      const { rows } = await client.query(
        `INSERT INTO customers (shop_id, name, phone, cnic, notes)
         VALUES ($1, $2, $3, $4, $5) RETURNING *`,
        [user.shopId, body.name.trim(), body.phone?.trim() || null,
         body.cnic?.trim() || null, body.notes?.trim() || null],
      );
      return Response.json(rows[0], { status: 201 });
    } finally { client.release(); }
  });
}
