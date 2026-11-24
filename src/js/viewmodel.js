// Filtering + sorting of records for the current view.
import { store, currentType, records, settings } from './store.js';
import { buildMatcher, recordColor, lastContactTime, getFieldDef, selectOptionIndex, valueToText, reminderState, parseAnyDate } from './shared.js';
import { relCtx } from './editors.js';
import { semanticActive } from './semantic-ui.js';
import { lastContactFor, lastEmailFor, mailStats, mailInSearch, mailMatches } from './mail-state.js';

export function colorOf(rec) { return recordColor(rec, settings().colorRule); }

export function fieldFilterMatch(type, rec, key, values) {
  if (!values?.length) return true;
  const def = getFieldDef(type, key);
  if (!def) return true;
  const v = rec[key];
  if (Array.isArray(v)) {
    if (def.type === 'relation') return values.some(x => (x === '' ? !v.length : v.some(l => String(l.id) === x)));
    return values.some(x => (x === '' ? !v.length : v.includes(x)));
  }
  const s = v == null ? '' : String(v);
  return values.includes(s);
}

// Applies search + all filters except `skip` (used for chip counts).
export function filteredRecords({ skip = null, type = currentType(), list = records(type.key) } = {}) {
  const f = store.ui.filters;
  const sem = semanticActive() ? store.ui.semantic.results : null;
  // In AI-search mode the search box holds a natural-language question, not keywords.
  const base = sem ? (rec => sem.has(rec.id)) : buildMatcher(store.ui.query, type, { colorRule: settings().colorRule, ...relCtx });
  const match = !sem && store.ui.query && mailInSearch() ? (rec => base(rec) || mailMatches(type.key, rec, store.ui.query)) : base;
  return list.filter(rec => {
    if (!match(rec)) return false;
    if (skip !== 'colors' && f.colors.length && !f.colors.includes(colorOf(rec) || 'none')) return false;
    if (skip !== 'due' && f.due.length) {
      const s = reminderState(rec);
      const ok = f.due.some(d => (d === 'overdue' ? s === 'overdue' : d === 'today' ? (s === 'today' || s === 'overdue') : d === 'week' ? ['overdue', 'today', 'week'].includes(s) : false));
      if (!ok) return false;
    }
    for (const [key, values] of Object.entries(f.fields)) {
      if (skip === `field:${key}`) continue;
      if (!fieldFilterMatch(type, rec, key, values)) return false;
    }
    return true;
  });
}

function sortValue(type, def, rec) {
  if (!def) return null;
  switch (def.key) {
    case '_lastContact': return lastContactFor(type.key, rec) || null;
    case '_lastEmail': return lastEmailFor(type.key, rec) || null;
    case '_emails': return mailStats(type.key, rec.id)?.count || null;
    case '_lastOpened': return mailStats(type.key, rec.id)?.lastOpened || null;
    case '_engagement': return mailStats(type.key, rec.id)?.engagement ?? null;
    case '_nextAction': { const d = rec.reminder?.date && !rec.reminder.done ? parseAnyDate(rec.reminder.date) : null; return d ? d.getTime() : null; }
    case '_noteCount': return (rec.notes || []).length;
    case '_files': return type.fieldDefs.filter(f => f.type === 'file').reduce((n, f) => n + (rec[f.key]?.length || 0), 0) + (rec.files?.length || 0);
    case '_updatedAt': return rec.updatedAt ? Date.parse(rec.updatedAt) : null;
    case '_createdAt': return rec.createdAt ? Date.parse(rec.createdAt) : null;
    default: break;
  }
  const v = rec[def.key];
  if (v == null || v === '' || (Array.isArray(v) && !v.length)) return null;
  switch (def.type) {
    case 'number': return Number(v);
    case 'date': { const d = parseAnyDate(v); return d ? d.getTime() : null; }
    case 'checkbox': return v ? 1 : 0;
    case 'select': { const i = selectOptionIndex(def, v); return i < 0 ? 1e6 + 0 : i; }
    case 'url': return String(def.displayField ? (rec[def.displayField] || v) : v).toLowerCase();
    default: return valueToText(def, v, relCtx).toLowerCase();
  }
}

const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });

export function sortRecords(list, type = currentType(), sort = type.ui.sort || []) {
  if (!sort.length) return list;
  const defs = sort.map(s => ({ def: getFieldDef(type, s.key), dir: s.dir === 'desc' ? -1 : 1 }));
  const keyed = list.map(rec => ({ rec, keys: defs.map(d => sortValue(type, d.def, rec)) }));
  keyed.sort((a, b) => {
    for (let i = 0; i < defs.length; i++) {
      const x = a.keys[i], y = b.keys[i];
      if (x === y) continue;
      if (x == null) return 1; // empty values always last
      if (y == null) return -1;
      const c = typeof x === 'number' && typeof y === 'number' ? x - y : collator.compare(String(x), String(y));
      if (c) return c * defs[i].dir;
    }
    return a.rec.id - b.rec.id;
  });
  return keyed.map(k => k.rec);
}

export function visibleRecords() {
  const list = filteredRecords();
  if (semanticActive()) {
    const res = store.ui.semantic.results;
    return list.sort((a, b) => (res.get(b.id)?.score || 0) - (res.get(a.id)?.score || 0));
  }
  return sortRecords(list);
}

export function duplicateTitles(type, list) {
  const counts = new Map();
  for (const r of list) {
    const t = String(r[type.titleField] || '').trim().toLowerCase();
    if (t) counts.set(t, (counts.get(t) || 0) + 1);
  }
  return new Set([...counts].filter(([, n]) => n > 1).map(([t]) => t));
}
