// Mail view: all conversations (threads) across records, filters, search, reader pane.
import { h, replace, debounce } from './dom.js';
import { store } from './store.js';
import { recordTitle } from './shared.js';
import { mail, accountStatus, relTime, recordForRef } from './mail-state.js';
import { renderThread, refChip } from './mail-thread.js';
import { avatarDot } from './mail-render.js';
import { hooks } from './hooks.js';
import { renderEngagement } from './mail-engagement.js';

export const mailUi = { filter: 'all', q: '', threadId: null, ref: null, lastCount: 0 };

const FILTERS = [['all', 'All'], ['unread', 'Unread'], ['contacts', 'From contacts'], ['unknown', 'Unknown senders'], ['sent', 'Sent'], ['engagement', '📊 Engagement']];

export function showMailFor(ref) {
  mailUi.ref = ref; mailUi.threadId = null; mailUi.filter = 'all';
}

export function renderMailView(container) {
  let root = container.querySelector('.mail-view');
  if (!root) {
    root = h('div', { class: 'mail-view' },
      h('div', { class: 'mail-left' },
        h('div', { class: 'mail-toolbar' },
          h('button', { class: 'btn btn-primary btn-sm', onclick: () => hooks.compose?.({ mode: 'new' }) }, '✉ New email'),
          h('button', { class: 'btn btn-sm', title: 'Drafts', onclick: e => draftsMenu(e.currentTarget) }, 'Drafts'),
          h('input', { class: 'input input-sm mail-search', type: 'search', placeholder: 'Search emails…', value: mailUi.q, oninput: debounce(e => { mailUi.q = e.target.value; refreshList(root); }, 200) }),
          h('button', { class: 'icon-btn', title: 'Check for new mail now', onclick: async e => { e.currentTarget.classList.add('spin'); await window.crm.mail.syncNow().catch(() => {}); refreshList(root); } }, '⟳')),
        h('div', { class: 'mail-filters' }),
        h('div', { class: 'mail-accounts' }),
        h('div', { class: 'mail-list' })),
      h('div', { class: 'mail-reader' }));
    replace(container, root);
  }
  renderFilters(root);
  renderAccounts(root);
  refreshList(root);
}

function renderFilters(root) {
  const f = root.querySelector('.mail-filters');
  const refInfo = mailUi.ref ? recordForRef(mailUi.ref) : null;
  replace(f, 
    h('div', { class: 'seg' }, FILTERS.map(([k, l]) => h('button', { class: ['seg-btn', mailUi.filter === k && 'on'], onclick: () => { mailUi.filter = k; renderFilters(root); refreshList(root); } }, l, k === 'unread' && mail.unread ? h('span', { class: 'badge-inline' }, String(mail.unread)) : null))),
    refInfo ? h('span', { class: 'chip ref-filter' }, `Only ${recordTitle(refInfo.type, refInfo.rec)} `, h('button', { class: 'icon-btn', title: 'Show all', onclick: () => { mailUi.ref = null; renderFilters(root); refreshList(root); } }, '×')) : null);
}

function renderAccounts(root) {
  const el = root.querySelector('.mail-accounts');
  if (!mail.accounts.length) {
    replace(el, h('div', { class: 'mail-setup' },
      h('p', {}, h('b', {}, 'Connect your email'), ' to send and receive mail from your contacts right here.'),
      h('p', { class: 'muted small' }, 'Works with Gmail, Yahoo, iCloud, GMX, Web.de, your own domain and more.'),
      h('button', { class: 'btn btn-primary', onclick: () => hooks.openSettings?.('email') }, 'Set up email')));
    return;
  }
  const bad = mail.accounts.map(a => ({ a, s: accountStatus(a.id) })).filter(x => x.s.state === 'error' || x.s.state === 'offline');
  const out = mail.outbox.filter(o => o.status !== 'sending' && o.status !== 'scheduled');
  replace(el, 
    ...bad.map(({ a, s }) => h('div', { class: ['acct-warn', s.state] }, s.state === 'offline' ? '⚠ ' : '✗ ', h('b', {}, a.email), ': ', s.error || (s.state === 'offline' ? 'offline, retrying…' : 'error'),
      h('button', { class: 'btn-link small', onclick: () => hooks.openSettings?.('email') }, 'Settings'))),
    out.length ? h('div', { class: 'acct-warn offline' }, `📤 ${out.length} email(s) waiting in the outbox`, h('button', { class: 'btn-link small', onclick: () => hooks.openOutbox?.() }, 'View')) : null);
}

