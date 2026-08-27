import { NextRequest, NextResponse } from 'next/server';

/**
 * middleware.ts — CORS for all /api/* routes.
 *
 * Runs on Vercel's Edge network before the Route Handler, so OPTIONS
 * preflights are handled without spinning up a Node.js function.
 *
 * Security: the previous *.vercel.app suffix check was removed because it
 * allowed ANY site on Vercel's shared domain to make credentialed requests
 * and read responses (session-riding / data-exfiltration). The allowlist is
 * now explicit: only origins from FRONTEND_URL plus a tightly scoped pattern
 * for this project's own Vercel preview deployments.
 */

/** Matches http(s)://localhost or http(s)://localhost:<port> — for local dev. */
const LOCALHOST_PATTERN = /^https?:\/\/localhost(:\d+)?$/;

/**
 * Matches only THIS project's preview URLs on Vercel:
 *   https://shop-pulse-<hash>-<team>.vercel.app
 * Edit the team slug ("muzair464") if your Vercel team slug differs.
 * Set VERCEL_PREVIEW_PATTERN env var to override entirely, or leave empty
 * to disable preview-URL support.
 */
function getPreviewPattern(): RegExp | null {
  const override = process.env['VERCEL_PREVIEW_PATTERN'];
  if (override === '') return null;          // explicitly disabled
  if (override)        return new RegExp(override);
  // Default: shop-pulse-* deployments under the project owner's team.
  // The team slug appears between the last hyphen group and .vercel.app.
  return /^https:\/\/shop-pulse-[a-z0-9-]+-muzair464\.vercel\.app$/;
}

function getAllowedOrigins(): string[] {
  return (process.env['FRONTEND_URL'] ?? 'http://localhost:4200')
    .split(',').map(o => o.trim()).filter(Boolean);
}

function isAllowed(origin: string | null): boolean {
  // Server-to-server / non-browser requests have no Origin — always pass.
  if (!origin) return true;

  // Explicit allowlist from FRONTEND_URL env var.
  if (getAllowedOrigins().includes(origin)) return true;

  // Local development.
  if (LOCALHOST_PATTERN.test(origin)) return true;

  // This project's own Vercel preview deployments only.
  const previewPattern = getPreviewPattern();
  if (previewPattern && previewPattern.test(origin)) return true;

  return false;
}

export function middleware(req: NextRequest): NextResponse {
  const origin  = req.headers.get('origin');
  const allowed = isAllowed(origin);

  const corsHeaders: Record<string, string> = {
    'Access-Control-Allow-Methods':     'GET,POST,PATCH,DELETE,OPTIONS',
    'Access-Control-Allow-Headers':     'Content-Type,X-Idempotency-Key',
    'Access-Control-Allow-Credentials': 'true',
    'Access-Control-Max-Age':           '600',
  };
  if (allowed && origin) corsHeaders['Access-Control-Allow-Origin'] = origin;

  // Handle OPTIONS preflight — return 204 immediately.
  if (req.method === 'OPTIONS') {
    return new NextResponse(null, { status: 204, headers: corsHeaders });
  }

  const res = NextResponse.next();
  Object.entries(corsHeaders).forEach(([k, v]) => res.headers.set(k, v));
  return res;
}

export const config = {
  matcher: '/api/:path*',
};
