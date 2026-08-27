import { NextRequest } from 'next/server';
import { verifySupabaseJwt } from '@/lib/verifyJwt';
import { supabaseRefreshToken } from '@/lib/auth.service';
import { getAuthPool } from '@/lib/db';
import { handleErrors, parseCookie } from '@/lib/requireAuth';
import { appendAuthCookies, appendClearCookies, REMEMBER_COOKIE } from '@/lib/cookieHelpers';
import { logger } from '@/lib/logger';

export async function GET(req: NextRequest): Promise<Response> {
  return handleErrors(async () => {
    const cookieHeader = req.headers.get('cookie') ?? '';
    const token        = parseCookie(cookieHeader, 'access_token');

    let userId: string | null = null;

    // ── Try the access_token first ────────────────────────────────────────
    if (token) {
      try {
        const p = await verifySupabaseJwt(token);
        userId = p.sub ?? null;
      } catch {
        // Access token expired or invalid — fall through to refresh attempt.
        userId = null;
      }
    }

    // ── Silent refresh: access_token missing or expired ───────────────────
    if (!userId) {
      const refreshToken = parseCookie(cookieHeader, 'refresh_token');
      if (!refreshToken) {
        return Response.json({ authenticated: false, user: null, shop: null });
      }

      let newTokens;
      try {
        newTokens = await supabaseRefreshToken(refreshToken);
        userId = newTokens.user.id;
      } catch {
        // Refresh token revoked, expired, or malformed — sign out cleanly.
        const headers = new Headers({ 'Content-Type': 'application/json' });
        appendClearCookies(headers);
        return new Response(
          JSON.stringify({ authenticated: false, user: null, shop: null }),
          { status: 200, headers },
        );
      }

      // Resolve the shop for the refreshed user.
      const pool = getAuthPool();
      const { rows } = await pool.query<{ id: string; name: string; email: string }>(
        `SELECT s.id, s.name, u.email
         FROM   shops s
         JOIN   auth.users u ON u.id = s.owner_user_id
         WHERE  s.owner_user_id = $1 LIMIT 1`,
        [userId],
      );
      if (!rows[0]) {
        return Response.json({ authenticated: false, user: null, shop: null });
      }

      // Re-issue cookies. Preserve the original remember-me preference by
      // reading the non-httpOnly `remember` marker cookie that was set at
      // sign-in time: if present (and the browser didn't discard it on close),
      // the user opted for persistent cookies; otherwise keep session-only.
      const rememberDevice = parseCookie(cookieHeader, REMEMBER_COOKIE) === '1';

      logger.info('Silent token refresh via /session', { userId });
      const headers = new Headers({ 'Content-Type': 'application/json' });
      appendAuthCookies(
        headers,
        newTokens.access_token,
        newTokens.refresh_token,
        newTokens.expires_in,
        rememberDevice,
      );
      return new Response(
        JSON.stringify({
          authenticated: true,
          user: { id: userId, email: rows[0].email },
          shop: { id: rows[0].id, name: rows[0].name },
        }),
        { status: 200, headers },
      );
    }

    // ── Access token still valid — normal path ────────────────────────────
    const { rows } = await getAuthPool().query<{ id: string; name: string; email: string }>(
      `SELECT s.id, s.name, u.email
       FROM   shops s
       JOIN   auth.users u ON u.id = s.owner_user_id
       WHERE  s.owner_user_id = $1 LIMIT 1`,
      [userId],
    );
    if (!rows[0]) {
      return Response.json({ authenticated: false, user: null, shop: null });
    }

    return Response.json({
      authenticated: true,
      user: { id: userId, email: rows[0].email },
      shop: { id: rows[0].id, name: rows[0].name },
    });
  });
}
