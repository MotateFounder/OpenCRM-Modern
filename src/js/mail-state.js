// Renderer-side mail state: per-record stats, account statuses, outbox, unread count; event wiring.
import { store, emit } from './store.js';
import { lastContactTime, refKey } from './shared.js';
import { toast } from './ui.js';

export const mail = { stats: {}, unread: 0, statuses: [], outbox: [], accounts: [], ready: false, searchText: {} };

export const mailInSearch = () => !!store.data?.meta?.settings?.mail?.includeInSearch;
let stTimer = null;
export function refreshSearchText() {
  clearTimeout(stTimer);
  if (!mailInSearch()) { mail.searchText = {}; return; }
  stTimer = setTimeout(async () => { try { mail.searchText = (await window.crm.mail.searchText()).text || {}; emit('mail-search-text'); } catch { /* no db */ } }, 300);
}
/** True when every plain word of the query appears in the record's email subjects/previews. */
export function mailMatches(typeKey, rec, query) {
  const t = mail.searchText[refKey(typeKey, rec.id)];
  if (!t) return false;
  const words = String(query || '').toLowerCase().split(/\s+/).filter(w => w && !w.includes(':'));
  if (!words.length) return false;
  const low = t.toLowerCase();
  return words.every(w => low.includes(w.replace(/^"|"$/g, '')));
}

export function mailEnabled() { return mail.accounts.length > 0; }
export function mailStats(typeKey, id) { return mail.stats[refKey(typeKey, id)] || null; }

/** Last contact = latest note, or latest email when the setting is on. */
export function lastContactFor(typeKey, rec) {
  const t = lastContactTime(rec);
  if (store.data?.meta?.settings?.mail?.lastContactIncludesEmail === false) return t;
  const s = mail.stats[refKey(typeKey, rec.id)];
  const e = s?.last ? Date.parse(s.last) : 0;
  return Math.max(t, e || 0);
}

export function lastEmailFor(typeKey, rec) {
  const s = mail.stats[refKey(typeKey, rec.id)];
  return s?.last ? Date.parse(s.last) : 0;
}

let wired = false;
export function initMail() {
  if (wired) return;
  wired = true;
  window.crm.mail.onEvent(({ type, payload }) => {
    switch (type) {
      case 'changed':
        mail.stats = payload.stats || {};
        mail.unread = payload.unread || 0;
        refreshSearchText();
        emit('mail-changed');
        break;
      case 'status': {
        const i = mail.statuses.findIndex(s => s.accountId === payload.accountId);
        if (i >= 0) mail.statuses[i] = payload; else mail.statuses.push(payload);
        emit('mail-status');
        break;
      }
      case 'outbox': mail.outbox = payload || []; emit('mail-outbox'); break;
      case 'new-mail': emit('mail-new', payload); break;
      case 'sent': emit('mail-sent', payload); break;
      case 'send-error': toast(`Email “${payload.subject || '(no subject)'}” ${payload.final ? 'could not be sent' : 'will be retried'}: ${payload.error}`, { type: 'error', timeout: 9000 }); emit('mail-outbox'); break;
      case 'warning': toast(payload, { type: 'error', timeout: 7000 }); break;
      default: emit(`mail-${type}`, payload);
    }
  });
}

export async function refreshMail() {
  try {
    const [a, s, st] = await Promise.all([window.crm.mail.accounts(), window.crm.mail.stats(), window.crm.mail.status()]);
    mail.accounts = a.accounts || [];
    mail.statuses = a.statuses?.length ? a.statuses : st.statuses || [];
    mail.stats = s.stats || {};
    mail.unread = s.unread || 0;
    mail.outbox = st.outbox || [];
    mail.ready = true;
    refreshSearchText();
    emit('mail-changed');
  } catch { /* no database open */ }
}

export function accountStatus(id) { return mail.statuses.find(s => s.accountId === id) || { state: 'stopped' }; }
export function defaultAccount() { return mail.accounts.find(a => a.enabled !== false) || null; }

export function relTime(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  const now = new Date();
  const diff = (now - d) / 1000;
  if (diff < 60) return 'just now';
  if (diff < 3600) return `${Math.floor(diff / 60)} min ago`;
  if (d.toDateString() === now.toDateString()) return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  const y = new Date(now); y.setDate(now.getDate() - 1);
  if (d.toDateString() === y.toDateString()) return `Yesterday ${d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`;
  if (diff < 6 * 86400) return d.toLocaleDateString([], { weekday: 'short', hour: '2-digit', minute: '2-digit' });
  if (d.getFullYear() === now.getFullYear()) return d.toLocaleDateString([], { day: 'numeric', month: 'short' });
  return d.toLocaleDateString([], { day: 'numeric', month: 'short', year: 'numeric' });
}

/** Finds the record for a ref "typeKey:id". */
export function recordForRef(ref) {
  const i = ref.lastIndexOf(':');
  const typeKey = ref.slice(0, i);
  const id = Number(ref.slice(i + 1));
  const type = store.data?.meta.recordTypes.find(t => t.key === typeKey);
  const rec = type ? (store.data[typeKey] || []).find(r => r.id === id) : null;
  return rec ? { type, rec, typeKey, id } : null;
}
