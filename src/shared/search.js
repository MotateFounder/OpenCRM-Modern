// Search query parser and matcher.
// Free text matches every field + notes. Tokens: key:value, -key:value, "quoted text".
// Special tokens: color:red|orange|green|none, has:files|reminder|notes|picture|<field>,
//                 due:today|overdue|week

import { valueToText, isEmptyValue } from './schema.js';
import { recordColor } from './notes.js';
import { startOfDay, parseAnyDate } from './dates.js';

const ALIASES = {
  name: 'fullName', group: 'contactGroup', groups: 'contactGroup', location: 'contactLocation',
  email: 'emailAddress', phone: 'phoneNumber', label: 'labels', tag: 'labels', tags: 'labels', url: 'urlLink',
};

export function tokenize(q) {
  const out = [];
  const re = /(-?)(?:([a-zA-Z_][\w.]*):)?(?:"([^"]*)"|(\S+))/g;
  let m;
  while ((m = re.exec(String(q || '')))) {
    const neg = m[1] === '-';
    const key = m[2] ? m[2].toLowerCase() : null;
    const value = (m[3] ?? m[4] ?? '').toLowerCase();
    if (!key && !value) continue;
    out.push({ neg, key, value });
  }
  return out;
}

function fieldForKey(type, key) {
  const defs = type.fieldDefs;
  const alias = ALIASES[key];
  return defs.find(f => f.key.toLowerCase() === key)
    || defs.find(f => f.label.toLowerCase().replace(/\s+/g, '') === key)
    || defs.find(f => f.label.toLowerCase().replace(/\s+/g, '_') === key)
    || (alias ? defs.find(f => f.key === alias) : null)
    || null;
}

export function recordSearchText(type, record, ctx = {}) {
  const parts = [];
  for (const def of type.fieldDefs) {
    if (def.type === 'image') continue;
    parts.push(valueToText(def, record[def.key], ctx));
  }
  for (const n of record.notes || []) parts.push(n.content || '');
  if (record.reminder?.text) parts.push(record.reminder.text);
  return parts.join('\n').toLowerCase();
}

export function reminderState(record, now = new Date()) {
  const r = record?.reminder;
  if (!r || !r.date || r.done) return null;
  const d = parseAnyDate(r.date);
  if (!d) return null;
  const diff = Math.round((startOfDay(d) - startOfDay(now)) / 86400000);
  if (diff < 0) return 'overdue';
  if (diff === 0) return 'today';
  if (diff <= 7) return 'week';
  return 'later';
}

export function buildMatcher(query, type, ctx = {}) {
  const tokens = tokenize(query);
  if (!tokens.length) return () => true;
  const cache = new WeakMap();
  const textOf = rec => {
    let t = cache.get(rec);
    if (t === undefined) { t = recordSearchText(type, rec, ctx); cache.set(rec, t); }
    return t;
  };
  const tests = tokens.map(tok => {
    let fn;
    if (!tok.key) fn = rec => textOf(rec).includes(tok.value);
    else if (tok.key === 'color') {
      fn = rec => {
        const c = recordColor(rec, ctx.colorRule) || 'none';
        return c === tok.value;
      };
    } else if (tok.key === 'has') {
      fn = rec => {
        switch (tok.value) {
          case 'files': case 'file': case 'attachment': case 'attachments':
            return type.fieldDefs.some(f => f.type === 'file' && !isEmptyValue(rec[f.key])) || !isEmptyValue(rec.files);
          case 'reminder': return !!(rec.reminder?.date && !rec.reminder.done);
          case 'notes': return (rec.notes || []).length > 0;
          case 'picture': return !!(type.pictureField && rec[type.pictureField]);
          case 'agent': case 'ai': return !!rec._agent || (rec.notes || []).some(n => n._agent);
          default: {
            const def = fieldForKey(type, tok.value);
            return def ? !isEmptyValue(rec[def.key]) : false;
          }
        }
      };
    } else if (tok.key === 'due') {
      fn = rec => {
        const s = reminderState(rec);
        if (tok.value === 'overdue') return s === 'overdue';
        if (tok.value === 'today') return s === 'overdue' || s === 'today';
        if (tok.value === 'week') return s === 'overdue' || s === 'today' || s === 'week';
        return !!s;
      };
    } else {
      const def = fieldForKey(type, tok.key);
      if (!def) fn = rec => textOf(rec).includes(`${tok.key}:${tok.value}`);
      else fn = rec => {
        const v = rec[def.key];
        if (Array.isArray(v) && (def.type === 'tags' || def.type === 'multiselect')) {
          return v.some(x => String(x).toLowerCase().includes(tok.value));
        }
        return valueToText(def, v, ctx).toLowerCase().includes(tok.value);
      };
    }
    return tok.neg ? rec => !fn(rec) : fn;
  });
  return rec => tests.every(t => t(rec));
}
