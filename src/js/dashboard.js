// Dashboard for the current record type: colours, dropdown breakdowns, reminders, staleness, activity.
import { h } from './dom.js';
import { store, currentType, records, settings, emit } from './store.js';
import { recordTitle, lastContactTime, reminderState, formatDate, noteTime, startOfDay, distinctValues } from './shared.js';
import { colorOf } from './viewmodel.js';
import { openRecord } from './actions.js';

const COLOR_HEX = { red: 'var(--row-red)', orange: 'var(--row-orange)', green: 'var(--row-green)', none: 'var(--muted-bg)' };

function bar(items, total) {
  return h('div', { class: 'hbars' }, items.map(it => h('div', { class: 'hbar-row', title: `${it.label}: ${it.count}`, onclick: it.onclick || null, style: it.onclick ? { cursor: 'pointer' } : null },
    h('span', { class: 'hbar-label' }, it.label),
    h('span', { class: 'hbar-track' }, h('span', { class: 'hbar-fill', style: { width: `${total ? (it.count / total) * 100 : 0}%`, background: it.color || 'var(--accent)' } })),
    h('span', { class: 'hbar-count' }, String(it.count)))));
}

function widget(title, body, extra) {
  return h('section', { class: 'widget' }, h('div', { class: 'widget-head' }, h('h3', {}, title), extra || null), body);
}

function recLink(type, r, right) {
  return h('div', { class: 'wlist-row', onclick: () => openRecord(r.id, type.key) }, h('span', { class: 'wl-title' }, recordTitle(type, r)), h('span', { class: 'muted small' }, right));
}

export function renderDashboard(container) {
  const type = currentType();
  const list = records(type.key);
  const df = settings().dateFormat;
  const total = list.length;
  const now = new Date();
  const filterBy = (setup) => () => { store.ui.filters = { colors: [], due: [], fields: {} }; setup(store.ui.filters); store.ui.mode = 'table'; emit('view-changed'); };

  // KPIs
  const weekAgo = startOfDay(now).getTime() - 6 * 86400000;
  let notesWeek = 0;
  const byDay = new Array(7).fill(0);
  const byKind = new Map();
  for (const r of list) for (const n of r.notes || []) {
    const t = noteTime(n);
    if (t >= weekAgo) {
      notesWeek++;
      byDay[Math.min(6, Math.floor((t - weekAgo) / 86400000))]++;
      const k = n.kind || 'Note';
      byKind.set(k, (byKind.get(k) || 0) + 1);
    }
  }
  const due = list.filter(r => ['overdue', 'today'].includes(reminderState(r)));
  const upcoming = list.filter(r => reminderState(r) === 'week');
  const staleDays = settings().staleDays || 30;
  const stale = list.filter(r => { const t = lastContactTime(r); return t && (now - t) / 86400000 > staleDays; })
    .sort((a, b) => lastContactTime(a) - lastContactTime(b));

  const kpis = h('div', { class: 'kpis' },
    kpi(String(total), type.label),
    kpi(String(notesWeek), 'notes in the last 7 days'),
    kpi(String(due.length), 'reminders due', due.length ? 'warn' : '', filterBy(f => { f.due = ['today']; })),
    kpi(String(stale.length), `not contacted in ${staleDays}+ days`));

  // colours
  const cc = { red: 0, orange: 0, green: 0, none: 0 };
  for (const r of list) cc[colorOf(r) || 'none']++;
  const colors = widget('Priority colours', bar(Object.entries(cc).map(([k, n]) => ({ label: k[0].toUpperCase() + k.slice(1), count: n, color: COLOR_HEX[k], onclick: filterBy(f => { f.colors = [k]; }) })), total));

  // dropdown breakdowns
  const selects = type.fieldDefs.filter(f => f.type === 'select' || f.type === 'multiselect');
  const breakdowns = selects.map(def => {
    const counts = new Map(distinctValues(store.data, type.key, def.key).map(v => [v.value, v.count]));
    const items = (def.options || []).map(o => ({ label: o.value, count: counts.get(o.value) || 0, color: o.color, onclick: filterBy(f => { f.fields[def.key] = [o.value]; }) }));
    const emptyN = list.filter(r => r[def.key] == null || r[def.key] === '' || (Array.isArray(r[def.key]) && !r[def.key].length)).length;
    items.push({ label: '(empty)', count: emptyN, color: 'var(--muted-bg)' });
    return widget(def.label, bar(items, total));
  });

  // activity sparkline
  const max = Math.max(1, ...byDay);
  const days = [...Array(7)].map((_, i) => new Date(weekAgo + i * 86400000));
  const activity = widget('Activity (last 7 days)', h('div', {},
    h('div', { class: 'spark' }, byDay.map((n, i) => h('div', { class: 'spark-col', title: `${formatDate(days[i], df)}: ${n} note(s)` },
      h('div', { class: 'spark-bar', style: { height: `${(n / max) * 100}%` } }), h('div', { class: 'spark-lbl' }, days[i].toLocaleDateString('en', { weekday: 'narrow' }))))),
    byKind.size ? h('div', { class: 'chips' }, [...byKind].map(([k, n]) => h('span', { class: 'chip' }, `${k}: ${n}`))) : null));

  const dueW = widget('Reminders', h('div', { class: 'wlist' },
    due.length || upcoming.length
      ? [...due, ...upcoming].map(r => recLink(type, r, `${reminderState(r) === 'overdue' ? '⏰ ' : ''}${formatDate(r.reminder.date, df)} · ${r.reminder.text || ''}`))
      : h('p', { class: 'muted' }, 'Nothing due in the next 7 days.')));

  const staleW = widget(`Going stale (${staleDays}+ days)`, h('div', { class: 'wlist' },
    stale.length ? stale.slice(0, 12).map(r => recLink(type, r, formatDate(new Date(lastContactTime(r)), df))) : h('p', { class: 'muted' }, 'Everyone has been contacted recently.')));

  const recent = [...list].sort((a, b) => String(b.updatedAt || '').localeCompare(String(a.updatedAt || ''))).slice(0, 10);
  const recentW = widget('Recently edited', h('div', { class: 'wlist' }, recent.map(r => recLink(type, r, r.updatedAt ? formatDate(new Date(r.updatedAt), df) : ''))));

  container.replaceChildren(h('div', { class: 'dashboard' }, kpis, h('div', { class: 'widgets' }, colors, ...breakdowns, activity, dueW, staleW, recentW)));
}

function kpi(value, label, cls = '', onclick) {
  return h('div', { class: ['kpi', cls, onclick && 'clickable'], onclick }, h('div', { class: 'kpi-value' }, value), h('div', { class: 'kpi-label' }, label));
}
