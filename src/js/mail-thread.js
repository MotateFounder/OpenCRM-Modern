// Conversation reader: messages of a thread, safe bodies, images opt-in, attachments, reply/forward,
// linked records and "create contact / link to" for unknown senders.
import { h, replace } from './dom.js';
import { store, mutate, findRecord, touch } from './store.js';
import { recordTitle, getType, formatAddressList, emailFieldsOf, normEmail, humanSize, isDangerousFile, recordEmails } from './shared.js';
import { mailFrame, avatarDot } from './mail-render.js';
import { relTime, recordForRef, mail } from './mail-state.js';
import { openRecord, createRecord } from './actions.js';
import { menu, toast, confirmDialog, popover } from './ui.js';
import { hooks } from './hooks.js';

const expandedKeys = new Set();
let activeMessage = null;
/** The newest message of the open conversation (for keyboard shortcuts). */
export function getActiveMessage() { return activeMessage?.el?.isConnected ? activeMessage.full : null; }
const imagesAllowed = new Set();

function senderAllowed(addr) {
  const list = store.data?.meta?.settings?.mail?.allowImagesFrom || [];
  return store.data?.meta?.settings?.mail?.images === 'always' || list.includes(normEmail(addr));
}

/** Renders a thread into container. opts: { threadId, ref (limit to a record) , compact } */
export async function renderThread(container, { threadId, compact = false } = {}) {
  replace(container, h('div', { class: 'muted pad' }, 'Loading…'));
  let msgs;
  try { msgs = (await window.crm.mail.list({ threadId, limit: 500 })).messages; } catch (e) { replace(container, h('p', { class: 'err pad' }, e.message)); return; }
  msgs.sort((a, b) => new Date(a.date) - new Date(b.date));
  if (!msgs.length) { replace(container, h('div', { class: 'empty-state' }, 'This conversation is no longer available.')); return; }
  const last = msgs[msgs.length - 1];
  const subject = msgs.find(m => m.subject)?.subject || '(no subject)';
  const refs = [...new Set(msgs.flatMap(m => m.refs || []))];
  const head = h('div', { class: 'thread-head' },
    h('h2', { class: 'thread-subject' }, subject),
    h('div', { class: 'thread-refs' }, refs.map(r => refChip(r))));
  const list = h('div', { class: 'thread-msgs' });
  replace(container, head, list);
  for (const m of msgs) {
    const open = m.key === last.key || expandedKeys.has(m.key) || (!m.seen && m.direction === 'in');
    list.appendChild(messageCard(m, open, { compact, isLast: m.key === last.key, rerender: () => renderThread(container, { threadId, compact }) }));
  }
}

export function refChip(ref) {
  const r = recordForRef(ref);
  if (!r) return null;
  return h('button', { class: 'chip chip-btn-sm ref-chip', title: `Open ${r.type.singular}`, onclick: () => openRecord(r.id, r.typeKey) }, `${r.type.singular === 'Contact' ? '👤' : '🏷'} ${recordTitle(r.type, r.rec)}`);
}

