/**
 * lib/db.ts — pg connection pools for Next.js Route Handlers.
 *
 * Next.js serverless functions are short-lived but the Node.js module cache
 * persists across invocations within the same worker instance.  Pooling here
 * prevents creating a new connection on every request.
 *
 * Two pools matching the two trust tiers from the Express backend:
 *   authenticatedPool  — RLS-enforced; call setJwtClaims() before each query
 *   serviceRolePool    — BYPASSRLS; for checkout, QR writes, exports
 */

import { Pool, PoolClient } from 'pg';
import { env } from './env';

// Module-level singletons — reused across warm lambda invocations.
let _authPool: Pool | null = null;
let _svcPool:  Pool | null = null;

export function getAuthPool(): Pool {
  if (!_authPool) {
    _authPool = new Pool({
      connectionString:     env.DATABASE_URL_AUTH,
      max:                  3,   // Reduced for serverless - Supabase pooler limit is 15
      min:                  0,   // No idle connections
      idleTimeoutMillis:    10_000,  // Release idle connections faster
      connectionTimeoutMillis: 5_000,
    });
  }
  return _authPool;
}

export function getServicePool(): Pool {
  if (!_svcPool) {
    _svcPool = new Pool({
      connectionString:     env.DATABASE_URL_SERVICE,
      max:                  2,   // Reduced for serverless
      min:                  0,
      idleTimeoutMillis:    10_000,
      connectionTimeoutMillis: 5_000,
    });
  }
  return _svcPool;
}

// Convenience aliases used throughout Route Handlers.
// These are thin wrappers so existing call sites work without change.
export const authenticatedPool = {
  query<T extends object = object>(sql: string, values?: unknown[]): Promise<import('pg').QueryResult<T>> {
    return getAuthPool().query<T>(sql, values);
  },
  connect() { return getAuthPool().connect(); },
};

export const serviceRolePool = {
  query<T extends object = object>(sql: string, values?: unknown[]): Promise<import('pg').QueryResult<T>> {
    return getServicePool().query<T>(sql, values);
  },
  connect() { return getServicePool().connect(); },
};

/**
 * Sets the Supabase JWT claims GUC so auth.uid() and RLS policies work
 * correctly for the duration of the current query context.
 */
export async function setJwtClaims(
  client: PoolClient,
  claims: Record<string, unknown>,
): Promise<void> {
  await client.query(
    `SELECT set_config('request.jwt.claims', $1, true)`,
    [JSON.stringify(claims)],
  );
}
