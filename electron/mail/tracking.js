// Open / click / interest / unsubscribe tracking through a tracker the user owns (Cloudflare Worker or PHP).
// No Electron imports: tested in plain Node against the worker code.
//
// prepare(draft) rewrites an outgoing email: http(s) links -> signed click links, crm-interest:<choice> ->
// signed interest links, crm-unsubscribe: -> unsubscribe page + List-Unsubscribe headers, adds the pixel.
// With tracking off, crm- links become mailto: replies so interest buttons and unsubscribe still work.
import crypto from 'node:crypto';
import { parseAddressList } from '../../src/shared/mail.js';

export const b64url = s => Buffer.from(String(s), 'utf8').toString('base64url');
export const sign = (secret, msg) => crypto.createHmac('sha256', secret).update(msg).digest('hex').slice(0, 24);
export const newCode = () => crypto.randomBytes(12).toString('base64url');

/** URL builder for the two tracker kinds. PHP uses ?p= routing (works on every host). */
export function trackerUrls(cfg, secret) {
  const base = String(cfg.url || '').replace(/\/+$/, '');
  const php = cfg.kind === 'php' || /\.php$/i.test(base);
  const at = (path, query = {}) => {
    const q = new URLSearchParams(php ? { p: path, ...query } : query).toString();
    return php ? `${base}?${q}` : `${base}${path}${q ? `?${q}` : ''}`;
  };
  return {
    open: code => at(`/o/${code}.gif`),
    click: (code, n, url) => at(`/c/${code}/${n}`, { u: b64url(url), s: sign(secret, `c|${code}|${n}|${url}`) }),
    interest: (code, choice, redirect = '') => at(`/i/${code}/${encodeURIComponent(choice)}`, { ...(redirect ? { r: b64url(redirect) } : {}), s: sign(secret, `i|${code}|${choice}|${redirect}`) }),
    unsub: code => at(`/u/${code}`, { s: sign(secret, `u|${code}`) }),
    api: (path, query = {}) => (php ? `${base}?${new URLSearchParams({ p: `/api/${path}`, ...query })}` : `${base}/api/${path}${Object.keys(query).length ? `?${new URLSearchParams(query)}` : ''}`),
  };
}

