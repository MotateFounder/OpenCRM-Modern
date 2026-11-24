// Provider presets. security: 'tls' (implicit TLS), 'starttls', 'none' (plain, only for local/test servers).
// auth: 'password' (normal or app password) | 'oauth-microsoft' | 'oauth-google'.

export const PRESETS = [
  {
    id: 'gmail', label: 'Gmail', domains: ['gmail.com', 'googlemail.com'],
    imap: { host: 'imap.gmail.com', port: 993, security: 'tls' },
    smtp: { host: 'smtp.gmail.com', port: 465, security: 'tls' },
    auth: 'password', dailyLimit: 400,
    help: 'Gmail needs an <b>app password</b> (not your normal password): turn on 2-Step Verification, then create one at myaccount.google.com/apppasswords.',
    helpUrl: 'https://myaccount.google.com/apppasswords',
  },
  {
    id: 'outlook', label: 'Outlook.com / Hotmail', domains: ['outlook.com', 'hotmail.com', 'live.com', 'msn.com', 'outlook.es', 'hotmail.es', 'live.es', 'hotmail.co.uk', 'outlook.fr', 'hotmail.fr', 'outlook.de', 'hotmail.de', 'hotmail.it'],
    imap: { host: 'outlook.office365.com', port: 993, security: 'tls' },
    smtp: { host: 'smtp-mail.outlook.com', port: 587, security: 'starttls' },
    auth: 'oauth-microsoft', dailyLimit: 250,
    help: 'Outlook.com only accepts Microsoft sign-in (passwords and app passwords are refused). Add a Client ID once (Settings → Email → Microsoft sign-in) and press “Sign in with Microsoft”.',
    helpUrl: 'https://learn.microsoft.com/entra/identity-platform/quickstart-register-app',
  },
  {
    id: 'yahoo', label: 'Yahoo Mail', domains: ['yahoo.com', 'yahoo.es', 'yahoo.co.uk', 'yahoo.fr', 'yahoo.de', 'ymail.com', 'rocketmail.com'],
    imap: { host: 'imap.mail.yahoo.com', port: 993, security: 'tls' },
    smtp: { host: 'smtp.mail.yahoo.com', port: 465, security: 'tls' },
    auth: 'password', dailyLimit: 200,
    help: 'Yahoo needs an <b>app password</b>: Account security → Generate app password.',
    helpUrl: 'https://login.yahoo.com/account/security',
  },
  {
    id: 'aol', label: 'AOL Mail', domains: ['aol.com'],
    imap: { host: 'imap.aol.com', port: 993, security: 'tls' },
    smtp: { host: 'smtp.aol.com', port: 465, security: 'tls' },
    auth: 'password', dailyLimit: 200,
    help: 'AOL needs an <b>app password</b>: Account security → Generate app password.',
    helpUrl: 'https://login.aol.com/account/security',
  },
  {
    id: 'icloud', label: 'iCloud Mail', domains: ['icloud.com', 'me.com', 'mac.com'],
    imap: { host: 'imap.mail.me.com', port: 993, security: 'tls' },
    smtp: { host: 'smtp.mail.me.com', port: 587, security: 'starttls' },
    auth: 'password', dailyLimit: 200,
    help: 'iCloud needs an <b>app-specific password</b> (appleid.apple.com → Sign-In and Security). If sign-in fails, try the IMAP user name without “@icloud.com”.',
    helpUrl: 'https://appleid.apple.com/account/manage',
  },
  {
    id: 'gmx-com', label: 'GMX (gmx.com)', domains: ['gmx.com', 'gmx.us', 'gmx.co.uk', 'gmx.es', 'gmx.fr'],
    imap: { host: 'imap.gmx.com', port: 993, security: 'tls' },
    smtp: { host: 'mail.gmx.com', port: 587, security: 'starttls' },
    auth: 'password', dailyLimit: 200,
    help: 'In GMX webmail open Settings → POP3 & IMAP and tick “Enable access to this account via POP3 and IMAP” first.',
    helpUrl: 'https://support.gmx.com/pop-imap/toggle.html',
  },
  {
    id: 'gmx-net', label: 'GMX (gmx.net / gmx.de)', domains: ['gmx.net', 'gmx.de', 'gmx.at', 'gmx.ch'],
    imap: { host: 'imap.gmx.net', port: 993, security: 'tls' },
    smtp: { host: 'mail.gmx.net', port: 587, security: 'starttls' },
    auth: 'password', dailyLimit: 200,
    help: 'In GMX webmail enable POP3/IMAP access first (Einstellungen → POP3/IMAP Abruf).',
    helpUrl: 'https://hilfe.gmx.net/pop-imap/einschalten.html',
  },
  {
    id: 'webde', label: 'WEB.DE', domains: ['web.de'],
    imap: { host: 'imap.web.de', port: 993, security: 'tls' },
    smtp: { host: 'smtp.web.de', port: 587, security: 'starttls' },
    auth: 'password', dailyLimit: 200,
    help: 'In WEB.DE webmail enable POP3/IMAP access first (Einstellungen → POP3/IMAP Abruf).',
    helpUrl: 'https://hilfe.web.de/pop-imap/einschalten.html',
  },
  {
    id: 'zoho', label: 'Zoho Mail (paid plans)', domains: ['zoho.com', 'zohomail.com'],
    imap: { host: 'imap.zoho.com', port: 993, security: 'tls' },
    smtp: { host: 'smtp.zoho.com', port: 465, security: 'tls' },
    auth: 'password', dailyLimit: 200,
    help: 'Zoho only allows IMAP/SMTP on paid plans. Use an app-specific password if 2-factor sign-in is on. EU accounts use imap.zoho.eu / smtp.zoho.eu.',
    helpUrl: 'https://accounts.zoho.com/home#security/app_password',
  },
  {
    id: 'custom', label: 'Other / own domain', domains: [],
    imap: { host: '', port: 993, security: 'tls' },
    smtp: { host: '', port: 465, security: 'tls' },
    auth: 'password', dailyLimit: 200,
    help: 'Use the IMAP and SMTP settings from your email host (cPanel → Email Accounts → Connect Devices). Typical: IMAP 993 SSL/TLS, SMTP 465 SSL/TLS or 587 STARTTLS.',
    helpUrl: '',
  },
];

export const presetById = id => PRESETS.find(p => p.id === id) || PRESETS.find(p => p.id === 'custom');

export function presetForEmail(email) {
  const d = String(email || '').toLowerCase().split('@')[1] || '';
  return PRESETS.find(p => p.domains.includes(d)) || null;
}

/** Fills hosts/ports for a new account from its email address. */
export function guessAccount(email) {
  const p = presetForEmail(email) || presetById('custom');
  const d = String(email || '').split('@')[1] || '';
  const imap = { ...p.imap, user: email };
  const smtp = { ...p.smtp, user: email };
  if (p.id === 'custom' && d) { imap.host = `mail.${d}`; smtp.host = `mail.${d}`; }
  return { preset: p.id, email, imap, smtp, auth: p.auth, dailyLimit: p.dailyLimit };
}
