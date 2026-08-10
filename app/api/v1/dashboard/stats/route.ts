import { NextRequest } from 'next/server';
import { getAuthPool, setJwtClaims } from '@/lib/db';
import { requireAuth, handleErrors } from '@/lib/requireAuth';

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

    const client = await getAuthPool().connect();
    try {
      await setJwtClaims(client, user.claims);

      const [kpi, series, topProducts, paymentBreakdown, hourlyStats, yesterdayKpi] =
        await Promise.all([

          // ── Today's KPIs ──────────────────────────────────────────────────
          client.query(
            `SELECT
              (SELECT COUNT(*)
                 FROM orders
                WHERE shop_id    = $1
                  AND created_at >= (CURRENT_TIMESTAMP AT TIME ZONE $2)::date
                  AND created_at <  (CURRENT_TIMESTAMP AT TIME ZONE $2)::date + INTERVAL '1 day'
              )::int AS new_orders_today,

              (SELECT COALESCE(SUM(total), 0)
                 FROM orders
                WHERE shop_id    = $1
                  AND created_at >= (CURRENT_TIMESTAMP AT TIME ZONE $2)::date
                  AND created_at <  (CURRENT_TIMESTAMP AT TIME ZONE $2)::date + INTERVAL '1 day'
              )::numeric AS sales_today,

              (SELECT COALESCE(
                 SUM(oi.qty * oi.unit_price)
               - SUM(oi.qty * COALESCE(ii.cost_price, 0))
               , 0)
                 FROM orders o
                 JOIN order_items oi ON oi.order_id = o.id
                 LEFT JOIN inventory_items ii ON ii.id = oi.inventory_item_id
                WHERE o.shop_id    = $1
                  AND o.created_at >= (CURRENT_TIMESTAMP AT TIME ZONE $2)::date
                  AND o.created_at <  (CURRENT_TIMESTAMP AT TIME ZONE $2)::date + INTERVAL '1 day'
              )::numeric AS profit_today,

              (SELECT COALESCE(SUM(total), 0) FROM orders WHERE shop_id = $1)::numeric AS total_sales,

              (SELECT COALESCE(
                 SUM(oi.qty * oi.unit_price)
               - SUM(oi.qty * COALESCE(ii.cost_price, 0))
               , 0)
                 FROM orders o
                 JOIN order_items oi ON oi.order_id = o.id
                 LEFT JOIN inventory_items ii ON ii.id = oi.inventory_item_id
                WHERE o.shop_id = $1
              )::numeric AS total_profit,

              (SELECT COUNT(*) FROM inventory_items WHERE shop_id = $1)::int AS total_inventory_items,
              (SELECT COUNT(*) FROM inventory_items WHERE shop_id = $1 AND stock = 0)::int AS out_of_stock_count,
              (SELECT COUNT(*) FROM inventory_items WHERE shop_id = $1 AND stock > 0 AND stock <= 5)::int AS low_stock_count,

              -- Average order value (all-time)
              (SELECT COALESCE(AVG(total), 0) FROM orders WHERE shop_id = $1)::numeric AS avg_order_value,

              -- Total customers (distinct phones, non-null)
              (SELECT COUNT(DISTINCT customer_phone)
                 FROM orders WHERE shop_id = $1 AND customer_phone IS NOT NULL
              )::int AS total_customers,

              -- Repeat customers (phone appears more than once)
              (SELECT COUNT(*) FROM (
                SELECT customer_phone
                  FROM orders WHERE shop_id = $1 AND customer_phone IS NOT NULL
                 GROUP BY customer_phone HAVING COUNT(*) > 1
              ) rc)::int AS repeat_customers,

              -- Total orders all-time
              (SELECT COUNT(*) FROM orders WHERE shop_id = $1)::int AS total_orders`,
            [user.shopId, pgInterval],
          ),

          // ── Revenue series (for chart) ────────────────────────────────────
          client.query<{ day: string; total_revenue: number; order_count: number; avg_order: number }>(
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
          ),

          // ── Top 5 products by revenue (period) ────────────────────────────
          client.query<{ name: string; revenue: number; units_sold: number; order_count: number }>(
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
          ),

          // ── Payment method breakdown (period) ─────────────────────────────
          client.query<{ method: string; count: number; total: number }>(
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
          ),

          // ── Hourly sales distribution (period, local time) ────────────────
          client.query<{ hour: number; order_count: number; revenue: number }>(
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
          ),

          // ── Yesterday KPIs (for % change badges) ─────────────────────────
          client.query(
            `SELECT
               (SELECT COUNT(*) FROM orders
                 WHERE shop_id    = $1
                   AND created_at >= (CURRENT_TIMESTAMP AT TIME ZONE $2)::date - INTERVAL '1 day'
                   AND created_at <  (CURRENT_TIMESTAMP AT TIME ZONE $2)::date
               )::int AS orders_yesterday,

               (SELECT COALESCE(SUM(total), 0) FROM orders
                 WHERE shop_id    = $1
                   AND created_at >= (CURRENT_TIMESTAMP AT TIME ZONE $2)::date - INTERVAL '1 day'
                   AND created_at <  (CURRENT_TIMESTAMP AT TIME ZONE $2)::date
               )::numeric AS sales_yesterday,

               (SELECT COALESCE(
                  SUM(oi.qty * oi.unit_price)
                - SUM(oi.qty * COALESCE(ii.cost_price, 0))
                , 0)
                  FROM orders o
                  JOIN order_items oi ON oi.order_id = o.id
                  LEFT JOIN inventory_items ii ON ii.id = oi.inventory_item_id
                 WHERE o.shop_id    = $1
                   AND o.created_at >= (CURRENT_TIMESTAMP AT TIME ZONE $2)::date - INTERVAL '1 day'
                   AND o.created_at <  (CURRENT_TIMESTAMP AT TIME ZONE $2)::date
               )::numeric AS profit_yesterday`,
            [user.shopId, pgInterval],
          ),
        ]);

      const k  = kpi.rows[0]          as Record<string, string>;
      const ky = yesterdayKpi.rows[0] as Record<string, string>;

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

      return Response.json({
        // Today
        newOrders:           Number(k['new_orders_today']),
        salesToday:          Number(k['sales_today']),
        profitToday:         Number(k['profit_today']),
        // All-time
        totalSales:          Number(k['total_sales']),
        totalProfit:         Number(k['total_profit']),
        totalOrders:         Number(k['total_orders']),
        avgOrderValue:       Number(k['avg_order_value']),
        totalCustomers:      Number(k['total_customers']),
        repeatCustomers:     Number(k['repeat_customers']),
        // Inventory
        totalInventoryItems: Number(k['total_inventory_items']),
        outOfStockCount:     Number(k['out_of_stock_count']),
        lowStockCount:       Number(k['low_stock_count']),
        // Yesterday (for % change)
        yesterday: {
          orders:  Number(ky['orders_yesterday']),
          sales:   Number(ky['sales_yesterday']),
          profit:  Number(ky['profit_yesterday']),
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
      });
    } finally { client.release(); }
  });
}
