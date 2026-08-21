/**
 * lib/auth.service.ts — Supabase Auth REST/Admin API proxy.
 * Identical logic to the Express backend's services/auth.service.ts.
 */

import { env } from './env';
import { logger } from './logger';
import { sendPasswordResetEmail } from './email.service';

interface SupabaseTokenResponse {
  access_token:  string;
  refresh_token: string;
  expires_in:    number;
  token_type:    string;
  user: { id: string; email: string };
}
interface SupabaseErrorResponse {
  error?: string; error_description?: string; message?: string; msg?: string;
}

function supabaseErr(body: SupabaseErrorResponse, fallback: string): Error & { statusCode: number } {
  const msg = body.error_description ?? body.message ?? body.msg ?? body.error ?? fallback;
  const err = new Error(msg) as Error & { statusCode: number };
  err.statusCode = 400;
  return err;
}

export async function supabaseSignIn(email: string, password: string): Promise<SupabaseTokenResponse> {
  let res: Response;
  try {
    res = await fetch(`${env.SUPABASE_URL}/auth/v1/token?grant_type=password`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'apikey': env.SUPABASE_ANON_KEY },
      body: JSON.stringify({ email, password }),
    });
  } catch (cause) {
    logger.error('supabaseSignIn: network error', cause);
    const e = new Error('Could not reach Supabase Auth.') as Error & { statusCode: number };
    e.statusCode = 503; throw e;
  }
  if (!res.ok) {
    const b = await res.json() as SupabaseErrorResponse;
    const e = supabaseErr(b, 'Sign in failed.');
    e.statusCode = res.status === 400 ? 401 : res.status;
    throw e;
  }
  return res.json() as Promise<SupabaseTokenResponse>;
}

export async function supabaseSignUp(email: string, password: string, redirectTo: string): Promise<{ id: string; email: string }> {
  let res: Response;
  try {
    // Use the public signup endpoint so Supabase sends a "Confirm your email"
    // link (type=email), NOT the admin endpoint which sends a recovery email.
    res = await fetch(`${env.SUPABASE_URL}/auth/v1/signup`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'apikey': env.SUPABASE_ANON_KEY },
      body: JSON.stringify({ email, password, options: { emailRedirectTo: redirectTo } }),
    });
  } catch (cause) {
    logger.error('supabaseSignUp: network error', cause);
    const e = new Error('Could not reach Supabase Auth.') as Error & { statusCode: number };
    e.statusCode = 503; throw e;
  }
  if (!res.ok) {
    const b = await res.json() as SupabaseErrorResponse;
    const e = supabaseErr(b, 'Sign up failed.');
    // 422 = email already registered
    e.statusCode = res.status === 422 ? 409 : res.status;
    throw e;
  }
  const data = await res.json() as { id?: string; user?: { id: string; email: string }; email?: string };
  // Public signup returns { user: { id, email, ... }, session: null } when email confirmation is required.
  const user = data.user ?? (data as unknown as { id: string; email: string });
  return { id: user.id, email: user.email ?? email };
}

export async function supabaseDeleteUser(userId: string): Promise<void> {
  await fetch(`${env.SUPABASE_URL}/auth/v1/admin/users/${userId}`, {
    method: 'DELETE',
    headers: { 'apikey': env.SUPABASE_SERVICE_ROLE_KEY, 'Authorization': `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}` },
  });
}

