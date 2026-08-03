import { NextRequest } from 'next/server';
import { supabaseSignUp, supabaseDeleteUser } from '@/lib/auth.service';
import { getServicePool } from '@/lib/db';
import { handleErrors } from '@/lib/requireAuth';
import { env } from '@/lib/env';
import { logger } from '@/lib/logger';

export async function POST(req: NextRequest): Promise<Response> {
  return handleErrors(async () => {
    const { email, password, shopName, phone, address } = await req.json() as {
      email?: string; password?: string; shopName?: string; phone?: string; address?: string;
    };
    if (!email || !password || !shopName) return Response.json({ error: 'email, password, and shopName are required.' }, { status: 400 });
    if (password.length < 8) return Response.json({ error: 'Password must be at least 8 characters.' }, { status: 400 });

    const redirectTo = `${env.FRONTEND_URL}/verify-email`;
    const newUser = await supabaseSignUp(email, password, redirectTo);

    try {
      await getServicePool().query(
        `INSERT INTO shops (owner_user_id, name, phone, address) VALUES ($1, $2, $3, $4)`,
        [newUser.id, shopName.trim(), phone?.trim() ?? null, address?.trim() ?? null],
      );
    } catch (dbErr) {
      logger.error('signUp: shop insert failed — rolling back auth user', dbErr);
      await supabaseDeleteUser(newUser.id).catch(() => undefined);
      throw dbErr;
    }

    logger.info('User signed up', { userId: newUser.id });
    return Response.json({ ok: true, message: 'Account created. Please check your email to verify your address.' }, { status: 201 });
  });
}
