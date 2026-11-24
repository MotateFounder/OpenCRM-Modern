// Main table view: sticky header, sortable/resizable/reorderable columns, expandable rows,
// v1 colour logic (#red/#orange/#green rows, teal selection marker), duplicate highlight.
import { h } from './dom.js';
import { store, mutate, currentType, settings, emit, records } from './store.js';
import { getFieldDef, VIRTUAL_COLUMNS, formatDate, lastContactTime, isStale, reminderState, notesForDisplay, stripWildcards, isImportant, FIELD_TYPES } from './shared.js';
import { displayValue } from './editors.js';
import { visibleRecords, colorOf, duplicateTitles } from './viewmodel.js';
import { openRecord, setColor, deleteRecords, duplicateRecord } from './actions.js';
import { popover, contextMenuAt } from './ui.js';
import { markdownPreviewText } from './markdown.js';
import { avatar } from './avatar.js';
import { hooks } from './hooks.js';
import { semanticActive, semanticScore } from './semantic-ui.js';
import { lastContactFor, lastEmailFor, mailStats } from './mail-state.js';

const SCORE_COL = { key: '_score', label: 'Match', type: 'number', virtual: true };

const COLUMN_TYPES_OK = new Set(FIELD_TYPES.filter(t => t.column).map(t => t.type));

export function columnDefs(type) {
  return type.ui.columns.map(k => getFieldDef(type, k)).filter(d => d && (d.virtual || COLUMN_TYPES_OK.has(d.type)));
}

function displayColumns(type) {
  const cols = columnDefs(type);
  if (!semanticActive()) return cols;
  return [cols[0], SCORE_COL, ...cols.slice(1)].filter(Boolean);
}

function cellContent(type, def, rec) {
  const df = settings().dateFormat;
  if (def.key === '_score') {
    const s = semanticScore(rec.id);
    if (!s) return '';
    return h('span', { class: 'score', title: s.why || `Similarity ${s.score}%` }, h('span', { class: 'score-bar', style: { width: `${s.score}%` } }), h('span', { class: 'score-num' }, `${s.score}%`), s.why ? h('span', { class: 'score-why' }, s.why) : null);
  }
  if (def.key === '_lastContact') {
    const t = lastContactFor(type.key, rec);
    if (!t) return '';
    const stale = isStale(rec, settings().staleDays);
    return h('span', { class: stale ? 'stale' : '', title: stale ? `No contact for more than ${settings().staleDays} days` : '' }, formatDate(new Date(t), df), stale ? ' ⏱' : '');
  }
  if (def.key === '_nextAction') {
    if (!rec.reminder?.date || rec.reminder.done) return '';
    const s = reminderState(rec);
    return h('span', { class: `due due-${s}`, title: rec.reminder.text || '' }, (s === 'overdue' || s === 'today') ? '⏰ ' : '', formatDate(rec.reminder.date, df));
  }
  if (def.key === '_noteCount') return String((rec.notes || []).length || '');
  if (def.key === '_lastEmail') { const t = lastEmailFor(type.key, rec); return t ? formatDate(new Date(t), df) : ''; }
  if (def.key === '_lastOpened') { const t = mailStats(type.key, rec.id)?.lastOpened; return t ? formatDate(new Date(t), df) : ''; }
  if (def.key === '_engagement') {
    const s = mailStats(type.key, rec.id);
    if (s?.engagement == null) return '';
    const v = s.engagement;
    return h('span', { class: 'engage', title: [s.interest ? `Interest: ${s.interest.label}` : '', s.clicks ? `${s.clicks} click(s)` : '', s.opens ? `${s.opens} open(s)` : '', s.intent ? `Last reply: ${s.intent.intent}` : ''].filter(Boolean).join(' · ') },
      h('span', { class: 'engage-bar' }, h('span', { style: { width: `${v}%`, background: v >= 60 ? '#34a853' : v >= 25 ? '#fbbc04' : '#9aa0a6' } })), ` ${v}`, s.unsub ? ' ⊘' : '');
  }
  if (def.key === '_emails') {
    const s = mailStats(type.key, rec.id);
    if (!s?.count) return '';
    return h('span', { class: ['mail-count', s.unread && 'unread'], title: s.unread ? `${s.unread} unread` : '' }, `✉ ${s.count}`, s.unread ? h('b', {}, ` · ${s.unread}`) : null);
  }
  if (def.key === '_files') {
    const n = type.fieldDefs.filter(f => f.type === 'file').reduce((a, f) => a + (rec[f.key]?.length || 0), 0) + (rec.files?.length || 0);
    return n ? `📎 ${n}` : '';
  }
  if (def.key === '_updatedAt' || def.key === '_createdAt') {
    const v = rec[def.key.slice(1)];
    return v ? formatDate(new Date(v), df) : '';
  }
  return displayValue(def, rec[def.key], { record: rec, compact: true });
}

