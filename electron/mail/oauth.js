// OAuth2 sign-in for mail (Outlook.com / Microsoft, optionally Google) with PKCE and a loopback redirect.
// The user's own app registration (Client ID) is used: OpenCRM never borrows another app's identity.
// No Electron imports: the caller passes openUrl(url) (system browser). Tested against a mock provider.
import http from 'node:http';
import crypto from 'node:crypto';

export const PROVIDERS = {
  microsoft: {
    label: 'Microsoft',
    authorize: tenant => `https://login.microsoftonline.com/${tenant || 'consumers'}/oauth2/v2.0/authorize`,
    token: tenant => `https://login.microsoftonline.com/${tenant || 'consumers'}/oauth2/v2.0/token`,
    scopes: ['offline_access', 'openid', 'email', 'https://outlook.office.com/IMAP.AccessToken.All', 'https://outlook.office.com/SMTP.Send'],
    redirectHost: 'localhost',
    extra: { prompt: 'select_account' },
  },
  google: {
    label: 'Google',
    authorize: () => 'https://accounts.google.com/o/oauth2/v2/auth',
    token: () => 'https://oauth2.googleapis.com/token',
    scopes: ['openid', 'email', 'https://mail.google.com/'],
    redirectHost: '127.0.0.1',
    extra: { access_type: 'offline', prompt: 'consent' },
  },
};

const b64url = buf => Buffer.from(buf).toString('base64url');

export function pkce() {
  const verifier = b64url(crypto.randomBytes(32));
  const challenge = b64url(crypto.createHash('sha256').update(verifier).digest());
  return { verifier, challenge };
}

export function decodeJwt(token) {
  try { return JSON.parse(Buffer.from(String(token).split('.')[1], 'base64url').toString('utf8')); } catch { return {}; }
}

const PAGE = (title, msg) => `<!doctype html><html><head><meta charset="utf-8"><title>${title}</title><style>body{font-family:Segoe UI,Arial,sans-serif;background:#f3f5f8;display:flex;align-items:center;justify-content:center;height:100vh;margin:0}div{background:#fff;padding:30px 36px;border-radius:12px;box-shadow:0 2px 16px rgba(0,0,0,.08);text-align:center}</style></head><body><div><h2>${title}</h2><p>${msg}</p></div></body></html>`;

/**
 * Runs the authorization-code flow. Returns { email, refreshToken, accessToken, expiresAt, provider, tenant }.
 * opts: { provider, clientId, clientSecret, tenant, loginHint, openUrl, timeoutMs, endpoints (tests) , fetchImpl }
 */
