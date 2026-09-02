import { NextRequest } from 'next/server';
import { getAuthPool, setJwtClaims } from '@/lib/db';
import { requireAuth, handleErrors } from '@/lib/requireAuth';

export async function GET(req: NextRequest): Promise<Response> {
  return handleErrors(async () => {
    const user   = await requireAuth(req);
    const client = await getAuthPool().connect();
    try {
      await setJwtClaims(client, user.claims);
      const { rows } = await client.query(
        `SELECT id, name AS "shopName", phone, address,
                CASE WHEN payment_qr_bytes IS NOT NULL
                  THEN 'data:'||payment_qr_mime_type||';base64,'||encode(payment_qr_bytes,'base64')
                  ELSE NULL END AS "paymentQrDataUri",
                auto_export_frequency AS "autoExportFrequency",
                auto_print_receipt    AS "autoPrintReceipt",
                receipt_footer_message AS "receiptFooterMessage"
         FROM shops WHERE owner_user_id=$1`,
        [user.userId],
      );
      if (!rows[0]) return Response.json({ error: 'Shop not found.' }, { status: 404 });
      return Response.json(rows[0]);
    } finally { client.release(); }
  });
}

export async function PATCH(req: NextRequest): Promise<Response> {
  return handleErrors(async () => {
    const user = await requireAuth(req);
    const { shopName, phone, address, autoExportFrequency, autoPrintReceipt, receiptFooterMessage } = await req.json() as {
      shopName?: string; phone?: string | null; address?: string | null;
      autoExportFrequency?: string; autoPrintReceipt?: boolean; receiptFooterMessage?: string | null;
    };
    const client = await getAuthPool().connect();
    try {
      await setJwtClaims(client, user.claims);
      const { rows } = await client.query(
        `UPDATE shops SET
           name=COALESCE($2,name), phone=COALESCE($3,phone), address=COALESCE($4,address),
           auto_export_frequency=COALESCE($5,auto_export_frequency),
           auto_print_receipt=COALESCE($6,auto_print_receipt),
           receipt_footer_message=COALESCE($7,receipt_footer_message),
           updated_at=now()
         WHERE owner_user_id=$1
         RETURNING id, name AS "shopName", phone, address,
                   auto_export_frequency AS "autoExportFrequency",
                   auto_print_receipt    AS "autoPrintReceipt",
                   receipt_footer_message AS "receiptFooterMessage"`,
        [user.userId, shopName ?? null,
         phone   !== undefined ? phone   : null,
         address !== undefined ? address : null,
         autoExportFrequency ?? null,
         autoPrintReceipt    !== undefined ? autoPrintReceipt : null,
         receiptFooterMessage !== undefined ? receiptFooterMessage : null],
      );
      if (!rows[0]) return Response.json({ error: 'Shop not found.' }, { status: 404 });
      return Response.json(rows[0]);
    } finally { client.release(); }
  });
}
