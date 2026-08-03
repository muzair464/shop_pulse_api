import { NextRequest } from 'next/server';
import { supabaseRevokeSession } from '@/lib/auth.service';
import { jsonClearCookies } from '@/lib/cookieHelpers';
import { handleErrors, parseCookie } from '@/lib/requireAuth';

export async function POST(req: NextRequest): Promise<Response> {
  return handleErrors(async () => {
    const refreshToken = parseCookie(req.headers.get('cookie') ?? '', 'refresh_token');
    if (refreshToken) await supabaseRevokeSession(refreshToken);
    return jsonClearCookies({ ok: true });
  });
}