function messageCard(m, open, ctx) {
  const card = h('div', { class: ['mail-msg', open && 'open', m.direction === 'out' && 'out', !m.seen && m.direction === 'in' && 'unread'] });
  const from = m.from?.[0] || {};
  const header = h('div', { class: 'mail-msg-head', onclick: () => {
    if (card.classList.contains('open')) { expandedKeys.delete(m.key); card.classList.remove('open'); card.querySelector('.mail-msg-body')?.remove(); }
    else { expandedKeys.add(m.key); card.classList.add('open'); loadBody(); }
  } },
  avatarDot(from.name, from.address),
  h('div', { class: 'mail-msg-who' },
    h('div', {}, h('b', {}, from.name || from.address || '(unknown)'), from.name ? h('span', { class: 'muted small' }, ` <${from.address}>`) : null),
    h('div', { class: 'muted small mail-to' }, open ? `to ${formatAddressList(m.to)}${m.cc?.length ? `, cc ${formatAddressList(m.cc)}` : ''}` : (m.snippet || ''))),
  h('span', { class: 'spacer' }),
  m.attachments?.length ? h('span', { class: 'muted', title: `${m.attachments.length} attachment(s)` }, '📎') : null,
  m.trackingState ? trackingBadge(m) : null,
  m.intent ? h('span', { class: ['intent-badge', `in-${m.intent.intent}`], title: [m.intent.summary, m.intent.nextStep && `Next step: ${m.intent.nextStep}`].filter(Boolean).join(' · ') }, `✨ ${m.intent.intent.replace(/_/g, ' ')}`) : null,
  h('span', { class: 'muted small nowrap', title: new Date(m.date).toLocaleString() }, relTime(m.date)));
  card.appendChild(header);
  const loadBody = async () => {
    const holder = h('div', { class: 'mail-msg-body' }, h('div', { class: 'muted pad small' }, 'Loading…'));
    card.appendChild(holder);
    let full;
    try { full = (await window.crm.mail.get(m.key)).message; } catch (e) { replace(holder, h('p', { class: 'err pad' }, e.message)); return; }
    if (!m.seen && m.direction === 'in') { window.crm.mail.markRead({ key: m.key, read: true }).catch(() => {}); card.classList.remove('unread'); }
    if (ctx.isLast) activeMessage = { full, el: card };
    const allow = imagesAllowed.has(m.key) || senderAllowed(from.address);
    const parts = [];
    if (full.body?.remoteImages && !allow) {
      parts.push(h('div', { class: 'img-banner' }, '🛡 Pictures from the internet are hidden to protect your privacy (they can tell the sender you opened the email).',
        h('button', { class: 'btn-link small', onclick: () => { imagesAllowed.add(m.key); holder.remove(); loadBody(); } }, 'Show pictures'),
        h('button', { class: 'btn-link small', onclick: () => {
          mutate('Allow pictures from sender', d => { const s = d.meta.settings.mail; s.allowImagesFrom = [...new Set([...(s.allowImagesFrom || []), normEmail(from.address)])]; }, { undoable: false });
          holder.remove(); loadBody();
        } }, `Always from ${from.address}`)));
    }
    parts.push(mailFrame(full.body, { allowImages: allow }));
    if (full.attachments?.length) parts.push(h('div', { class: 'mail-atts' }, full.attachments.map(a => attachmentChip(m, a))));
    if (m.direction === 'in' && !(m.refs || []).length && !m.autoSubmitted) parts.push(unknownSenderBar(m));
    parts.push(h('div', { class: 'mail-actions' },
      h('button', { class: 'btn btn-sm', onclick: () => hooks.compose?.({ mode: 'reply', message: full }) }, '↩ Reply'),
      (m.to?.length + (m.cc?.length || 0)) > 1 ? h('button', { class: 'btn btn-sm', onclick: () => hooks.compose?.({ mode: 'replyAll', message: full }) }, '↩↩ Reply all') : null,
      h('button', { class: 'btn btn-sm', onclick: () => hooks.compose?.({ mode: 'forward', message: full }) }, '↪ Forward'),
      h('span', { class: 'spacer' }),
      hooks.mailAI ? h('button', { class: 'btn btn-sm', title: 'Summarise this conversation with your local AI', onclick: () => hooks.mailAI({ action: 'summarize', message: full }) }, '✨ Summarise') : null,
      h('button', { class: 'btn btn-sm', title: 'More', onclick: e => menu(e.currentTarget, [
        { label: m.seen ? 'Mark as unread' : 'Mark as read', icon: '●', fn: () => window.crm.mail.markRead({ key: m.key, read: !m.seen }) },
        { label: 'Save as note on the linked record', icon: '📝', disabled: !(m.refs || []).length, fn: () => saveAsNote(full) },
        { label: 'Link to a record…', icon: '🔗', fn: () => linkToRecordPicker(e.target, m) },
      ], { align: 'right' }) }, '⋯')));
    replace(holder, ...parts);
  };
  if (open) loadBody();
  return card;
}

function trackingBadge(m) {
  const t = m.trackingState;
  if (!t) return h('span', { class: 'track-badge', title: 'Tracking on' }, '📊');
  return h('span', { class: ['track-badge', `ts-${t.status}`], title: t.title || '' }, t.label);
}

function attachmentChip(m, a) {
  const open = async (confirmed = false) => {
    try {
      const r = await window.crm.mail.attachment({ key: m.key, index: a.index, action: 'open', confirmed });
      if (r?.dangerous) {
        if (await confirmDialog(`“${a.filename}” is a type of file that can run programs on your computer.`, { title: 'Open this file?', okLabel: 'Open anyway', danger: true, detail: 'Only open it if you trust the sender and were expecting it.' })) open(true);
      }
    } catch (e) { toast(e.message, { type: 'error' }); }
  };
  return h('div', { class: ['att-chip', isDangerousFile(a.filename) && 'danger'] },
    h('button', { class: 'att-open', title: 'Open', onclick: () => open() }, '📄 ', a.filename, h('span', { class: 'muted tiny' }, ` ${humanSize(a.size)}`)),
    h('button', { class: 'icon-btn', title: 'Save / keep', onclick: e => menu(e.currentTarget, [
      { label: 'Save as…', icon: '💾', fn: () => window.crm.mail.attachment({ key: m.key, index: a.index, action: 'save' }).catch(err => toast(err.message, { type: 'error' })) },
      ...(m.refs || []).map(ref => {
        const r = recordForRef(ref);
        return r ? { label: `Keep in ${recordTitle(r.type, r.rec)}'s files`, icon: '📎', fn: () => keepAttachment(m, a, r) } : null;
      }).filter(Boolean),
    ]) }, '▾'));
}