function expandedRow(type, rec, colspan) {
  const notes = notesForDisplay(rec).slice(0, 2);
  const md = type.fieldDefs.find(f => f.type === 'markdown' && String(rec[f.key] || '').trim());
  return h('tr', { class: 'expand-row' }, h('td', { colspan },
    h('div', { class: 'expand-inner' },
      type.pictureField ? avatar(type, rec, 64) : null,
      h('div', { class: 'expand-notes' },
        notes.length ? notes.map(n => h('div', { class: ['mini-note', isImportant(n) && 'important'] },
          h('span', { class: 'mini-date' }, `${formatDate(n.date, settings().dateFormat)} ${n.time || ''}`),
          stripWildcards(n.content).slice(0, 220))) : h('span', { class: 'muted' }, 'No notes yet.'),
        md ? h('div', { class: 'mini-md' }, h('b', {}, `${md.label}: `), markdownPreviewText(rec[md.key], 220)) : null),
      h('div', { class: 'expand-actions' },
        h('button', { class: 'btn btn-sm', onclick: () => openRecord(rec.id) }, 'Open'),
        h('button', { class: 'btn btn-sm', onclick: () => { openRecord(rec.id); setTimeout(() => emit('new-note'), 50); } }, '+ Note'),
        h('button', { class: 'btn btn-sm', onclick: () => hooks.openAI?.([rec.id]) }, '✨ AI')))));
}

