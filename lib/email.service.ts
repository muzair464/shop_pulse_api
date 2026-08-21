import { env } from './env';
import { logger } from './logger';

interface SendEmailOptions {
  to: string; subject: string; html: string;
  attachments?: Array<{ filename: string; content: string; contentType: string }>;
}

async function sendEmail(opts: SendEmailOptions): Promise<void> {
  if (!env.RESEND_API_KEY) {
    logger.debug('Email skipped — RESEND_API_KEY not configured', { subject: opts.subject });
    return;
  }
  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${env.RESEND_API_KEY}` },
    body: JSON.stringify({ from: env.EMAIL_FROM, to: [opts.to], subject: opts.subject, html: opts.html, attachments: opts.attachments }),
  });
  if (!res.ok) throw new Error(`Resend error ${res.status}: ${await res.text()}`);
}

export function maybeSendLowStockAlert(ownerEmail: string, items: Array<{ name: string; stock: number }>): void {
  if (items.length === 0) return;
  const rows = items.map(i => `<tr><td>${i.name}</td><td><strong>${i.stock}</strong></td></tr>`).join('');
  sendEmail({
    to: ownerEmail, subject: `ShopPulse: ${items.length} item(s) are running low`,
    html: `<h2>Low Stock Alert</h2><table border="1" cellpadding="6"><thead><tr><th>Item</th><th>Stock</th></tr></thead><tbody>${rows}</tbody></table>`,
  }).catch((err: unknown) => logger.error('Low-stock email failed', err));
}

export function sendNewDeviceAlert(ownerEmail: string, deviceName: string, revokeUrl: string): void {
  sendEmail({
    to: ownerEmail, subject: 'ShopPulse: New device signed in',
    html: `<h2>New Device Sign-In</h2><p><strong>${deviceName}</strong></p><p><a href="${revokeUrl}">Revoke this device</a></p>`,
  }).catch((err: unknown) => logger.error('New-device email failed', err));
}

export async function sendPasswordResetEmail(to: string, resetUrl: string): Promise<void> {
  await sendEmail({
    to,
    subject: 'ShopPulse: Reset your password',
    html: `
      <div style="font-family:sans-serif;max-width:480px;margin:0 auto;padding:32px 24px">
        <h2 style="margin:0 0 8px;font-size:20px;color:#111827">Reset your password</h2>
        <p style="margin:0 0 24px;color:#6b7280;font-size:14px">
          We received a request to reset the password for your ShopPulse account.
          Click the button below to choose a new one.
        </p>
        <a href="${resetUrl}"
           style="display:inline-block;padding:12px 24px;background:#2563eb;color:#fff;
                  text-decoration:none;border-radius:8px;font-size:14px;font-weight:600">
          Reset password
        </a>
        <p style="margin:24px 0 0;color:#9ca3af;font-size:12px">
          If you didn't request this, you can safely ignore this email.
          This link expires in 1 hour.
        </p>
      </div>
    `,
  });
}

export function sendScheduledExport(ownerEmail: string, csvContent: string, filename: string): void {
  sendEmail({
    to: ownerEmail, subject: `ShopPulse: Scheduled export — ${filename}`,
    html: `<h2>Scheduled Export</h2><p>Your export is attached as <strong>${filename}</strong>.</p>`,
    attachments: [{ filename, content: Buffer.from(csvContent).toString('base64'), contentType: 'text/csv' }],
  }).catch((err: unknown) => logger.error('Scheduled export email failed', err));
}
