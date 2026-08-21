import { NextRequest } from 'next/server';
import { supabaseForgotPassword } from '@/lib/auth.service';
import { handleErrors } from '@/lib/requireAuth';
import { env } from '@/lib/env';

export async function POST(req: NextRequest): Promise<Response> {
  return handleErrors(async () => {
    const { email } = await req.json() as { email?: string };
    if (!email) return Response.json({ error: 'Email is required.' }, { status: 400 });
    const redirectTo = `${env.FRONTEND_URL.replace(/\/$/, '')}/set-password`;
    await supabaseForgotPassword(email, redirectTo);
    return Response.json({ ok: true });
  });
}
