// OpenCRM email tracker — Cloudflare Worker (free plan is enough for a solopreneur).
//
// It only ever sees random codes, times and which link/button was used: never names or email addresses.
// The OpenCRM app on your computer collects the events and matches the codes to your contacts.
//
// Setup (about 10 minutes, see OpenCRM → Settings → Email → Open & click tracking):
//   1. dash.cloudflare.com → Workers & Pages → Create → Worker → paste this file → Deploy.
//   2. Storage & Databases → D1 → Create database "opencrm-tracker".
//      Worker → Settings → Bindings → Add → D1 database → variable name: DB → choose "opencrm-tracker".
//      (Workers KV also works: bind a KV namespace as EVENTS. D1 is recommended: more free writes per day.)
//   3. Worker → Settings → Variables and Secrets → Add → type "Secret", name SECRET, value: the secret shown in OpenCRM.
//   4. Copy the worker address (https://<name>.<you>.workers.dev) into OpenCRM and press “Test tracker”.
//   Optional: Settings → Domains & Routes → add a custom domain such as t.yourdomain.com (better for spam filters).

const VERSION = 1;
const GIF = Uint8Array.from(atob('R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7'), c => c.charCodeAt(0));
const CODE_RE = /^[A-Za-z0-9_-]{8,40}$/;
const noStore = { 'Cache-Control': 'no-store, no-cache, must-revalidate, private', Pragma: 'no-cache', Expires: '0' };

const enc = new TextEncoder();
async function hmac(secret, msg) {
  const key = await crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const sig = new Uint8Array(await crypto.subtle.sign('HMAC', key, enc.encode(msg)));
  return [...sig.slice(0, 12)].map(b => b.toString(16).padStart(2, '0')).join('');
}
function safeEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length) return false;
  let x = 0;
  for (let i = 0; i < a.length; i++) x |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return x === 0;
}
function b64urlDecode(s) {
  const b = String(s || '').replace(/-/g, '+').replace(/_/g, '/');
  const bin = atob(b + '==='.slice((b.length + 3) % 4));
  return new TextDecoder().decode(Uint8Array.from(bin, c => c.charCodeAt(0)));
}
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', '\'': '&#39;' }[c]));
const page = (title, body, status = 200) => new Response(`<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex"><title>${esc(title)}</title><style>body{font-family:-apple-system,Segoe UI,Roboto,Arial,sans-serif;background:#f3f5f8;color:#1f2933;margin:0;display:flex;min-height:100vh;align-items:center;justify-content:center}.c{background:#fff;padding:32px 36px;border-radius:12px;max-width:460px;box-shadow:0 2px 16px rgba(0,0,0,.08);text-align:center}h1{font-size:22px;margin:0 0 10px}p{line-height:1.5;color:#4b5563}button{font:inherit;background:#2f6fed;color:#fff;border:0;border-radius:8px;padding:10px 22px;cursor:pointer}</style></head><body><div class="c">${body}</div></body></html>`, { status, headers: { 'Content-Type': 'text/html; charset=utf-8', ...noStore } });

// ---------------- storage (D1 preferred, KV fallback)
async function ensureTable(env) {
  if (env.__ready) return;
  await env.DB.prepare('CREATE TABLE IF NOT EXISTS events (id INTEGER PRIMARY KEY AUTOINCREMENT, ts INTEGER NOT NULL, type TEXT NOT NULL, code TEXT NOT NULL, n INTEGER, v TEXT, ua TEXT, org TEXT)').run();
  env.__ready = true;
}
async function store(env, ev) {
  if (env.DB) {
    await ensureTable(env);
    await env.DB.prepare('INSERT INTO events (ts, type, code, n, v, ua, org) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)').bind(ev.ts, ev.type, ev.code, ev.n ?? null, ev.v ?? null, ev.ua ?? null, ev.org ?? null).run();
  } else if (env.EVENTS) {
    await env.EVENTS.put(`ev:${String(ev.ts).padStart(14, '0')}:${crypto.randomUUID().slice(0, 8)}`, JSON.stringify(ev), { expirationTtl: 60 * 60 * 24 * 60 });
  } else throw new Error('No storage bound (add a D1 binding named DB or a KV binding named EVENTS)');
}
async function list(env, limit = 500) {
  if (env.DB) {
    await ensureTable(env);
    const r = await env.DB.prepare('SELECT id, ts, type, code, n, v, ua, org FROM events ORDER BY id LIMIT ?1').bind(limit).all();
    return (r.results || []).map(e => ({ ...e, id: String(e.id) }));
  }
  const out = [];
  const r = await env.EVENTS.list({ prefix: 'ev:', limit });
  for (const k of r.keys) { const v = await env.EVENTS.get(k.name); if (v) out.push({ id: k.name, ...JSON.parse(v) }); }
  return out;
}
async function ack(env, ids) {
  if (!ids.length) return 0;
  if (env.DB) {
    await ensureTable(env);
    const nums = ids.map(Number).filter(Number.isFinite);
    for (let i = 0; i < nums.length; i += 90) {
      const chunk = nums.slice(i, i + 90);
      await env.DB.prepare(`DELETE FROM events WHERE id IN (${chunk.map((_, j) => `?${j + 1}`).join(',')})`).bind(...chunk).run();
    }
    return nums.length;
  }
  for (const id of ids) if (String(id).startsWith('ev:')) await env.EVENTS.delete(id);
  return ids.length;
}

