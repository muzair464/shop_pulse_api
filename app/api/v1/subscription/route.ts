import { NextRequest } from 'next/server';
import { getServicePool, getAuthPool, setJwtClaims } from '@/lib/db';
import { requireAuth, handleErrors, AppError } from '@/lib/requireAuth';

export async function GET(req: NextRequest): Promise<Response> {
  return handleErrors(async () => {
    const user = await requireAuth(req);
    const pool = getAuthPool();
    const client = await pool.connect();

    try {
      await setJwtClaims(client, user.claims);

      // 1. Fetch system bank/easypaisa payment details
      const { rows: systemRows } = await client.query(
        `SELECT monthly_fee, bank_name, account_title, account_number, iban,
                easypaisa_title, easypaisa_number, instructions,
                CASE WHEN payment_qr_bytes IS NOT NULL
                  THEN 'data:'||payment_qr_mime_type||';base64,'||encode(payment_qr_bytes,'base64')
                  ELSE NULL END AS "paymentQrDataUri"
         FROM system_subscription_settings WHERE id = 1`,
      );

      // 2. Fetch current shop's subscription info
      const { rows: shopRows } = await client.query(
        `SELECT id, name, subscription_status, subscription_expires_at, subscription_monthly_fee
         FROM shops WHERE id = $1`,
        [user.shopId],
      );

      // 3. Fetch past payment submission history
      const { rows: paymentRows } = await client.query(
        `SELECT id, amount, payment_method, transaction_id, sender_account,
                notes, status, admin_notes, verified_at, created_at,
                CASE WHEN receipt_bytes IS NOT NULL
                  THEN 'data:'||receipt_mime_type||';base64,'||encode(receipt_bytes,'base64')
                  ELSE NULL END AS "receiptDataUri"
         FROM subscription_payments
         WHERE shop_id = $1
         ORDER BY created_at DESC`,
        [user.shopId],
      );

      const shop = shopRows[0];
      const expiresAt = shop?.subscription_expires_at;
      const isExpired = expiresAt ? new Date(expiresAt).getTime() < Date.now() : true;
      const subStatus = shop?.subscription_status ?? 'expired';
      // Both 'active' and 'trial' are live — no payment required.
      // 'trial' ignores the expiry date (admin-granted, never auto-expires from backend).
      const isSubscriptionActive =
        (subStatus === 'active' && !isExpired) ||
        subStatus === 'trial';

      return Response.json({
        systemSettings: systemRows[0] || {
          monthly_fee: 3000,
          bank_name: 'Meezan Bank',
          account_title: 'ShopPulse Billing',
          account_number: '0101-0102030405',
          iban: 'PK00MEZN0001010102030405',
          easypaisa_title: 'ShopPulse Payments',
          easypaisa_number: '0300-1234567',
          paymentQrDataUri: null,
          instructions: 'Transfer the monthly fee to Easypaisa or Bank Account, then submit the TRX ID and receipt screenshot below.',
        },
        subscription: {
          status: subStatus,
          expiresAt,
          isSubscriptionActive,
          monthlyFee: shop?.subscription_monthly_fee ?? 3000,
        },
        payments: paymentRows,
      });
    } finally {
      client.release();
    }
  });
}

export async function POST(req: NextRequest): Promise<Response> {
  return handleErrors(async () => {
    const user = await requireAuth(req);
    const body = await req.json() as {
      amount?: number;
      paymentMethod?: string;
      transactionId?: string;
      senderAccount?: string | null;
      receiptBase64?: string | null;
      notes?: string | null;
    };

    if (!body.amount || Number(body.amount) <= 0) {
      throw new AppError('Valid amount is required.', 400);
    }
    if (!body.paymentMethod || !['EASYPAISA', 'BANK'].includes(body.paymentMethod.toUpperCase())) {
      throw new AppError('Payment method must be EASYPAISA or BANK.', 400);
    }
    if (!body.transactionId?.trim()) {
      throw new AppError('Transaction ID (TRX ID) is required.', 400);
    }

    let receiptBytes: Buffer | null = null;
    let receiptMime: string | null = null;

    if (body.receiptBase64) {
      const dataUri = body.receiptBase64;
      if (dataUri.includes(';base64,')) {
        const [header, base64] = dataUri.split(';base64,');
        receiptMime = header.replace(/^data:/, '');
        receiptBytes = Buffer.from(base64, 'base64');
      } else {
        receiptBytes = Buffer.from(dataUri, 'base64');
        receiptMime = 'image/jpeg';
      }

      if (receiptBytes.length > 5 * 1024 * 1024) {
        throw new AppError('Receipt screenshot must be under 5MB.', 400);
      }
    }

    const pool = getServicePool();
    const { rows } = await pool.query(
      `INSERT INTO subscription_payments
         (shop_id, amount, payment_method, transaction_id, sender_account, receipt_bytes, receipt_mime_type, notes, status)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'pending')
       RETURNING id, amount, payment_method, transaction_id, sender_account, notes, status, created_at`,
      [
        user.shopId,
        Number(body.amount),
        body.paymentMethod.toUpperCase(),
        body.transactionId.trim(),
        body.senderAccount?.trim() || null,
        receiptBytes,
        receiptMime,
        body.notes?.trim() || null,
      ],
    );

    // Also update shop status to pending_verification if currently expired
    await pool.query(
      `UPDATE shops
       SET subscription_status = 'pending_verification'
       WHERE id = $1 AND (subscription_status = 'expired' OR subscription_expires_at < now())`,
      [user.shopId],
    );

    return Response.json(
      {
        message: 'Payment verification request submitted successfully. Once verified by admin, your service will be fully active.',
        payment: rows[0],
      },
      { status: 201 },
    );
  });
}
