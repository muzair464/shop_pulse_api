import { NextRequest } from 'next/server';
import { supabaseRefreshToken } from '@/lib/auth.service';
import { jsonWithCookies, jsonClearCookies } from '@/lib/cookieHelpers';
import { withHandler } from '@/lib/requireAuth';

function parseCookie(h: string, n: string) {
  const m = h.match(new RegExp(`(?:^|;\\s*)${n}=([^;]*)`));
  return m ? decodeURIComponent(m[1]) : undefined;
}

export const POST = withHandler(async (req: NextRequest) => {
  const refreshToken = parseCookie(req.headers.get('cookie') ?? '', 'refresh_token');
  if (!refreshToken) return Response.json({ error: 'No refresh token.' }, { status: 401 });
  try {
    const tokens = await supabaseRefreshToken(refreshToken);
    return jsonWithCookies({ ok: true }, tokens.access_token, tokens.refresh_token, tokens.expires_in);
  } catch {
    return jsonClearCookies({ error: 'Session refresh failed.' }, 401);
  }
});