export function renderTable(container) {
  const type = currentType();
  const cols = displayColumns(type);
  const list = visibleRecords();
  const dups = duplicateTitles(type, records(type.key));
  const sort = type.ui.sort || [];
  const widths = type.ui.columnWidths || {};
  const anySelected = store.ui.selected.size > 0;

  const allChecked = list.length > 0 && list.every(r => store.ui.selected.has(r.id));
  const headCheck = h('input', { type: 'checkbox', checked: allChecked, title: 'Select all visible', onclick: e => e.stopPropagation(), onchange: () => {
    if (allChecked) list.forEach(r => store.ui.selected.delete(r.id)); else list.forEach(r => store.ui.selected.add(r.id));
    emit('selection-changed');
  } });

  const ths = cols.map((def, ci) => {
    if (def.key === '_score') return h('th', { class: 'score-th', title: 'Relevance from AI search (hover a value for the reason)' }, def.label);
    const si = sort.findIndex(s => s.key === def.key);
    const arrow = si >= 0 && !semanticActive() ? (sort[si].dir === 'desc' ? '▼' : '▲') + (sort.length > 1 ? String(si + 1) : '') : '';
    const th = h('th', {
      class: ['sortable', si >= 0 && 'sorted'], draggable: true, dataset: { key: def.key },
      style: widths[def.key] ? { width: `${widths[def.key]}px`, minWidth: `${widths[def.key]}px` } : null,
      title: 'Click: sort · Shift+Click: add secondary sort · Drag: reorder · Right-click: columns',
      onclick: (e) => {
        if (e.target.classList.contains('col-resize')) return;
        mutate('Sort', () => {
          const t = currentType();
          let s = t.ui.sort || [];
          const idx = s.findIndex(x => x.key === def.key);
          if (e.shiftKey) {
            if (idx >= 0) s[idx].dir = s[idx].dir === 'asc' ? 'desc' : 'asc'; else s.push({ key: def.key, dir: 'asc' });
          } else {
            s = [{ key: def.key, dir: idx >= 0 && s[idx].dir === 'asc' && s.length === 1 ? 'desc' : 'asc' }];
          }
          t.ui.sort = s;
        }, { undoable: false });
      },
    }, h('span', { class: 'th-label' }, def.label), arrow ? h('span', { class: 'sort-arrow' }, arrow) : null,
    h('span', { class: 'col-resize', onmousedown: e => startResize(e, th, def.key) }));
    th.addEventListener('dragstart', e => { e.dataTransfer.setData('text/col', String(ci)); th.classList.add('dragging'); });
    th.addEventListener('dragend', () => th.classList.remove('dragging'));
    th.addEventListener('dragover', e => { if (e.dataTransfer.types.includes('text/col')) { e.preventDefault(); th.classList.add('drop-target'); } });
    th.addEventListener('dragleave', () => th.classList.remove('drop-target'));
    th.addEventListener('drop', e => {
      e.preventDefault(); th.classList.remove('drop-target');
      const from = +e.dataTransfer.getData('text/col');
      if (Number.isNaN(from) || from === ci) return;
      mutate('Reorder columns', () => {
        const t = currentType();
        const keys = displayColumns(t).map(d => d.key);
        const [k] = keys.splice(from, 1);
        keys.splice(ci, 0, k);
        const sc = keys.indexOf('_score');
        if (sc >= 0) keys.splice(sc, 1);
        t.ui.columns = keys;
      }, { undoable: false });
    });
    th.addEventListener('contextmenu', e => { e.preventDefault(); columnChooser(e.currentTarget); });
    return th;
  });

  const thead = h('thead', {}, h('tr', {},
    h('th', { class: 'col-select', title: '#' }, h('span', { class: 'hash' }, '#'), headCheck),
    ths,
    h('th', { class: 'col-config' }, h('button', { class: 'icon-btn', title: 'Choose columns', onclick: e => { e.stopPropagation(); columnChooser(e.currentTarget); } }, '⚙'))));

  const colspan = cols.length + 2;
  const tbody = h('tbody', {});
  for (const rec of list) {
    const color = colorOf(rec);
    const isDup = dups.has(String(rec[type.titleField] || '').trim().toLowerCase());
    const expanded = store.ui.expanded.has(rec.id);
    const cb = h('input', { type: 'checkbox', checked: store.ui.selected.has(rec.id), onclick: e => e.stopPropagation(), onchange: e => {
      e.target.checked ? store.ui.selected.add(rec.id) : store.ui.selected.delete(rec.id);
      emit('selection-changed');
    } });
    const tr = h('tr', {
      class: [color && `row-${color}`, rec.id === store.ui.activeId && 'active', store.ui.selected.has(rec.id) && 'checked', isDup && 'duplicate'],
      dataset: { id: rec.id },
    },
    h('td', { class: 'col-select' }, cb),
    cols.map((def, i) => h('td', { class: [`t-${def.type}`, i === 0 && 'first-col'], title: i === 0 && isDup ? 'Duplicate name' : null },
      i === 0 ? h('button', { class: ['chev', expanded && 'open'], title: expanded ? 'Collapse' : 'Expand preview', onclick: e => {
        e.stopPropagation();
        expanded ? store.ui.expanded.delete(rec.id) : store.ui.expanded.add(rec.id);
        emit('view-changed');
      } }, '▸') : null,
      i === 0 && isDup ? h('span', { class: 'dup-flag', title: 'Duplicate name' }, '⚠ ') : null,
      cellContent(type, def, rec))),
    h('td', { class: 'col-config' }));
    tr.addEventListener('click', (e) => {
      if (e.target.closest('a,button,input,select')) return;
      if (e.ctrlKey || e.metaKey) { store.ui.selected.has(rec.id) ? store.ui.selected.delete(rec.id) : store.ui.selected.add(rec.id); emit('selection-changed'); return; }
      openRecord(rec.id);
    });
    tr.addEventListener('contextmenu', (e) => { e.preventDefault(); rowMenu(e.clientX, e.clientY, rec); });
    tbody.appendChild(tr);
    if (expanded) tbody.appendChild(expandedRow(type, rec, colspan));
  }

  const table = h('table', { class: ['crm-table', anySelected && 'selecting'] }, thead, tbody);
  const wrap = h('div', { class: 'table-wrap' }, table,
    !list.length ? h('div', { class: 'empty-state' }, records(type.key).length ? 'No records match the current search/filters.' : `No ${type.label.toLowerCase()} yet. Click “+ New” to add one.`) : null);
  const prevScroll = container.querySelector('.table-wrap')?.scrollTop || 0;
  container.replaceChildren(wrap);
  wrap.scrollTop = prevScroll;
}

