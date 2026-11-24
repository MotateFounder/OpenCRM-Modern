// Migration of v1 ({contacts:[...]}) and v2 databases to schema v3, plus validation.
// v1 keys are kept untouched so a migrated file stays readable by humans and by v1 logic.

import {
  SCHEMA_VERSION, RESERVED_KEYS, defaultMeta, defaultSettings, makeContactsType,
  makeGenericType, normalizeTags, newNoteId,
} from './schema.js';
import { parseAnyDate } from './dates.js';
import { starterPrompts } from './templates.js';
import { defaultBrand, defaultMailSettings, starterEmailTemplates } from './email-templates.js';

function guessTypeFromValues(values) {
  const nonEmpty = values.filter(v => v != null && v !== '');
  if (nonEmpty.length && nonEmpty.every(v => Array.isArray(v))) return 'tags';
  if (nonEmpty.length && nonEmpty.every(v => typeof v === 'number')) return 'number';
  if (nonEmpty.length && nonEmpty.every(v => typeof v === 'boolean')) return 'checkbox';
  if (nonEmpty.some(v => typeof v === 'string' && /\n/.test(v))) return 'longtext';
  return 'text';
}

function prettyLabel(key) {
  return String(key).replace(/([a-z])([A-Z])/g, '$1 $2').replace(/[_-]+/g, ' ')
    .replace(/^./, c => c.toUpperCase());
}

function normalizeRecord(rec, type, idSet, nextIdRef) {
  if (!rec || typeof rec !== 'object') return null;
  let id = Number(rec.id);
  if (!Number.isFinite(id) || id <= 0 || idSet.has(id)) id = nextIdRef.value++;
  idSet.add(id);
  rec.id = id;
  if (id >= nextIdRef.value) nextIdRef.value = id + 1;

  if (!Array.isArray(rec.notes)) rec.notes = [];
  rec.notes = rec.notes.filter(n => n && typeof n === 'object').map(n => ({
    ...n,
    id: n.id || newNoteId(),
    date: n.date || '',
    time: n.time || '',
    content: String(n.content ?? ''),
  }));

  for (const def of type.fieldDefs) {
    if (def.type === 'tags' || def.type === 'multiselect') {
      if (rec[def.key] !== undefined) rec[def.key] = normalizeTags(rec[def.key]);
    }
  }
  if (type.key === 'contacts') {
    rec.labels = normalizeTags(rec.labels);
    for (const k of ['fullName', 'contactGroup', 'contactLocation', 'emailAddress', 'phoneNumber', 'urlName', 'urlLink', 'picture']) {
      if (rec[k] == null) rec[k] = '';
      else if (typeof rec[k] !== 'string') rec[k] = String(rec[k]);
    }
  }
  if (rec.info == null) rec.info = '';
  if (!rec.createdAt) {
    let first = Infinity;
    for (const n of rec.notes) { const d = parseAnyDate(n.date, n.time); if (d) first = Math.min(first, d.getTime()); }
    rec.createdAt = Number.isFinite(first) ? new Date(first).toISOString() : new Date().toISOString();
  }
  if (!rec.updatedAt) rec.updatedAt = rec.createdAt;
  return rec;
}

