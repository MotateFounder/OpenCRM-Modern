// Field management UI: add field, dropdown options editor, field manager, record types manager.
import { h } from './dom.js';
import { store, mutate, currentType, records } from './store.js';
import { openModal, confirmDialog, toast, field, promptDialog, choiceDialog } from './ui.js';
import {
  FIELD_TYPES, TYPE_LABEL, COLOR_PALETTE, slugKey, getType, makeGenericType,
  renameOption, deleteOption, distinctValues, convertFieldType, deleteField, recordsUsing,
} from './shared.js';

const parseOptions = (text) => {
  const seen = new Set();
  return String(text || '').split('\n').map(s => s.trim()).filter(s => s && !seen.has(s) && seen.add(s))
    .map((v, i) => ({ value: v, color: COLOR_PALETTE[(i * 2 + 1) % COLOR_PALETTE.length] }));
};

// ---------- Add field ----------
export function addFieldDialog({ type = currentType(), recordId = null, presetType = 'text', onDone } = {}) {
  const label = h('input', { class: 'input', placeholder: 'e.g. Stage, Resume, Budget…', autofocus: true });
  const typeSel = h('select', { class: 'input' }, FIELD_TYPES.filter(t => t.type !== 'image').map(t => h('option', { value: t.type, selected: t.type === presetType }, t.label)));
  const optsTa = h('textarea', { class: 'input', rows: 6, placeholder: 'One option per line, e.g.\nNew\nContacted\nInterested\nClosed' });
  const targetSel = h('select', { class: 'input' }, store.data.meta.recordTypes.map(t => h('option', { value: t.key }, t.label)));
  const linkLabel = h('input', { class: 'input', placeholder: 'optional, e.g. Stage / Role' });
  const linkOpts = h('textarea', { class: 'input', rows: 3, placeholder: 'optional per-link options, one per line' });
  const scopeAll = h('input', { type: 'radio', name: 'scope', checked: true });
  const scopeOne = h('input', { type: 'radio', name: 'scope' });
  const showTable = h('input', { type: 'checkbox', checked: false });
  const err = h('div', { class: 'error-text' });

  const optRow = field('Options', optsTa, 'The value is stored as plain text; the app shows a dropdown with these options. You can edit, recolour and reorder them later.');
  const relRows = h('div', {}, field('Links to', targetSel), field('Per-link label', linkLabel), field('Per-link options', linkOpts));
  const tableRow = h('label', { class: 'check-row' }, showTable, ' Show as a column in the table');
  const sync = () => {
    const t = typeSel.value;
    optRow.style.display = (t === 'select' || t === 'multiselect') ? '' : 'none';
    relRows.style.display = t === 'relation' ? '' : 'none';
    tableRow.style.display = t === 'markdown' ? 'none' : '';
  };
  typeSel.addEventListener('change', sync);
  sync();

  openModal({
    title: `Add field to ${type.label}`,
    size: 'md',
    body: h('div', {},
      field('Field name', label),
      field('Type', typeSel),
      optRow, relRows,
      recordId != null ? h('div', { class: 'form-row' },
        h('label', { class: 'check-row' }, scopeAll, ` All ${type.label.toLowerCase()}`),
        h('label', { class: 'check-row' }, scopeOne, ' Only this record')) : null,
      tableRow, err),
    actions: [
      { label: 'Cancel' },
      {
        label: 'Add field', primary: true, fn: () => {
          const name = label.value.trim();
          if (!name) { err.textContent = 'Please enter a name.'; return false; }
          if (type.fieldDefs.some(f => f.label.toLowerCase() === name.toLowerCase())) { err.textContent = 'A field with this name already exists.'; return false; }
          const t = typeSel.value;
          const def = {
            key: slugKey(name, type.fieldDefs.map(f => f.key)), label: name, type: t,
            showInTable: showTable.checked && t !== 'markdown', showInCard: true, aiContext: t !== 'file',
          };
          if (t === 'select' || t === 'multiselect') def.options = parseOptions(optsTa.value);
          if (t === 'relation') {
            def.target = targetSel.value;
            if (linkLabel.value.trim()) def.linkLabel = linkLabel.value.trim();
            const lo = parseOptions(linkOpts.value);
            if (lo.length) def.linkOptions = lo;
          }
          if (recordId != null && scopeOne.checked) def.onlyFor = [recordId];
          mutate(`Add field “${name}”`, () => {
            const ty = getType(store.data, type.key);
            ty.fieldDefs.push(def);
            if (def.showInTable && !ty.ui.columns.includes(def.key)) ty.ui.columns.push(def.key);
          });
          toast(`Field “${name}” added`);
          onDone?.(def);
        },
      },
    ],
  });
}

