import { NextRequest } from 'next/server';
import { supabaseSignIn, supabaseUpdatePassword } from '@/lib/auth.service';
import { requireAuth, handleErrors } from '@/lib/requireAuth';

export async function PATCH(req: NextRequest): Promise<Response> {
  return handleErrors(async () => {
    const user = await requireAuth(req);
    const { currentPassword, newPassword } = await req.json() as { currentPassword?: string; newPassword?: string };
    if (!currentPassword || !newPassword) return Response.json({ error: 'currentPassword and newPassword are required.' }, { status: 400 });
    if (newPassword.length < 8) return Response.json({ error: 'Password must be at least 8 characters.' }, { status: 400 });
    await supabaseSignIn(user.email, currentPassword);
    await supabaseUpdatePassword(user.userId, newPassword);
    return Response.json({ ok: true });
  });
}
