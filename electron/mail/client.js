// IMAP/SMTP connection factories and human-friendly error messages. No Electron imports (testable in Node).
import { ImapFlow } from 'imapflow';
import nodemailer from 'nodemailer';
import { presetById } from './presets.js';

/** credentials: { pass } for password auth, { accessToken } for OAuth2 (XOAUTH2). */
export function imapOptions(account, cred) {
  const s = account.imap || {};
  const auth = cred.accessToken ? { user: s.user || account.email, accessToken: cred.accessToken } : { user: s.user || account.email, pass: cred.pass || '' };
  return {
    host: s.host, port: Number(s.port) || 993,
    secure: s.security === 'tls',
    doSTARTTLS: s.security === 'starttls' ? true : (s.security === 'none' ? false : undefined),
    auth,
    logger: false,
    emitLogs: false,
    tls: { rejectUnauthorized: !account.allowSelfSigned, minVersion: 'TLSv1.2' },
    connectionTimeout: 20000,
    greetingTimeout: 15000,
    socketTimeout: 5 * 60 * 1000,
    maxIdleTime: 4 * 60 * 1000, // re-issue IDLE regularly (some servers drop long idles)
    clientInfo: { name: 'OpenCRM', vendor: 'OpenCRM' },
  };
}

export function makeImap(account, cred) {
  return new ImapFlow(imapOptions(account, cred));
}

export function smtpOptions(account, cred) {
  const s = account.smtp || {};
  const auth = cred.accessToken
    ? { type: 'OAuth2', user: s.user || account.email, accessToken: cred.accessToken }
    : { user: s.user || account.email, pass: cred.pass || '' };
  return {
    host: s.host, port: Number(s.port) || 465,
    secure: s.security === 'tls',
    requireTLS: s.security === 'starttls',
    ignoreTLS: s.security === 'none',
    auth,
    tls: { rejectUnauthorized: !account.allowSelfSigned, minVersion: 'TLSv1.2' },
    connectionTimeout: 20000,
    greetingTimeout: 15000,
    socketTimeout: 60000,
    name: 'opencrm.local',
  };
}

export function makeTransport(account, cred) {
  return nodemailer.createTransport(smtpOptions(account, cred));
}

/** Network-type errors are retried later; auth/config errors are not. */
export function isTransient(err) {
  const c = String(err?.code || '');
  const m = String(err?.message || '');
  if (/EAUTH|AUTHENTICATIONFAILED|AUTHORIZATIONFAILED/i.test(c + m)) return false;
  if (/^5\d\d$/.test(String(err?.responseCode || '')) && !/4\.\d\.\d/.test(m)) return false;
  return /ECONNREFUSED|ECONNRESET|ETIMEDOUT|ENOTFOUND|EAI_AGAIN|ENETUNREACH|EHOSTUNREACH|EPIPE|ESOCKET|ECONNECTION|NoConnection|Socket|timeout|closed/i.test(c + ' ' + m) || /^4\d\d$/.test(String(err?.responseCode || ''));
}

export function friendlyError(err, account, which = '') {
  const preset = presetById(account?.preset);
  const c = String(err?.code || '');
  const raw = [err?.responseText, err?.response, err?.message].filter(Boolean).join(' ');
  const where = which ? `${which.toUpperCase()}: ` : '';
  const host = which === 'smtp' ? account?.smtp?.host : account?.imap?.host;
  if (/AUTHENTICATIONFAILED|EAUTH|Invalid login|Authentication (failed|credentials invalid|unsuccessful)|535|Username and Password not accepted|LOGIN failed|Invalid credentials/i.test(c + ' ' + raw)) {
    if (/basic auth|BasicAuthBlocked|5\.7\.139/i.test(raw) || preset.auth === 'oauth-microsoft') return `${where}Microsoft refused the password: Outlook.com accounts must use “Sign in with Microsoft”.`;
    if (/Application-specific password required|InvalidSecondFactor|app password/i.test(raw) || ['gmail', 'yahoo', 'aol', 'icloud'].includes(preset.id)) {
      return `${where}${preset.label} rejected the password. Use an app password, not your normal password.`;
    }
    if (preset.id.startsWith('gmx') || preset.id === 'webde') return `${where}${preset.label} rejected the login. Check the password and that POP3/IMAP access is enabled in the webmail settings.`;
    return `${where}The server rejected the user name or password.`;
  }
  if (/ENOTFOUND|EAI_AGAIN/.test(c + raw)) return `${where}Server “${host}” was not found. Check the server name and your internet connection.`;
  if (/ECONNREFUSED/.test(c + raw)) return `${where}${host} refused the connection. Check the port and security setting.`;
  if (/ETIMEDOUT|timeout/i.test(c + raw)) return `${where}${host} did not answer in time. Check the port, the security setting, or a firewall.`;
  if (/self[- ]signed|certificate|CERT_|UNABLE_TO_VERIFY/i.test(c + raw)) return `${where}The server's security certificate could not be verified. If this is your own server with a self-signed certificate, tick “Allow self-signed certificate”.`;
  if (/wrong version number|SSL routines|EPROTO/i.test(raw)) return `${where}Security setting mismatch: try SSL/TLS on port ${which === 'smtp' ? '465' : '993'} or STARTTLS on port ${which === 'smtp' ? '587' : '143'}.`;
  if (/Web login required|WEBALERT/i.test(raw)) return `${where}${preset.label} wants you to sign in once in a web browser to approve this app, then try again.`;
  if (/IMAP access is disabled|IMAP is disabled/i.test(raw)) return `${where}IMAP is turned off for this account. Enable it in the webmail settings.`;
  return `${where}${String(err?.message || err).slice(0, 300)}`;
}
