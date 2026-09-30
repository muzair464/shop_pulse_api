import { NextRequest } from 'next/server';
import { getServicePool } from '@/lib/db';
import { handleErrors, AppError } from '@/lib/requireAuth';
import { requireAdminPasscode } from '@/lib/requireAdminPasscode';

/**
 * GET /api/v1/subscription/admin/shops
 * Lists all shops with subscription status, owner info, contact details.
 */
export async function GET(req: NextRequest): Promise<Response> {
  return handleErrors(async () => {
    await requireAdminPasscode(req);
    const pool = getServicePool();

    const { rows } = await pool.query(
      `SELECT
          s.id,
          s.name,
          s.phone,
          s.address,
          s.subscription_status,
          s.subscription_expires_at,
          s.subscription_monthly_fee,
          s.created_at,
          u.email AS owner_email
       FROM shops s
       JOIN auth.users u ON u.id = s.owner_user_id
       ORDER BY s.created_at DESC`,
    );

    return Response.json({ shops: rows });
  });
}

/**
 * PATCH /api/v1/subscription/admin/shops
 * Update a shop's subscription status and/or expiry date manually.
 */
export async function PATCH(req: NextRequest): Promise<Response> {
  return handleErrors(async () => {
    await requireAdminPasscode(req);

    const body = await req.json() as {
      shopId?: string;
      subscriptionStatus?: 'active' | 'expired' | 'pending_verification' | 'trial';
      subscriptionExpiresAt?: string | null; // ISO date string
      monthlyFee?: number;
    };

    if (!body.shopId) throw new AppError('shopId is required.', 400);

    const allowed = ['active', 'expired', 'pending_verification', 'trial'];
    if (body.subscriptionStatus && !allowed.includes(body.subscriptionStatus)) {
      throw new AppError('Invalid subscriptionStatus.', 400);
    }

    const pool = getServicePool();

    // Build dynamic SET clause
    const setClauses: string[] = ['updated_at = now()'];
    const params: unknown[] = [body.shopId];

    if (body.subscriptionStatus) {
      params.push(body.subscriptionStatus);
      setClauses.push(`subscription_status = $${params.length}::subscription_status`);
    }

    if (body.subscriptionExpiresAt !== undefined) {
      params.push(body.subscriptionExpiresAt);
      setClauses.push(`subscription_expires_at = $${params.length}`);
    }

    if (body.monthlyFee !== undefined) {
      params.push(body.monthlyFee);
      setClauses.push(`subscription_monthly_fee = $${params.length}`);
    }

    const { rows } = await pool.query(
      `UPDATE shops SET ${setClauses.join(', ')}
       WHERE id = $1
       RETURNING id, name, subscription_status, subscription_expires_at, subscription_monthly_fee`,
      params,
    );

    if (!rows.length) throw new AppError('Shop not found.', 404);

    return Response.json({ message: 'Shop subscription updated.', shop: rows[0] });
  });
}
