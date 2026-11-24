// Import wizard for tabular files (CSV / XLSX / vCard):
// smart column -> field matching, near-duplicate warnings, per-column formatting, value mapping
// for dropdowns, live preview with validation, presets, remembered column names.
import { h, debounce } from './dom.js';
import { store, mutate, currentType, records } from './store.js';
import {
  autoMapDetailed, similarFields, matchScore, rowToRecordDetailed, defaultTransform, analyzeColumn, distinctOptionValues,
  findDuplicate, mergeInto, newFieldFromHeader, rememberAliases, presetOverlap, applyTextTransform, convertCell,
  getType, FIELD_TYPES, TYPE_LABEL, nextId, newId, slugKey, COLOR_PALETTE, normName,
} from './shared.js';
import { openModal, toast, promptDialog, confirmDialog } from './ui.js';
import { blankRecord } from './actions.js';

const SPECIAL = [['ignore', '— skip this column —'], ['new', '➕ New field'], ['note', '📝 Add as a note'], ['_first', 'First name (joined into the name)'], ['_last', 'Last name (joined into the name)']];
const MAPPABLE = d => !['file', 'relation'].includes(d.type);

export function openImportWizard(parsed) {
  const st = {
    type: currentType(),
    policy: 'merge',
    cols: {}, // header -> { target, transform, newDef, info }
    selected: parsed.headers[0],
    onlyProblems: false,
    saveAliases: true,
    presetName: null,
  };
  const rows = parsed.rows;
  const headers = parsed.headers;

  // ---------- state setup ----------
  const initColumns = () => {
    const { mapping, info } = autoMapDetailed(headers, st.type);
    st.cols = {};
    for (const hd of headers) {
      st.cols[hd] = { target: mapping[hd], transform: defaultTransform(), newDef: null, info: info[hd] };
      if (mapping[hd] === 'new') {
        const values = rows.map(r => r[hd]).filter(v => String(v ?? '').trim());
        if (!values.length) { st.cols[hd].target = 'ignore'; st.cols[hd].info = { score: 0, reason: 'column is empty' }; }
      }
    }
    st.presetName = null;
    // auto-apply the best matching preset for this record type
    const presets = (store.data.meta.importPresets || []).filter(p => p.typeKey === st.type.key);
    const best = presets.map(p => ({ p, o: presetOverlap(p, headers) })).sort((a, b) => b.o - a.o)[0];
    if (best && best.o >= 0.6) applyPreset(best.p);
  };

  const ensureNewDef = (hd) => {
    const c = st.cols[hd];
    if (!c.newDef) {
      const def = newFieldFromHeader(st.type, hd, rows.map(r => r[hd]));
      // keys must not collide with other new fields of this import
      const taken = [...st.type.fieldDefs.map(f => f.key), ...Object.values(st.cols).filter(x => x !== c && x.newDef).map(x => x.newDef.key)];
      def.key = slugKey(def.label, taken);
      if (def.type === 'select' || def.type === 'multiselect') def.options = []; // filled from the formatted values
      c.newDef = def;
    }
    return c.newDef;
  };

  // Field definitions as they will exist after the import (existing + new).
  const effectiveType = () => {
    const defs = st.type.fieldDefs.map(d => ({ ...d, options: d.options ? [...d.options] : d.options }));
    for (const [hd, c] of Object.entries(st.cols)) if (c.target === 'new') defs.push(ensureNewDef(hd));
    return { ...st.type, fieldDefs: defs };
  };
  const targetKey = (hd) => {
    const c = st.cols[hd];
    if (c.target === 'new') return ensureNewDef(hd).key;
    if (c.target?.startsWith('same:')) { const o = st.cols[c.target.slice(5)]; return o?.target === 'new' ? ensureNewDef(c.target.slice(5)).key : o?.target; }
    return c.target;
  };
  const mappingNow = () => Object.fromEntries(headers.map(hd => [hd, targetKey(hd)]));
  const transformsNow = () => Object.fromEntries(headers.map(hd => [hd, st.cols[hd].transform]));
  const defFor = (hd, et = effectiveType()) => et.fieldDefs.find(f => f.key === targetKey(hd)) || null;

  // ---------- warnings ----------
  const warningsFor = (hd) => {
    const c = st.cols[hd];
    const out = [];
    if (c.target === 'new') {
      const name = ensureNewDef(hd).label;
      for (const s of similarFields(name, st.type, 0.7).slice(0, 3)) out.push({ kind: 'existing', def: s.def, score: s.score, reason: s.reason });
      for (const [oh, oc] of Object.entries(st.cols)) {
        if (oh === hd || oc.target !== 'new') continue;
        const m = matchScore(name, { key: oc.newDef?.key || '', label: oc.newDef?.label || oh });
        if (m.score >= 0.8) out.push({ kind: 'sibling', header: oh, score: m.score, reason: m.reason });
      }
    }
    return out;
  };

  // ---------- conversion (all rows) ----------
  let result = null;
  const compute = () => {
    const et = effectiveType();
    const mapping = mappingNow();
    const transforms = transformsNow();
    const existing = records(st.type.key);
    const out = [];
    const accepted = [];
    let issues = 0;
    for (let i = 0; i < rows.length; i++) {
      const r = rowToRecordDetailed(rows[i], mapping, et, transforms);
      const hasData = Object.keys(r.rec).some(k => k !== 'notes') || r.rec.notes.length;
      if (!hasData) continue;
      const match = findDuplicate(et, [...existing, ...accepted], r.rec);
      if (!match) accepted.push(r.rec);
      issues += r.issues.length;
      out.push({ index: i, ...r, match });
    }
    result = { et, mapping, transforms, items: out, issues, dup: out.filter(x => x.match).length };
    return result;
  };

  // ---------- UI ----------
  const body = h('div', { class: 'iw' });
  const colList = h('div', { class: 'iw-cols' });
  const editor = h('div', { class: 'iw-editor' });
  const preview = h('div', { class: 'iw-preview' });
  const summary = h('div', { class: 'iw-summary' });
  const presetSel = h('select', { class: 'input input-sm' });
  const typeSel = h('select', { class: 'input input-sm' }, store.data.meta.recordTypes.map(t => h('option', { value: t.key, selected: t.key === st.type.key }, t.label)));
  typeSel.addEventListener('change', () => { st.type = getType(store.data, typeSel.value); initColumns(); renderAll(); });

  const badge = (hd) => {
    const c = st.cols[hd];
    const w = warningsFor(hd);
    if (c.target === 'ignore') return h('span', { class: 'iw-badge muted' }, c.info?.reason === 'column is empty' ? 'empty' : 'skipped');
    if (c.target === 'new') return w.length ? h('span', { class: 'iw-badge warn', title: w.map(x => x.kind === 'existing' ? `Similar to existing field “${x.def.label}” (${x.reason})` : `Similar to new column “${x.header}”`).join('\n') }, '⚠ similar field exists') : h('span', { class: 'iw-badge new' }, '➕ new field');
    if (c.target?.startsWith('same:')) return h('span', { class: 'iw-badge new' }, `↳ same as “${c.target.slice(5)}”`);
    if (c.target === 'note') return h('span', { class: 'iw-badge muted' }, 'note');
    if (c.target === '_first' || c.target === '_last') return h('span', { class: 'iw-badge ok' }, 'name part');
    return c.info?.score ? h('span', { class: 'iw-badge ok', title: c.info.reason }, `✓ ${Math.round(c.info.score * 100)}% · ${c.info.reason}`) : h('span', { class: 'iw-badge ok' }, '✓ chosen');
  };

  const targetSelect = (hd, onChange) => {
    const c = st.cols[hd];
    const others = Object.entries(st.cols).filter(([oh, oc]) => oh !== hd && oc.target === 'new');
    const sel = h('select', { class: 'input input-sm' },
      SPECIAL.filter(([v]) => !((v === '_first' || v === '_last') && st.type.titleField == null)).map(([v, l]) => h('option', { value: v, selected: c.target === v }, l)),
      h('optgroup', { label: `Existing ${st.type.label} fields` }, st.type.fieldDefs.filter(MAPPABLE).map(d => h('option', { value: d.key, selected: c.target === d.key }, `${d.label}  (${TYPE_LABEL[d.type] || d.type})`))),
      others.length ? h('optgroup', { label: 'Same new field as column…' }, others.map(([oh]) => h('option', { value: `same:${oh}`, selected: c.target === `same:${oh}` }, `“${oh}”`))) : null);
    sel.addEventListener('click', e => e.stopPropagation());
    sel.addEventListener('change', () => { c.target = sel.value; c.info = { score: 0, reason: '' }; onChange?.(); });
    return sel;
  };

  const sample = hd => rows.slice(0, 4).map(r => String(r[hd] ?? '').trim()).filter(Boolean).join(' · ').slice(0, 70);

  const renderCols = () => {
    colList.replaceChildren(h('table', { class: 'grid-table iw-table' },
      h('thead', {}, h('tr', {}, h('th', {}, 'Column in file'), h('th', {}, 'Import as'), h('th', {}, ''))),
      h('tbody', {}, headers.map(hd => h('tr', { class: ['iw-row', st.selected === hd && 'on'], onclick: () => { st.selected = hd; renderCols(); renderEditor(); } },
        h('td', {}, h('b', {}, hd), h('div', { class: 'muted tiny iw-sample' }, sample(hd) || '(empty)')),
        h('td', {}, targetSelect(hd, () => { st.selected = hd; renderAll(); })),
        h('td', {}, badge(hd)))))));
  };

  // ---------- column editor ----------
  const renderEditor = () => {
    const hd = st.selected;
    const c = st.cols[hd];
    if (!c) { editor.replaceChildren(); return; }
    const t = c.transform;
    const upd = () => { renderColsSoon(); renderPreviewSoon(); renderValuesSoon(); };
    const parts = [h('div', { class: 'iw-ed-head' }, h('h3', {}, `Column “${hd}”`), targetSelect(hd, () => renderAll()))];

    if (c.target === 'new') {
      const nd = ensureNewDef(hd);
      const nameIn = h('input', { class: 'input input-sm', value: nd.label });
      nameIn.addEventListener('input', debounce(() => {
        nd.label = nameIn.value.trim() || hd;
        nd.key = slugKey(nd.label, [...st.type.fieldDefs.map(f => f.key), ...Object.values(st.cols).filter(x => x !== c && x.newDef).map(x => x.newDef.key)]);
        renderWarnings(); upd();
      }, 250));
      const typeIn = h('select', { class: 'input input-sm' }, FIELD_TYPES.filter(x => !['file', 'relation'].includes(x.type)).map(x => h('option', { value: x.type, selected: x.type === nd.type }, x.label)));
      typeIn.addEventListener('change', () => { nd.type = typeIn.value; if (nd.type === 'select' || nd.type === 'multiselect') nd.options = []; else delete nd.options; renderEditor(); upd(); });
      const warnBox = h('div', {});
      const renderWarnings = () => {
        const ws = warningsFor(hd);
        warnBox.replaceChildren(...ws.map(w => h('div', { class: 'iw-warn' },
          w.kind === 'existing'
            ? [`⚠ An existing field “${w.def.label}” looks like the same thing (${w.reason}). `, h('button', { class: 'btn btn-sm btn-primary', onclick: () => { c.target = w.def.key; c.info = { score: w.score, reason: w.reason }; renderAll(); } }, `Use “${w.def.label}” instead`)]
            : [`⚠ Column “${w.header}” would create a very similar new field. `, h('button', { class: 'btn btn-sm', onclick: () => { c.target = `same:${w.header}`; renderAll(); } }, `Put both into one field`)])));
      };
      renderWarnings();
      parts.push(h('div', { class: 'iw-newfield' }, h('div', { class: 'row-gap' }, h('span', { class: 'muted small' }, 'New field name'), nameIn, h('span', { class: 'muted small' }, 'type'), typeIn), warnBox));
    } else if (!['ignore'].includes(c.target)) {
      const def = defFor(hd);
      if (def) parts.push(h('p', { class: 'muted small' }, `Goes into the existing field “${def.label}” (${TYPE_LABEL[def.type] || def.type}). Existing values are kept when merging; empty ones are filled.`));
    }

    if (c.target !== 'ignore') {
      const def = defFor(hd);
      // generic clean-up
      const trim = h('input', { type: 'checkbox', checked: t.trim !== false, onchange: e => { t.trim = e.target.checked; upd(); } });
      const kase = h('select', { class: 'input input-sm', onchange: e => { t.case = e.target.value; upd(); } },
        [['none', 'Keep as is'], ['title', 'Title Case'], ['sentence', 'Sentence case'], ['lower', 'lowercase'], ['upper', 'UPPERCASE']].map(([v, l]) => h('option', { value: v, selected: t.case === v }, l)));
      const empty = h('input', { class: 'input input-sm', value: t.emptyValue || '', placeholder: '(leave empty)' });
      empty.addEventListener('input', debounce(() => { t.emptyValue = empty.value; upd(); }, 250));
      const repl = h('div', { class: 'iw-repl' });
      const renderRepl = () => repl.replaceChildren(...(t.replace || []).map((r, i) => {
        const f = h('input', { class: 'input input-sm', value: r.find, placeholder: 'find' });
        const w = h('input', { class: 'input input-sm', value: r.with, placeholder: 'replace with' });
        f.addEventListener('input', debounce(() => { r.find = f.value; upd(); }, 250));
        w.addEventListener('input', debounce(() => { r.with = w.value; upd(); }, 250));
        return h('div', { class: 'row-gap' }, f, '→', w,
          h('label', { class: 'check-row tiny', title: 'Regular expression' }, h('input', { type: 'checkbox', checked: !!r.regex, onchange: e => { r.regex = e.target.checked; upd(); } }), 'regex'),
          h('button', { class: 'icon-btn', onclick: () => { t.replace.splice(i, 1); renderRepl(); upd(); } }, '×'));
      }), h('button', { class: 'btn-link small', onclick: () => { (t.replace ||= []).push({ find: '', with: '', regex: false }); renderRepl(); } }, '+ find & replace'));
      renderRepl();
      parts.push(h('div', { class: 'iw-section' }, h('h4', {}, 'Clean-up'),
        h('div', { class: 'row-gap' }, h('label', { class: 'check-row small' }, trim, ' Trim spaces'), h('span', { class: 'muted small' }, 'Case'), kase, h('span', { class: 'muted small' }, 'If empty use'), empty),
        repl));

      // type-specific
      const tp = def?.type || (c.target === 'note' ? 'text' : null);
      if (tp === 'tags' || tp === 'multiselect') {
        parts.push(h('div', { class: 'row-gap' }, h('span', { class: 'muted small' }, 'Split values on'),
          h('select', { class: 'input input-sm', onchange: e => { t.split = e.target.value; upd(); } },
            [['auto', 'Auto ( , ; | new line )'], [',', 'Comma ,'], [';', 'Semicolon ;'], ['|', 'Pipe |'], ['/', 'Slash /'], ['newline', 'New line'], ['space', 'Space']].map(([v, l]) => h('option', { value: v, selected: t.split === v }, l)))));
      }
      if (tp === 'date') {
        const an = analyzeColumn(rows, hd, def, t);
        parts.push(h('div', { class: 'row-gap' }, h('span', { class: 'muted small' }, 'Date order'),
          h('select', { class: 'input input-sm', onchange: e => { t.dateOrder = e.target.value; renderEditor(); upd(); } },
            [['auto', 'Automatic'], ['DMY', 'Day / Month / Year (31/12/2024)'], ['MDY', 'Month / Day / Year (12/31/2024)'], ['YMD', 'Year-Month-Day (2024-12-31)']].map(([v, l]) => h('option', { value: v, selected: t.dateOrder === v }, l))),
          an.ambiguous && t.dateOrder === 'auto' ? h('span', { class: 'warn small' }, `⚠ ${an.ambiguous} date(s) could be read both ways (e.g. 03/04) — choose the order.`) : null));
      }
      if (tp === 'number') {
        parts.push(h('div', { class: 'row-gap' }, h('span', { class: 'muted small' }, 'Number format'),
          h('select', { class: 'input input-sm', onchange: e => { t.numberFormat = e.target.value; upd(); } },
            [['auto', 'Automatic'], ['eu', '1.234,56 (European)'], ['us', '1,234.56 (US/UK)']].map(([v, l]) => h('option', { value: v, selected: t.numberFormat === v }, l))),
          h('span', { class: 'muted tiny' }, 'Currency symbols and text are removed; 60k = 60000.')));
      }
      if (tp === 'select' || tp === 'multiselect') parts.push(valueMapEditor(hd, def, t, upd));
      parts.push(valuesBox);
      renderValues();
    } else {
      parts.push(h('p', { class: 'muted' }, 'This column will not be imported.'));
    }
    editor.replaceChildren(...parts);
  };

  // dropdown value mapping: incoming value -> option
  const valueMapEditor = (hd, def, t, upd) => {
    const vals = distinctOptionValues(rows, hd, def, { ...t, valueMap: {} }).slice(0, 60);
    const isNew = !st.type.fieldDefs.some(f => f.key === def.key);
    const options = isNew ? [] : (def.options || []).map(o => o.value);
    const box = h('div', { class: 'iw-section' }, h('h4', {}, 'Dropdown values'),
      isNew ? h('p', { class: 'muted small' }, 'New dropdown: every distinct value below becomes an option. Map variants (e.g. “interviewed”) onto one value to keep the list clean.') : null,
      h('label', { class: 'check-row small' }, h('input', { type: 'checkbox', checked: t.addNewOptions !== false || isNew, disabled: isNew, onchange: e => { t.addNewOptions = e.target.checked; upd(); } }), ' Values that are not options yet become new options'),
      h('table', { class: 'grid-table iw-vmap' }, h('tbody', {}, vals.map(v => {
        const mapped = Object.prototype.hasOwnProperty.call(t.valueMap, v.value) ? t.valueMap[v.value] : null;
        const auto = convertCell(v.value, def, { ...t, valueMap: {} });
        const choices = [...new Set([...options, ...vals.map(x => x.value).filter(x => x !== v.value)])];
        const sel = h('select', { class: 'input input-sm' },
          h('option', { value: '__auto' }, auto.newOptions?.length ? `➕ keep “${v.value}”${isNew ? '' : ' (new option)'}` : `= ${auto.value}`),
          h('option', { value: '' }, '(empty)'),
          choices.map(o => h('option', { value: o, selected: mapped === o }, `→ ${o}`)));
        if (mapped === '') sel.value = '';
        else if (mapped == null) sel.value = '__auto';
        sel.addEventListener('change', () => { if (sel.value === '__auto') delete t.valueMap[v.value]; else t.valueMap[v.value] = sel.value; upd(); });
        return h('tr', {}, h('td', {}, v.value), h('td', { class: 'muted small' }, `${v.count}×`), h('td', {}, sel));
      }))));
    return box;
  };

  const valuesBox = h('div', { class: 'iw-section' });
  const renderValues = () => {
    const hd = st.selected;
    const c = st.cols[hd];
    if (!c || c.target === 'ignore') { valuesBox.replaceChildren(); return; }
    const def = defFor(hd);
    const t = c.transform;
    const raw = new Map();
    for (const r of rows) { const v = String(r[hd] ?? ''); raw.set(v, (raw.get(v) || 0) + 1); }
    const list = [...raw].sort((a, b) => b[1] - a[1]).slice(0, 14);
    valuesBox.replaceChildren(h('h4', {}, 'Values (in file → as imported)'),
      h('table', { class: 'grid-table iw-values' }, h('tbody', {}, list.map(([v, n]) => {
        const res = def ? convertCell(v, def, t) : { value: applyTextTransform(v, t), issue: null };
        const shown = res.value === undefined ? '' : Array.isArray(res.value) ? res.value.join(', ') : String(res.value);
        return h('tr', { class: res.issue ? 'bad' : '' },
          h('td', { class: 'mono small' }, v === '' ? h('i', { class: 'muted' }, '(empty)') : v),
          h('td', {}, '→'),
          h('td', {}, shown || h('i', { class: 'muted' }, '(empty)'), res.issue ? h('span', { class: 'iw-issue' }, ` ⚠ ${res.issue}`) : null),
          h('td', { class: 'muted tiny' }, `${n}×`));
      }))));
  };

  // ---------- preview ----------
  const renderPreview = () => {
    const r = compute();
    const keys = [...new Set(Object.values(r.mapping).filter(k => k && !['ignore', 'note', '_first', '_last', 'new'].includes(k)))];
    if (Object.values(r.mapping).some(k => k === '_first' || k === '_last') && !keys.includes(st.type.titleField)) keys.unshift(st.type.titleField);
    const defs = keys.map(k => r.et.fieldDefs.find(f => f.key === k)).filter(Boolean);
    let items = r.items;
    if (st.onlyProblems) items = items.filter(x => x.issues.length);
    const cell = (it, d) => {
      const v = it.rec[d.key];
      const iss = it.issues.filter(x => x.field === d.key);
      const text = v == null ? '' : Array.isArray(v) ? v.join(', ') : String(v);
      return h('td', { class: iss.length ? 'bad' : '', title: iss.map(x => `${x.header}: “${x.value}” — ${x.issue}`).join('\n') || null }, text || (iss.length ? `“${iss[0].value}”` : ''));
    };
    preview.replaceChildren(
      h('div', { class: 'row-gap' }, h('h4', {}, `Preview${st.onlyProblems ? ' — rows with problems' : ''}`),
        h('label', { class: 'check-row small' }, h('input', { type: 'checkbox', checked: st.onlyProblems, onchange: e => { st.onlyProblems = e.target.checked; renderPreview(); } }), ' Only rows with problems'),
        h('span', { class: 'muted small' }, `showing ${Math.min(items.length, 50)} of ${items.length}`)),
      h('div', { class: 'table-scroll iw-prev-scroll' }, h('table', { class: 'grid-table iw-prev' },
        h('thead', {}, h('tr', {}, h('th', {}, '#'), defs.map(d => h('th', {}, d.label)), h('th', {}, 'Status'))),
        h('tbody', {}, items.slice(0, 50).map(it => h('tr', {},
          h('td', { class: 'muted tiny' }, String(it.index + 2)),
          defs.map(d => cell(it, d)),
          h('td', { class: 'small' }, it.match ? h('span', { class: 'iw-badge warn', title: 'Same email, or same name + group' }, `exists: ${it.match[st.type.titleField] || '#' + it.match.id}`) : h('span', { class: 'iw-badge new' }, 'new'))))))));
    const newFields = Object.values(st.cols).filter(c => c.target === 'new').length;
    summary.replaceChildren(
      h('b', {}, `${r.items.length} records`), ` · ${r.items.length - r.dup} new · ${r.dup} already exist (${st.policy === 'merge' ? 'will be merged' : st.policy === 'skip' ? 'will be skipped' : 'imported again'})`,
      newFields ? ` · ${newFields} new field(s)` : '',
      r.issues ? h('span', { class: 'warn' }, ` · ⚠ ${r.issues} value(s) need attention — they are kept in an “Import notes” note on the record, nothing is lost`) : h('span', { class: 'ok' }, ' · ✓ no problems'));
  };

  const renderColsSoon = debounce(renderCols, 120);
  const renderPreviewSoon = debounce(renderPreview, 200);
  const renderValuesSoon = debounce(renderValues, 150);
  const renderAll = () => { renderCols(); renderEditor(); renderPreview(); renderPresets(); };

  // ---------- presets ----------
  function applyPreset(p) {
    for (const hd of headers) {
      const pc = Object.entries(p.columns).find(([ph]) => normName(ph) === normName(hd))?.[1];
      if (!pc) continue;
      const target = pc.target === 'new' || pc.target?.startsWith('same:') || pc.target === 'ignore' || pc.target === 'note' || pc.target?.startsWith('_') || st.type.fieldDefs.some(f => f.key === pc.target)
        ? pc.target : 'new';
      st.cols[hd] = { target, transform: { ...defaultTransform(), ...structuredClone(pc.transform || {}) }, newDef: pc.newDef ? structuredClone(pc.newDef) : null, info: { score: 1, reason: `preset “${p.name}”` } };
      // a field created by an earlier import with this preset now exists: map onto it
      if (target === 'new' && pc.newDef && st.type.fieldDefs.some(f => f.key === pc.newDef.key)) st.cols[hd].target = pc.newDef.key;
    }
    st.policy = p.policy || st.policy;
    st.presetName = p.name;
  }
  const renderPresets = () => {
    const presets = (store.data.meta.importPresets || []).filter(p => p.typeKey === st.type.key);
    presetSel.replaceChildren(h('option', { value: '' }, presets.length ? (st.presetName ? `Preset: ${st.presetName}` : 'Apply a preset…') : 'No presets yet'),
      presets.map(p => h('option', { value: p.id }, `${p.name}  (${Math.round(presetOverlap(p, headers) * 100)}% columns match)`)));
    presetSel.disabled = !presets.length;
  };
  presetSel.addEventListener('change', () => {
    const p = (store.data.meta.importPresets || []).find(x => x.id === presetSel.value);
    if (p) { applyPreset(p); renderAll(); toast(`Preset “${p.name}” applied`); }
  });
  const savePreset = async () => {
    const name = await promptDialog('Save import preset', { label: 'Name (e.g. “LinkedIn export”). Mappings and formatting are reused next time; files with the same columns pick it automatically.', value: st.presetName || parsed.fileName.replace(/\.[^.]+$/, '') });
    if (!name?.trim()) return;
    const columns = {};
    for (const hd of headers) { const c = st.cols[hd]; columns[hd] = { target: c.target, transform: structuredClone(c.transform), newDef: c.target === 'new' ? structuredClone(ensureNewDef(hd)) : null }; }
    mutate('Save import preset', d => {
      d.meta.importPresets ||= [];
      const ex = d.meta.importPresets.find(p => p.name === name.trim() && p.typeKey === st.type.key);
      const p = { id: ex?.id || newId('ip'), name: name.trim(), typeKey: st.type.key, columns, policy: st.policy, savedAt: new Date().toISOString() };
      if (ex) Object.assign(ex, p); else d.meta.importPresets.push(p);
    }, { undoable: false });
    st.presetName = name.trim();
    renderPresets();
    toast('Import preset saved');
  };

  // ---------- run the import ----------
  const runImport = async () => {
    const r = compute();
    if (!r.items.length) { toast('Nothing to import'); return false; }
    const unresolved = headers.filter(hd => st.cols[hd].target === 'new' && warningsFor(hd).some(w => w.kind === 'existing' && w.score >= 0.9));
    if (unresolved.length) {
      const ok = await confirmDialog(`These columns will create new fields although a very similar field already exists:\n• ${unresolved.join('\n• ')}`, { okLabel: 'Create them anyway', cancelLabel: 'Go back' });
      if (!ok) return false;
    }
    let added = 0, merged = 0, skipped = 0, aliases = 0;
    mutate(`Import ${parsed.fileName}`, (d) => {
      const t = d.meta.recordTypes.find(x => x.key === st.type.key);
      // 1. new fields
      for (const def of r.et.fieldDefs) {
        if (t.fieldDefs.some(f => f.key === def.key)) continue;
        const clean = { ...def, options: def.options ? [...def.options] : undefined };
        if (!clean.options) delete clean.options;
        t.fieldDefs.push(clean);
      }
      // 2. remember column names for next time
      if (st.saveAliases) aliases = rememberAliases(t, Object.fromEntries(headers.filter(hd => !st.cols[hd].target.startsWith('_') && st.cols[hd].target !== 'new').map(hd => [hd, targetKey(hd)])));
      for (const hd of headers) if (st.cols[hd].target === 'new') { const nd = t.fieldDefs.find(f => f.key === targetKey(hd)); if (nd && normName(nd.label) !== normName(hd)) { nd.aliases ||= []; if (!nd.aliases.includes(hd)) nd.aliases.push(hd); } }
      // 3. dropdown options discovered in the data
      const addOpts = (key, vals) => {
        const def = t.fieldDefs.find(f => f.key === key);
        if (!def || !(def.type === 'select' || def.type === 'multiselect')) return;
        def.options ||= [];
        for (const v of vals) if (v && !def.options.some(o => o.value === v)) def.options.push({ value: v, color: COLOR_PALETTE[(def.options.length * 2 + 1) % COLOR_PALETTE.length] });
      };
      // 4. records
      const now = new Date().toISOString();
      const fresh = [];
      for (const it of r.items) {
        for (const [k, vals] of Object.entries(it.newOptions || {})) addOpts(k, vals);
        const match = findDuplicate(t, [...d[st.type.key], ...fresh], it.rec);
        if (match && st.policy === 'skip') { skipped++; continue; }
        if (match && st.policy === 'merge') { mergeInto(t, match, it.rec); match.updatedAt = now; merged++; continue; }
        const rec = { ...blankRecord(t), ...it.rec, id: nextId(d[st.type.key]), notes: it.rec.notes || [], createdAt: now, updatedAt: now };
        d[st.type.key].push(rec);
        fresh.push(rec);
        added++;
      }
    });
    toast(`Imported ${added} new, merged ${merged}, skipped ${skipped}${aliases ? ` · remembered ${aliases} column name(s) for next time` : ''}. Ctrl+Z undoes the whole import.`, { timeout: 7000 });
    return true;
  };

  // ---------- layout ----------
  const policySeg = h('div', { class: 'seg' }, [['merge', 'Merge'], ['skip', 'Skip'], ['new', 'Import as new']].map(([v, l]) =>
    h('button', { class: ['seg-btn', st.policy === v && 'on'], onclick: e => { st.policy = v; e.currentTarget.parentElement.querySelectorAll('.seg-btn').forEach(b => b.classList.toggle('on', b === e.currentTarget)); renderPreview(); } }, l)));
  body.append(
    h('div', { class: 'iw-top row-gap' },
      h('span', {}, '📄 ', h('b', {}, parsed.fileName), ` · ${rows.length} rows · ${headers.length} columns · into `), typeSel,
      h('span', { class: 'spacer' }), presetSel, h('button', { class: 'btn btn-sm', onclick: savePreset }, '💾 Save as preset')),
    h('div', { class: 'iw-main' }, colList, editor),
    preview,
    h('div', { class: 'iw-bottom row-gap' },
      h('span', { class: 'muted small' }, 'Existing records (same email, or same name + group):'), policySeg,
      h('label', { class: 'check-row small', title: 'Next time, columns with these names map automatically' }, h('input', { type: 'checkbox', checked: st.saveAliases, onchange: e => { st.saveAliases = e.target.checked; } }), ' Remember column names')),
    summary);

  initColumns();
  st.selected = headers.find(hd => st.cols[hd].target === 'new' && warningsFor(hd).length) || headers.find(hd => st.cols[hd].target === 'new') || headers[0];
  renderAll();
  if (st.presetName) setTimeout(() => toast(`Preset “${st.presetName}” applied automatically`), 50);

  openModal({
    title: 'Import', size: 'xxl', className: 'iw-modal', body,
    actions: [{ label: 'Cancel' }, { label: 'Import', primary: true, keepOpen: true, fn: async (api) => { if (await runImport()) api.close(); } }],
  });
}
