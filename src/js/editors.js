// Value display + inline editors for every field type (schema-driven).
import { h, externalHref, fmtSize } from './dom.js';
import { store, findRecord, settings } from './store.js';
import { formatDate, parseAnyDate, toIsoDate, normalizeTags, getType, recordTitle, selectOptionIndex, distinctValues } from './shared.js';
import { popover, closePopover, toast } from './ui.js';

export function relationName(def, id) {
  const t = getType(store.data, def.target);
  const r = t ? findRecord(t.key, id) : null;
  return r ? recordTitle(t, r) : `#${id} (missing)`;
}

export const relCtx = { resolveRelation: (def, id) => relationName(def, id) };

function copyText(text, what = 'Copied') {
  window.crm.app.clipboard(text);
  toast(`${what}: ${text}`, { timeout: 1800 });
}

export function optionPill(def, value, { orphanMark = true } = {}) {
  const opt = def.options?.find(o => o.value === value);
  return h('span', { class: ['pill', !opt && orphanMark && 'orphan'], title: opt ? '' : 'Not in the option list', style: opt?.color ? { '--pill': opt.color } : null },
    h('span', { class: 'dot' }), value, !opt && orphanMark ? ' ⚠' : null);
}

// ---------- display ----------
export function displayValue(def, value, { record, compact = false } = {}) {
  const empty = value == null || value === '' || (Array.isArray(value) && !value.length);
  if (empty && def.type !== 'checkbox') return compact ? '' : h('span', { class: 'placeholder' }, '—');
  switch (def.type) {
    case 'url': {
      const label = (def.displayField && record?.[def.displayField]) || (compact ? shortUrl(value) : value);
      return h('a', { href: externalHref(value), class: 'ext', title: value, onclick: e => e.stopPropagation() }, label);
    }
    case 'email':
      return h('a', {
        href: `mailto:${value}`, title: 'Click: copy · Ctrl+Click: open mail app',
        onclick: (e) => { e.preventDefault(); e.stopPropagation(); if (e.ctrlKey || e.metaKey) window.crm.app.openExternal(`mailto:${value}`); else copyText(value, 'Email copied'); },
      }, value);
    case 'phone':
      return h('span', { class: 'copyable', title: 'Click to copy', onclick: (e) => { e.stopPropagation(); copyText(value, 'Phone copied'); } }, value);
    case 'tags':
      return compact ? value.join(', ') : h('span', { class: 'chips' }, value.map(t => h('span', { class: 'chip' }, t)));
    case 'select':
      return optionPill(def, value);
    case 'multiselect':
      return h('span', { class: 'chips' }, value.map(v => optionPill(def, v)));
    case 'date':
      return formatDate(value, settings().dateFormat);
    case 'number':
      return Number.isFinite(value) ? value.toLocaleString() : String(value);
    case 'checkbox':
      return value ? '✓' : (compact ? '' : h('span', { class: 'placeholder' }, '—'));
    case 'relation':
      return compact
        ? value.map(l => relationName(def, l.id) + (l.v ? ` (${l.v})` : '')).join(', ')
        : h('span', { class: 'chips' }, value.map(l => h('span', { class: 'chip rel-chip' }, relationName(def, l.id), l.v ? h('small', {}, ` · ${l.v}`) : null)));
    case 'file':
      return compact ? `📎 ${value.length}` : h('span', {}, value.map(f => f.name).join(', '));
    case 'markdown':
      return h('span', { class: 'muted' }, `${String(value).length} chars`);
    case 'longtext':
      return compact ? String(value).replace(/\s+/g, ' ').slice(0, 120) : h('span', { class: 'pre' }, value);
    default:
      return String(value);
  }
}

function shortUrl(u) {
  try { const x = new URL(externalHref(u)); return x.hostname.replace(/^www\./, '') + (x.pathname.length > 1 ? x.pathname.slice(0, 18) : ''); } catch { return u; }
}

