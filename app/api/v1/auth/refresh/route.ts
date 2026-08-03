import { NextRequest } from 'next/server';
import { supabaseRefreshToken } from '@/lib/auth.service';
import { jsonWithCookies, jsonClearCookies } from '@/lib/cookieHelpers';
import { handleErrors, parseCookie } from '@/lib/requireAuth';

export async function POST(req: NextRequest): Promise<Response> {
  return handleErrors(async () => {
    const refreshToken = parseCookie(req.headers.get('cookie') ?? '', 'refresh_token');
    if (!refreshToken) return Response.json({ error: 'No refresh token.' }, { status: 401 });
    try {
      const tokens = await supabaseRefreshToken(refreshToken);
      return jsonWithCookies({ ok: true }, tokens.access_token, tokens.refresh_token, tokens.expires_in);
    } catch {
      return jsonClearCookies({ error: 'Session refresh failed.' }, 401);
    }
  });
}
