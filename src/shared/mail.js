// Email helpers shared by the main process, the renderer and tests. Pure ES module.
// Addresses, record matching, threads, replies, mail templates ({{fields}} with filters), bulk-send pacing.

import { valueToText, isEmptyValue, recordTitle } from './schema.js';
import { formatDate } from './dates.js';

export const EMAIL_RE = /^[^\s@<>()",;:]+@[^\s@<>()",;:]+\.[^\s@<>()",;:]{2,}$/;
export const isValidEmail = s => EMAIL_RE.test(String(s || '').trim());

// ---------------------------------------------------------------- addresses

export function normEmail(a) { return String(a || '').trim().toLowerCase(); }

/** "+tag" addressing: john+crm@x.com and john@x.com are the same person. */
export function looseEmail(a) {
  const n = normEmail(a);
  const at = n.lastIndexOf('@');
  if (at < 0) return n;
  return n.slice(0, at).replace(/\+.*$/, '') + n.slice(at);
}

/** Parses "Name <a@b.c>, \"Last, First\" <x@y.z>; plain@q.r" into [{name, address}]. */
export function parseAddressList(input) {
  if (Array.isArray(input)) return input.flatMap(parseAddressList);
  if (input && typeof input === 'object') return input.address ? [{ name: input.name || '', address: normEmail(input.address) }] : [];
  const s = String(input || '');
  const parts = [];
  let cur = '', quote = false, angle = false;
  for (const ch of s) {
    if (ch === '"') quote = !quote;
    else if (ch === '<' && !quote) angle = true;
    else if (ch === '>' && !quote) angle = false;
    if ((ch === ',' || ch === ';' || ch === '\n') && !quote && !angle) { parts.push(cur); cur = ''; continue; }
    cur += ch;
  }
  parts.push(cur);
  const out = [];
  for (const p of parts) {
    const t = p.trim();
    if (!t) continue;
    const m = t.match(/^(.*?)<\s*([^>]+?)\s*>\s*$/);
    let name = '', address = '';
    if (m) { name = m[1].trim().replace(/^"(.*)"$/, '$1').trim(); address = m[2]; }
    else { address = t.replace(/^mailto:/i, ''); }
    address = normEmail(address);
    if (address) out.push({ name, address });
  }
  return out;
}

export function formatAddress({ name, address } = {}) {
  if (!address) return '';
  if (!name) return address;
  const n = /[",;<>@()]/.test(name) ? `"${name.replace(/"/g, '\'')}"` : name;
  return `${n} <${address}>`;
}
export const formatAddressList = list => (list || []).map(formatAddress).filter(Boolean).join(', ');

// ---------------------------------------------------------------- records <-> addresses

export const emailFieldsOf = type => (type?.fieldDefs || []).filter(f => f.type === 'email');

/** Every address of a record: all email-type fields (a field may hold "a@x, b@y") + extraEmails. */
export function recordEmails(type, rec) {
  const out = [];
  const add = v => { for (const a of parseAddressList(v)) if (isValidEmail(a.address) && !out.includes(a.address)) out.push(a.address); };
  for (const f of emailFieldsOf(type)) add(rec?.[f.key]);
  for (const e of rec?.extraEmails || []) add(e);
  return out;
}

export const refKey = (typeKey, id) => `${typeKey}:${id}`;
export const parseRef = ref => { const i = String(ref).lastIndexOf(':'); return { typeKey: ref.slice(0, i), id: Number(ref.slice(i + 1)) || ref.slice(i + 1) }; };

/** Map of address -> [ref] (exact) and loose address -> [ref]. */
export function buildAddressIndex(data) {
  const exact = new Map(), loose = new Map();
  const push = (m, k, v) => { const a = m.get(k); if (!a) m.set(k, [v]); else if (!a.includes(v)) a.push(v); };
  for (const type of data?.meta?.recordTypes || []) {
    if (!emailFieldsOf(type).length) continue;
    for (const rec of data[type.key] || []) {
      for (const a of recordEmails(type, rec)) {
        const r = refKey(type.key, rec.id);
        push(exact, a, r);
        push(loose, looseEmail(a), r);
      }
    }
  }
  return { exact, loose };
}

export function refsForAddress(index, address) {
  const a = normEmail(address);
  return index.exact.get(a) || index.loose.get(looseEmail(a)) || [];
}

/** Records involved in a message (from/to/cc/bcc), excluding the user's own addresses. */
export function matchMessage(index, msg, selfAddresses = []) {
  const self = new Set(selfAddresses.map(normEmail));
  const refs = new Set();
  for (const a of messageParticipants(msg)) {
    if (self.has(a)) continue;
    for (const r of refsForAddress(index, a)) refs.add(r);
  }
  return [...refs];
}

export function messageParticipants(msg) {
  const all = [...(msg.from || []), ...(msg.to || []), ...(msg.cc || []), ...(msg.bcc || [])].map(x => normEmail(x.address || x));
  return [...new Set(all.filter(Boolean))];
}

// ---------------------------------------------------------------- subjects & threads

const PREFIX_RE = /^\s*((re|fw|fwd|rv|aw|wg|sv|tr|antw|res|enc|ref|vs|odp|r)\s*(\[\d+\])?\s*:\s*)+/i;
export function normSubject(s) {
  let t = String(s || '').trim();
  for (let i = 0; i < 10; i++) {
    const n = t.replace(PREFIX_RE, '').replace(/^\[[^\]]{1,30}\]\s*(?=(re|fw|fwd|rv|aw|wg)\s*:)/i, '').trim();
    if (n === t) break;
    t = n;
  }
  return t.replace(/\s+/g, ' ').toLowerCase();
}

export function replySubject(subject, kind = 'reply') {
  const s = String(subject || '').trim();
  const base = s.replace(PREFIX_RE, '').trim();
  if (kind === 'forward') return `Fwd: ${base}`;
  return `Re: ${base}`;
}

/**
 * Groups messages into threads. Uses Message-ID / In-Reply-To / References (union-find);
 * messages without headers fall back to the normalised subject + shared participant within 90 days.
 * Returns Map(messageKey -> threadId). msg: {key, messageId, inReplyTo, references[], subject, date, from, to, cc}
 */
export function computeThreads(msgs, selfAddresses = []) {
  const parent = new Map();
  const find = x => { while (parent.get(x) !== x) { parent.set(x, parent.get(parent.get(x))); x = parent.get(x); } return x; };
  const add = x => { if (!parent.has(x)) parent.set(x, x); };
  const union = (a, b) => { add(a); add(b); const ra = find(a), rb = find(b); if (ra !== rb) parent.set(rb, ra); };
  const idOf = m => m.messageId ? `mid:${m.messageId}` : `key:${m.key}`;
  for (const m of msgs) {
    add(idOf(m));
    for (const r of [m.inReplyTo, ...(m.references || [])].filter(Boolean)) union(`mid:${r}`, idOf(m));
  }
  // subject fallback for messages that reference nothing
  const self = new Set(selfAddresses.map(normEmail));
  const bySubject = new Map();
  const sorted = [...msgs].sort((a, b) => new Date(a.date) - new Date(b.date));
  for (const m of sorted) {
    const ns = normSubject(m.subject);
    if (!ns || ns.length < 4) continue;
    const people = messageParticipants(m).filter(a => !self.has(a));
    const list = bySubject.get(ns) || [];
    const hasRefs = m.inReplyTo || (m.references || []).length;
    if (!hasRefs && PREFIX_RE.test(m.subject || '')) {
      const prev = [...list].reverse().find(p => new Date(m.date) - new Date(p.date) < 90 * 864e5 && p.people.some(a => people.includes(a)));
      if (prev) union(prev.id, idOf(m));
    }
    list.push({ id: idOf(m), date: m.date, people });
    bySubject.set(ns, list);
  }
  const out = new Map();
  for (const m of msgs) out.set(m.key, 't_' + hashString(find(idOf(m))));
  return out;
}

export function hashString(s) {
  let h1 = 0x811c9dc5, h2 = 0x9e3779b9;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    h1 = Math.imul(h1 ^ c, 16777619) >>> 0;
    h2 = Math.imul(h2 ^ c, 2246822507) >>> 0;
  }
  return h1.toString(36) + h2.toString(36);
}

// ---------------------------------------------------------------- replies

export function replyRecipients(msg, selfAddresses = [], { all = false } = {}) {
  const self = new Set(selfAddresses.map(normEmail));
  const fromSelf = (msg.from || []).some(a => self.has(normEmail(a.address)));
  const replyTo = msg.replyTo?.length ? msg.replyTo : msg.from || [];
  let to = fromSelf ? (msg.to || []) : replyTo;
  let cc = [];
  if (all) {
    const seen = new Set(to.map(a => normEmail(a.address)));
    cc = [...(fromSelf ? [] : msg.to || []), ...(msg.cc || [])].filter(a => {
      const n = normEmail(a.address);
      if (self.has(n) || seen.has(n)) return false;
      seen.add(n);
      return true;
    });
  }
  to = to.filter(a => !self.has(normEmail(a.address)) || fromSelf);
  return { to, cc };
}

export function replyHeaders(msg) {
  const refs = [...(msg.references || [])];
  if (msg.messageId && !refs.includes(msg.messageId)) refs.push(msg.messageId);
  return { inReplyTo: msg.messageId || undefined, references: refs.slice(-20) };
}

export function quoteText(msg, { dateFormat = 'YYYY/MMM/DD' } = {}) {
  const who = msg.from?.[0] ? (msg.from[0].name || msg.from[0].address) : 'someone';
  const when = msg.date ? `${formatDate(new Date(msg.date), dateFormat)} ${new Date(msg.date).toTimeString().slice(0, 5)}` : '';
  const body = String(msg.text || '').replace(/\r\n/g, '\n').trimEnd();
  return `\n\nOn ${when}, ${who} wrote:\n` + body.split('\n').map(l => '> ' + l).join('\n');
}

export function forwardText(msg, { dateFormat = 'YYYY/MMM/DD' } = {}) {
  const lines = ['', '', '---------- Forwarded message ----------',
    `From: ${formatAddressList(msg.from)}`,
    `Date: ${msg.date ? formatDate(new Date(msg.date), dateFormat) : ''}`,
    `Subject: ${msg.subject || ''}`,
    `To: ${formatAddressList(msg.to)}`];
  if (msg.cc?.length) lines.push(`Cc: ${formatAddressList(msg.cc)}`);
  lines.push('', String(msg.text || ''));
  return lines.join('\n');
}

/** First meaningful characters of a body, without quoted history or signatures. */
export function snippetOf(text, max = 160) {
  const lines = String(text || '').replace(/\r\n/g, '\n').split('\n');
  const keep = [];
  for (const l of lines) {
    if (/^\s*>/.test(l)) continue;
    if (/^\s*(On .{4,200} wrote:|El .{4,200} escribió:|Le .{4,200} a écrit :|Am .{4,200} schrieb .*:)\s*$/i.test(l)) break;
    if (/^-- ?$/.test(l) || /^-{5,}\s*(Original|Forwarded) Message/i.test(l)) break;
    keep.push(l.trim());
  }
  const s = keep.join(' ').replace(/\s+/g, ' ').trim();
  return s.length > max ? s.slice(0, max - 1).trimEnd() + '…' : s;
}

/** Strips quoted history from a reply body (for AI intent detection and timeline). */
export function stripQuoted(text) {
  const lines = String(text || '').replace(/\r\n/g, '\n').split('\n');
  const keep = [];
  for (const l of lines) {
    if (/^\s*(On .{4,200} wrote:|El .{4,200} escribió:|Le .{4,200} a écrit :|Am .{4,200} schrieb .*:)\s*$/i.test(l)) break;
    if (/^-{5,}\s*(Original|Forwarded) Message/i.test(l) || /^_{10,}$/.test(l) || /^From: .+/.test(l) && keep.length > 2) break;
    if (/^\s*>/.test(l)) continue;
    keep.push(l);
  }
  return keep.join('\n').trim();
}

// ---------------------------------------------------------------- mail templates

const caseTitle = s => s.toLowerCase().replace(/(^|[\s\-'])(\p{L})/gu, (m, a, b) => a + b.toUpperCase());

/** Placeholders the user fills at send time: {{?Meeting link}} */
export function sendTimeFields(...templates) {
  const out = [];
  for (const t of templates) {
    for (const m of String(t || '').matchAll(/\{\{\s*\?\s*([^}|]+?)\s*(\|[^}]*)?\}\}/g)) if (!out.includes(m[1])) out.push(m[1]);
  }
  return out;
}

/**
 * Renders {{placeholders}} for email: record fields by label or key, me.*, today, {{?ask}} send-time fields,
 * filters: |first |last |upper |lower |title |long |or:"fallback". Unknown/empty values are reported in `missing`.
 * opts.escape: function applied to every inserted value (HTML escaping for HTML bodies).
 */
export function renderMailTemplate(template, { type, record, me = {}, ask = {}, ctx = {}, escape = null } = {}) {
  const missing = [];
  const df = ctx.dateFormat || 'YYYY/MMM/DD';
  const findDef = name => {
    const n = String(name).trim().toLowerCase();
    return type?.fieldDefs.find(f => f.key.toLowerCase() === n || f.label.toLowerCase() === n) || null;
  };
  const text = String(template || '').replace(/\{\{\s*([^}]+?)\s*\}\}/g, (whole, expr) => {
    const parts = splitFilters(expr);
    let head = parts.shift().trim();
    let value;
    let known = true;
    if (head.startsWith('?')) { const k = head.slice(1).trim(); value = ask[k] ?? ''; head = k; }
    else if (head === 'today') value = formatDate(new Date(), df);
    else if (head === 'title' || head === 'record.title') value = record ? recordTitle(type, record) : '';
    else if (head.startsWith('me.')) value = me[head.slice(3)] ?? '';
    else {
      const [base, sub] = head.split('.');
      const def = findDef(head) || findDef(base);
      if (def && record) {
        if (def.type === 'relation' && sub && ctx.relationField) value = ctx.relationField(def, record[def.key], sub);
        else value = isEmptyValue(record[def.key]) ? '' : valueToText(def, record[def.key], ctx);
        if (def.type === 'date' && value) value = formatDate(value, df);
      } else known = false;
    }
    if (!known) {
      if (parts.some(p => p.startsWith('or:'))) return escape ? escape(applyFilters('', parts, df)) : applyFilters('', parts, df);
      missing.push(head);
      return whole;
    }
    let out = applyFilters(String(value ?? ''), parts, df);
    if (!out && !parts.some(p => p.startsWith('or:'))) missing.push(head);
    if (escape) out = escape(out);
    return out;
  });
  return { text, missing: [...new Set(missing)] };
}

function splitFilters(expr) {
  const out = [];
  let cur = '', q = false;
  for (const ch of expr) {
    if (ch === '"') q = !q;
    if (ch === '|' && !q) { out.push(cur); cur = ''; continue; }
    cur += ch;
  }
  out.push(cur);
  return out.map(s => s.trim());
}

function applyFilters(v, filters, df) {
  let s = v;
  for (const f of filters) {
    if (f === 'first') s = s.trim().split(/\s+/)[0] || '';
    else if (f === 'last') { const p = s.trim().split(/\s+/); s = p.length > 1 ? p[p.length - 1] : ''; }
    else if (f === 'upper') s = s.toUpperCase();
    else if (f === 'lower') s = s.toLowerCase();
    else if (f === 'title') s = caseTitle(s);
    else if (f === 'long' && s) { const d = new Date(s); if (!Number.isNaN(+d)) s = d.toLocaleDateString(undefined, { day: 'numeric', month: 'long', year: 'numeric' }); }
    else if (f.startsWith('or:')) { if (!s.trim()) s = f.slice(3).trim().replace(/^"(.*)"$/, '$1'); }
    else if (f === 'date') s = s ? formatDate(s, df) : s;
  }
  return s;
}

// ---------------------------------------------------------------- bulk pacing

/**
 * Plans when each bulk message goes out. spacingSec between messages, at most dailyLimit per rolling day
 * (sentTimes = timestamps already sent in the last 24h). Returns array of epoch ms.
 */
export function planBulk(count, { spacingSec = 20, dailyLimit = 200, sentTimes = [], now = Date.now() } = {}) {
  const day = 864e5;
  const window = sentTimes.filter(t => now - t < day).sort((a, b) => a - b);
  const plan = [];
  let t = now;
  for (let i = 0; i < count; i++) {
    if (i > 0) t += spacingSec * 1000;
    // keep the rolling 24h window under the limit
    const recent = [...window, ...plan].filter(x => t - x < day);
    if (recent.length >= dailyLimit) {
      const all = [...window, ...plan].sort((a, b) => a - b);
      const oldest = all[all.length - dailyLimit];
      t = Math.max(t, oldest + day + 1000);
    }
    plan.push(t);
  }
  return plan;
}

export function remainingToday(dailyLimit, sentTimes = [], now = Date.now()) {
  return Math.max(0, dailyLimit - sentTimes.filter(t => now - t < 864e5).length);
}

// ---------------------------------------------------------------- misc

export const DANGEROUS_EXT = /\.(exe|com|bat|cmd|msi|msp|scr|pif|js|jse|vbs|vbe|wsf|wsh|ps1|psm1|hta|cpl|jar|lnk|reg|dll|scf|inf|iso|img|vhd|vhdx|appx|msix|docm|xlsm|pptm)$/i;
export const isDangerousFile = name => DANGEROUS_EXT.test(String(name || '').trim());

export function humanSize(n) {
  if (!n && n !== 0) return '';
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(n < 10240 ? 1 : 0)} KB`;
  return `${(n / 1048576).toFixed(1)} MB`;
}

/** Markdown-ish plain text body -> safe minimal HTML is done in email-design.js; this escapes text. */
export function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', '\'': '&#39;' }[c]));
}
