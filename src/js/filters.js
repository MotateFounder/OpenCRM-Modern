// Filter chips bar (colours, reminders, dropdown fields, any field) + bulk action bar.
import { h } from './dom.js';
import { store, currentType, emit, records, mutate, findRecord, touch } from './store.js';
import { filteredRecords, colorOf, fieldFilterMatch } from './viewmodel.js';
import { reminderState, getFieldDef, distinctValues, normalizeTags } from './shared.js';
import { popover, menu, promptDialog, closePopover } from './ui.js';
import { optionPill, relationName } from './editors.js';
import { setColor, deleteRecords } from './actions.js';
import { hooks } from './hooks.js';

const COLOR_CHIPS = [
  { key: 'red', label: 'Red' }, { key: 'orange', label: 'Orange' }, { key: 'green', label: 'Green' }, { key: 'none', label: 'None' },
];

function toggleIn(arr, v) { const i = arr.indexOf(v); if (i >= 0) arr.splice(i, 1); else arr.push(v); }

export function renderFilterBar(container) {
  const type = currentType();
  const f = store.ui.filters;
  const changed = () => emit('view-changed');

  // colour counts ignoring the colour filter itself
  const baseColors = filteredRecords({ skip: 'colors' });
  const cc = { red: 0, orange: 0, green: 0, none: 0 };
  for (const r of baseColors) cc[colorOf(r) || 'none']++;

  const baseDue = filteredRecords({ skip: 'due' });
  let overdue = 0, today = 0;
  for (const r of baseDue) { const s = reminderState(r); if (s === 'overdue') overdue++; if (s === 'today') today++; }

  const chips = [
    ...COLOR_CHIPS.map(c => h('button', {
      class: ['chip-btn', `cchip-${c.key}`, f.colors.includes(c.key) && 'on'], title: `Show ${c.label.toLowerCase()} records (wildcards #${c.key})`,
      onclick: () => { toggleIn(f.colors, c.key); changed(); },
    }, h('span', { class: 'cdot' }), `${c.label} `, h('b', {}, String(cc[c.key])))),
  ];
  if (overdue || today || f.due.length) {
    chips.push(h('span', { class: 'chip-sep' }));
    chips.push(h('button', { class: ['chip-btn', 'due-chip', f.due.includes('overdue') && 'on'], onclick: () => { toggleIn(f.due, 'overdue'); changed(); } }, '⏰ Overdue ', h('b', {}, String(overdue))));
    chips.push(h('button', { class: ['chip-btn', 'due-chip', f.due.includes('today') && 'on'], onclick: () => { toggleIn(f.due, 'today'); changed(); } }, 'Due today ', h('b', {}, String(today + overdue))));
  }

  // automatic dropdown filters for select/multiselect fields + any user-added filter
  const autoKeys = type.fieldDefs.filter(d => (d.type === 'select' || d.type === 'multiselect') && d.showInFilters !== false).map(d => d.key);
  const keys = [...new Set([...autoKeys, ...Object.keys(f.fields)])];
  if (keys.length) chips.push(h('span', { class: 'chip-sep' }));
  for (const key of keys) {
    const def = getFieldDef(type, key);
    if (!def) { delete f.fields[key]; continue; }
    const active = f.fields[key] || [];
    chips.push(h('button', {
      class: ['chip-btn', 'field-chip', active.length && 'on'],
      onclick: (e) => fieldFilterPopover(e.currentTarget, type, def),
    }, `${def.label}${active.length ? `: ${active.length === 1 ? (active[0] || 'empty') : active.length}` : ''} ▾`));
  }
  chips.push(h('button', { class: 'chip-btn add-filter', title: 'Filter by any field', onclick: (e) => {
    const candidates = type.fieldDefs.filter(d => !['markdown', 'image', 'file', 'longtext'].includes(d.type) && !keys.includes(d.key));
    menu(e.currentTarget, candidates.length ? candidates.map(d => ({ label: d.label, fn: () => { f.fields[d.key] = []; changed(); setTimeout(() => { const btn = [...container.querySelectorAll('.field-chip')].find(b => b.textContent.startsWith(d.label)); if (btn) fieldFilterPopover(btn, type, d); }, 30); } })) : [{ label: 'No more fields', disabled: true }]);
  } }, '+ Filter'));

  const total = records(type.key).length;
  const shown = filteredRecords().length;
  const anyActive = f.colors.length || f.due.length || Object.values(f.fields).some(v => v.length) || store.ui.query;
  container.replaceChildren(
    h('div', { class: 'chips-scroll' }, chips),
    h('div', { class: 'filter-right' },
      anyActive ? h('button', { class: 'btn-link small', onclick: () => { store.ui.filters = { colors: [], due: [], fields: {} }; store.ui.query = ''; emit('query-reset'); changed(); } }, 'Clear filters') : null,
      h('span', { class: 'counter', title: 'Shown / total' }, shown === total ? `${total} ${total === 1 ? type.singular?.toLowerCase() || 'record' : type.label.toLowerCase()}` : `${shown} of ${total}`)),
  );
}