// ---------- Options editor (select / multiselect / relation link options) ----------
export function optionsEditor(typeKey, fieldKey, { linkOptions = false } = {}) {
  const getDef = () => getType(store.data, typeKey).fieldDefs.find(f => f.key === fieldKey);
  const listEl = h('div', { class: 'opt-list' });
  const usage = () => {
    const def = getDef();
    if (linkOptions) return new Map();
    return new Map(distinctValues(store.data, typeKey, def.key).map(v => [v.value, v.count]));
  };
  const opts = () => (linkOptions ? getDef().linkOptions : getDef().options) || [];

  const render = () => {
    const counts = usage();
    const orphans = linkOptions ? [] : [...counts.keys()].filter(v => !opts().some(o => o.value === v));
    listEl.replaceChildren(
      ...opts().map((o, i) => {
        const valInput = h('input', { class: 'input', value: o.value });
        valInput.addEventListener('change', async () => {
          const nv = valInput.value.trim();
          if (!nv || nv === o.value) { valInput.value = o.value; return; }
          if (opts().some(x => x.value === nv)) { toast('That option already exists', { type: 'error' }); valInput.value = o.value; return; }
          const n = counts.get(o.value) || 0;
          let update = true;
          if (n) update = await confirmDialog(`Rename “${o.value}” to “${nv}”.\nUpdate the ${n} record(s) that use it?`, { okLabel: 'Rename and update', cancelLabel: 'Rename option only' });
          mutate(`Rename option “${o.value}”`, () => {
            const d = getDef();
            if (linkOptions) { d.linkOptions.find(x => x.value === o.value).value = nv; }
            else renameOption(store.data, typeKey, d, o.value, nv, { updateRecords: update });
          });
          render();
        });
        const color = h('input', { type: 'color', class: 'swatch', value: o.color || '#9e9e9e', title: 'Colour' });
        color.addEventListener('change', () => { mutate('Option colour', () => { opts().find(x => x.value === o.value).color = color.value; }, { coalesce: `color:${fieldKey}` }); });
        return h('div', { class: 'opt-row' },
          h('button', { class: 'icon-btn', title: 'Move up', disabled: i === 0, onclick: () => move(i, -1) }, '↑'),
          h('button', { class: 'icon-btn', title: 'Move down', disabled: i === opts().length - 1, onclick: () => move(i, 1) }, '↓'),
          color, valInput,
          h('span', { class: 'muted small count' }, linkOptions ? '' : `${counts.get(o.value) || 0} used`),
          h('button', { class: 'icon-btn danger', title: 'Delete option', onclick: () => remove(o.value, counts.get(o.value) || 0) }, '🗑'));
      }),
      h('div', { class: 'opt-add' },
        h('button', { class: 'btn btn-sm', onclick: async () => {
          const v = await promptDialog('New option', { placeholder: 'Option text' });
          if (!v?.trim()) return;
          if (opts().some(x => x.value === v.trim())) return toast('Already exists', { type: 'error' });
          mutate('Add option', () => {
            const d = getDef();
            const arr = linkOptions ? (d.linkOptions ||= []) : (d.options ||= []);
            arr.push({ value: v.trim(), color: COLOR_PALETTE[arr.length * 2 % COLOR_PALETTE.length] });
          });
          render();
        } }, '+ Add option'),
        orphans.length ? h('button', { class: 'btn btn-sm', title: orphans.join(', '), onclick: () => {
          mutate('Add values in use', () => { const d = getDef(); orphans.forEach((v, i) => d.options.push({ value: v, color: COLOR_PALETTE[(d.options.length + i) % COLOR_PALETTE.length] })); });
          render();
        } }, `+ Add ${orphans.length} value(s) in use but not listed`) : null),
    );
  };
  const move = (i, d) => {
    mutate('Reorder options', () => { const arr = opts(); const [x] = arr.splice(i, 1); arr.splice(i + d, 0, x); }, { coalesce: `order:${fieldKey}` });
    render();
  };
  const remove = async (value, n) => {
    if (n) {
      const replacement = await choiceDialog(`“${value}” is used by ${n} record(s). Replace it with:`,
        [{ label: 'Empty', value: '' }, ...opts().filter(o => o.value !== value).slice(0, 6).map(o => ({ label: o.value, value: o.value })), { label: 'Cancel', value: null }],
        { title: 'Delete option' });
      if (replacement === null || replacement === undefined) return;
      mutate(`Delete option “${value}”`, () => deleteOption(store.data, typeKey, getDef(), value, replacement));
    } else {
      mutate(`Delete option “${value}”`, () => {
        const d = getDef();
        if (linkOptions) d.linkOptions = d.linkOptions.filter(o => o.value !== value);
        else deleteOption(store.data, typeKey, d, value, '');
      });
    }
    render();
  };
  render();
  openModal({ title: `Options · ${getDef().label}${linkOptions ? ' (per link)' : ''}`, size: 'md', body: h('div', {}, h('p', { class: 'muted small' }, 'Values are stored as plain text. Renaming can update existing records; deleting lets you choose a replacement.'), listEl), actions: [{ label: 'Close', primary: true }] });
}