function meta(request) {
  const ua = (request.headers.get('user-agent') || '').slice(0, 160);
  const org = (request.cf && (request.cf.asOrganization || '')) ? String(request.cf.asOrganization).slice(0, 80) : '';
  return { ua, org };
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const parts = url.pathname.split('/').filter(Boolean);
    const secret = env.SECRET || '';
    const now = Date.now();
    const later = p => (ctx && ctx.waitUntil ? ctx.waitUntil(p.catch(() => {})) : p.catch(() => {}));
    try {
      // ---- open pixel: /o/<code>.gif
      if (parts[0] === 'o' && parts[1]) {
        const code = parts[1].replace(/\.gif$/, '');
        if (CODE_RE.test(code)) later(store(env, { ts: now, type: 'open', code, ...meta(request) }));
        return new Response(GIF, { headers: { 'Content-Type': 'image/gif', ...noStore } });
      }
      // ---- click: /c/<code>/<n>?u=<base64url>&s=<sig>
      if (parts[0] === 'c' && parts[1] && parts[2]) {
        const code = parts[1], n = Number(parts[2]);
        const target = b64urlDecode(url.searchParams.get('u'));
        const sig = url.searchParams.get('s') || '';
        if (!CODE_RE.test(code) || !/^https?:\/\//i.test(target) || !safeEqual(sig, await hmac(secret, `c|${code}|${n}|${target}`))) return page('Link not valid', '<h1>This link is not valid</h1><p>It may have been changed or copied incompletely.</p>', 400);
        later(store(env, { ts: now, type: 'click', code, n, v: target.slice(0, 300), ...meta(request) }));
        return new Response(null, { status: 302, headers: { Location: target, ...noStore } });
      }
      // ---- interest button: /i/<code>/<choice>?s=<sig>[&r=<base64url redirect>]
      if (parts[0] === 'i' && parts[1] && parts[2]) {
        const code = parts[1], choice = decodeURIComponent(parts[2]).slice(0, 60);
        const r = url.searchParams.get('r') ? b64urlDecode(url.searchParams.get('r')) : '';
        const sig = url.searchParams.get('s') || '';
        if (!CODE_RE.test(code) || !safeEqual(sig, await hmac(secret, `i|${code}|${choice}|${r}`))) return page('Link not valid', '<h1>This link is not valid</h1>', 400);
        await store(env, { ts: now, type: 'interest', code, v: choice, ...meta(request) });
        if (/^https?:\/\//i.test(r)) return new Response(null, { status: 302, headers: { Location: r, ...noStore } });
        const msg = env.THANK_YOU || 'Thank you! Your answer has been received. We will be in touch soon.';
        return page('Thank you', `<h1>✓ Thank you!</h1><p>${esc(msg)}</p>`);
      }
      // ---- unsubscribe: GET shows a confirm button (link scanners never unsubscribe anyone), POST confirms (also RFC 8058 one-click)
      if (parts[0] === 'u' && parts[1]) {
        const code = parts[1];
        const sig = url.searchParams.get('s') || '';
        if (!CODE_RE.test(code) || !safeEqual(sig, await hmac(secret, `u|${code}`))) return page('Link not valid', '<h1>This link is not valid</h1>', 400);
        if (request.method === 'POST') {
          await store(env, { ts: now, type: 'unsub', code, ...meta(request) });
          return page('Unsubscribed', '<h1>You have been unsubscribed</h1><p>You will not receive these emails any more.</p>');
        }
        return page('Unsubscribe', `<h1>Unsubscribe?</h1><p>Click the button to stop receiving these emails.</p><form method="post"><button type="submit">Unsubscribe</button></form>`);
      }
      // ---- API for the OpenCRM app (Authorization: Bearer <SECRET>)
      if (parts[0] === 'api') {
        const auth = (request.headers.get('authorization') || '').replace(/^Bearer\s+/i, '');
        if (!secret || !safeEqual(auth, secret)) return Response.json({ error: 'unauthorized' }, { status: 401 });
        if (parts[1] === 'health') return Response.json({ ok: true, version: VERSION, storage: env.DB ? 'd1' : env.EVENTS ? 'kv' : 'none' });
        if (parts[1] === 'events' && request.method === 'GET') return Response.json({ events: await list(env, Math.min(1000, Number(url.searchParams.get('limit')) || 500)) });
        if (parts[1] === 'ack' && request.method === 'POST') { const body = await request.json(); return Response.json({ deleted: await ack(env, Array.isArray(body.ids) ? body.ids.slice(0, 1000) : []) }); }
        return Response.json({ error: 'not found' }, { status: 404 });
      }
      if (url.pathname === '/' || url.pathname === '') return new Response('OK', { headers: { 'Content-Type': 'text/plain' } });
      return new Response('Not found', { status: 404 });
    } catch (e) {
      if (parts[0] === 'o') return new Response(GIF, { headers: { 'Content-Type': 'image/gif', ...noStore } });
      return Response.json({ error: String(e && e.message || e) }, { status: 500 });
    }
  },
};