// ---------- editors ----------
// Returns an element. commit(newValue) persists, cancel() restores display.
export function makeEditor(def, value, { record, type, commit, cancel, onEditOptions }) {
  const keys = (el, getVal, { multiline = false } = {}) => {
    el.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); cancel(); }
      else if (e.key === 'Enter' && (!multiline || e.ctrlKey)) { e.preventDefault(); commit(getVal()); }
    });
    el.addEventListener('blur', () => setTimeout(() => { if (el.isConnected) commit(getVal()); }, 120));
    setTimeout(() => { el.focus(); el.select?.(); }, 0);
    return el;
  };
  switch (def.type) {
    case 'longtext': {
      const ta = h('textarea', { class: 'input', rows: 4, value: value ?? '' });
      return keys(ta, () => ta.value, { multiline: true });
    }
    case 'number': {
      const inp = h('input', { class: 'input', type: 'number', step: 'any', value: value ?? '' });
      return keys(inp, () => (inp.value === '' ? null : Number(inp.value)));
    }
    case 'date': {
      const inp = h('input', { class: 'input', type: 'date', value: toIsoDate(parseAnyDate(value)) || '' });
      return keys(inp, () => inp.value);
    }
    case 'checkbox': {
      const cb = h('input', { type: 'checkbox', checked: !!value });
      cb.addEventListener('change', () => commit(cb.checked));
      setTimeout(() => cb.focus(), 0);
      cb.addEventListener('blur', () => setTimeout(() => { if (cb.isConnected) cancel(); }, 150));
      return cb;
    }
    case 'select': {
      const sel = h('select', { class: 'input' },
        h('option', { value: '' }, '— empty —'),
        (def.options || []).map(o => h('option', { value: o.value, selected: o.value === value }, o.value)),
        value && selectOptionIndex(def, value) < 0 ? h('option', { value, selected: true }, `${value} ⚠`) : null,
        onEditOptions ? h('option', { value: '__edit__' }, '✎ Edit options…') : null);
      sel.addEventListener('change', () => {
        if (sel.value === '__edit__') { cancel(); onEditOptions(); return; }
        commit(sel.value);
      });
      sel.addEventListener('keydown', e => { if (e.key === 'Escape') { e.stopPropagation(); cancel(); } });
      sel.addEventListener('blur', () => setTimeout(() => { if (sel.isConnected) cancel(); }, 150));
      setTimeout(() => { sel.focus(); try { if (sel.isConnected) sel.showPicker?.(); } catch { /* not rendered yet */ } }, 30);
      return sel;
    }
    case 'multiselect': return multiEditor(def, value || [], { commit, cancel, onEditOptions });
    case 'tags': {
      const list = h('datalist', { id: `dl-${def.key}` }, distinctValues(store.data, type.key, def.key).map(v => h('option', { value: v.value })));
      const inp = h('input', { class: 'input', value: (value || []).join(', '), list: `dl-${def.key}`, placeholder: 'comma, separated, tags' });
      keys(inp, () => normalizeTags(inp.value));
      return h('span', { class: 'editor-wrap' }, inp, list);
    }
    case 'relation': return relationEditor(def, value || [], { commit, cancel });
    default: {
      const inp = h('input', { class: 'input', type: def.type === 'email' ? 'email' : def.type === 'url' ? 'url' : def.type === 'phone' ? 'tel' : 'text', value: value ?? '' });
      return keys(inp, () => inp.value.trim());
    }
  }
}

function multiEditor(def, value, { commit, cancel, onEditOptions }) {
  const chosen = new Set(value);
  const btn = h('button', { class: 'btn btn-sm' }, 'Choose…');
  const open = () => {
    const opts = [...(def.options || []).map(o => o.value), ...value.filter(v => !def.options?.some(o => o.value === v))];
    popover(btn, h('div', { class: 'check-list' },
      opts.map(v => h('label', { class: 'check-row' },
        h('input', { type: 'checkbox', checked: chosen.has(v), onchange: e => { e.target.checked ? chosen.add(v) : chosen.delete(v); } }),
        optionPill(def, v))),
      onEditOptions ? h('button', { class: 'btn-link', onclick: () => { closePopover(); cancel(); onEditOptions(); } }, '✎ Edit options…') : null,
    ), { onClose: () => commit(opts.filter(v => chosen.has(v))) });
  };
  btn.onclick = open;
  setTimeout(open, 0);
  return btn;
}

