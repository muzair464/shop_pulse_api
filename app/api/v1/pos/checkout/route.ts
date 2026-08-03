import { NextRequest } from 'next/server';
import { getServicePool, getAuthPool } from '@/lib/db';
import { requireAuth, handleErrors } from '@/lib/requireAuth';
import { maybeSendLowStockAlert } from '@/lib/email.service';
import { logger } from '@/lib/logger';

interface CheckoutItem { inventoryId: string; qty: number; unitPrice: number; nameSnapshot: string; }

export async function POST(req: NextRequest): Promise<Response> {
  return handleErrors(async () => {
    const user = await requireAuth(req);
    const { items, discount, paymentMethod, idempotencyKey } = await req.json() as {
      items?: CheckoutItem[]; discount?: number; paymentMethod?: string; idempotencyKey?: string;
    };
    if (!items?.length)  return Response.json({ error: 'items must be a non-empty array.' }, { status: 400 });
    if (!paymentMethod)  return Response.json({ error: 'paymentMethod is required.' },       { status: 400 });
    if (!idempotencyKey) return Response.json({ error: 'idempotencyKey is required.' },      { status: 400 });

    try {
      const { rows } = await getServicePool().query(
        `SELECT checkout_sale($1::uuid,$2::jsonb,$3::numeric,$4::text,$5::text) AS result`,
        [user.shopId, JSON.stringify(items), Number(discount ?? 0), paymentMethod, idempotencyKey],
      );
      const order = rows[0].result as Record<string, unknown>;

      const ids = items.map(i => i.inventoryId);
      getAuthPool().query<{ name: string; stock: number }>(
        `SELECT name, stock FROM inventory_items WHERE shop_id=$1 AND id=ANY($2::uuid[]) AND stock<=5`,
        [user.shopId, ids],
      ).then(r => { if (r.rows.length > 0) maybeSendLowStockAlert(user.email, r.rows); })
       .catch((e: unknown) => logger.warn('low-stock check failed', e));

      logger.info('Checkout completed', { shopId: user.shopId, orderId: order['id'] });
      return Response.json({ order }, { status: 201 });
    } catch (err: unknown) {
      const e = err as { code?: string; message?: string };
      if (e.code === 'P0001') return Response.json({ error: e.message ?? 'Insufficient stock.' }, { status: 409 });
      throw err;
    }
  });
}