// Returns { data, fromVersion, changed, notes: [] }
export function migrate(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new Error('Database must be a JSON object.');
  }
  const data = input;
  const fromVersion = Number(data.schemaVersion) || (data.meta ? 2 : 1);
  const log = [];

  if (!Array.isArray(data.contacts)) data.contacts = [];
  if (!data.meta || typeof data.meta !== 'object') { data.meta = defaultMeta(); log.push('Created meta section.'); }
  const meta = data.meta;

  // v2 had meta.fieldDefs (contacts only) — fold into recordTypes.
  if (!Array.isArray(meta.recordTypes)) {
    const contacts = makeContactsType();
    if (Array.isArray(meta.fieldDefs)) {
      for (const def of meta.fieldDefs) {
        if (!contacts.fieldDefs.some(f => f.key === def.key)) contacts.fieldDefs.push(def);
      }
      delete meta.fieldDefs;
    }
    if (meta.ui?.columns) contacts.ui.columns = meta.ui.columns;
    meta.recordTypes = [contacts];
  }
  if (!meta.recordTypes.some(t => t.key === 'contacts')) meta.recordTypes.unshift(makeContactsType());
  meta.views = Array.isArray(meta.views) ? meta.views : [];
  meta.prompts = Array.isArray(meta.prompts) ? meta.prompts : [];
  if (fromVersion < 3 && !meta.prompts.length) { meta.prompts = starterPrompts(); log.push('Added starter AI prompts.'); }
  meta.settings = { ...defaultSettings(), ...(meta.settings || {}) };
  // v4: email
  meta.settings.mail = { ...defaultMailSettings(), ...(meta.settings.mail || {}) };
  if (!Array.isArray(meta.emailTemplates)) { meta.emailTemplates = starterEmailTemplates(); if (fromVersion < 4) log.push('Added starter email templates.'); }
  meta.brand = { ...defaultBrand(), ...(meta.brand || {}) };
  meta.mailRules = Array.isArray(meta.mailRules) ? meta.mailRules : [];

  for (const type of meta.recordTypes) {
    const base = type.key === 'contacts' ? makeContactsType() : makeGenericType(type.key, type.label || type.key);
    type.label = type.label || base.label;
    type.singular = type.singular || base.singular;
    type.titleField = type.titleField || base.titleField;
    if (type.pictureField === undefined) type.pictureField = base.pictureField;
    type.fieldDefs = Array.isArray(type.fieldDefs) ? type.fieldDefs : [];
    // ensure built-ins exist
    for (const b of base.fieldDefs) {
      if (!type.fieldDefs.some(f => f.key === b.key)) type.fieldDefs.push(b);
    }
    for (const f of type.fieldDefs) {
      if (f.showInTable === undefined) f.showInTable = true;
      if (f.showInCard === undefined) f.showInCard = true;
      if (f.aiContext === undefined) f.aiContext = f.type !== 'image' && f.type !== 'file';
      if ((f.type === 'select' || f.type === 'multiselect') && !Array.isArray(f.options)) f.options = [];
    }
    type.ui = { ...base.ui, ...(type.ui || {}) };
    if (!Array.isArray(type.ui.columns) || !type.ui.columns.length) type.ui.columns = [...base.ui.columns];
    if (!Array.isArray(type.ui.sort)) type.ui.sort = [...base.ui.sort];
    type.ui.columnWidths = type.ui.columnWidths || {};

    if (!Array.isArray(data[type.key])) data[type.key] = [];
    const records = data[type.key];

    // Discover unknown keys (hand-edited or imported data) and register them as fields.
    const known = new Set(type.fieldDefs.map(f => f.key));
    const unknown = new Map();
    for (const rec of records) {
      if (!rec || typeof rec !== 'object') continue;
      for (const k of Object.keys(rec)) {
        if (known.has(k) || RESERVED_KEYS.has(k) || k.startsWith('_')) continue;
        if (!unknown.has(k)) unknown.set(k, []);
        unknown.get(k).push(rec[k]);
      }
    }
    for (const [k, values] of unknown) {
      const t = guessTypeFromValues(values);
      if (values.some(v => v && typeof v === 'object' && !Array.isArray(v))) continue; // ignore nested objects
      type.fieldDefs.push({ key: k, label: prettyLabel(k), type: t, showInTable: false, showInCard: true, aiContext: true });
      log.push(`Registered field "${k}" (${t}) on ${type.label}.`);
    }

    const idSet = new Set();
    const nextIdRef = { value: records.reduce((m, r) => Math.max(m, Number(r?.id) || 0), 0) + 1 };
    data[type.key] = records.map(r => normalizeRecord(r, type, idSet, nextIdRef)).filter(Boolean);
  }

  const changed = fromVersion !== SCHEMA_VERSION || log.length > 0;
  data.schemaVersion = SCHEMA_VERSION;
  // keep schemaVersion/meta first in the written JSON for readability
  const ordered = { schemaVersion: data.schemaVersion, meta: data.meta };
  for (const k of Object.keys(data)) if (!(k in ordered)) ordered[k] = data[k];
  return { data: ordered, fromVersion, changed, log };
}

export function validate(data) {
  const errors = [];
  if (!data || typeof data !== 'object') return ['Not an object'];
  if (!data.meta || !Array.isArray(data.meta.recordTypes)) errors.push('meta.recordTypes missing');
  else {
    for (const t of data.meta.recordTypes) {
      if (!t.key || !Array.isArray(data[t.key])) errors.push(`records for type "${t.key}" missing`);
      const keys = new Set();
      for (const f of t.fieldDefs || []) {
        if (!f.key) errors.push(`field without key in ${t.key}`);
        if (keys.has(f.key)) errors.push(`duplicate field key ${f.key} in ${t.key}`);
        keys.add(f.key);
      }
      const ids = new Set();
      for (const r of data[t.key] || []) {
        if (ids.has(r.id)) errors.push(`duplicate id ${r.id} in ${t.key}`);
        ids.add(r.id);
      }
    }
  }
  return errors;
}

export function countRecords(data) {
  const out = {};
  for (const t of data?.meta?.recordTypes || []) out[t.key] = (data[t.key] || []).length;
  if (!data?.meta && Array.isArray(data?.contacts)) out.contacts = data.contacts.length;
  return out;
}

