// Operations that change a field definition and (optionally) the data stored under it.
// All functions mutate `data` in place and return a short summary.

import { normalizeTags, COLOR_PALETTE } from './schema.js';
import { parseAnyDate, toIsoDate } from './dates.js';

export function recordsUsing(data, typeKey, fieldKey, value) {
  return (data[typeKey] || []).filter(r => {
    const v = r[fieldKey];
    if (Array.isArray(v)) return value === undefined ? v.length > 0 : v.includes(value);
    return value === undefined ? (v != null && v !== '' && v !== false) : v === value;
  });
}

export function renameOption(data, typeKey, def, oldValue, newValue, { updateRecords = true } = {}) {
  const opt = def.options.find(o => o.value === oldValue);
  if (!opt) return 0;
  opt.value = newValue;
  let n = 0;
  if (updateRecords) {
    for (const r of data[typeKey] || []) {
      if (def.type === 'multiselect' && Array.isArray(r[def.key])) {
        const i = r[def.key].indexOf(oldValue);
        if (i >= 0) { r[def.key][i] = newValue; r[def.key] = normalizeTags(r[def.key]); n++; }
      } else if (r[def.key] === oldValue) { r[def.key] = newValue; n++; }
    }
  }
  return n;
}

export function deleteOption(data, typeKey, def, value, replacement = '') {
  def.options = def.options.filter(o => o.value !== value);
  let n = 0;
  for (const r of data[typeKey] || []) {
    if (def.type === 'multiselect' && Array.isArray(r[def.key])) {
      if (r[def.key].includes(value)) {
        r[def.key] = normalizeTags(r[def.key].map(v => (v === value ? replacement : v)).filter(Boolean));
        n++;
      }
    } else if (r[def.key] === value) { r[def.key] = replacement; n++; }
  }
  return n;
}

export function distinctValues(data, typeKey, fieldKey) {
  const counts = new Map();
  for (const r of data[typeKey] || []) {
    const v = r[fieldKey];
    const vals = Array.isArray(v) ? v : [v];
    for (const x of vals) {
      if (x == null || x === '') continue;
      const s = String(x).trim();
      if (!s) continue;
      counts.set(s, (counts.get(s) || 0) + 1);
    }
  }
  return [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).map(([value, count]) => ({ value, count }));
}

export function optionsFromValues(values) {
  return values.map((v, i) => ({ value: v.value ?? v, color: COLOR_PALETTE[i % COLOR_PALETTE.length] }));
}

// Converts a field to a new type, transforming stored values when needed.
export function convertFieldType(data, typeKey, def, newType) {
  const old = def.type;
  if (old === newType) return { converted: 0 };
  const records = data[typeKey] || [];
  let converted = 0;
  if ((newType === 'select' || newType === 'multiselect') && !(old === 'select' || old === 'multiselect')) {
    const vals = distinctValues(data, typeKey, def.key);
    def.options = optionsFromValues(vals);
  }
  for (const r of records) {
    const v = r[def.key];
    if (v == null) continue;
    let nv = v;
    switch (newType) {
      case 'tags': case 'multiselect':
        nv = normalizeTags(Array.isArray(v) ? v : String(v));
        break;
      case 'select': case 'text': case 'longtext': case 'markdown': case 'url': case 'email': case 'phone':
        nv = Array.isArray(v) ? (newType === 'select' ? (v[0] ?? '') : v.join(', ')) : (typeof v === 'boolean' ? (v ? 'Yes' : '') : String(v));
        break;
      case 'number': {
        const num = parseFloat(String(Array.isArray(v) ? v[0] : v).replace(',', '.'));
        nv = Number.isFinite(num) ? num : null;
        break;
      }
      case 'checkbox':
        nv = !!v && v !== 'No' && v !== 'false' && v !== '0' && !(Array.isArray(v) && !v.length);
        break;
      case 'date': {
        const d = parseAnyDate(Array.isArray(v) ? v[0] : v);
        nv = d ? toIsoDate(d) : '';
        break;
      }
      default: break;
    }
    if (JSON.stringify(nv) !== JSON.stringify(v)) { r[def.key] = nv; converted++; }
  }
  def.type = newType;
  if (newType !== 'select' && newType !== 'multiselect') delete def.options;
  return { converted };
}

export function deleteField(data, typeKey, def) {
  const type = data.meta.recordTypes.find(t => t.key === typeKey);
  type.fieldDefs = type.fieldDefs.filter(f => f !== def);
  type.ui.columns = type.ui.columns.filter(c => c !== def.key);
  let n = 0;
  for (const r of data[typeKey] || []) if (def.key in r) { delete r[def.key]; n++; }
  return n;
}