async function refreshList(root) {
  const listEl = root.querySelector('.mail-list');
  if (mailUi.filter === 'engagement') { mailUi.threadId = null; mailUi.lastCount = 0; return renderEngagement(listEl, root.querySelector('.mail-reader')); }
  if (!mail.accounts.length && !listEl.childElementCount) { replace(listEl, ); }
  let threads = [];
  try { threads = (await window.crm.mail.threads({ filter: mailUi.filter, q: mailUi.q, ref: mailUi.ref || undefined, limit: 300 })).threads; } catch { threads = []; }
  const self = new Set(mail.accounts.map(a => a.email.toLowerCase()));
  if (!threads.length) {
    replace(listEl, h('div', { class: 'empty-state small' }, mail.accounts.length ? (mailUi.q ? 'No emails match your search.' : 'No emails here yet.') : ''));
  } else {
    replace(listEl, ...threads.map(t => {
      const others = t.participants.filter(p => !self.has(p.address));
      const who = others.length ? others.slice(0, 3).map(p => p.name || p.address).join(', ') : 'me';
      const last = t.last;
      return h('div', { class: ['thread-row', t.unread && 'unread', mailUi.threadId === t.threadId && 'on'], dataset: { thread: t.threadId }, onclick: () => { mailUi.threadId = t.threadId; root.querySelectorAll('.thread-row.on').forEach(x => x.classList.remove('on')); root.querySelector(`.thread-row[data-thread="${t.threadId}"]`)?.classList.add("on"); openReader(root, t.count); } },
        avatarDot(others[0]?.name, others[0]?.address || last.from?.[0]?.address),
        h('div', { class: 'thread-main' },
          h('div', { class: 'thread-line1' }, h('span', { class: 'thread-who' }, last.direction === 'out' ? `To: ${who}` : who), t.count > 1 ? h('span', { class: 'thread-count' }, String(t.count)) : null, h('span', { class: 'spacer' }), t.hasAttachments ? h('span', { class: 'muted' }, '📎') : null, h('span', { class: 'thread-date' }, relTime(t.date))),
          h('div', { class: 'thread-subj' }, t.subject || '(no subject)'),
          h('div', { class: 'thread-snip' }, last.snippet || ''),
          t.refs.length ? h('div', { class: 'thread-refs' }, t.refs.slice(0, 3).map(r => refChip(r))) : null));
    }));
  }
  const cur = threads.find(t => t.threadId === mailUi.threadId);
  const reader = root.querySelector('.mail-reader');
  if (!cur && !mailUi.threadId) replace(reader, h('div', { class: 'empty-state' }, threads.length ? 'Select a conversation' : ''));
  else if (cur && cur.count !== mailUi.lastCount) openReader(root, cur.count);
}

function openReader(root, count) {
  const reader = root.querySelector('.mail-reader');
  mailUi.lastCount = count ?? mailUi.lastCount;
  renderThread(reader, { threadId: mailUi.threadId });
}

export function openOutbox() {
  import('./ui.js').then(({ openModal, toast }) => {
    const body = h('div', {});
    const render = async () => {
      const { outbox } = await window.crm.mail.outbox();
      replace(body, outbox.length ? h('table', { class: 'grid-table' }, h('tbody', {}, outbox.map(o => h('tr', {},
        h('td', {}, h('b', {}, o.subject || '(no subject)'), h('div', { class: 'muted small' }, (Array.isArray(o.to) ? o.to.map(a => a.address || a).join(', ') : o.to) || '')),
        h('td', { class: 'small' }, { scheduled: `Sends ${new Date(o.sendAt).toLocaleString()}`, retry: `Retry ${new Date(o.sendAt).toLocaleTimeString()}`, failed: 'Failed', sending: 'Sending…', paused: 'Paused' }[o.status] || o.status, o.error ? h('div', { class: 'err small' }, o.error) : null),
        h('td', { class: 'nowrap' },
          o.status !== 'sending' ? h('button', { class: 'btn btn-sm', onclick: async () => { await window.crm.mail.retry(o.id); toast('Sending now…'); render(); } }, 'Send now') : null,
          o.status !== 'sending' ? h('button', { class: 'btn btn-sm', onclick: async () => { await window.crm.mail.discard(o.id); render(); } }, 'Discard') : null)))))
        : h('p', { class: 'muted' }, 'The outbox is empty.'));
    };
    render();
    openModal({ title: 'Outbox', size: 'lg', body });
  });
}

export async function draftsMenu(anchor) {
  const { menu } = await import('./ui.js');
  const { drafts } = await window.crm.mail.drafts({});
  menu(anchor, drafts.length ? drafts.slice(0, 20).map(d => ({
    label: d.subject || '(no subject)', hint: new Date(d.savedAt).toLocaleString(), icon: '📝',
    fn: () => hooks.compose?.({ draft: { ...d, draftId: d.id } }),
  })) : [{ label: 'No drafts', disabled: true }]);
}
