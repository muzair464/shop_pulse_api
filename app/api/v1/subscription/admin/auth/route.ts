import { NextRequest } from 'next/server';
import { getServicePool } from '@/lib/db';
import { handleErrors, AppError } from '@/lib/requireAuth';

/**
 * POST /api/v1/subscription/admin/auth
 * Verifies the super-admin passcode against what's stored in the DB.
 * No JWT auth required — the passcode IS the credential.
 * Returns 200 { ok: true } on match, 401 on mismatch, 403 if not set.
 */
export async function POST(req: NextRequest): Promise<Response> {
  return handleErrors(async () => {
    const body = await req.json() as { passcode?: string };

    if (!body.passcode?.trim()) {
      throw new AppError('Passcode is required.', 400);
    }

    const pool = getServicePool();
    const { rows } = await pool.query<{ admin_passcode: string }>(
      `SELECT admin_passcode FROM system_subscription_settings WHERE id = 1`,
    );

    const stored = rows[0]?.admin_passcode ?? '';

    if (!stored) {
      throw new AppError('Admin passcode has not been configured. Set it in the database.', 403);
    }

    if (body.passcode.trim() !== stored) {
      throw new AppError('Incorrect passcode.', 401);
    }

    return Response.json({ ok: true });
  });
}
