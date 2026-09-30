import { NextRequest } from 'next/server';
import { getServicePool } from '@/lib/db';
import { handleErrors, AppError } from '@/lib/requireAuth';
import { requireAdminPasscode } from '@/lib/requireAdminPasscode';

// GET /api/v1/subscription/admin/payments — view all submitted payments (for admin verification)
export async function GET(req: NextRequest): Promise<Response> {
  return handleErrors(async () => {
    await requireAdminPasscode(req);
    const pool = getServicePool();

    // Fetch payments with shop info
    const { rows } = await pool.query(
      `SELECT p.id, p.shop_id, s.name AS shop_name, s.phone AS shop_phone, u.email AS owner_email,
              p.amount, p.payment_method, p.transaction_id, p.sender_account,
              p.notes, p.status, p.admin_notes, p.verified_at, p.created_at,
              CASE WHEN p.receipt_bytes IS NOT NULL
                THEN 'data:'||p.receipt_mime_type||';base64,'||encode(p.receipt_bytes,'base64')
                ELSE NULL END AS "receiptDataUri",
              s.subscription_status, s.subscription_expires_at
       FROM subscription_payments p
       JOIN shops s ON s.id = p.shop_id
       JOIN auth.users u ON u.id = s.owner_user_id
       ORDER BY p.created_at DESC
       LIMIT 100`,
    );

    return Response.json({ payments: rows });
  });
}

// POST /api/v1/subscription/admin/verify — approve or reject a payment request
export async function POST(req: NextRequest): Promise<Response> {
  return handleErrors(async () => {
    await requireAdminPasscode(req);
    const body = await req.json() as {
      paymentId?: string;
      action?: 'approve' | 'reject';
      adminNotes?: string | null;
    };

    if (!body.paymentId) throw new AppError('paymentId is required.', 400);
    if (!body.action || !['approve', 'reject'].includes(body.action)) {
      throw new AppError('action must be either "approve" or "reject".', 400);
    }

    const pool = getServicePool();

    if (body.action === 'approve') {
      const { rows } = await pool.query(
        `SELECT approve_subscription_payment($1::uuid, $2::text) AS result`,
        [body.paymentId, body.adminNotes ?? null],
      );
      return Response.json({
        message: 'Payment approved successfully. Subscription extended by 30 days.',
        result: rows[0].result,
      });
    } else {
      // Reject
      const { rows } = await pool.query(
        `UPDATE subscription_payments
         SET status = 'rejected',
             admin_notes = $2,
             verified_at = now(),
             updated_at = now()
         WHERE id = $1::uuid
         RETURNING id, shop_id, status`,
        [body.paymentId, body.adminNotes ?? 'Payment could not be verified.'],
      );

      if (!rows.length) throw new AppError('Payment not found.', 404);

      // Re-evaluate shop subscription status if currently pending_verification
      await pool.query(
        `UPDATE shops
         SET subscription_status = CASE
           WHEN subscription_expires_at > now() THEN 'active'::subscription_status
           ELSE 'expired'::subscription_status
         END
         WHERE id = $1::uuid`,
        [rows[0].shop_id],
      );

      return Response.json({
        message: 'Payment rejected.',
        payment: rows[0],
      });
    }
  });
}
