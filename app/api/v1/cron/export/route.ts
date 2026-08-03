import { NextRequest } from 'next/server';
import { getServicePool } from '@/lib/db';
import { sendScheduledExport } from '@/lib/email.service';
import { env } from '@/lib/env';
import { logger } from '@/lib/logger';

/**
 * GET /api/v1/cron/export
 *
 * Called nightly by Vercel Cron (see vercel.json).
 * Protected by the CRON_SECRET env var via the Authorization header
 * that Vercel adds automatically.
 */
export async function GET(req: NextRequest) {
  const auth = req.headers.get('authorization');
  if (env.CRON_SECRET && auth !== `Bearer ${env.CRON_SECRET}`) {
    return Response.json({ error: 'Unauthorized.' }, { status: 401 });
  }

  const today      = new Date();
  const dayOfWeek  = today.getDay();
  const dayOfMonth = today.getDate();

  const pool = getServicePool();

  const { rows: shops } = await pool.query<{
    id: string; name: string; auto_export_frequency: string; email: string;
  }>(
    `SELECT s.id, s.name, s.auto_export_frequency, u.email
     FROM   shops s JOIN auth.users u ON u.id = s.owner_user_id
     WHERE  s.auto_export_frequency != 'never'`,
  );

  let sent = 0;
  for (const shop of shops) {
    const freq      = shop.auto_export_frequency;
    const shouldRun = freq === 'daily'
      || (freq === 'weekly'  && dayOfWeek  === 1)
      || (freq === 'monthly' && dayOfMonth === 1);
    if (!shouldRun) continue;

    try {
      const { rows } = await pool.query(
        `SELECT id, name, category, classification, stock, selling_price, cost_price
         FROM inventory_items WHERE shop_id = $1 ORDER BY name`,
        [shop.id],
      );
      const csv = 'id,name,category,classification,stock,selling_price,cost_price\n'
        + rows.map(r => [r.id, `"${(r.name as string).replace(/"/g,'""')}"`,
            r.category, r.classification, r.stock, r.selling_price, r.cost_price].join(',')).join('\n');
      sendScheduledExport(shop.email, csv, `${shop.name}-inventory-${today.toISOString().slice(0,10)}.csv`);
      sent++;
    } catch (err) {
      logger.error('Cron export failed for shop', { shopId: shop.id, err });
    }
  }

  logger.info('Cron export complete', { sent });
  return Response.json({ ok: true, sent });
}