function fieldFilterPopover(anchor, type, def) {
  const f = store.ui.filters;
  const chosen = new Set(f.fields[def.key] || []);
  const base = filteredRecords({ skip: `field:${def.key}` });
  let values;
  if (def.type === 'select' || def.type === 'multiselect') {
    const used = distinctValues({ [type.key]: base }, type.key, def.key);
    const usedMap = new Map(used.map(u => [u.value, u.count]));
    values = (def.options || []).map(o => ({ value: o.value, count: usedMap.get(o.value) || 0 }));
    for (const u of used) if (!values.some(v => v.value === u.value)) values.push(u);
  } else if (def.type === 'relation') {
    const counts = new Map();
    for (const r of base) for (const l of r[def.key] || []) counts.set(String(l.id), (counts.get(String(l.id)) || 0) + 1);
    values = [...counts].map(([id, count]) => ({ value: id, label: relationName(def, +id), count }));
  } else if (def.type === 'checkbox') {
    values = [{ value: 'true', label: 'Yes', count: base.filter(r => r[def.key]).length }];
  } else {
    values = distinctValues({ [type.key]: base }, type.key, def.key).slice(0, 200);
  }
  const emptyCount = base.filter(r => fieldFilterMatch(type, r, def.key, [''])).length;
  const apply = () => { f.fields[def.key] = [...chosen]; emit('view-changed'); };
  const search = h('input', { class: 'input input-sm', placeholder: 'Search values…' });
  const list = h('div', { class: 'check-list' });
  const renderList = () => {
    const q = search.value.toLowerCase();
    list.replaceChildren(
      ...values.filter(v => String(v.label ?? v.value).toLowerCase().includes(q)).map(v => h('label', { class: 'check-row' },
        h('input', { type: 'checkbox', checked: chosen.has(v.value), onchange: e => { e.target.checked ? chosen.add(v.value) : chosen.delete(v.value); apply(); } }),
        def.type === 'select' || def.type === 'multiselect' ? optionPill(def, v.value, { orphanMark: false }) : h('span', {}, v.label ?? v.value),
        h('span', { class: 'muted small count' }, String(v.count)))),
      h('label', { class: 'check-row' },
        h('input', { type: 'checkbox', checked: chosen.has(''), onchange: e => { e.target.checked ? chosen.add('') : chosen.delete(''); apply(); } }),
        h('i', { class: 'muted' }, '(empty)'), h('span', { class: 'muted small count' }, String(emptyCount))));
  };
  search.addEventListener('input', renderList);
  renderList();
  popover(anchor, h('div', { class: 'filter-pop' },
    values.length > 8 ? search : null, list,
    h('div', { class: 'filter-pop-actions' },
      h('button', { class: 'btn-link small', onclick: () => { chosen.clear(); apply(); renderList(); } }, 'Clear'),
      h('button', { class: 'btn-link small', onclick: () => { delete f.fields[def.key]; closePopover(); emit('view-changed'); } }, 'Remove filter'))));
}