function startResize(e, th, key) {
  e.preventDefault(); e.stopPropagation();
  const startX = e.clientX;
  const startW = th.getBoundingClientRect().width;
  let w = startW;
  const move = ev => { w = Math.max(40, startW + ev.clientX - startX); th.style.width = th.style.minWidth = `${w}px`; };
  const up = () => {
    document.removeEventListener('mousemove', move);
    document.removeEventListener('mouseup', up);
    mutate('Resize column', () => { const t = currentType(); (t.ui.columnWidths ||= {})[key] = Math.round(w); }, { undoable: false, silent: true });
  };
  document.addEventListener('mousemove', move);
  document.addEventListener('mouseup', up);
}

export function columnChooser(anchor) {
  const type = currentType();
  const cur = new Set(type.ui.columns);
  const fieldCols = type.fieldDefs.filter(f => COLUMN_TYPES_OK.has(f.type));
  const virt = Object.values(VIRTUAL_COLUMNS);
  const toggle = (key, on) => mutate('Columns', () => {
    const t = currentType();
    if (on && !t.ui.columns.includes(key)) t.ui.columns.push(key);
    if (!on) t.ui.columns = t.ui.columns.filter(k => k !== key);
  }, { undoable: false });
  const row = def => h('label', { class: 'check-row' }, h('input', { type: 'checkbox', checked: cur.has(def.key), onchange: e => toggle(def.key, e.target.checked) }), ` ${def.label}`, def.virtual ? h('span', { class: 'muted tiny' }, ' (computed)') : null);
  popover(anchor, h('div', { class: 'col-chooser' },
    h('div', { class: 'menu-header' }, 'Fields'), fieldCols.map(row),
    h('div', { class: 'menu-header' }, 'Computed'), virt.map(row),
    h('div', { class: 'menu-sep' }),
    h('div', { class: 'muted tiny pad' }, 'Drag column headers to reorder. Markdown fields are shown in the card only.'),
    h('button', { class: 'btn-link', onclick: () => mutate('Reset columns', () => {
      const t = currentType();
      t.ui.columns = t.key === 'contacts' ? ['fullName', 'contactGroup', 'contactLocation', 'urlLink', 'emailAddress', 'phoneNumber', 'labels', '_lastContact'] : [t.titleField, 'labels', '_lastContact'];
      t.ui.columnWidths = {};
    }, { undoable: false }) }, 'Reset to default columns')), { align: 'right' });
}

export function rowMenu(x, y, rec) {
  const type = currentType();
  const ids = store.ui.selected.has(rec.id) && store.ui.selected.size > 1 ? [...store.ui.selected] : [rec.id];
  contextMenuAt(x, y, [
    ids.length > 1 ? { header: `${ids.length} selected` } : null,
    { label: 'Open', icon: '↗', fn: () => openRecord(rec.id) },
    { label: 'Add note', icon: '📝', fn: () => { openRecord(rec.id); setTimeout(() => emit('new-note'), 50); } },
    { label: 'Ask AI…', icon: '✨', fn: () => hooks.openAI?.(ids) },
    { label: 'Set colour', icon: '●', sub: [
      { label: 'Red', icon: '🔴', fn: () => setColor(type.key, ids, 'red') },
      { label: 'Orange', icon: '🟠', fn: () => setColor(type.key, ids, 'orange') },
      { label: 'Green', icon: '🟢', fn: () => setColor(type.key, ids, 'green') },
      { label: 'None', icon: '○', fn: () => setColor(type.key, ids, null) },
    ] },
    ids.length === 1 ? { label: 'Duplicate', icon: '⧉', fn: () => { const c = duplicateRecord(type.key, rec.id); if (c) openRecord(c.id); } } : null,
    'sep',
    { label: ids.length > 1 ? `Delete ${ids.length}` : 'Delete', icon: '🗑', danger: true, fn: () => deleteRecords(type.key, ids) },
  ].filter(Boolean));
}