export async function supabaseRefreshToken(refreshToken: string): Promise<SupabaseTokenResponse> {
  const res = await fetch(`${env.SUPABASE_URL}/auth/v1/token?grant_type=refresh_token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'apikey': env.SUPABASE_ANON_KEY },
    body: JSON.stringify({ refresh_token: refreshToken }),
  });
  if (!res.ok) {
    const e = new Error('Session refresh failed.') as Error & { statusCode: number };
    e.statusCode = 401; throw e;
  }
  return res.json() as Promise<SupabaseTokenResponse>;
}

export async function supabaseRevokeSession(refreshToken: string): Promise<void> {
  try {
    await fetch(`${env.SUPABASE_URL}/auth/v1/logout`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'apikey': env.SUPABASE_ANON_KEY, 'Authorization': `Bearer ${refreshToken}` },
    });
  } catch (err) { logger.warn('supabaseRevokeSession failed', err); }
}

export async function supabaseForgotPassword(email: string, redirectTo: string): Promise<void> {
  // Use the Admin generateLink API to create a recovery link without sending
  // any email through Supabase — Supabase's built-in mailer only delivers to
  // project team members unless custom SMTP is configured, which causes 500s
  // for real user email addresses. We generate the link ourselves and send
  // the email via Resend (see email.service.ts).
  const res = await fetch(`${env.SUPABASE_URL}/auth/v1/admin/generate_link`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'apikey': env.SUPABASE_SERVICE_ROLE_KEY,
      'Authorization': `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`,
    },
    body: JSON.stringify({ type: 'recovery', email, redirect_to: redirectTo }),
  });

  if (!res.ok) {
    const b = await res.json() as SupabaseErrorResponse;
    const msg = b.error_description ?? b.message ?? b.msg ?? b.error ?? 'Failed to generate reset link.';
    logger.error('supabaseForgotPassword generate_link failed', { status: res.status, body: b });
    throw new Error(msg);
  }

  const data = await res.json() as { action_link?: string; email?: string };
  const actionLink = data.action_link;
  if (!actionLink) {
    logger.error('supabaseForgotPassword: no action_link in response', { data });
    throw new Error('Failed to generate reset link.');
  }

  // The action_link returned by generate_link looks like:
  // https://<project>.supabase.co/auth/v1/verify?token=<hash>&type=recovery&redirect_to=...
  // The query param is `token`, not `token_hash`. We extract it and build
  // our own set-password URL using `token_hash` (the name the /verify POST expects).
  const parsed   = new URL(actionLink);
  const tokenHash = parsed.searchParams.get('token') ?? parsed.searchParams.get('token_hash');
  const type      = parsed.searchParams.get('type') ?? 'recovery';

  if (!tokenHash) {
    logger.error('supabaseForgotPassword: could not extract token from action_link', { actionLink });
    throw new Error('Failed to build reset link.');
  }

  const resetUrl = `${redirectTo}?token_hash=${encodeURIComponent(tokenHash)}&type=${type}`;
  logger.info('Sending password reset email via Resend', { email, resetUrl });
  await sendPasswordResetEmail(email, resetUrl);
}

export async function supabaseResendVerification(email: string, redirectTo: string): Promise<void> {
  const res = await fetch(`${env.SUPABASE_URL}/auth/v1/resend`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'apikey': env.SUPABASE_ANON_KEY },
    body: JSON.stringify({ type: 'signup', email, options: { emailRedirectTo: redirectTo } }),
  });
  if (!res.ok) { const b = await res.json() as SupabaseErrorResponse; throw new Error(b.message ?? 'Failed to resend verification email.'); }
}

export async function supabaseUpdatePassword(userId: string, newPassword: string): Promise<void> {
  const res = await fetch(`${env.SUPABASE_URL}/auth/v1/admin/users/${userId}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json', 'apikey': env.SUPABASE_SERVICE_ROLE_KEY, 'Authorization': `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}` },
    body: JSON.stringify({ password: newPassword }),
  });
  if (!res.ok) { const b = await res.json() as SupabaseErrorResponse; throw new Error(b.message ?? 'Failed to update password.'); }
}

export async function supabaseExchangeOtp(tokenHash: string, type: 'invite' | 'recovery' | 'email'): Promise<SupabaseTokenResponse> {
  const res = await fetch(`${env.SUPABASE_URL}/auth/v1/verify`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'apikey': env.SUPABASE_ANON_KEY },
    body: JSON.stringify({ token_hash: tokenHash, type }),
  });
  if (!res.ok) {
    const b = await res.json() as SupabaseErrorResponse;
    const e = supabaseErr(b, 'Token exchange failed.');
    e.statusCode = res.status === 400 ? 422 : res.status;
    throw e;
  }
  return res.json() as Promise<SupabaseTokenResponse>;
}

export async function supabaseRevokeUserSession(sessionId: string): Promise<void> {
  try {
    await fetch(`${env.SUPABASE_URL}/auth/v1/admin/sessions/${sessionId}`, {
      method: 'DELETE',
      headers: { 'apikey': env.SUPABASE_SERVICE_ROLE_KEY, 'Authorization': `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}` },
    });
  } catch (err) { logger.warn('supabaseRevokeUserSession failed', err); }
}