function relationEditor(def, value, { commit, cancel }) {
  const target = getType(store.data, def.target);
  const links = value.map(l => ({ ...l }));
  const wrap = h('div', { class: 'rel-editor' });
  const render = () => {
    wrap.replaceChildren(
      ...links.map((l, i) => h('div', { class: 'rel-row' },
        h('span', { class: 'chip rel-chip' }, relationName(def, l.id)),
        def.linkOptions?.length ? h('select', { class: 'input input-sm', onchange: e => { l.v = e.target.value; } },
          h('option', { value: '' }, `${def.linkLabel || 'Status'}…`),
          def.linkOptions.map(o => h('option', { value: o.value, selected: o.value === l.v }, o.value))) : null,
        h('button', { class: 'icon-btn', title: 'Remove link', onclick: () => { links.splice(i, 1); render(); } }, '×'))),
      h('div', { class: 'rel-actions' },
        h('button', { class: 'btn btn-sm', onclick: (e) => pickRecord(e.currentTarget, target, links.map(l => l.id), (id) => { links.push({ id }); render(); }) }, `+ Link ${target?.singular || 'record'}`),
        h('button', { class: 'btn btn-sm btn-primary', onclick: () => commit(links) }, 'Done'),
        h('button', { class: 'btn btn-sm', onclick: cancel }, 'Cancel')));
  };
  render();
  return wrap;
}

export function pickRecord(anchor, type, excludeIds, onPick, { allowCreate = true } = {}) {
  if (!type) { toast('Target record type not found', { type: 'error' }); return; }
  const input = h('input', { class: 'input', placeholder: `Search ${type.label}…`, autofocus: true });
  const list = h('div', { class: 'pick-list' });
  const refresh = () => {
    const q = input.value.trim().toLowerCase();
    const recs = (store.data[type.key] || []).filter(r => !excludeIds.includes(r.id) && recordTitle(type, r).toLowerCase().includes(q)).slice(0, 50);
    list.replaceChildren(
      ...recs.map(r => h('div', { class: 'pick-item', onclick: () => { closePopover(); onPick(r.id); } }, recordTitle(type, r))),
      allowCreate && q ? h('div', { class: 'pick-item create', onclick: () => {
        closePopover();
        const id = (store.data[type.key] || []).reduce((m, r) => Math.max(m, r.id), 0) + 1;
        const now = new Date().toISOString();
        store.data[type.key].push({ id, [type.titleField]: input.value.trim(), labels: [], info: '', notes: [], createdAt: now, updatedAt: now });
        onPick(id);
      } }, `+ Create ${type.singular} “${input.value.trim()}”`) : null,
      !recs.length && !q ? h('div', { class: 'muted small pad' }, 'Type to search') : null,
    );
  };
  input.addEventListener('input', refresh);
  input.addEventListener('keydown', e => { if (e.key === 'Enter') list.querySelector('.pick-item')?.click(); if (e.key === 'Escape') closePopover(); });
  popover(anchor, h('div', { class: 'picker' }, input, list));
  refresh();
  setTimeout(() => input.focus(), 0);
}

export function fileList(refs, { onOpen, onReveal, onRemove, onExtract }) {
  if (!refs?.length) return h('div', { class: 'muted small' }, 'No files. Drop files here or click “+ Attach”.');
  return h('div', { class: 'file-list' }, refs.map(f => h('div', { class: 'file-item' },
    h('span', { class: 'file-icon' }, fileIcon(f.name)),
    h('a', { class: 'file-name', href: '#', title: 'Open with default app', onclick: e => { e.preventDefault(); onOpen(f); } }, f.name),
    h('span', { class: 'muted small' }, fmtSize(f.size)),
    onExtract && /\.(pdf|docx|txt|md|html?)$/i.test(f.name) ? h('button', { class: 'icon-btn', title: 'Fill fields from this document with AI', onclick: () => onExtract(f) }, '✨') : null,
    h('button', { class: 'icon-btn', title: 'Show in folder', onclick: () => onReveal(f) }, '📂'),
    h('button', { class: 'icon-btn', title: 'Remove (moved to .trash)', onclick: () => onRemove(f) }, '×'))));
}

function fileIcon(name) {
  if (/\.pdf$/i.test(name)) return '📕';
  if (/\.(docx?|odt|rtf)$/i.test(name)) return '📘';
  if (/\.(xlsx?|csv|ods)$/i.test(name)) return '📗';
  if (/\.(png|jpe?g|gif|webp|svg)$/i.test(name)) return '🖼';
  return '📄';
}
