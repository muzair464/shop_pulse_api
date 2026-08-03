import { NextRequest } from 'next/server';
import { getAuthPool, setJwtClaims } from '@/lib/db';
import { withAuth } from '@/lib/requireAuth';

export const GET = withAuth(async (_req, user) => {
  const client = await getAuthPool().connect();
  try {
    await setJwtClaims(client, user.claims);
    const { rows } = await client.query(
      `SELECT id, name AS "shopName", phone, address,
              CASE WHEN payment_qr_bytes IS NOT NULL
                THEN 'data:'||payment_qr_mime_type||';base64,'||encode(payment_qr_bytes,'base64')
                ELSE NULL END AS "paymentQrDataUri",
              auto_export_frequency AS "autoExportFrequency",
              auto_print_receipt    AS "autoPrintReceipt"
       FROM shops WHERE owner_user_id=$1`,
      [user.userId],
    );
    if (!rows[0]) return Response.json({ error: 'Shop not found.' }, { status: 404 });
    return Response.json(rows[0]);
  } finally { client.release(); }
});

export const PATCH = withAuth(async (req: NextRequest, user) => {
  const { shopName, phone, address, autoExportFrequency, autoPrintReceipt } = await req.json() as {
    shopName?: string; phone?: string | null; address?: string | null;
    autoExportFrequency?: string; autoPrintReceipt?: boolean;
  };
  const client = await getAuthPool().connect();
  try {
    await setJwtClaims(client, user.claims);
    const { rows } = await client.query(
      `UPDATE shops SET
         name=COALESCE($2,name), phone=COALESCE($3,phone), address=COALESCE($4,address),
         auto_export_frequency=COALESCE($5,auto_export_frequency),
         auto_print_receipt=COALESCE($6,auto_print_receipt), updated_at=now()
       WHERE owner_user_id=$1
       RETURNING id, name AS "shopName", phone, address,
                 auto_export_frequency AS "autoExportFrequency",
                 auto_print_receipt    AS "autoPrintReceipt"`,
      [user.userId, shopName??null, phone!==undefined?phone:null, address!==undefined?address:null,
       autoExportFrequency??null, autoPrintReceipt!==undefined?autoPrintReceipt:null],
    );
    if (!rows[0]) return Response.json({ error: 'Shop not found.' }, { status: 404 });
    return Response.json(rows[0]);
  } finally { client.release(); }
});
