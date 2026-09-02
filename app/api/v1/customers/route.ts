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

    // Build conditional search clauses to avoid query planner defeating "IS NULL OR" pattern
    const searchConditions: string[] = [];
    const searchParams: unknown[] = [user.shopId];
    let paramIndex = 2;

    if (search) {
      searchConditions.push(
        `(c.name ILIKE $${paramIndex} OR c.phone ILIKE $${paramIndex} OR c.cnic ILIKE $${paramIndex})`
      );
      searchParams.push(`%${search}%`);
      paramIndex++;
    }

    const searchClause = searchConditions.length > 0
      ? `AND ${searchConditions.join(' AND ')}`
      : '';

    const pool = getAuthPool();

    // Parallel execution with separate connections for true concurrency
    const [rowsResult, countResult, kpiResult] = await Promise.all([
      (async () => {
        const client = await pool.connect();
        try {
          await setJwtClaims(client, user.claims);
          return await client.query(
            `SELECT
               c.id, c.shop_id, c.name, c.phone, c.cnic, c.notes,
               c.balance, c.created_at, c.updated_at,
               s.last_tx_at, s.last_repayment_at, s.tx_count
             FROM   customer_khata_summary s
             JOIN   customers c ON c.id = s.id
             WHERE  c.shop_id = $1
               ${statusClause}
               ${searchClause}
             ORDER  BY c.balance DESC, c.name ASC
             LIMIT  $${paramIndex} OFFSET $${paramIndex + 1}`,
            [...searchParams, limit, offset],
          );
        } finally { client.release(); }
      })(),

      (async () => {
        const client = await pool.connect();
        try {
          await setJwtClaims(client, user.claims);
          return await client.query<{ total: string }>(
            `SELECT COUNT(*)::text AS total FROM customers c
             WHERE  c.shop_id = $1
               ${statusClause}
               ${searchClause}`,
            searchParams,
          );
        } finally { client.release(); }
      })(),

      // KPI totals for the header cards
      (async () => {
        const client = await pool.connect();
        try {
          await setJwtClaims(client, user.claims);
          return await client.query(
            `SELECT
               COUNT(*)::int                              AS total_customers,
               COUNT(*) FILTER (WHERE balance > 0)::int  AS overdue_count,
               COALESCE(SUM(balance) FILTER (WHERE balance > 0), 0)::numeric AS total_outstanding,
               COALESCE(SUM(balance) FILTER (WHERE balance < 0), 0)::numeric AS total_advance
             FROM customers WHERE shop_id = $1`,
            [user.shopId],
          );
        } finally { client.release(); }
      })(),
    ]);

    return Response.json({
      customers:  rowsResult.rows,
      total:      parseInt(countResult.rows[0].total, 10),
      page,
      limit,
      kpi:        kpiResult.rows[0],
    });
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
