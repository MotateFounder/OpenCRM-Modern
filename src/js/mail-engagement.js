// Mail view → 📊 Engagement: hot leads, people to follow up, bounced / unsubscribed, results per template.
import { h, replace } from './dom.js';
import { store } from './store.js';
import { recordTitle, emailFieldsOf, recordEmails } from './shared.js';
import { mail, relTime } from './mail-state.js';
import { openRecord } from './actions.js';
import { hooks } from './hooks.js';
import { INTENTS } from './mail-rules.js';

const DAY = 864e5;

function allRefs() {
  const out = [];
  for (const t of store.data.meta.recordTypes) {
    if (!emailFieldsOf(t).length) continue;
    for (const r of store.data[t.key] || []) out.push({ ref: `${t.key}:${r.id}`, type: t, rec: r, s: mail.stats[`${t.key}:${r.id}`] || null });
  }
  return out;
}

export function engagementLists(now = Date.now()) {
  const rows = allRefs();
  const hot = rows.filter(x => x.s && !x.rec.doNotEmail && (
    (x.s.interest && now - x.s.interest.ts < 30 * DAY)
    || (x.s.intent && ['interested', 'meeting', 'question'].includes(x.s.intent.intent) && now - Date.parse(x.s.intent.date) < 30 * DAY)
    || (x.s.lastClicked && now - x.s.lastClicked < 14 * DAY)
    || (x.s.engagement >= 40)))
    .sort((a, b) => (b.s.engagement || 0) - (a.s.engagement || 0));
  const follow = rows.filter(x => {
    const s = x.s;
    if (!s?.lastOut || x.rec.doNotEmail || x.rec.emailInvalid) return false;
    const out = Date.parse(s.lastOut), inn = s.lastIn ? Date.parse(s.lastIn) : 0;
    return inn < out && now - out > 3 * DAY && now - out < 60 * DAY;
  }).sort((a, b) => Date.parse(a.s.lastOut) - Date.parse(b.s.lastOut));
  const problems = rows.filter(x => x.rec.emailInvalid || x.rec.doNotEmail);
  return { hot, follow, problems };
}

function personRow(x, extra) {
  return h('div', { class: 'eng-row', onclick: () => openRecord(x.rec.id, x.type.key) },
    h('div', { class: 'eng-main' },
      h('b', {}, recordTitle(x.type, x.rec)), h('span', { class: 'muted small' }, ` ${recordEmails(x.type, x.rec)[0] || ''}`),
      h('div', { class: 'small' }, extra)),
    x.s?.engagement != null ? h('span', { class: 'engage' }, h('span', { class: 'engage-bar' }, h('span', { style: { width: `${x.s.engagement}%`, background: x.s.engagement >= 60 ? '#34a853' : x.s.engagement >= 25 ? '#fbbc04' : '#9aa0a6' } })), ` ${x.s.engagement}`) : null);
}

const intentLabel = code => (INTENTS.find(i => i[0] === code) || [, code])[1];

export async function renderEngagement(listEl, readerEl) {
  const { hot, follow, problems } = engagementLists();
  const bulk = list => {
    const byType = new Map();
    for (const x of list) { if (!byType.has(x.type.key)) byType.set(x.type.key, []); byType.get(x.type.key).push(x.rec.id); }
    for (const [typeKey, ids] of byType) hooks.bulkEmail?.(typeKey, ids);
  };
  replace(listEl,
    h('div', { class: 'eng-section' },
      h('div', { class: 'eng-head' }, h('b', {}, `🔥 Hot leads (${hot.length})`)),
      hot.length ? hot.slice(0, 50).map(x => personRow(x, [
        x.s.interest ? `👍 “${x.s.interest.label}” ${relTime(new Date(x.s.interest.ts).toISOString())}` : '',
        x.s.intent ? `✨ ${intentLabel(x.s.intent.intent)}${x.s.intent.summary ? `: ${x.s.intent.summary}` : ''}` : '',
        x.s.lastClicked ? `🔗 clicked ${relTime(new Date(x.s.lastClicked).toISOString())}` : '',
      ].filter(Boolean).join(' · '))) : h('p', { class: 'muted small pad' }, 'Nobody yet. Interest buttons, clicks and interested replies show up here.')),
    h('div', { class: 'eng-section' },
      h('div', { class: 'eng-head' }, h('b', {}, `⏳ Waiting for a reply > 3 days (${follow.length})`), h('span', { class: 'spacer' }),
        follow.length ? h('button', { class: 'btn btn-sm', title: 'Send a follow-up to all of them', onclick: () => bulk(follow) }, '✉ Follow up all…') : null),
      follow.length ? follow.slice(0, 80).map(x => personRow(x, `Last email ${relTime(x.s.lastOut)}${x.s.lastOpened ? ` · opened ${relTime(new Date(x.s.lastOpened).toISOString())}` : ' · not opened'}`))
        : h('p', { class: 'muted small pad' }, 'Nobody is waiting for a follow-up.')),
    problems.length ? h('div', { class: 'eng-section' },
      h('div', { class: 'eng-head' }, h('b', {}, `⚠ Bounced / unsubscribed (${problems.length})`)),
      problems.map(x => personRow(x, x.rec.emailInvalid ? '⚠ the address bounced: check it' : '⊘ asked not to be emailed'))) : null);

  let report;
  try { report = await window.crm.mail.tracker({ action: 'report' }); } catch { report = { templates: {} }; }
  const tpls = Object.values(report.templates || {}).sort((a, b) => b.last - a.last);
  const name = id => (store.data.meta.emailTemplates || []).find(t => t.id === id)?.name || (id === '_none' ? 'Without template' : 'Deleted template');
  const pct = (n, d) => (d ? `${Math.round((n / d) * 100)}%` : '—');
  replace(readerEl,
    h('div', { class: 'eng-report' },
      h('h2', {}, '📊 Results of tracked emails'),
      tpls.length ? h('table', { class: 'grid-table eng-table' },
        h('thead', {}, h('tr', {}, h('th', {}, 'Template'), h('th', {}, 'Sent'), h('th', {}, 'Opened'), h('th', {}, 'Clicked'), h('th', {}, 'Interest'), h('th', {}, 'Replied'), h('th', {}, 'Bounced'), h('th', {}, 'Unsub.'))),
        h('tbody', {}, tpls.map(g => h('tr', {},
          h('td', {}, name(g.id)), h('td', {}, String(g.sent)), h('td', {}, pct(g.opened, g.sent)), h('td', {}, pct(g.clicked, g.sent)),
          h('td', {}, pct(g.interest, g.sent)), h('td', {}, pct(g.replied, g.sent)), h('td', {}, g.bounced ? String(g.bounced) : ''), h('td', {}, g.unsub ? String(g.unsub) : '')))))
        : h('p', { class: 'muted' }, mail.accounts.length ? 'No tracked emails yet. Set up tracking in Settings → Email → Open & click tracking.' : ''),
      h('p', { class: 'muted small' }, 'Opens are approximate (Apple Mail opens everything automatically, many apps block pictures). Clicks, interest buttons and replies are reliable.'),
      h('button', { class: 'btn btn-sm', onclick: () => hooks.openTrackingSettings?.() }, 'Tracking settings…')));
}