const decodeEnt = s => String(s).replace(/&amp;/g, '&').replace(/&#39;/g, '\'').replace(/&quot;/g, '"');
const mailto = (to, subject, body) => `mailto:${to}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`;

/**
 * Rewrites a draft for sending. Returns { draft, record } where record (or null) describes the tracked send.
 * opts: { cfg: {kind,url,pixel,clicks}, secret, from: account email, enabled: boolean }
 */
export function prepareTracked(draft, { cfg = {}, secret = '', from = '', enabled = false } = {}) {
  const d = { ...draft, headers: { ...(draft.headers || {}) } };
  const on = enabled && cfg.kind && cfg.kind !== 'off' && cfg.url && secret;
  const subj = d.subject || '';
  // interest labels (for notifications) from the HTML
  const labels = {};
  for (const m of String(d.html || '').matchAll(/<a\b[^>]*href="crm-interest:([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi)) labels[decodeURIComponent(m[1])] = decodeEnt(m[2].replace(/<[^>]+>/g, '').trim());
  const hasUnsub = /crm-unsubscribe:/.test(d.html || '') || /crm-unsubscribe:/.test(d.text || '') || d.bulk;
  if (!on) {
    const rep = s => String(s || '')
      .replace(/crm-interest:([^"'\s<>)]+)/g, (m, c) => decodeEnt(mailto(from, `Re: ${subj}`, labels[decodeURIComponent(c)] || decodeURIComponent(c))).replace(/&/g, '&amp;'))
      .replace(/crm-unsubscribe:/g, decodeEnt(mailto(from, 'Unsubscribe', 'Please stop sending me these emails.')).replace(/&/g, '&amp;'));
    if (d.html) d.html = rep(d.html);
    if (d.text) d.text = rep(d.text).replace(/&amp;/g, '&');
    if (hasUnsub) d.headers['List-Unsubscribe'] = `<mailto:${from}?subject=Unsubscribe>`;
    delete d.tracking;
    return { draft: d, record: null };
  }
  const urls = trackerUrls(cfg, secret);
  const code = newCode();
  const links = [];
  let html = String(d.html || '');
  if (html) {
    html = html.replace(/crm-interest:([^"'\s<>)]+)/g, (m, c) => urls.interest(code, decodeURIComponent(c)).replace(/&/g, '&amp;'));
    html = html.replace(/crm-unsubscribe:/g, urls.unsub(code).replace(/&/g, '&amp;'));
    if (cfg.clicks !== false) {
      // href="http..." and VML href (desktop Outlook buttons)
      html = html.replace(/(\shref\s*=\s*)(["'])(https?:\/\/[^"']+)\2/gi, (m, pre, q, raw) => {
        const url = decodeEnt(raw);
        if (url.startsWith(String(cfg.url).replace(/\/+$/, ''))) return m; // already a tracker link
        let n = links.indexOf(url);
        if (n < 0) { links.push(url); n = links.length - 1; }
        return `${pre}${q}${urls.click(code, n, url).replace(/&/g, '&amp;')}${q}`;
      });
    }
    if (cfg.pixel !== false) {
      const px = `<img src="${urls.open(code).replace(/&/g, '&amp;')}" width="1" height="1" alt="" style="display:block;width:1px;height:1px;border:0;opacity:0;" />`;
      html = /<\/body>/i.test(html) ? html.replace(/<\/body>/i, `${px}</body>`) : html + px;
    }
    d.html = html;
  }
  if (d.text) {
    d.text = String(d.text)
      .replace(/crm-interest:([^\s<>)]+)/g, (m, c) => urls.interest(code, decodeURIComponent(c)))
      .replace(/crm-unsubscribe:/g, urls.unsub(code));
  }
  if (hasUnsub) {
    d.headers['List-Unsubscribe'] = `<${urls.unsub(code)}>, <mailto:${from}?subject=Unsubscribe>`;
    d.headers['List-Unsubscribe-Post'] = 'List-Unsubscribe=One-Click';
  }
  const to = [...parseAddressList(d.to), ...parseAddressList(d.cc)].map(a => a.address);
  d.tracking = { code, pixel: cfg.pixel !== false, clicks: cfg.clicks !== false };
  const record = { code, subject: subj, to, refs: d.refs || [], links, labels, templateId: d.templateId || null, bulk: !!d.bulk, createdAt: Date.now(), sentAt: null, messageId: null, events: [], opens: 0, proxyOpens: 0, clicks: 0, scannerClicks: 0, interest: [], unsub: false, firstOpen: null, lastOpen: null, lastClick: null };
  return { draft: d, record };
}

/** Is this an automatic fetch rather than a person? */
export function classifyOpen(ev, sentAt) {
  const ua = String(ev.ua || ''), org = String(ev.org || '');
  if (/apple/i.test(org) || /Apple(Mail|WebKit)?.*\bproxy\b/i.test(ua)) return 'apple-proxy';
  if (/GoogleImageProxy|ggpht\.com/i.test(ua)) return 'gmail';
  if (/YahooMailProxy/i.test(ua)) return 'yahoo';
  if (/Microsoft|Outlook-iOS|ms-office/i.test(ua) && sentAt && ev.ts - sentAt < 15000) return 'scanner';
  if (sentAt && ev.ts - sentAt < 4000) return 'scanner';
  return 'human';
}

export function classifyClick(ev, rec) {
  if (rec.sentAt && ev.ts - rec.sentAt < 20000) return 'scanner';
  const ua = String(ev.ua || '');
  if (/bot|crawler|spider|preview|scanner|safelinks|barracuda|proofpoint|mimecast|urldefense/i.test(ua)) return 'scanner';
  // several different links within 2 s = automatic link checking
  const recent = rec.events.filter(e => e.type === 'click' && Math.abs(e.ts - ev.ts) < 2000 && e.n !== ev.n);
  if (recent.length >= 2) return 'scanner';
  return 'human';
}

/** Applies tracker events to the send records. Returns a list of human-meaningful changes for the UI. */
export function applyEvents(sends, events) {
  const changes = [];
  const ORDER = { open: 0, click: 1, interest: 2, unsub: 3 };
  for (const ev of [...events].sort((a, b) => (Number(a.ts) - Number(b.ts)) || ((ORDER[a.type] ?? 9) - (ORDER[b.type] ?? 9)))) {
    const rec = sends[ev.code];
    if (!rec) continue;
    if (rec.events.some(e => e.id === ev.id && ev.id != null)) continue;
    const item = { id: ev.id, type: ev.type, ts: Number(ev.ts) || Date.now(), n: ev.n, v: ev.v };
    if (ev.type === 'open') {
      item.kind = classifyOpen(ev, rec.sentAt);
      if (item.kind === 'apple-proxy' || item.kind === 'scanner') rec.proxyOpens++;
      else { rec.opens++; rec.firstOpen ||= item.ts; rec.lastOpen = Math.max(rec.lastOpen || 0, item.ts); }
      if (item.kind !== 'scanner' && item.kind !== 'apple-proxy' && rec.opens === 1) changes.push({ kind: 'open', code: rec.code, refs: rec.refs, subject: rec.subject });
    } else if (ev.type === 'click') {
      item.kind = classifyClick(ev, rec);
      if (item.kind === 'human') {
        rec.clicks++; rec.lastClick = Math.max(rec.lastClick || 0, item.ts);
        if (!rec.opens) { rec.opens = 1; rec.firstOpen ||= item.ts; rec.lastOpen = item.ts; } // a click implies an open
        changes.push({ kind: 'click', code: rec.code, refs: rec.refs, subject: rec.subject, url: rec.links[ev.n] || ev.v });
      } else rec.scannerClicks++;
    } else if (ev.type === 'interest') {
      const label = rec.labels?.[ev.v] || ev.v;
      rec.interest.push({ choice: ev.v, label, ts: item.ts });
      if (!rec.opens) { rec.opens = 1; rec.firstOpen ||= item.ts; rec.lastOpen = item.ts; }
      changes.push({ kind: 'interest', code: rec.code, refs: rec.refs, subject: rec.subject, choice: ev.v, label });
    } else if (ev.type === 'unsub') {
      if (!rec.unsub) changes.push({ kind: 'unsubscribe', code: rec.code, refs: rec.refs, subject: rec.subject });
      rec.unsub = true;
    }
    rec.events.push(item);
    if (rec.events.length > 200) rec.events.splice(0, rec.events.length - 200);
  }
  return changes;
}

/** Short status for one sent message (for badges). */
export function sendStatus(rec, { replied = false, bounced = false } = {}) {
  if (!rec) return null;
  if (bounced) return { status: 'bounced', label: '⚠ Bounced', title: 'The address does not exist or rejected the email' };
  if (rec.unsub) return { status: 'unsub', label: '⊘ Unsubscribed', title: 'Asked not to receive these emails' };
  if (replied) return { status: 'replied', label: '↩ Replied', title: 'They answered' };
  if (rec.interest.length) { const last = rec.interest[rec.interest.length - 1]; return { status: 'interest', label: `👍 ${last.label}`, title: `Clicked “${last.label}” ${new Date(last.ts).toLocaleString()}` }; }
  if (rec.clicks) return { status: 'clicked', label: `🔗 Clicked${rec.clicks > 1 ? ` ×${rec.clicks}` : ''}`, title: `Last click ${new Date(rec.lastClick).toLocaleString()}` };
  if (rec.opens) return { status: 'opened', label: `👁 Opened${rec.opens > 1 ? ` ×${rec.opens}` : ''}`, title: `First opened ${new Date(rec.firstOpen).toLocaleString()}` };
  if (rec.proxyOpens) return { status: 'proxy', label: '👁? Opened (privacy proxy)', title: 'Apple Mail or a security scanner loaded the email automatically: it may not have been read by a person' };
  if (!rec.sentAt) return { status: 'queued', label: '⏳ Queued', title: '' };
  return { status: 'sent', label: '✓ Sent', title: rec.pixelBlocked ? '' : 'Not opened yet (or pictures are blocked in their mail app)' };
}

/** Engagement 0-100: recent clicks, interest and replies count most; opens a little; decays with time. */
export function engagementScore(items, now = Date.now()) {
  let s = 0;
  for (const it of items) {
    const age = Math.max(0, (now - it.ts) / 864e5);
    const decay = 0.5 ** (age / 30);
    s += ({ open: 6, click: 18, interest: 40, reply: 30, 'reply-interested': 45 }[it.type] || 0) * decay;
    if (it.type === 'unsubscribe') return 0;
  }
  return Math.min(100, Math.round(s));
}

/** Talks to the tracker API. */
export async function fetchEvents(cfg, secret, { fetchImpl = fetch } = {}) {
  const urls = trackerUrls(cfg, secret);
  const get = async (path, init = {}, query = {}) => {
    const r = await fetchImpl(urls.api(path, query), { ...init, headers: { Authorization: `Bearer ${secret}`, 'Content-Type': 'application/json', ...(init.headers || {}) }, signal: AbortSignal.timeout(20000) });
    if (r.status === 401) throw new Error('The tracker refused the secret. Copy the secret from OpenCRM into the tracker again.');
    if (!r.ok) throw new Error(`Tracker answered ${r.status}`);
    return r.json();
  };
  return {
    health: () => get('health'),
    events: () => get('events', {}, { limit: '500' }),
    ack: ids => get('ack', { method: 'POST', body: JSON.stringify({ ids }) }),
  };
}
