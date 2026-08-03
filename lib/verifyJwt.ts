import { createRemoteJWKSet, jwtVerify, JWTPayload } from 'jose';
import { env, JWKS_URL } from './env';
import { logger } from './logger';

const JWKS = createRemoteJWKSet(new URL(JWKS_URL), {
  cacheMaxAge: 10 * 60 * 1_000,
});

export async function verifySupabaseJwt(token: string): Promise<JWTPayload> {
  try {
    const { payload } = await jwtVerify(token, JWKS, { audience: 'authenticated' });
    return payload;
  } catch (jwksErr) {
    if (env.SUPABASE_JWT_SECRET) {
      logger.debug('JWKS verify failed — trying HS256 fallback', jwksErr);
      try {
        const secret = new TextEncoder().encode(env.SUPABASE_JWT_SECRET);
        const { payload } = await jwtVerify(token, secret, {
          audience: 'authenticated', algorithms: ['HS256'],
        });
        return payload;
      } catch { throw jwksErr; }
    }
    throw jwksErr;
  }
}
