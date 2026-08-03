import { NextRequest, NextResponse } from 'next/server';

/**
 * middleware.ts — CORS for all /api/* routes.
 *
 * Runs on Vercel's Edge network before the Route Handler, so OPTIONS
 * preflights are handled without spinning up a Node.js function.
 */

const ALLOWED_PATTERN = /^https?:\/\/localhost(:\d+)?$/;

function getAllowedOrigins(): string[] {
  return (process.env['FRONTEND_URL'] ?? 'http://localhost:4200')
    .split(',').map(o => o.trim()).filter(Boolean);
}

function isAllowed(origin: string | null): boolean {
  if (!origin) return true;
  const configured = getAllowedOrigins();
  if (configured.includes(origin))    return true;
  if (origin.endsWith('.vercel.app')) return true;
  if (ALLOWED_PATTERN.test(origin))   return true;
  return false;
}

export function middleware(req: NextRequest): NextResponse {
  const origin = req.headers.get('origin');
  const allowed = isAllowed(origin);

  const corsHeaders: Record<string, string> = {
    'Access-Control-Allow-Methods':  'GET,POST,PATCH,DELETE,OPTIONS',
    'Access-Control-Allow-Headers':  'Content-Type,X-Idempotency-Key',
    'Access-Control-Allow-Credentials': 'true',
    'Access-Control-Max-Age':        '600',
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
