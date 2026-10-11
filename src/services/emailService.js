import nodemailer from 'nodemailer';
import { env } from '../config/env.js';
import { logger } from '../config/logger.js';
import { decryptSecret } from './cryptoService.js';

/**
 * Lazily-created platform transport. If SMTP is unconfigured, every send
 * becomes a logged no-op that RESOLVES — order creation must never fail
 * because a mail server is down. (The reference codebase got this right.)
 */
let platformTransport = null;
let platformTried = false;

function getPlatformTransport() {
  if (platformTried) return platformTransport;
  platformTried = true;

  if (!env.SMTP_HOST || !env.SMTP_USER || !env.SMTP_PASS) {
    logger.warn('SMTP is not configured — emails will be logged, not sent');
    return null;
  }

  platformTransport = nodemailer.createTransport({
    host: env.SMTP_HOST,
    port: env.SMTP_PORT,
    secure: env.SMTP_PORT === 465,
    auth: { user: env.SMTP_USER, pass: env.SMTP_PASS.replace(/\s+/g, '') },
    connectionTimeout: 10_000,
    greetingTimeout: 10_000,
    socketTimeout: 15_000,
  });
  return platformTransport;
}

/**
 * A tenant may bring its own SMTP (settings.email.useOwnSmtp), so mail appears
 * to come from their domain. Falls back to the platform transport.
 */
function getTenantTransport(emailSettings) {
  if (!emailSettings?.useOwnSmtp) return null;
  const pass = decryptSecret(emailSettings.smtpPass);
  if (!emailSettings.smtpHost || !emailSettings.smtpUser || !pass) return null;

  return nodemailer.createTransport({
    host: emailSettings.smtpHost,
    port: Number(emailSettings.smtpPort) || 587,
    secure: Number(emailSettings.smtpPort) === 465,
    auth: { user: emailSettings.smtpUser, pass },
    connectionTimeout: 10_000,
    greetingTimeout: 10_000,
    socketTimeout: 15_000,
  });
}

/**
 * @param {object} message  { to, subject, html, text?, replyTo? }
 * @param {object} opts     { emailSettings?, fromName?, fromEmail? }
 */
export async function sendMail(message, opts = {}) {
  const tenantTransport = getTenantTransport(opts.emailSettings);
  const transport = tenantTransport || getPlatformTransport();

  const from =
    opts.fromName && opts.fromEmail
      ? `${opts.fromName} <${opts.fromEmail}>`
      : env.EMAIL_FROM || env.SMTP_USER;

  if (!transport) {
    logger.info(
      { to: message.to, subject: message.subject },
      'email suppressed (SMTP not configured)'
    );
    return { success: false, suppressed: true, error: 'SMTP not configured' };
  }

  try {
    const info = await transport.sendMail({ from, ...message });
    logger.info({ to: message.to, subject: message.subject, id: info.messageId }, 'email sent');
    return { success: true, messageId: info.messageId };
  } catch (err) {
    // Never throws: callers run this through safeAsync as a side effect.
    logger.error({ to: message.to, err: { message: err.message } }, 'email failed');
    return { success: false, error: err.message };
  }
}

/** Verifies credentials for the "Test connection" button in settings. */
export async function verifyTransport(emailSettings) {
  const transport = getTenantTransport(emailSettings) || getPlatformTransport();
  if (!transport) return { success: false, error: 'SMTP not configured' };
  try {
    await transport.verify();
    return { success: true };
  } catch (err) {
    return { success: false, error: err.message };
  }
}
