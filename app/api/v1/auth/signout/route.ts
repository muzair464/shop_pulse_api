import { NextRequest } from 'next/server';
import { supabaseRevokeSession } from '@/lib/auth.service';
import { jsonClearCookies } from '@/lib/cookieHelpers';
import { withHandler } from '@/lib/requireAuth';

function parseCookie(header: string, name: string): string | undefined {
  const m = header.match(new RegExp(`(?:^|;\\s*)${name}=([^;]*)`));
  return m ? decodeURIComponent(m[1]) : undefined;
}

export const POST = withHandler(async (req: NextRequest) => {
  const refreshToken = parseCookie(req.headers.get('cookie') ?? '', 'refresh_token');
  if (refreshToken) await supabaseRevokeSession(refreshToken);
  return jsonClearCookies({ ok: true });
});