export function renderBulkBar(container) {
  const type = currentType();
  // drop selections that no longer exist
  for (const id of [...store.ui.selected]) if (!findRecord(type.key, id)) store.ui.selected.delete(id);
  const ids = [...store.ui.selected];
  container.classList.toggle('hidden', !ids.length);
  if (!ids.length) { container.replaceChildren(); return; }
  const setFieldBulk = (anchor) => {
    const defs = type.fieldDefs.filter(d => ['text', 'select', 'multiselect', 'tags', 'checkbox', 'date', 'number', 'url', 'email', 'phone'].includes(d.type) && d.key !== type.titleField);
    menu(anchor, defs.map(d => ({
      label: d.label,
      sub: d.type === 'select' ? [...(d.options || []).map(o => ({ label: o.value, fn: () => bulkSet(d, o.value) })), { label: '— empty —', fn: () => bulkSet(d, '') }]
        : d.type === 'checkbox' ? [{ label: 'Yes', fn: () => bulkSet(d, true) }, { label: 'No', fn: () => bulkSet(d, false) }]
          : undefined,
      fn: async () => {
        const v = await promptDialog(`Set “${d.label}” on ${ids.length} records`, { placeholder: d.type === 'tags' || d.type === 'multiselect' ? 'comma separated (added to existing)' : 'value' });
        if (v === null) return;
        if (d.type === 'tags' || d.type === 'multiselect') bulkSet(d, normalizeTags(v), true);
        else if (d.type === 'number') bulkSet(d, v === '' ? null : Number(v));
        else bulkSet(d, v);
      },
    })));
  };
  const bulkSet = (def, value, addTags = false) => mutate(`Set ${def.label} on ${ids.length}`, () => {
    for (const id of ids) {
      const r = findRecord(type.key, id);
      if (!r) continue;
      r[def.key] = addTags ? normalizeTags([...(r[def.key] || []), ...value]) : structuredClone(value);
      touch(r);
    }
  });
  container.replaceChildren(
    h('span', { class: 'bulk-count' }, `${ids.length} selected`),
    h('button', { class: 'btn btn-sm', onclick: () => hooks.openAI?.(ids) }, '✨ Run AI prompt'),
    hooks.bulkEmail ? h('button', { class: 'btn btn-sm', title: 'Send a personalised email to each selected record', onclick: () => hooks.bulkEmail(type.key, ids) }, '✉ Email…') : null,
    h('button', { class: 'btn btn-sm', onclick: e => setFieldBulk(e.currentTarget) }, 'Set field ▾'),
    h('button', { class: 'btn btn-sm', onclick: e => menu(e.currentTarget, [
      { label: 'Red', icon: '🔴', fn: () => setColor(type.key, ids, 'red') },
      { label: 'Orange', icon: '🟠', fn: () => setColor(type.key, ids, 'orange') },
      { label: 'Green', icon: '🟢', fn: () => setColor(type.key, ids, 'green') },
      { label: 'None', icon: '○', fn: () => setColor(type.key, ids, null) }]) }, 'Colour ▾'),
    h('button', { class: 'btn btn-sm', onclick: e => menu(e.currentTarget, [
      { label: 'JSON (OpenCRM)', fn: () => hooks.exportRecords?.('json', ids) },
      { label: 'CSV (visible columns)', fn: () => hooks.exportRecords?.('csv', ids) },
      { label: 'CSV (all fields)', fn: () => hooks.exportRecords?.('csv-all', ids) },
      type.key === 'contacts' ? { label: 'vCard (.vcf)', fn: () => hooks.exportRecords?.('vcf', ids) } : null].filter(Boolean)) }, 'Export ▾'),
    h('button', { class: 'btn btn-sm btn-danger-soft', onclick: () => deleteRecords(type.key, ids) }, 'Delete'),
    h('button', { class: 'btn-link small', onclick: () => { store.ui.selected.clear(); emit('selection-changed'); } }, 'Clear selection'),
  );
}
