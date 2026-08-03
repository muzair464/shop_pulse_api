import { NextRequest } from 'next/server';
import { getServicePool } from '@/lib/db';
import { requireAuth, handleErrors } from '@/lib/requireAuth';

export async function POST(req: NextRequest): Promise<Response> {
  return handleErrors(async () => {
    const user = await requireAuth(req);
    let imageBytes: Buffer;
    let mimeType: string;

    const contentType = req.headers.get('content-type') ?? '';
    if (contentType.includes('multipart/form-data')) {
      const form = await req.formData();
      const file = form.get('image') as File | null;
      if (!file) return Response.json({ error: 'No image file provided.' }, { status: 400 });
      imageBytes = Buffer.from(await file.arrayBuffer());
      mimeType   = file.type;
    } else {
      const { imageBase64, mimeType: mt } = await req.json() as { imageBase64?: string; mimeType?: string };
      if (!imageBase64 || !mt) return Response.json({ error: 'Provide { imageBase64, mimeType }.' }, { status: 400 });
      imageBytes = Buffer.from(imageBase64, 'base64');
      mimeType   = mt;
    }

    if (!mimeType.startsWith('image/')) return Response.json({ error: 'File must be an image.' }, { status: 400 });

    const { rows } = await getServicePool().query(
      `UPDATE shops SET payment_qr_bytes=$2, payment_qr_mime_type=$3, updated_at=now()
       WHERE owner_user_id=$1
       RETURNING id, 'data:'||payment_qr_mime_type||';base64,'||encode(payment_qr_bytes,'base64') AS "paymentQrDataUri"`,
      [user.userId, imageBytes, mimeType],
    );
    if (!rows[0]) return Response.json({ error: 'Shop not found.' }, { status: 404 });
    return Response.json(rows[0]);
  });
}

export async function DELETE(req: NextRequest): Promise<Response> {
  return handleErrors(async () => {
    const user = await requireAuth(req);
    await getServicePool().query(
      `UPDATE shops SET payment_qr_bytes=NULL, payment_qr_mime_type=NULL, updated_at=now() WHERE owner_user_id=$1`,
      [user.userId],
    );
    return new Response(null, { status: 204 });
  });
}
