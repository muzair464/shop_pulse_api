import { NextRequest } from 'next/server';
import { verifySupabaseJwt } from '@/lib/verifyJwt';
import { getAuthPool } from '@/lib/db';
import { withHandler } from '@/lib/requireAuth';

function parseCookie(h: string, n: string) {
  const m = h.match(new RegExp(`(?:^|;\\s*)${n}=([^;]*)`));
  return m ? decodeURIComponent(m[1]) : undefined;
}

export const GET = withHandler(async (req: NextRequest) => {
  const token = parseCookie(req.headers.get('cookie') ?? '', 'access_token');
  if (!token) return Response.json({ authenticated: false, user: null, shop: null });

  let userId: string;
  try {
    const p = await verifySupabaseJwt(token);
    userId = p.sub ?? '';
  } catch {
    return Response.json({ authenticated: false, user: null, shop: null });
  }
  if (!userId) return Response.json({ authenticated: false, user: null, shop: null });

  const { rows } = await getAuthPool().query<{ id: string; name: string; email: string }>(
    `SELECT s.id, s.name, u.email FROM shops s JOIN auth.users u ON u.id = s.owner_user_id WHERE s.owner_user_id = $1 LIMIT 1`,
    [userId],
  );
  if (!rows[0]) return Response.json({ authenticated: false, user: null, shop: null });

  return Response.json({
    authenticated: true,
    user: { id: userId, email: rows[0].email },
    shop: { id: rows[0].id, name: rows[0].name },
  });
});