async function keepAttachment(m, a, r) {
  try {
    const res = await window.crm.mail.attachment({ key: m.key, index: a.index, action: 'keep', typeKey: r.typeKey, id: r.id });
    mutate('Keep attachment', () => { const x = findRecord(r.typeKey, r.id); x.files = [...(x.files || []), ...res.refs]; touch(x); });
    toast(`Saved “${a.filename}” to ${recordTitle(r.type, r.rec)}`);
  } catch (e) { toast(e.message, { type: 'error' }); }
}

function saveAsNote(full) {
  for (const ref of full.refs || []) {
    const r = recordForRef(ref);
    if (!r) continue;
    const d = new Date(full.date);
    const pad = n => String(n).padStart(2, '0');
    const MON = ['JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN', 'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC'];
    mutate('Save email as note', () => {
      const x = findRecord(r.typeKey, r.id);
      (x.notes ||= []).push({ id: 'n_' + Math.random().toString(36).slice(2, 10), date: `${d.getFullYear()}/${MON[d.getMonth()]}/${pad(d.getDate())}`, time: `${pad(d.getHours())}:${pad(d.getMinutes())}`, kind: 'Email', content: `${full.direction === 'out' ? '→' : '←'} ${full.subject}\n\n${(full.body?.text || '').slice(0, 4000)}` });
      touch(x);
    });
  }
  toast('Saved as a note');
}

function unknownSenderBar(m) {
  const from = m.from?.[0] || {};
  return h('div', { class: 'unknown-bar' },
    h('span', {}, `${from.address} is not in your CRM.`),
    h('button', { class: 'btn btn-sm btn-primary', onclick: () => createContactFrom(from) }, '+ Create contact'),
    h('button', { class: 'btn btn-sm', onclick: e => linkToRecordPicker(e.currentTarget, m) }, '🔗 Link to existing…'));
}

export function createContactFrom(from) {
  const type = getType(store.data, 'contacts') || store.data.meta.recordTypes.find(t => emailFieldsOf(t).length);
  if (!type) { toast('No record type has an email field.', { type: 'error' }); return; }
  const emailKey = emailFieldsOf(type)[0]?.key;
  const name = from.name || from.address.split('@')[0].replace(/[._-]+/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
  const rec = createRecord(type, { [type.titleField]: name, ...(emailKey ? { [emailKey]: from.address } : {}) });
  openRecord(rec.id, type.key);
  toast(`Created ${name}. Their emails will appear on the card in a moment.`);
}

export function linkToRecordPicker(anchor, m) {
  const from = m.direction === 'out' ? (m.to?.[0] || {}) : (m.from?.[0] || {});
  const types = store.data.meta.recordTypes.filter(t => emailFieldsOf(t).length || t.key === 'contacts');
  const input = h('input', { class: 'input input-sm', placeholder: 'Search a record…', autofocus: true });
  const results = h('div', { class: 'pick-list' });
  const doLink = (t, rec) => {
    mutate('Link email address', () => {
      const x = findRecord(t.key, rec.id);
      const ek = emailFieldsOf(t)[0]?.key;
      if (ek && !String(x[ek] || '').trim()) x[ek] = from.address;
      else if (!recordEmails(t, x).includes(normEmail(from.address))) x.extraEmails = [...(x.extraEmails || []), from.address];
      touch(x);
    });
    toast(`${from.address} linked to ${recordTitle(t, rec)}`);
    document.querySelector('.popover')?.remove();
  };
  const update = () => {
    const q = input.value.trim().toLowerCase();
    const items = [];
    for (const t of types) for (const r of store.data[t.key] || []) {
      if (q && !recordTitle(t, r).toLowerCase().includes(q)) continue;
      items.push({ t, r });
      if (items.length >= 30) break;
    }
    replace(results, ...items.map(({ t, r }) => h('div', { class: 'menu-item', onclick: () => doLink(t, r) }, h('span', { class: 'mi-label' }, recordTitle(t, r)), h('span', { class: 'mi-hint' }, t.singular))));
  };
  input.addEventListener('input', update);
  update();
  popover(anchor, h('div', { class: 'link-picker' }, h('div', { class: 'muted small pad' }, `Link ${from.address} to:`), input, results));
  setTimeout(() => input.focus(), 0);
}

export { mail };
