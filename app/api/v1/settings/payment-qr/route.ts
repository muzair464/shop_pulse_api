import { NextRequest } from 'next/server';
import { getServicePool } from '@/lib/db';
import { requireAuth, handleErrors } from '@/lib/requireAuth';

// 2 MB hard limit — generous enough for any QR image, rejects large payloads.
const MAX_BYTES = 2 * 1024 * 1024;

/**
 * Magic-byte signatures for accepted image formats.
 * Checked against the actual file bytes, not the client-supplied MIME type.
 */
const IMAGE_SIGNATURES: Array<{ mime: string; magic: number[] }> = [
  { mime: 'image/png',  magic: [0x89, 0x50, 0x4e, 0x47] },         // PNG
  { mime: 'image/jpeg', magic: [0xff, 0xd8, 0xff] },                // JPEG
  { mime: 'image/webp', magic: [0x52, 0x49, 0x46, 0x46] },          // RIFF (WebP)
  { mime: 'image/gif',  magic: [0x47, 0x49, 0x46, 0x38] },          // GIF8
];

function detectMimeType(buf: Buffer): string | null {
  for (const sig of IMAGE_SIGNATURES) {
    if (sig.magic.every((byte, i) => buf[i] === byte)) {
      // Extra WebP check: bytes 8-11 must be 'W','E','B','P'
      if (sig.mime === 'image/webp') {
        if (buf[8] === 0x57 && buf[9] === 0x45 && buf[10] === 0x42 && buf[11] === 0x50) {
          return sig.mime;
        }
        continue;
      }
      return sig.mime;
    }
  }
  return null;
}

export async function POST(req: NextRequest): Promise<Response> {
  return handleErrors(async () => {
    const user = await requireAuth(req);
    let imageBytes: Buffer;

    const contentType = req.headers.get('content-type') ?? '';
    if (contentType.includes('multipart/form-data')) {
      const form = await req.formData();
      const file = form.get('image') as File | null;
      if (!file) return Response.json({ error: 'No image file provided.' }, { status: 400 });
      imageBytes = Buffer.from(await file.arrayBuffer());
    } else {
      const { imageBase64 } = await req.json() as { imageBase64?: string; mimeType?: string };
      if (!imageBase64) {
        return Response.json({ error: 'Provide { imageBase64, mimeType }.' }, { status: 400 });
      }
      imageBytes = Buffer.from(imageBase64, 'base64');
    }

    // ── Size check ────────────────────────────────────────────────────────
    if (imageBytes.length > MAX_BYTES) {
      return Response.json(
        { error: `Image must be smaller than ${MAX_BYTES / 1024 / 1024} MB.` },
        { status: 400 },
      );
    }

    // ── Magic-byte content sniffing ───────────────────────────────────────
    // Trust the actual file bytes, not the client-supplied MIME type string.
    const detectedMime = detectMimeType(imageBytes);
    if (!detectedMime) {
      return Response.json(
        { error: 'File must be a valid PNG, JPEG, WebP, or GIF image.' },
        { status: 400 },
      );
    }

    const { rows } = await getServicePool().query(
      `UPDATE shops
          SET payment_qr_bytes    = $2,
              payment_qr_mime_type = $3,
              updated_at           = now()
        WHERE owner_user_id = $1
        RETURNING id,
          'data:' || payment_qr_mime_type || ';base64,' ||
          encode(payment_qr_bytes, 'base64') AS "paymentQrDataUri"`,
      [user.userId, imageBytes, detectedMime],
    );
    if (!rows[0]) return Response.json({ error: 'Shop not found.' }, { status: 404 });
    return Response.json(rows[0]);
  });
}

export async function DELETE(req: NextRequest): Promise<Response> {
  return handleErrors(async () => {
    const user = await requireAuth(req);
    await getServicePool().query(
      `UPDATE shops
          SET payment_qr_bytes = NULL, payment_qr_mime_type = NULL, updated_at = now()
        WHERE owner_user_id = $1`,
      [user.userId],
    );
    return new Response(null, { status: 204 });
  });
}
