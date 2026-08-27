import { NextRequest } from 'next/server';
import { supabaseRefreshToken } from '@/lib/auth.service';
import { jsonWithCookies, jsonClearCookies, REMEMBER_COOKIE } from '@/lib/cookieHelpers';
import { handleErrors, parseCookie } from '@/lib/requireAuth';

export async function POST(req: NextRequest): Promise<Response> {
  return handleErrors(async () => {
    const cookieHeader = req.headers.get('cookie') ?? '';
    const refreshToken = parseCookie(cookieHeader, 'refresh_token');
    if (!refreshToken) return Response.json({ error: 'No refresh token.' }, { status: 401 });

    // Preserve the original remember-me preference when re-issuing cookies.
    const rememberDevice = parseCookie(cookieHeader, REMEMBER_COOKIE) === '1';

    try {
      const tokens = await supabaseRefreshToken(refreshToken);
      return jsonWithCookies(
        { ok: true },
        tokens.access_token,
        tokens.refresh_token,
        tokens.expires_in,
        200,
        rememberDevice,
      );
    } catch {
      return jsonClearCookies({ error: 'Session refresh failed.' }, 401);
    }
  });
}
