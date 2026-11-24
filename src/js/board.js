// Kanban board grouped by ANY dropdown (select) field of the current record type.
import { h } from './dom.js';
import { store, currentType, emit, settings } from './store.js';
import { formatDate, lastContactTime, reminderState, recordTitle } from './shared.js';
import { visibleRecords, colorOf } from './viewmodel.js';
import { openRecord, setField } from './actions.js';
import { avatar } from './avatar.js';
import { addFieldDialog } from './fields-ui.js';
import { rowMenu } from './table.js';

export function boardFieldFor(type) {
  const selects = type.fieldDefs.filter(f => f.type === 'select');
  let key = store.ui.boardField[type.key];
  if (!selects.some(f => f.key === key)) key = selects[0]?.key || null;
  store.ui.boardField[type.key] = key;
  return selects.find(f => f.key === key) || null;
}

export function renderBoard(container) {
  const type = currentType();
  const selects = type.fieldDefs.filter(f => f.type === 'select');
  const def = boardFieldFor(type);
  if (!def) {
    container.replaceChildren(h('div', { class: 'empty-state' },
      h('p', {}, `The board groups ${type.label.toLowerCase()} by a dropdown field (e.g. Stage, Status, Priority).`),
      h('p', { class: 'muted' }, `${type.label} has no dropdown field yet.`),
      h('button', { class: 'btn btn-primary', onclick: () => addFieldDialog({ type, presetType: 'select', onDone: () => emit('view-changed') }) }, '+ Create a dropdown field')));
    return;
  }
  const list = visibleRecords();
  const groups = new Map(def.options.map(o => [o.value, []]));
  const orphans = new Map();
  const empty = [];
  for (const r of list) {
    const v = r[def.key];
    if (v == null || v === '') empty.push(r);
    else if (groups.has(v)) groups.get(v).push(r);
    else { if (!orphans.has(v)) orphans.set(v, []); orphans.get(v).push(r); }
  }
  const columns = [
    { value: '', label: 'No value', color: '#bdbdbd', items: empty },
    ...def.options.map(o => ({ value: o.value, label: o.value, color: o.color, items: groups.get(o.value) })),
    ...[...orphans].map(([v, items]) => ({ value: v, label: `${v} ⚠`, color: '#bdbdbd', items, orphan: true })),
  ];

  const header = h('div', { class: 'board-head' },
    h('label', { class: 'muted small' }, 'Group by '),
    h('select', { class: 'input input-sm', onchange: e => { store.ui.boardField[type.key] = e.target.value; emit('view-changed'); } },
      selects.map(f => h('option', { value: f.key, selected: f.key === def.key }, f.label))),
    h('span', { class: 'muted small' }, ' · drag cards between columns to change the value'));

  const board = h('div', { class: 'board' }, columns.filter(c => c.items.length || !c.orphan).map(col => {
    const body = h('div', { class: 'board-col-body' }, col.items.map(r => card(type, def, r)));
    const colEl = h('div', { class: 'board-col', dataset: { value: col.value } },
      h('div', { class: 'board-col-head', style: { '--pill': col.color } }, h('span', { class: 'dot' }), h('span', { class: 'bc-label' }, col.label), h('span', { class: 'bc-count' }, String(col.items.length))),
      body);
    colEl.addEventListener('dragover', e => { if (e.dataTransfer.types.includes('text/rec')) { e.preventDefault(); colEl.classList.add('drop'); } });
    colEl.addEventListener('dragleave', e => { if (!colEl.contains(e.relatedTarget)) colEl.classList.remove('drop'); });
    colEl.addEventListener('drop', e => {
      e.preventDefault(); colEl.classList.remove('drop');
      const id = +e.dataTransfer.getData('text/rec');
      if (!id) return;
      setField(type.key, id, def.key, col.value);
    });
    return colEl;
  }));
  const prev = container.querySelector('.board')?.scrollLeft || 0;
  container.replaceChildren(h('div', { class: 'board-wrap' }, header, board));
  board.scrollLeft = prev;
}

function card(type, def, r) {
  const color = colorOf(r);
  const lc = lastContactTime(r);
  const due = reminderState(r);
  const labels = Array.isArray(r.labels) ? r.labels.slice(0, 3) : [];
  const el = h('div', {
    class: ['bcard', color && `bcard-${color}`, r.id === store.ui.activeId && 'active'], draggable: true,
    onclick: () => openRecord(r.id),
  },
  h('div', { class: 'bcard-top' }, type.pictureField ? avatar(type, r, 28) : null, h('span', { class: 'bcard-title' }, recordTitle(type, r))),
  type.key === 'contacts' && r.contactGroup ? h('div', { class: 'bcard-sub muted small' }, r.contactGroup, r.contactLocation ? ` · ${r.contactLocation}` : '') : null,
  labels.length ? h('div', { class: 'chips' }, labels.map(l => h('span', { class: 'chip chip-sm' }, l))) : null,
  h('div', { class: 'bcard-foot muted small' },
    lc ? formatDate(new Date(lc), settings().dateFormat) : '',
    due === 'overdue' || due === 'today' ? h('span', { class: 'due due-overdue' }, ' ⏰') : null));
  el.addEventListener('dragstart', e => { e.dataTransfer.setData('text/rec', String(r.id)); el.classList.add('dragging'); });
  el.addEventListener('dragend', () => el.classList.remove('dragging'));
  el.addEventListener('contextmenu', e => { e.preventDefault(); rowMenu(e.clientX, e.clientY, r); });
  return el;
}
