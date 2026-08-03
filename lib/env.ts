/**
 * lib/env.ts — environment variable config for Next.js.
 *
 * Next.js automatically loads .env.local in development and Vercel
 * injects env vars at build/runtime in production — no dotenv call needed.
 *
 * All required variables throw at module load time so a misconfigured
 * deployment crashes immediately rather than failing on the first request.
 */

function required(key: string): string {
  const value = process.env[key];
  if (!value) throw new Error(`Missing required environment variable: ${key}`);
  return value;
}

function optional(key: string, fallback = ''): string {
  return process.env[key] ?? fallback;
}

export const env = {
  NODE_ENV: optional('NODE_ENV', 'development'),

  // ── CORS / Cookies ─────────────────────────────────────────────────────────
  FRONTEND_URL:    optional('FRONTEND_URL', 'http://localhost:4200'),
  COOKIE_SECURE:   optional('COOKIE_SECURE',   'true') === 'true',
  COOKIE_SAME_SITE: optional('COOKIE_SAME_SITE', 'none') as 'lax' | 'strict' | 'none',
  COOKIE_DOMAIN:   optional('COOKIE_DOMAIN'),

  // ── Supabase ───────────────────────────────────────────────────────────────
  SUPABASE_URL:              required('SUPABASE_URL'),
  SUPABASE_ANON_KEY:         required('SUPABASE_ANON_KEY'),
  SUPABASE_SERVICE_ROLE_KEY: required('SUPABASE_SERVICE_ROLE_KEY'),
  SUPABASE_JWT_SECRET:       optional('SUPABASE_JWT_SECRET'),

  // ── Postgres ───────────────────────────────────────────────────────────────
  DATABASE_URL_AUTH:    required('DATABASE_URL_AUTH'),
  DATABASE_URL_SERVICE: required('DATABASE_URL_SERVICE'),

  // ── Email ──────────────────────────────────────────────────────────────────
  RESEND_API_KEY: optional('RESEND_API_KEY'),
  EMAIL_FROM:     optional('EMAIL_FROM', 'ShopPulse <noreply@shoppulse.app>'),

  // ── Cron ──────────────────────────────────────────────────────────────────
  // Used to authenticate Vercel Cron job requests to /api/v1/cron/export.
  CRON_SECRET: optional('CRON_SECRET'),
};

export const JWKS_URL = `${env.SUPABASE_URL}/auth/v1/.well-known/jwks.json`;
