import { NextRequest } from 'next/server';
import { getAuthPool, setJwtClaims } from '@/lib/db';
import { withAuth } from '@/lib/requireAuth';

export const GET = withAuth(async (req: NextRequest, user) => {
  const days   = Math.min(90, Math.max(7, parseInt(new URL(req.url).searchParams.get('days') ?? '30', 10)));
  const client = await getAuthPool().connect();
  try {
    await setJwtClaims(client, user.claims);
    const [kpi, series] = await Promise.all([
      client.query(
        `SELECT
          (SELECT COUNT(*) FROM orders WHERE shop_id=$1 AND created_at>=CURRENT_DATE)::int AS new_orders_today,
          (SELECT COALESCE(SUM(total),0) FROM orders WHERE shop_id=$1 AND created_at>=CURRENT_DATE)::numeric AS revenue_today,
          (SELECT COUNT(*) FROM inventory_items WHERE shop_id=$1)::int AS total_inventory_items,
          (SELECT COUNT(*) FROM inventory_items WHERE shop_id=$1 AND stock<=5)::int AS low_stock_count`,
        [user.shopId],
      ),
      client.query<{ day: string; total_revenue: number; order_count: number }>(
        `SELECT d.day::date AS day, COALESCE(SUM(o.total),0) AS total_revenue, COALESCE(COUNT(o.id),0) AS order_count
         FROM generate_series(CURRENT_DATE-($2-1)*INTERVAL '1 day',CURRENT_DATE,'1 day') AS d(day)
         LEFT JOIN orders o ON o.shop_id=$1 AND o.created_at>=d.day AND o.created_at<d.day+INTERVAL '1 day'
         GROUP BY d.day ORDER BY d.day`,
        [user.shopId, days],
      ),
    ]);
    const k = kpi.rows[0] as Record<string, string>;
    return Response.json({
      newOrders:           Number(k['new_orders_today']),
      revenueToday:        Number(k['revenue_today']),
      totalInventoryItems: Number(k['total_inventory_items']),
      lowStockCount:       Number(k['low_stock_count']),
      revenueSeries:       series.rows.map(r => ({ day: r.day, total_revenue: Number(r.total_revenue), order_count: Number(r.order_count) })),
    });
  } finally { client.release(); }
});