// ---------- Field manager ----------
export function fieldManager(container, typeKey) {
  const render = () => {
    const type = getType(store.data, typeKey);
    if (!type) { container.replaceChildren(h('p', {}, 'Record type not found')); return; }
    const rows = type.fieldDefs.map((def, i) => {
      const used = recordsUsing(store.data, typeKey, def.key).length;
      const labelIn = h('input', { class: 'input input-sm', value: def.label });
      labelIn.addEventListener('change', () => { const v = labelIn.value.trim(); if (v) mutate('Rename field', () => { def.label = v; }); });
      const typeSel = h('select', { class: 'input input-sm', disabled: def.builtin && ['fullName', 'name', 'picture', 'info', 'labels'].includes(def.key) },
        FIELD_TYPES.map(t => h('option', { value: t.type, selected: t.type === def.type }, t.label)));
      typeSel.addEventListener('change', async () => {
        const nt = typeSel.value;
        const ok = await confirmDialog(`Change “${def.label}” from ${TYPE_LABEL[def.type]} to ${TYPE_LABEL[nt]}?`, {
          detail: used ? `${used} record(s) have a value. Values are converted where possible${nt === 'select' || nt === 'multiselect' ? '; the distinct values in use become the dropdown options' : ''}. You can undo with Ctrl+Z.` : 'No records use this field yet.',
          okLabel: 'Convert',
        });
        if (!ok) { typeSel.value = def.type; return; }
        if (nt === 'relation') { def.target = def.target || 'contacts'; }
        mutate(`Convert field “${def.label}”`, () => { convertFieldType(store.data, typeKey, getType(store.data, typeKey).fieldDefs.find(f => f.key === def.key), nt); });
        render();
      });
      const tog = (prop, title, disabled) => {
        const cb = h('input', { type: 'checkbox', checked: prop === 'showInFilters' ? def[prop] !== false : !!def[prop], title, disabled });
        cb.addEventListener('change', () => mutate(`${title}: ${def.label}`, () => {
          def[prop] = cb.checked;
          if (prop === 'showInTable') {
            const cols = getType(store.data, typeKey).ui.columns;
            if (cb.checked && !cols.includes(def.key)) cols.push(def.key);
            if (!cb.checked) getType(store.data, typeKey).ui.columns = cols.filter(c => c !== def.key);
          }
        }));
        return h('td', { class: 'center' }, cb);
      };
      return h('tr', {},
        h('td', { class: 'nowrap' },
          h('button', { class: 'icon-btn', disabled: i === 0, title: 'Move up', onclick: () => { mutate('Reorder fields', () => { const a = type.fieldDefs; [a[i - 1], a[i]] = [a[i], a[i - 1]]; }, { coalesce: 'fieldorder' }); render(); } }, '↑'),
          h('button', { class: 'icon-btn', disabled: i === type.fieldDefs.length - 1, title: 'Move down', onclick: () => { mutate('Reorder fields', () => { const a = type.fieldDefs; [a[i + 1], a[i]] = [a[i], a[i + 1]]; }, { coalesce: 'fieldorder' }); render(); } }, '↓')),
        h('td', {}, labelIn, h('div', { class: 'muted tiny' }, def.key, def.builtin ? ' · built-in' : '', def.onlyFor ? ` · only record #${def.onlyFor.join(', #')}` : '')),
        h('td', {}, typeSel,
          (def.type === 'select' || def.type === 'multiselect') ? h('button', { class: 'btn-link small', onclick: () => optionsEditor(typeKey, def.key) }, `${def.options?.length || 0} options…`) : null,
          def.type === 'relation' ? h('div', { class: 'small' }, '→ ', h('select', { class: 'input input-sm', onchange: e => mutate('Relation target', () => { def.target = e.target.value; }) },
            store.data.meta.recordTypes.map(t => h('option', { value: t.key, selected: t.key === def.target }, t.label))),
          ' ', h('button', { class: 'btn-link small', onclick: () => optionsEditor(typeKey, def.key, { linkOptions: true }) }, `per-link options (${def.linkOptions?.length || 0})…`)) : null),
        def.type === 'markdown' || def.type === 'image' ? h('td', { class: 'center muted' }, '–') : tog('showInTable', 'Table column'),
        tog('showInCard', 'Show in card'),
        tog('aiContext', 'Offer as AI context'),
        (def.type === 'select' || def.type === 'multiselect') ? tog('showInFilters', 'Filter chips') : h('td', { class: 'center muted' }, '–'),
        h('td', { class: 'muted small center' }, String(used)),
        h('td', {}, def.builtin ? h('span', { class: 'muted tiny' }, 'hide only') : h('button', {
          class: 'icon-btn danger', title: 'Delete field', onclick: async () => {
            const ok = await confirmDialog(`Delete the field “${def.label}”?`, { danger: true, okLabel: 'Delete field', detail: used ? `${used} record(s) contain data in this field. It will be removed from them (Ctrl+Z to undo; backups also keep it).` : '' });
            if (!ok) return;
            mutate(`Delete field “${def.label}”`, () => deleteField(store.data, typeKey, getType(store.data, typeKey).fieldDefs.find(f => f.key === def.key)));
            render();
          },
        }, '🗑')));
    });
    container.replaceChildren(
      h('div', { class: 'toolbar-row' },
        h('button', { class: 'btn btn-primary btn-sm', onclick: () => addFieldDialog({ type, onDone: render }) }, '+ Add field'),
        h('span', { class: 'muted small' }, 'Changes apply immediately and are autosaved. Ctrl+Z undoes them.')),
      h('div', { class: 'table-scroll' }, h('table', { class: 'grid-table' },
        h('thead', {}, h('tr', {}, h('th', {}, ''), h('th', {}, 'Name'), h('th', {}, 'Type'), h('th', {}, 'Table'), h('th', {}, 'Card'), h('th', {}, 'AI'), h('th', {}, 'Filter'), h('th', {}, 'Used'), h('th', {}, ''))),
        h('tbody', {}, rows))));
  };
  render();
  return render;
}

