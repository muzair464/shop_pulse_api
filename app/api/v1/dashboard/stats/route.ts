import { NextRequest } from 'next/server';
import { getAuthPool, setJwtClaims } from '@/lib/db';
import { requireAuth, handleErrors } from '@/lib/requireAuth';

export async function GET(req: NextRequest): Promise<Response> {
  return handleErrors(async () => {
    const user = await requireAuth(req);
    const sp   = new URL(req.url).searchParams;
    const days = Math.min(90, Math.max(7, parseInt(sp.get('days') ?? '30', 10)));

    // tzOffset: minutes the client is behind UTC (e.g. PKT = -300, i.e. UTC+5).
    // We convert it to a Postgres interval so "today" means local midnight → local midnight.
    const rawOffset    = parseInt(sp.get('tzOffset') ?? '0', 10);
    const safeOffset   = isNaN(rawOffset) ? 0 : Math.max(-840, Math.min(840, rawOffset));
    // Postgres INTERVAL: negative tzOffset means ahead of UTC, so we ADD the offset.
    // E.g. PKT (UTC+5) has JS offset = -300 min → interval = '+05:00'
    const offsetMinutes = -safeOffset; // flip sign: JS is "behind UTC", Postgres interval is "ahead"
    const sign          = offsetMinutes >= 0 ? '+' : '-';
    const absMin        = Math.abs(offsetMinutes);
    const hh            = String(Math.floor(absMin / 60)).padStart(2, '0');
    const mm            = String(absMin % 60).padStart(2, '0');
    const pgInterval    = `${sign}${hh}:${mm}`; // e.g. '+05:00'

    const client = await getAuthPool().connect();
    try {
      await setJwtClaims(client, user.claims);

      const [kpi, series] = await Promise.all([
        client.query(
          // Use CURRENT_DATE AT TIME ZONE so "today" is local to the client.
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
            )::numeric AS revenue_today,

            (SELECT COUNT(*) FROM inventory_items WHERE shop_id = $1)::int
              AS total_inventory_items,

            (SELECT COUNT(*) FROM inventory_items WHERE shop_id = $1 AND stock <= 5)::int
              AS low_stock_count`,
          [user.shopId, pgInterval],
        ),

        client.query<{ day: string; total_revenue: number; order_count: number }>(
          // Series: generate_series in local date, then LEFT JOIN orders
          `SELECT
             d.local_day                              AS day,
             COALESCE(SUM(o.total), 0)               AS total_revenue,
             COALESCE(COUNT(o.id), 0)                AS order_count
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
      ]);

      const k = kpi.rows[0] as Record<string, string>;
      return Response.json({
        newOrders:           Number(k['new_orders_today']),
        revenueToday:        Number(k['revenue_today']),
        totalInventoryItems: Number(k['total_inventory_items']),
        lowStockCount:       Number(k['low_stock_count']),
        revenueSeries: series.rows.map(r => ({
          day:           r.day,
          total_revenue: Number(r.total_revenue),
          order_count:   Number(r.order_count),
        })),
      });
    } finally { client.release(); }
  });
}
