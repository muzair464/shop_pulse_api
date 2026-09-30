import { NextRequest } from 'next/server';
import { getServicePool } from '@/lib/db';
import { handleErrors, AppError } from '@/lib/requireAuth';
import { requireAdminPasscode } from '@/lib/requireAdminPasscode';

// GET /api/v1/subscription/admin/settings — fetch settings for admin panel
export async function GET(req: NextRequest): Promise<Response> {
  return handleErrors(async () => {
    await requireAdminPasscode(req);
    const pool = getServicePool();
    const { rows } = await pool.query(
      `SELECT monthly_fee, bank_name, account_title, account_number, iban,
              easypaisa_title, easypaisa_number, instructions,
              CASE WHEN payment_qr_bytes IS NOT NULL
                THEN 'data:'||payment_qr_mime_type||';base64,'||encode(payment_qr_bytes,'base64')
                ELSE NULL END AS "paymentQrDataUri"
       FROM system_subscription_settings WHERE id = 1`
    );
    return Response.json({ settings: rows[0] });
  });
}

// PATCH /api/v1/subscription/admin/settings — update global Easypaisa & Bank details & QR
export async function PATCH(req: NextRequest): Promise<Response> {
  return handleErrors(async () => {
    await requireAdminPasscode(req);
    const body = await req.json() as {
      monthlyFee?: number;
      bankName?: string;
      accountTitle?: string;
      accountNumber?: string;
      iban?: string;
      easypaisaTitle?: string;
      easypaisaNumber?: string;
      instructions?: string;
      paymentQrBase64?: string | null;
    };

    let qrBytes: Buffer | null = null;
    let qrMime: string | null = null;

    if (body.paymentQrBase64) {
      const dataUri = body.paymentQrBase64;
      if (dataUri.includes(';base64,')) {
        const [header, base64] = dataUri.split(';base64,');
        qrMime = header.replace(/^data:/, '');
        qrBytes = Buffer.from(base64, 'base64');
      } else {
        qrBytes = Buffer.from(dataUri, 'base64');
        qrMime = 'image/png';
      }
    }

    const pool = getServicePool();
    const { rows } = await pool.query(
      `UPDATE system_subscription_settings
       SET monthly_fee          = COALESCE($1, monthly_fee),
           bank_name            = COALESCE($2, bank_name),
           account_title        = COALESCE($3, account_title),
           account_number       = COALESCE($4, account_number),
           iban                 = COALESCE($5, iban),
           easypaisa_title      = COALESCE($6, easypaisa_title),
           easypaisa_number     = COALESCE($7, easypaisa_number),
           instructions         = COALESCE($8, instructions),
           payment_qr_bytes     = CASE WHEN $9::boolean THEN $10 ELSE payment_qr_bytes END,
           payment_qr_mime_type = CASE WHEN $9::boolean THEN $11 ELSE payment_qr_mime_type END,
           updated_at           = now()
       WHERE id = 1
       RETURNING monthly_fee, bank_name, account_title, account_number, iban,
                 easypaisa_title, easypaisa_number, instructions`,
      [
        body.monthlyFee ?? null,
        body.bankName ?? null,
        body.accountTitle ?? null,
        body.accountNumber ?? null,
        body.iban ?? null,
        body.easypaisaTitle ?? null,
        body.easypaisaNumber ?? null,
        body.instructions ?? null,
        body.paymentQrBase64 !== undefined,
        qrBytes,
        qrMime,
      ],
    );

    return Response.json({
      message: 'System subscription settings updated.',
      settings: rows[0],
    });
  });
}
