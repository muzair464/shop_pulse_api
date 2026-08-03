import { supabaseSignIn, supabaseUpdatePassword } from '@/lib/auth.service';
import { withAuth } from '@/lib/requireAuth';

export const PATCH = withAuth(async (req, user) => {
  const { currentPassword, newPassword } = await req.json() as { currentPassword?: string; newPassword?: string };
  if (!currentPassword || !newPassword) return Response.json({ error: 'currentPassword and newPassword are required.' }, { status: 400 });
  if (newPassword.length < 8) return Response.json({ error: 'Password must be at least 8 characters.' }, { status: 400 });
  await supabaseSignIn(user.email, currentPassword);
  await supabaseUpdatePassword(user.userId, newPassword);
  return Response.json({ ok: true });
});
