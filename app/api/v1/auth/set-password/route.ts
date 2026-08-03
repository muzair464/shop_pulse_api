import { NextRequest } from 'next/server';
import { supabaseUpdatePassword } from '@/lib/auth.service';
import { requireAuth, handleErrors } from '@/lib/requireAuth';
import { logger } from '@/lib/logger';

export async function PATCH(req: NextRequest): Promise<Response> {
  return handleErrors(async () => {
    const user = await requireAuth(req);
    const { newPassword } = await req.json() as { newPassword?: string };
    if (!newPassword) return Response.json({ error: 'newPassword is required.' }, { status: 400 });
    if (newPassword.length < 8) return Response.json({ error: 'Password must be at least 8 characters.' }, { status: 400 });
    await supabaseUpdatePassword(user.userId, newPassword);
    logger.info('Password set', { userId: user.userId });
    return Response.json({ ok: true });
  });
}
