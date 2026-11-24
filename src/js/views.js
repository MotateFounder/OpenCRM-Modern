// Saved views (search + filters + sort + columns + mode) and reminders/notifications.
import { h } from './dom.js';
import { store, mutate, currentType, emit, records } from './store.js';
import { newId, getType, reminderState, recordTitle, formatDate } from './shared.js';
import { menu, promptDialog, openModal, confirmDialog, toast } from './ui.js';
import { openRecord } from './actions.js';

export function captureView(name) {
  const t = currentType();
  return {
    id: newId('v'), name, typeKey: t.key, mode: store.ui.mode, query: store.ui.query,
    filters: structuredClone(store.ui.filters), columns: [...t.ui.columns], sort: structuredClone(t.ui.sort || []),
    boardField: store.ui.boardField[t.key] || null, pinned: true,
  };
}

export function applyView(v) {
  const t = getType(store.data, v.typeKey);
  if (!t) { toast('This view’s record type no longer exists', { type: 'error' }); return; }
  store.ui.typeKey = v.typeKey;
  store.ui.mode = v.mode || 'table';
  store.ui.query = v.query || '';
  store.ui.filters = structuredClone(v.filters || { colors: [], due: [], fields: {} });
  store.ui.filters.fields ||= {}; store.ui.filters.colors ||= []; store.ui.filters.due ||= [];
  if (v.boardField) store.ui.boardField[v.typeKey] = v.boardField;
  store.ui.viewId = v.id;
  mutate('Apply view', () => { t.ui.columns = [...v.columns]; t.ui.sort = structuredClone(v.sort || []); }, { undoable: false, silent: true });
  store.ui.activeId = null;
  emit('query-reset');
  emit('type-changed');
}

export function viewsMenu(anchor) {
  const views = store.data.meta.views || [];
  menu(anchor, [
    ...(views.length ? views.map(v => ({ label: `${v.name}`, icon: v.pinned ? '📌' : '', hint: getType(store.data, v.typeKey)?.label || '', checked: store.ui.viewId === v.id, fn: () => applyView(v) })) : [{ label: 'No saved views yet', disabled: true }]),
    'sep',
    { label: 'Save current view…', icon: '💾', fn: saveCurrentView },
    store.ui.viewId ? { label: 'Update current view', icon: '↻', fn: () => {
      const cur = views.find(v => v.id === store.ui.viewId);
      if (!cur) return;
      const nv = { ...captureView(cur.name), id: cur.id, pinned: cur.pinned };
      mutate('Update view', d => { const i = d.meta.views.findIndex(v => v.id === cur.id); d.meta.views[i] = nv; });
      toast(`View “${cur.name}” updated`);
    } } : null,
    views.length ? { label: 'Manage views…', icon: '⚙', fn: manageViews } : null,
  ].filter(Boolean));
}

export async function saveCurrentView() {
  const name = await promptDialog('Save view', { label: 'Name (search, filters, sort, columns and table/board mode are saved)', placeholder: 'e.g. Hot leads this month' });
  if (!name?.trim()) return;
  const v = captureView(name.trim());
  mutate('Save view', d => { (d.meta.views ||= []).push(v); });
  store.ui.viewId = v.id;
  emit('view-changed');
  toast(`View “${v.name}” saved`);
}

function manageViews() {
  const body = h('div', {});
  const render = () => {
    const views = store.data.meta.views || [];
    body.replaceChildren(views.length ? h('table', { class: 'grid-table' },
      h('thead', {}, h('tr', {}, h('th', {}, 'Name'), h('th', {}, 'Type'), h('th', {}, 'Pinned as tab'), h('th', {}, ''))),
      h('tbody', {}, views.map((v, i) => h('tr', {},
        h('td', {}, h('input', { class: 'input input-sm', value: v.name, onchange: e => mutate('Rename view', d => { d.meta.views[i].name = e.target.value.trim() || v.name; }) })),
        h('td', { class: 'muted' }, getType(store.data, v.typeKey)?.label || v.typeKey),
        h('td', { class: 'center' }, h('input', { type: 'checkbox', checked: !!v.pinned, onchange: e => mutate('Pin view', d => { d.meta.views[i].pinned = e.target.checked; }) })),
        h('td', {}, h('button', { class: 'icon-btn danger', onclick: async () => {
          if (!(await confirmDialog(`Delete view “${v.name}”?`, { okLabel: 'Delete', danger: true }))) return;
          mutate('Delete view', d => { d.meta.views.splice(i, 1); });
          if (store.ui.viewId === v.id) store.ui.viewId = null;
          render();
        } }, '🗑')))))) : h('p', { class: 'muted' }, 'No views.'));
  };
  render();
  openModal({ title: 'Saved views', size: 'md', body, actions: [{ label: 'Close', primary: true }] });
}

// ---------- reminders ----------
const notified = new Set();
let timer = null;

export function dueReminders() {
  const out = [];
  for (const t of store.data?.meta.recordTypes || []) {
    for (const r of records(t.key)) {
      const s = reminderState(r);
      if (s === 'overdue' || s === 'today') out.push({ type: t, rec: r, state: s });
    }
  }
  return out.sort((a, b) => String(a.rec.reminder.date).localeCompare(String(b.rec.reminder.date)));
}

export function startReminders() {
  clearInterval(timer);
  let first = true;
  const check = () => {
    if (!store.data) return;
    const due = dueReminders();
    emit('reminders', due);
    const fresh = due.filter(d => !notified.has(`${d.type.key}:${d.rec.id}:${d.rec.reminder.date}`));
    fresh.forEach(d => notified.add(`${d.type.key}:${d.rec.id}:${d.rec.reminder.date}`));
    if (!fresh.length) return;
    if (first && fresh.length > 1) {
      window.crm.app.notify({ title: `OpenCRM · ${fresh.length} reminders due`, body: fresh.slice(0, 4).map(d => `${recordTitle(d.type, d.rec)}: ${d.rec.reminder.text || 'follow up'}`).join('\n') });
    } else {
      for (const d of fresh.slice(0, 5)) {
        window.crm.app.notify({ title: `⏰ ${recordTitle(d.type, d.rec)}`, body: d.rec.reminder.text || `Reminder for ${formatDate(d.rec.reminder.date)}`, ref: { typeKey: d.type.key, id: d.rec.id } });
      }
    }
    first = false;
  };
  setTimeout(check, 2500);
  timer = setInterval(check, 60 * 1000);
}

export function remindersPopover(anchor) {
  const due = dueReminders();
  menu(anchor, due.length ? [
    { header: `${due.length} due` },
    ...due.slice(0, 25).map(d => ({ label: `${recordTitle(d.type, d.rec)} — ${d.rec.reminder.text || 'follow up'}`, icon: d.state === 'overdue' ? '⏰' : '📅', hint: formatDate(d.rec.reminder.date), fn: () => openRecord(d.rec.id, d.type.key) })),
  ] : [{ label: 'No reminders due today 🎉', disabled: true }], { align: 'right' });
}
