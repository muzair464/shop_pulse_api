import { NextRequest } from 'next/server';
import { getServicePool } from '@/lib/db';
import { AppError } from '@/lib/requireAuth';

/**
 * Validates the X-Admin-Passcode header against the database.
 * Throws AppError(401/403) if invalid or missing.
 */
export async function requireAdminPasscode(req: NextRequest | Request): Promise<void> {
  const passcode = req.headers.get('x-admin-passcode');
  if (!passcode) {
    throw new AppError('Admin passcode is required.', 401);
  }

  const pool = getServicePool();
  const { rows } = await pool.query<{ admin_passcode: string }>(
    `SELECT admin_passcode FROM system_subscription_settings WHERE id = 1`,
  );

  const stored = rows[0]?.admin_passcode ?? '';
  if (!stored) {
    throw new AppError('Admin passcode has not been configured in the database.', 403);
  }

  if (passcode !== stored) {
    throw new AppError('Incorrect admin passcode.', 401);
  }
}
