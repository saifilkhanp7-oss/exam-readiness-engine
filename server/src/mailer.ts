// Sends the login code by email. Same three modes as Chronos, picked by which settings exist:
//
// 1. GMAIL_SCRIPT_URL + GMAIL_SCRIPT_SECRET  → Google Apps Script in your Gmail sends it over HTTPS.
//    Works on Railway Free/Hobby (they block normal email ports). See gmail-sender.gs.
// 2. GMAIL_USER + GMAIL_APP_PASSWORD         → direct Gmail SMTP with an App Password.
// 3. Neither                                  → code printed in the server log
//    (and shown on screen when OTP_DEMO_MODE=true or when running locally).
import type { Transporter } from 'nodemailer';
import { APP_NAME } from './config.ts';

const escapeHtml = (s: string) => s.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));

function render(code: string, name?: string) {
  const subject = `${code} is your ${APP_NAME} code`;
  const text = `Hi ${name || 'there'},\n\nYour ${APP_NAME} verification code is ${code}.\nIt expires in 5 minutes.\n\nIf you didn't request this, you can ignore this email.`;
  const html = `<div style="font-family:Arial,Helvetica,sans-serif;max-width:420px;margin:0 auto;padding:24px;color:#0f172a">
  <div style="font-size:20px;font-weight:700;margin-bottom:16px"><span style="color:#4f46e5">&#9679;</span> ${escapeHtml(APP_NAME)}</div>
  <p style="margin:0 0 12px">Hi ${escapeHtml(name || 'there')},</p>
  <p style="margin:0 0 16px">Your verification code is:</p>
  <div style="font-size:34px;font-weight:700;letter-spacing:8px;background:#eef2ff;border-radius:12px;padding:16px;text-align:center">${code}</div>
  <p style="margin:16px 0 0;color:#64748b;font-size:13px">It expires in 5 minutes. If you didn't request this, you can ignore this email.</p>
</div>`;
  return { subject, text, html };
}

export function emailMode(): 'apps-script' | 'smtp' | 'none' {
  if (process.env.GMAIL_SCRIPT_URL && process.env.GMAIL_SCRIPT_SECRET) return 'apps-script';
  if (process.env.GMAIL_USER && process.env.GMAIL_APP_PASSWORD) return 'smtp';
  return 'none';
}

let transporter: Transporter | undefined;

export async function sendOtpEmail(to: string, code: string, name?: string): Promise<{ dev: boolean }> {
  const msg = render(code, name);
  const mode = emailMode();

  if (mode === 'apps-script') {
    const res = await fetch(process.env.GMAIL_SCRIPT_URL!, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ secret: process.env.GMAIL_SCRIPT_SECRET, to, ...msg, name: APP_NAME }),
      redirect: 'follow',
      signal: AbortSignal.timeout(20000),
    });
    const body = await res.text();
    let data: { ok?: boolean; error?: string } = {};
    try { data = JSON.parse(body); } catch { /* not JSON: usually a Google sign-in page = wrong deployment access */ }
    if (!res.ok || !data.ok) {
      throw new Error(data.error || 'the Gmail script did not accept the request (check the script URL, the secret, and that access is set to "Anyone")');
    }
    return { dev: false };
  }

  if (mode === 'smtp') {
    if (!transporter) {
      const { default: nodemailer } = await import('nodemailer');
      transporter = nodemailer.createTransport({
        service: 'gmail',
        auth: { user: process.env.GMAIL_USER, pass: process.env.GMAIL_APP_PASSWORD!.replace(/\s/g, '') },
        connectionTimeout: 15000,
      });
    }
    await transporter.sendMail({ from: `"${APP_NAME}" <${process.env.GMAIL_USER}>`, to, ...msg });
    return { dev: false };
  }

  console.log(`\n[DEV OTP] Email to ${to}: ${code}\n`);
  return { dev: process.env.NODE_ENV !== 'production' || process.env.OTP_DEMO_MODE === 'true' };
}
