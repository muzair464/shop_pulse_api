import { NextRequest } from 'next/server';
import { getAuthPool, setJwtClaims } from '@/lib/db';
import { requireAuth, handleErrors } from '@/lib/requireAuth';

// Simple in-memory cache with TTL per warm instance
const cache = new Map<string, { data: unknown; expires: number }>();
const CACHE_TTL_MS = 30_000; // 30s cache

export async function GET(req: NextRequest): Promise<Response> {
  return handleErrors(async () => {
    const user = await requireAuth(req);
    const sp   = new URL(req.url).searchParams;
    const days = Math.min(90, Math.max(7, parseInt(sp.get('days') ?? '30', 10)));

    const rawOffset  = parseInt(sp.get('tzOffset') ?? '0', 10);
    const safeOffset = isNaN(rawOffset) ? 0 : Math.max(-840, Math.min(840, rawOffset));
    const offsetMinutes = -safeOffset;
    const sign  = offsetMinutes >= 0 ? '+' : '-';
    const absMin = Math.abs(offsetMinutes);
    const hh    = String(Math.floor(absMin / 60)).padStart(2, '0');
    const mm    = String(absMin % 60).padStart(2, '0');
    const pgInterval = `${sign}${hh}:${mm}`;

    // Cache key includes shop + params that affect the result
    const cacheKey = `dashboard:${user.shopId}:${days}:${pgInterval}`;
    const cached = cache.get(cacheKey);
    if (cached && cached.expires > Date.now()) {
      return Response.json(cached.data, {
        headers: {
          'Cache-Control': 'private, max-age=30, stale-while-revalidate=60',
          'X-Cache': 'HIT',
        },
      });
    }

    const pool = getAuthPool();

    // Parallel queries using separate connections for true concurrency
    const [allTimeStats, todayYesterdayStats, series, topProducts, paymentBreakdown, hourlyStats] =
      await Promise.all([

        // ── All-time stats from shop_stats (single row lookup) ──────────
        (async () => {
          const client = await pool.connect();
          try {
            await setJwtClaims(client, user.claims);
            const { rows } = await client.query(
              `SELECT * FROM shop_stats WHERE shop_id = $1`,
              [user.shopId],
            );
            // Handle case where shop_stats row doesn't exist yet (new shop)
            return rows[0] || {
              total_orders: 0, total_sales: 0, total_profit: 0,
              total_customers: 0, repeat_customers: 0,
              total_inventory_items: 0, out_of_stock_count: 0, low_stock_count: 0,
            };
          } finally { client.release(); }
        })(),

        // ── Today + Yesterday KPIs (combined into one query via CTE) ──────
        (async () => {
          const client = await pool.connect();
          try {
            await setJwtClaims(client, user.claims);
            const { rows } = await client.query(
              `WITH period_stats AS (
                SELECT
                  CASE
                    WHEN created_at >= (CURRENT_TIMESTAMP AT TIME ZONE $2)::date
                     AND created_at <  (CURRENT_TIMESTAMP AT TIME ZONE $2)::date + INTERVAL '1 day'
                    THEN 'today'
                    WHEN created_at >= (CURRENT_TIMESTAMP AT TIME ZONE $2)::date - INTERVAL '1 day'
                     AND created_at <  (CURRENT_TIMESTAMP AT TIME ZONE $2)::date
                    THEN 'yesterday'
                    ELSE NULL
                  END AS period,
                  o.id, o.total
                FROM orders o
                WHERE o.shop_id = $1
                  AND o.created_at >= (CURRENT_TIMESTAMP AT TIME ZONE $2)::date - INTERVAL '1 day'
              ),
              profit_calc AS (
                SELECT
                  CASE
                    WHEN o.created_at >= (CURRENT_TIMESTAMP AT TIME ZONE $2)::date
                     AND o.created_at <  (CURRENT_TIMESTAMP AT TIME ZONE $2)::date + INTERVAL '1 day'
                    THEN 'today'
                    WHEN o.created_at >= (CURRENT_TIMESTAMP AT TIME ZONE $2)::date - INTERVAL '1 day'
                     AND o.created_at <  (CURRENT_TIMESTAMP AT TIME ZONE $2)::date
                    THEN 'yesterday'
                    ELSE NULL
                  END AS period,
                  COALESCE(
                    SUM(oi.qty * oi.unit_price) - SUM(oi.qty * COALESCE(ii.cost_price, 0)),
                    0
                  ) AS profit
                FROM orders o
                JOIN order_items oi ON oi.order_id = o.id
                LEFT JOIN inventory_items ii ON ii.id = oi.inventory_item_id
                WHERE o.shop_id = $1
                  AND o.created_at >= (CURRENT_TIMESTAMP AT TIME ZONE $2)::date - INTERVAL '1 day'
                GROUP BY period
              )
              SELECT
                COUNT(*) FILTER (WHERE ps.period = 'today')::int AS new_orders_today,
                COALESCE(SUM(ps.total) FILTER (WHERE ps.period = 'today'), 0)::numeric AS sales_today,
                COALESCE((SELECT profit FROM profit_calc WHERE period = 'today'), 0)::numeric AS profit_today,
                COUNT(*) FILTER (WHERE ps.period = 'yesterday')::int AS orders_yesterday,
                COALESCE(SUM(ps.total) FILTER (WHERE ps.period = 'yesterday'), 0)::numeric AS sales_yesterday,
                COALESCE((SELECT profit FROM profit_calc WHERE period = 'yesterday'), 0)::numeric AS profit_yesterday
              FROM period_stats ps`,
              [user.shopId, pgInterval],
            );
            return rows[0];
          } finally { client.release(); }
        })(),

        // ── Revenue series (for chart) ────────────────────────────────────
        (async () => {
          const client = await pool.connect();
          try {
            await setJwtClaims(client, user.claims);
            return await client.query<{ day: string; total_revenue: number; order_count: number; avg_order: number }>(
              `SELECT
                 d.local_day                               AS day,
                 COALESCE(SUM(o.total), 0)                AS total_revenue,
                 COALESCE(COUNT(o.id), 0)                 AS order_count,
                 COALESCE(AVG(o.total), 0)                AS avg_order
               FROM (
                 SELECT generate_series(
                   (CURRENT_TIMESTAMP AT TIME ZONE $3)::date - ($2 - 1) * INTERVAL '1 day',
                   (CURRENT_TIMESTAMP AT TIME ZONE $3)::date,
                   '1 day'
                 )::date AS local_day
               ) d
               LEFT JOIN orders o
                 ON  o.shop_id    = $1
                 AND o.created_at >= d.local_day::timestamp + $3::interval
                 AND o.created_at <  d.local_day::timestamp + $3::interval + INTERVAL '1 day'
               GROUP BY d.local_day
               ORDER BY d.local_day`,
              [user.shopId, days, pgInterval],
            );
          } finally { client.release(); }
        })(),

        // ── Top 5 products by revenue (period) ────────────────────────────
        (async () => {
          const client = await pool.connect();
          try {
            await setJwtClaims(client, user.claims);
            return await client.query<{ name: string; revenue: number; units_sold: number; order_count: number }>(
              `SELECT
                 oi.name_snapshot                          AS name,
                 SUM(oi.line_total)                       AS revenue,
                 SUM(oi.qty)                              AS units_sold,
                 COUNT(DISTINCT oi.order_id)              AS order_count
               FROM order_items oi
               JOIN orders o ON o.id = oi.order_id
               WHERE o.shop_id    = $1
                 AND o.created_at >= (CURRENT_TIMESTAMP AT TIME ZONE $3)::date
                                     - ($2 - 1) * INTERVAL '1 day'
               GROUP BY oi.name_snapshot
               ORDER BY revenue DESC
               LIMIT 5`,
              [user.shopId, days, pgInterval],
            );
          } finally { client.release(); }
        })(),

        // ── Payment method breakdown (period) ─────────────────────────────
        (async () => {
          const client = await pool.connect();
          try {
            await setJwtClaims(client, user.claims);
            return await client.query<{ method: string; count: number; total: number }>(
              `SELECT
                 payment_method              AS method,
                 COUNT(*)::int               AS count,
                 COALESCE(SUM(total), 0)     AS total
               FROM orders
               WHERE shop_id    = $1
                 AND created_at >= (CURRENT_TIMESTAMP AT TIME ZONE $3)::date
                                   - ($2 - 1) * INTERVAL '1 day'
               GROUP BY payment_method
               ORDER BY total DESC`,
              [user.shopId, days, pgInterval],
            );
          } finally { client.release(); }
        })(),

        // ── Hourly sales distribution (period, local time) ────────────────
        (async () => {
          const client = await pool.connect();
          try {
            await setJwtClaims(client, user.claims);
            return await client.query<{ hour: number; order_count: number; revenue: number }>(
              `SELECT
                 EXTRACT(HOUR FROM (created_at AT TIME ZONE $3))::int AS hour,
                 COUNT(*)::int                                          AS order_count,
                 COALESCE(SUM(total), 0)                               AS revenue
               FROM orders
               WHERE shop_id    = $1
                 AND created_at >= (CURRENT_TIMESTAMP AT TIME ZONE $3)::date
                                   - ($2 - 1) * INTERVAL '1 day'
               GROUP BY hour
               ORDER BY hour`,
              [user.shopId, days, pgInterval],
            );
          } finally { client.release(); }
        })(),
      ]);

    const stats = allTimeStats as Record<string, number>;
    const todayYesterday = todayYesterdayStats as Record<string, number>;

    // Build full 24-hour array (fill missing hours with 0)
    const hourMap = new Map<number, { order_count: number; revenue: number }>();
    for (const r of hourlyStats.rows) {
      hourMap.set(Number(r.hour), { order_count: Number(r.order_count), revenue: Number(r.revenue) });
    }
    const hourlyData = Array.from({ length: 24 }, (_, h) => ({
      hour:        h,
      order_count: hourMap.get(h)?.order_count ?? 0,
      revenue:     hourMap.get(h)?.revenue     ?? 0,
    }));

    const result = {
      // Today
      newOrders:           todayYesterday.new_orders_today ?? 0,
      salesToday:          Number(todayYesterday.sales_today ?? 0),
      profitToday:         Number(todayYesterday.profit_today ?? 0),
      // All-time (from shop_stats)
      totalSales:          Number(stats.total_sales ?? 0),
      totalProfit:         Number(stats.total_profit ?? 0),
      totalOrders:         stats.total_orders ?? 0,
      avgOrderValue:       stats.total_orders > 0
        ? Number(stats.total_sales) / stats.total_orders
        : 0,
      totalCustomers:      stats.total_customers ?? 0,
      repeatCustomers:     stats.repeat_customers ?? 0,
      // Inventory (from shop_stats)
      totalInventoryItems: stats.total_inventory_items ?? 0,
      outOfStockCount:     stats.out_of_stock_count ?? 0,
      lowStockCount:       stats.low_stock_count ?? 0,
      // Yesterday (for % change)
      yesterday: {
        orders:  todayYesterday.orders_yesterday ?? 0,
        sales:   Number(todayYesterday.sales_yesterday ?? 0),
        profit:  Number(todayYesterday.profit_yesterday ?? 0),
      },
      // Series & breakdowns
      revenueSeries: series.rows.map(r => ({
        day:           r.day,
        total_revenue: Number(r.total_revenue),
        order_count:   Number(r.order_count),
        avg_order:     Number(r.avg_order),
      })),
      topProducts: topProducts.rows.map(r => ({
        name:        r.name,
        revenue:     Number(r.revenue),
        units_sold:  Number(r.units_sold),
        order_count: Number(r.order_count),
      })),
      paymentBreakdown: paymentBreakdown.rows.map(r => ({
        method: r.method,
        count:  Number(r.count),
        total:  Number(r.total),
      })),
      hourlyData,
    };

    // Cache the result
    cache.set(cacheKey, { data: result, expires: Date.now() + CACHE_TTL_MS });

    // Clean up expired cache entries periodically
    if (Math.random() < 0.1) { // 10% chance per request
      const now = Date.now();
      for (const [key, val] of cache.entries()) {
        if (val.expires < now) cache.delete(key);
      }
    }

    return Response.json(result, {
      headers: {
        'Cache-Control': 'private, max-age=30, stale-while-revalidate=60',
        'X-Cache': 'MISS',
      },
    });
  });
}