// ---------- Record types manager ----------
export function recordTypesManager(container, onChange) {
  const render = () => {
    const types = store.data.meta.recordTypes;
    container.replaceChildren(
      h('div', { class: 'toolbar-row' },
        h('button', { class: 'btn btn-primary btn-sm', onclick: async () => {
          const label = await promptDialog('New record type', { label: 'Plural name (e.g. Companies, Deals, Projects)', placeholder: 'Companies' });
          if (!label?.trim()) return;
          const key = slugKey(label, [...types.map(t => t.key), 'meta', 'schemaVersion']);
          mutate(`Add record type “${label}”`, (d) => { d.meta.recordTypes.push(makeGenericType(key, label.trim())); d[key] = []; });
          render(); onChange?.();
        } }, '+ New record type'),
        h('span', { class: 'muted small' }, 'Each record type has its own fields, table, board, notes and AI. Link types with a Relation field.')),
      h('table', { class: 'grid-table' },
        h('thead', {}, h('tr', {}, h('th', {}, 'Name (plural)'), h('th', {}, 'Singular'), h('th', {}, 'Title field'), h('th', {}, 'Records'), h('th', {}, ''))),
        h('tbody', {}, types.map(t => {
          const pl = h('input', { class: 'input input-sm', value: t.label });
          pl.addEventListener('change', () => { if (pl.value.trim()) { mutate('Rename record type', () => { t.label = pl.value.trim(); }); onChange?.(); } });
          const sg = h('input', { class: 'input input-sm', value: t.singular || '' });
          sg.addEventListener('change', () => mutate('Rename record type', () => { t.singular = sg.value.trim(); }));
          const tf = h('select', { class: 'input input-sm', onchange: e => mutate('Title field', () => { t.titleField = e.target.value; }) },
            t.fieldDefs.filter(f => ['text', 'email', 'url', 'phone'].includes(f.type)).map(f => h('option', { value: f.key, selected: f.key === t.titleField }, f.label)));
          return h('tr', {},
            h('td', {}, pl), h('td', {}, sg), h('td', {}, tf),
            h('td', { class: 'center' }, String(records(t.key).length)),
            h('td', {}, t.builtin ? h('span', { class: 'muted tiny' }, 'built-in') : h('button', {
              class: 'icon-btn danger', title: 'Delete record type', onclick: async () => {
                const n = records(t.key).length;
                const ok = await confirmDialog(`Delete record type “${t.label}”${n ? ` and its ${n} record(s)` : ''}?`, { danger: true, okLabel: 'Delete', detail: 'Relation fields pointing to it will show missing links. Ctrl+Z can undo.' });
                if (!ok) return;
                mutate(`Delete record type “${t.label}”`, (d) => { d.meta.recordTypes = d.meta.recordTypes.filter(x => x.key !== t.key); delete d[t.key]; });
                if (store.ui.typeKey === t.key) store.ui.typeKey = 'contacts';
                render(); onChange?.();
              },
            }, '🗑')));
        }))));
  };
  render();
}