export async function signIn({ provider = 'microsoft', clientId, clientSecret = '', tenant = 'consumers', loginHint = '', openUrl, timeoutMs = 5 * 60e3, endpoints = null, fetchImpl = fetch }) {
  const p = PROVIDERS[provider];
  if (!p) throw new Error(`Unknown sign-in provider ${provider}`);
  if (!clientId) throw new Error(`Add your ${p.label} Client ID first (Settings → Email → ${p.label} sign-in).`);
  const { verifier, challenge } = pkce();
  const state = b64url(crypto.randomBytes(16));
  let server, server6;
  const codeP = new Promise((resolve, reject) => {
    const handler = (req, res) => {
      const u = new URL(req.url, 'http://localhost');
      if (u.pathname !== '/') { res.writeHead(404); res.end(); return; }
      const err = u.searchParams.get('error');
      if (err) {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(PAGE('Sign-in cancelled', 'You can close this window and return to OpenCRM.'));
        reject(new Error(u.searchParams.get('error_description') || err));
        return;
      }
      if (u.searchParams.get('state') !== state) { res.writeHead(400); res.end('State mismatch'); return; }
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(PAGE('✓ Signed in', 'You can close this window and return to OpenCRM.'));
      resolve(u.searchParams.get('code'));
    };
    server = http.createServer(handler);
    server.on('error', reject);
    server6 = http.createServer(handler);
    server6.on('error', () => {}); // IPv6 loopback is best-effort ("localhost" may resolve to ::1)
  });
  codeP.catch(() => {}); // handled below (avoids an unhandled rejection while the browser opens)
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  await new Promise(r => { server6.once('error', r); server6.listen(server.address().port, '::1', r); });
  const redirectUri = `http://${p.redirectHost}:${server.address().port}`;
  const authUrl = new URL(endpoints?.authorize || p.authorize(tenant));
  Object.entries({
    client_id: clientId, response_type: 'code', redirect_uri: redirectUri, scope: p.scopes.join(' '), state,
    code_challenge: challenge, code_challenge_method: 'S256', ...(loginHint ? { login_hint: loginHint } : {}), ...p.extra,
  }).forEach(([k, v]) => authUrl.searchParams.set(k, v));
  let timer;
  try {
    await openUrl(authUrl.toString());
    const code = await Promise.race([codeP, new Promise((_, rej) => { timer = setTimeout(() => rej(new Error('Sign-in timed out. Please try again.')), timeoutMs); })]);
    const tok = await tokenRequest({ url: endpoints?.token || p.token(tenant), fetchImpl, body: {
      client_id: clientId, ...(clientSecret ? { client_secret: clientSecret } : {}), grant_type: 'authorization_code', code, redirect_uri: redirectUri, code_verifier: verifier,
    } });
    if (!tok.refresh_token) throw new Error('The provider did not return a refresh token (offline access was not granted).');
    const claims = decodeJwt(tok.id_token);
    return {
      provider, tenant, email: String(claims.email || claims.preferred_username || claims.upn || loginHint || '').toLowerCase(),
      refreshToken: tok.refresh_token, accessToken: tok.access_token, expiresAt: Date.now() + (Number(tok.expires_in) || 3600) * 1000,
    };
  } finally {
    clearTimeout(timer);
    server.close();
    try { server6.close(); } catch { /* not listening */ }
  }
}

async function tokenRequest({ url, body, fetchImpl }) {
  const r = await fetchImpl(url, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(body).toString(), signal: AbortSignal.timeout(30000) });
  const j = await r.json().catch(() => ({}));
  if (!r.ok || j.error) {
    const msg = j.error_description || j.error || `HTTP ${r.status}`;
    const e = new Error(/invalid_grant|expired|revoked/i.test(msg) ? 'Your sign-in expired or was revoked. Please sign in again (Settings → Email → Edit account).' : `Sign-in failed: ${String(msg).split('\n')[0].slice(0, 200)}`);
    e.code = j.error === 'invalid_grant' ? 'EAUTH' : 'OAUTH';
    throw e;
  }
  return j;
}

/**
 * Returns a valid access token, refreshing when needed. saveSecret(newSecret) persists rotated tokens.
 * secret: { refreshToken, accessToken, expiresAt, provider, tenant }
 */
export async function accessTokenFor({ secret, clientId, clientSecret = '', saveSecret, endpoints = null, fetchImpl = fetch }) {
  if (!secret?.refreshToken) { const e = new Error('Not signed in. Edit the account and press “Sign in”.'); e.code = 'EAUTH'; throw e; }
  if (secret.accessToken && secret.expiresAt - 90e3 > Date.now()) return secret.accessToken;
  const p = PROVIDERS[secret.provider || 'microsoft'];
  const tok = await tokenRequest({ url: endpoints?.token || p.token(secret.tenant), fetchImpl, body: {
    client_id: clientId, ...(clientSecret ? { client_secret: clientSecret } : {}), grant_type: 'refresh_token', refresh_token: secret.refreshToken, scope: p.scopes.join(' '),
  } });
  const next = { ...secret, accessToken: tok.access_token, expiresAt: Date.now() + (Number(tok.expires_in) || 3600) * 1000, refreshToken: tok.refresh_token || secret.refreshToken };
  await saveSecret?.(next);
  return next.accessToken;
}
