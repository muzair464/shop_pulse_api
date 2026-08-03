import { supabaseForgotPassword } from '@/lib/auth.service';
import { withHandler } from '@/lib/requireAuth';

export const POST = withHandler(async (req) => {
  const { email } = await req.json() as { email?: string };
  if (!email) return Response.json({ error: 'Email is required.' }, { status: 400 });
  await supabaseForgotPassword(email);
  return Response.json({ ok: true });
});
