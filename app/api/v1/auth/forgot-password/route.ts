import { NextRequest } from 'next/server';
import { supabaseForgotPassword } from '@/lib/auth.service';
import { handleErrors } from '@/lib/requireAuth';
import { checkRateLimit, rateLimitKey, tooManyRequests } from '@/lib/rateLimit';
import { env } from '@/lib/env';
import { logger } from '@/lib/logger';

// 5 reset requests per hour per email.
const FP_MAX    = 5;
const FP_WINDOW = 60 * 60 * 1_000;

export async function POST(req: NextRequest): Promise<Response> {
  return handleErrors(async () => {
    const { email } = await req.json() as { email?: string };
    if (!email) return Response.json({ error: 'Email is required.' }, { status: 400 });

    // Rate limit by email so an attacker can't hammer a specific account.
    // Also rate limit by IP to slow down enumeration via timing differences.
    const emailKey = checkRateLimit(`forgot:email:${email.toLowerCase()}`, FP_MAX, FP_WINDOW);
    const ipKey    = checkRateLimit(rateLimitKey(req), FP_MAX * 2, FP_WINDOW);

    if (!emailKey.allowed) {
      logger.warn('forgot-password rate-limited by email', { email });
      return tooManyRequests(emailKey.retryAfterMs!);
    }
    if (!ipKey.allowed) {
      logger.warn('forgot-password rate-limited by IP', { ip: req.headers.get('x-forwarded-for') });
      return tooManyRequests(ipKey.retryAfterMs!);
    }

    const redirectTo = `${env.FRONTEND_URL.replace(/\/$/, '')}/set-password`;
    await supabaseForgotPassword(email, redirectTo);
    return Response.json({ ok: true });
  });
}
