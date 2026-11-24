// Import engine (pure): column -> field matching, per-column formatting, validation,
// row -> record conversion, duplicate detection and merge.

import { normalizeTags, newNoteId, slugKey, COLOR_PALETTE } from './schema.js';
import { toIsoDate, noteDateString, noteTimeString } from './dates.js';

// ---------------------------------------------------------------------------
// Name normalisation & matching
// ---------------------------------------------------------------------------

const stripAccents = s => String(s || '').normalize('NFKD').replace(/[̀-ͯ]/g, '');

// "Profiles" -> "profile", "E-mail address" -> "emailaddress", "Teléfonos" -> "telefono"
export function normName(s) {
  return stripAccents(s).toLowerCase().replace(/[^a-z0-9]/g, '');
}

function singularWord(w) {
  if (w.length <= 3) return w;
  if (/ies$/.test(w)) return w.slice(0, -3) + 'y';
  if (/(ss|us|is)$/.test(w)) return w;
  if (/(ches|shes|xes|zes|sses)$/.test(w)) return w.slice(0, -2);
  if (/s$/.test(w)) return w.slice(0, -1);
  return w;
}

// Normalises word by word so "Phone Numbers" -> "phonenumber"
export function normSingular(s) {
  return stripAccents(s).toLowerCase().split(/[^a-z0-9]+/).filter(Boolean).map(singularWord).join('');
}

// Groups of equivalent column names (normalised, singular). The first entry of a group may be a
// built-in field key (marked with '='), which lets well-known exports map onto built-in fields.
const GROUPS = [
  ['=fullName', 'name', 'fullname', 'displayname', 'contactname', 'nombre', 'nombrecompleto', 'contact', 'person', 'candidate', 'candidato'],
  ['=_first', 'firstname', 'givenname', 'first', 'forename', 'nombrepila'],
  ['=_last', 'lastname', 'familyname', 'surname', 'last', 'apellido', 'apellidos'],
  ['=picture', 'picture', 'image', 'photo', 'avatar', 'foto', 'imagen', 'headshot', 'profilepicture', 'profilephoto', 'pic', 'thumbnail'],
  ['=emailAddress', 'email', 'emailaddress', 'mail', 'email1value', 'email1', 'primaryemail', 'correo', 'correoelectronico', 'emailid'],
  ['=phoneNumber', 'phone', 'phonenumber', 'telephone', 'tel', 'mobile', 'mobilephone', 'cell', 'cellphone', 'phone1value', 'telefono', 'movil', 'celular', 'whatsapp', 'businessphone', 'homephone'],
  ['=contactGroup', 'company', 'organization', 'organisation', 'organizationname', 'organization1name', 'employer', 'empresa', 'group', 'contactgroup', 'account', 'compania', 'firm', 'business'],
  ['=contactLocation', 'location', 'city', 'ciudad', 'country', 'pais', 'address', 'direccion', 'region', 'homecity', 'businesscity', 'contactlocation', 'localidad', 'ubicacion', 'state', 'provincia'],
  ['=urlLink', 'url', 'website', 'web', 'site', 'linkedin', 'linkedinurl', 'profileurl', 'webpage', 'website1value', 'urllink', 'link', 'sitioweb', 'enlace'],
  ['=labels', 'label', 'tag', 'category', 'keyword', 'skill', 'etiqueta', 'habilidad', 'competencia', 'topic'],
  ['=info', 'info', 'description', 'about', 'bio', 'summary', 'resumen', 'descripcion', 'profile', 'perfil', 'notes', 'note', 'nota', 'comment', 'comentario'],
  ['position', 'jobtitle', 'title', 'role', 'cargo', 'puesto', 'occupation', 'job', 'headline'],
  ['salary', 'salaryexpectation', 'compensation', 'pay', 'salario', 'sueldo', 'rate', 'expectedsalary'],
  ['birthday', 'birthdate', 'dateofbirth', 'dob', 'cumpleano', 'fechanacimiento', 'fechadenacimiento'],
  ['stage', 'status', 'phase', 'estado', 'etapa', 'pipeline', 'pipelinestage'],
  ['source', 'origin', 'channel', 'fuente', 'origen', 'leadsource', 'canal'],
  ['industry', 'sector', 'industria', 'vertical'],
  ['resume', 'cv', 'curriculum', 'curriculumvitae'],
  ['availability', 'disponibilidad', 'noticeperiod', 'startdate'],
  ['language', 'idioma', 'lengua'],
  ['connectedon', 'connectiondate', 'datecontacted', 'firstcontact', 'fechacontacto'],
];
const GROUP_OF = new Map();
const BUILTIN_OF_GROUP = [];
GROUPS.forEach((g, i) => {
  for (const w of g) {
    if (w.startsWith('=')) { BUILTIN_OF_GROUP[i] = w.slice(1); continue; }
    if (!GROUP_OF.has(w)) GROUP_OF.set(w, i);
  }
});

function groupOf(name) {
  const n = normSingular(name);
  if (GROUP_OF.has(n)) return GROUP_OF.get(n);
  const raw = normName(name);
  return GROUP_OF.has(raw) ? GROUP_OF.get(raw) : -1;
}

export function levenshtein(a, b) {
  if (a === b) return 0;
  if (!a.length) return b.length;
  if (!b.length) return a.length;
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    for (let j = 1; j <= b.length; j++) cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    prev = cur;
  }
  return prev[b.length];
}

// Names a field answers to: key, label, remembered aliases.
function fieldNames(def) {
  return [def.key, def.label, ...(def.aliases || [])].filter(Boolean);
}

// How well a column header matches a field (0..1) and why.
export function matchScore(header, def) {
  const hN = normName(header), hS = normSingular(header);
  if (!hN) return { score: 0, reason: '' };
  let best = { score: 0, reason: '' };
  const consider = (score, reason) => { if (score > best.score) best = { score, reason }; };
  for (const name of fieldNames(def)) {
    const fN = normName(name), fS = normSingular(name);
    if (!fN) continue;
    if (hN === fN) consider(1, 'same name');
    else if (hS === fS) consider(0.97, 'same name (singular/plural)');
    else {
      const len = Math.max(hS.length, fS.length);
      if (len >= 5) {
        const d = levenshtein(hS, fS);
        const ratio = 1 - d / len;
        if (d <= 2 && ratio >= 0.75) consider(0.85 + (ratio - 0.75) * 0.4, 'almost the same name (typo)');
      }
      if (Math.min(hS.length, fS.length) >= 5 && (hS.includes(fS) || fS.includes(hS))) consider(0.72, 'one name contains the other');
    }
  }
  const g = groupOf(header);
  if (g >= 0) {
    if (BUILTIN_OF_GROUP[g] === def.key) consider(0.92, 'common name for this field');
    if (fieldNames(def).some(n => groupOf(n) === g)) consider(0.9, 'equivalent name');
  }
  return best;
}

// Existing fields similar to a name (to warn before creating near-duplicates).
export function similarFields(name, type, minScore = 0.7) {
  return type.fieldDefs
    .map(def => ({ def, ...matchScore(name, def) }))
    .filter(x => x.score >= minScore)
    .sort((a, b) => b.score - a.score);
}

const AUTO_THRESHOLD = 0.8;

// Returns { mapping: {header: target}, info: {header: {score, reason}} }
// target = field key | '_first' | '_last' | 'note' | 'ignore' | 'new'
export function autoMapDetailed(headers, type) {
  const mapping = {};
  const info = {};
  const candidates = [];
  for (const h of headers) {
    for (const def of type.fieldDefs) {
      if (['file', 'relation'].includes(def.type)) continue;
      const m = matchScore(h, def);
      if (m.score >= AUTO_THRESHOLD) candidates.push({ h, key: def.key, ...m });
    }
    const g = groupOf(h);
    if (g >= 0 && (BUILTIN_OF_GROUP[g] === '_first' || BUILTIN_OF_GROUP[g] === '_last')) candidates.push({ h, key: BUILTIN_OF_GROUP[g], score: 0.95, reason: 'name part' });
  }
  // greedy: best scores first, one column per field (name parts excepted)
  candidates.sort((a, b) => b.score - a.score);
  const usedFields = new Set();
  for (const c of candidates) {
    if (mapping[c.h]) continue;
    if (!c.key.startsWith('_') && usedFields.has(c.key)) continue;
    mapping[c.h] = c.key;
    info[c.h] = { score: c.score, reason: c.reason };
    if (!c.key.startsWith('_')) usedFields.add(c.key);
  }
  for (const h of headers) if (!mapping[h]) { mapping[h] = 'new'; info[h] = { score: 0, reason: '' }; }
  // First + Last only when there is no direct name column
  const hasTitle = Object.values(mapping).includes(type.titleField);
  for (const [h, t] of Object.entries(mapping)) {
    if (t === '_first' || t === '_last') {
      if (hasTitle) { mapping[h] = 'ignore'; info[h] = { score: 0, reason: 'name column already mapped' }; }
    }
  }
  return { mapping, info };
}

export function autoMap(headers, type) { return autoMapDetailed(headers, type).mapping; }

// ---------------------------------------------------------------------------
// Per-column formatting (transforms)
// ---------------------------------------------------------------------------

export function defaultTransform() {
  return {
    trim: true, // trim + collapse inner whitespace
    case: 'none', // none | title | sentence | lower | upper
    replace: [], // [{ find, with, regex }]
    emptyValue: '', // used when the cell is empty
    split: 'auto', // tags / multiselect separator: auto | , | ; | | | / | newline | space
    dateOrder: 'auto', // auto | DMY | MDY | YMD
    numberFormat: 'auto', // auto | eu (1.234,5) | us (1,234.5)
    valueMap: {}, // select/multiselect: incoming value -> option value ('' = empty)
    addNewOptions: true, // select/multiselect: unknown values become new options
  };
}

const titleCase = s => s.toLowerCase().replace(/(^|[\s\-/'(])(\p{L})/gu, (m, a, b) => a + b.toUpperCase());

export function applyTextTransform(raw, t = {}) {
  let v = raw == null ? '' : String(raw);
  if (t.trim !== false) v = v.replace(/[ \t ]+/g, ' ').replace(/\s*\n\s*/g, '\n').trim();
  for (const r of t.replace || []) {
    if (!r?.find) continue;
    try {
      // plain text: case-insensitive (like spreadsheet find & replace); regex: as written
      const re = r.regex ? new RegExp(r.find, 'g') : new RegExp(r.find.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi');
      v = r.regex ? v.replace(re, r.with ?? '') : v.replace(re, () => r.with ?? ''); // regex keeps $1 references
    } catch { /* invalid regex: ignore */ }
  }
  switch (t.case) {
    case 'title': v = titleCase(v); break;
    case 'sentence': v = v.charAt(0).toUpperCase() + v.slice(1).toLowerCase(); break;
    case 'lower': v = v.toLowerCase(); break;
    case 'upper': v = v.toUpperCase(); break;
    default: break;
  }
  if (!v && t.emptyValue) v = String(t.emptyValue);
  return v;
}

const SPLITTERS = { ',': /,/, ';': /;/, '|': /\|/, '/': /\//, newline: /\n/, space: /\s+/ };
export function splitList(v, mode = 'auto') {
  if (!v) return [];
  const re = mode === 'auto' ? /[,;|\n]/ : SPLITTERS[mode] || /,/;
  return normalizeTags(String(v).split(re));
}

const MONTHS = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12, ene: 1, abr: 4, ago: 8, dic: 12 };

// Parses a date honouring the chosen order. Returns { iso, ambiguous } or null.
export function parseDateOrdered(s, order = 'auto') {
  const v = String(s || '').trim();
  if (!v) return null;
  let m = v.match(/^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})/);
  if (m) return mk(+m[1], +m[2], +m[3], false);
  m = v.match(/^(\d{1,2})[-/. ]([A-Za-zÀ-ÿ]{3,})\.?[-/. ,]+(\d{2,4})$/); // 05 Jan 2024
  if (m && MONTHS[stripAccents(m[2]).toLowerCase().slice(0, 3)]) return mk(year(m[3]), MONTHS[stripAccents(m[2]).toLowerCase().slice(0, 3)], +m[1], false);
  m = v.match(/^([A-Za-z]{3,})\.? (\d{1,2}),? (\d{4})$/); // Jan 5, 2024
  if (m && MONTHS[m[1].toLowerCase().slice(0, 3)]) return mk(+m[3], MONTHS[m[1].toLowerCase().slice(0, 3)], +m[2], false);
  m = v.match(/^(\d{1,2})[-/.](\d{1,2})[-/.](\d{2,4})(?:\s|T|$)/);
  if (m) {
    const a = +m[1], b = +m[2], y = year(m[3]);
    let ord = order;
    if (ord === 'auto' || ord === 'YMD') ord = a > 12 ? 'DMY' : b > 12 ? 'MDY' : 'DMY';
    const ambiguous = order === 'auto' && a <= 12 && b <= 12 && a !== b;
    return ord === 'MDY' ? mk(y, a, b, ambiguous) : mk(y, b, a, ambiguous);
  }
  return null;
  function year(t) { const n = +t; return t.length === 2 ? (n > 50 ? 1900 + n : 2000 + n) : n; }
  function mk(y, mo, d, ambiguous) {
    const dt = new Date(y, mo - 1, d);
    if (dt.getFullYear() !== y || dt.getMonth() !== mo - 1 || dt.getDate() !== d) return null;
    return { iso: toIsoDate(dt), ambiguous };
  }
}

export function parseNumber(s, format = 'auto') {
  const str = String(s || '').trim();
  const mult = /\d\s*k$/i.test(str) ? 1e3 : /\d\s*(m|mm)$/i.test(str) ? 1e6 : 1; // 60k, 1.2M
  let v = str.replace(/[^\d.,\-]/g, '');
  if (!v || !/\d/.test(v)) return null;
  let fmt = format;
  if (fmt === 'auto') {
    const commas = (v.match(/,/g) || []).length, dots = (v.match(/\./g) || []).length;
    if (commas && dots) fmt = v.lastIndexOf(',') > v.lastIndexOf('.') ? 'eu' : 'us';
    else if (commas) fmt = commas > 1 || /^-?\d{1,3},\d{3}$/.test(v) ? 'us' : 'eu'; // 1,234 -> thousands; 3,5 -> decimal
    else if (dots) fmt = dots > 1 || /^-?\d{1,3}\.\d{3}$/.test(v) ? 'eu' : 'us'; // 60.000 -> thousands; 3.5 -> decimal
    else fmt = 'us';
  }
  v = fmt === 'eu' ? v.replace(/\./g, '').replace(',', '.') : v.replace(/,/g, '');
  const n = parseFloat(v);
  return Number.isFinite(n) ? n * mult : null;
}

const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;

// Maps one select value to an option (case/accent-insensitive, plus the user's value map).
export function mapOptionValue(v, def, t = {}) {
  const map = t.valueMap || {};
  if (Object.prototype.hasOwnProperty.call(map, v)) return { value: map[v], known: true, mapped: true };
  const n = normName(v);
  const opt = (def.options || []).find(o => normName(o.value) === n) || (def.options || []).find(o => normSingular(o.value) === normSingular(v));
  if (opt) return { value: opt.value, known: true };
  return { value: v, known: false };
}

// Converts a cell into a field value. Returns { value, issue } (issue = message or null).
export function convertCell(raw, def, t = defaultTransform()) {
  const s = applyTextTransform(raw, t);
  if (!s) return { value: undefined, issue: null };
  switch (def.type) {
    case 'tags': return { value: splitList(s, t.split), issue: null };
    case 'multiselect': {
      const vals = splitList(s, t.split).map(x => mapOptionValue(x, def, t));
      const unknown = vals.filter(x => !x.known && x.value).map(x => x.value);
      return { value: normalizeTags(vals.map(x => x.value).filter(Boolean)), issue: unknown.length && !t.addNewOptions ? `not in the option list: ${unknown.join(', ')}` : null, newOptions: unknown };
    }
    case 'select': {
      const m = mapOptionValue(s, def, t);
      if (!m.value) return { value: '', issue: null };
      if (!m.known && !t.addNewOptions) return { value: m.value, issue: 'not in the option list', newOptions: [m.value] };
      return { value: m.value, issue: null, newOptions: m.known ? [] : [m.value] };
    }
    case 'number': {
      const n = parseNumber(s, t.numberFormat);
      return n == null ? { value: undefined, issue: 'not a number' } : { value: n, issue: null };
    }
    case 'checkbox': {
      if (/^(1|true|yes|y|x|si|sí|✓|✔|on)$/i.test(s)) return { value: true, issue: null };
      if (/^(0|false|no|n|off|-)$/i.test(s)) return { value: false, issue: null };
      return { value: undefined, issue: 'not yes/no' };
    }
    case 'date': {
      const d = parseDateOrdered(s, t.dateOrder);
      return d ? { value: d.iso, issue: null, ambiguous: d.ambiguous } : { value: undefined, issue: 'unreadable date' };
    }
    case 'email': return EMAIL_RE.test(s) ? { value: s.toLowerCase(), issue: null } : { value: s, issue: 'not a valid email' };
    case 'url': return /^(https?:\/\/|www\.)\S+\.\S+|^[\w-]+(\.[\w-]+)+(\/\S*)?$/i.test(s) ? { value: s, issue: null } : { value: s, issue: 'does not look like a URL' };
    case 'image': return { value: s, issue: /^(https?:\/\/|data:image\/|www\.)/i.test(s) ? null : 'not an image URL' };
    default: return { value: s, issue: null };
  }
}

// ---------------------------------------------------------------------------
// Rows -> records
// ---------------------------------------------------------------------------

// mapping: { header: target }, transforms: { header: transform }
// Cells that fail validation are kept: their raw text is saved in an "Import notes" note, never lost.
export function rowToRecordDetailed(row, mapping, type, transforms = {}) {
  const rec = {};
  const issues = [];
  const newOptions = {};
  let first = '', last = '';
  const notes = [];
  const rejected = [];
  for (const [h, target] of Object.entries(mapping)) {
    if (!target || target === 'ignore' || target === 'new') continue;
    const t = { ...defaultTransform(), ...(transforms[h] || {}) };
    if (target === '_first') { first = applyTextTransform(row[h], t); continue; }
    if (target === '_last') { last = applyTextTransform(row[h], t); continue; }
    if (target === 'note') {
      const v = applyTextTransform(row[h], t);
      if (v) notes.push({ id: newNoteId(), date: noteDateString(), time: noteTimeString(), content: `${h}: ${v}` });
      continue;
    }
    const def = type.fieldDefs.find(f => f.key === target);
    if (!def) continue;
    const res = convertCell(row[h], def, t);
    if (t.addNewOptions && res.newOptions?.length) {
      if (!newOptions[def.key]) newOptions[def.key] = new Set();
      for (const o of res.newOptions) newOptions[def.key].add(o);
    }
    if (res.issue) {
      issues.push({ header: h, field: def.key, value: String(row[h] ?? ''), issue: res.issue });
      // Text-like fields keep the value as typed (flagged in the preview).
      // Typed fields (date, number, yes/no, dropdown) cannot hold it: the raw text goes to an import note.
      if (['email', 'url', 'image'].includes(def.type)) { if (!rec[def.key]) rec[def.key] = res.value; continue; }
      rejected.push(`${def.label}: ${String(row[h] ?? '').trim()}`);
      continue;
    }
    if (res.value === undefined) continue;
    const cur = rec[def.key];
    if (Array.isArray(res.value)) rec[def.key] = normalizeTags([...(cur || []), ...res.value]);
    else if (cur && typeof cur === 'string' && ['text', 'longtext', 'markdown'].includes(def.type)) rec[def.key] = `${cur}\n${res.value}`;
    else if (cur === undefined || cur === '') rec[def.key] = res.value;
  }
  if ((first || last) && !rec[type.titleField]) rec[type.titleField] = `${first} ${last}`.trim();
  if (rejected.length) notes.push({ id: newNoteId(), date: noteDateString(), time: noteTimeString(), content: `Import notes (values that did not fit their field):\n${rejected.join('\n')}` });
  rec.notes = notes;
  return { rec, issues, newOptions: Object.fromEntries(Object.entries(newOptions).map(([k, s]) => [k, [...s]])) };
}

export function rowToRecord(row, mapping, type, transforms = {}) {
  return rowToRecordDetailed(row, mapping, type, transforms).rec;
}

// Column statistics for the formatting editor.
export function analyzeColumn(rows, header, def, t = defaultTransform()) {
  const counts = new Map();
  let issues = 0, ambiguous = 0, empty = 0;
  const unknownOptions = new Map();
  for (const r of rows) {
    const raw = r[header];
    const s = applyTextTransform(raw, t);
    if (!s) { empty++; continue; }
    counts.set(s, (counts.get(s) || 0) + 1);
    if (!def) continue;
    const res = convertCell(raw, def, t);
    if (res.issue) issues++;
    if (res.ambiguous) ambiguous++;
    for (const o of res.newOptions || []) unknownOptions.set(o, (unknownOptions.get(o) || 0) + 1);
  }
  const distinct = [...counts].sort((a, b) => b[1] - a[1]).map(([value, count]) => ({ value, count }));
  return { distinct, issues, ambiguous, empty, unknownOptions: [...unknownOptions].map(([value, count]) => ({ value, count })) };
}

// Values of select/multiselect columns, split, for the value-mapping table.
export function distinctOptionValues(rows, header, def, t = defaultTransform()) {
  const counts = new Map();
  for (const r of rows) {
    const s = applyTextTransform(r[header], t);
    if (!s) continue;
    const vals = def.type === 'multiselect' ? splitList(s, t.split) : [s];
    for (const v of vals) counts.set(v, (counts.get(v) || 0) + 1);
  }
  return [...counts].sort((a, b) => b[1] - a[1]).map(([value, count]) => ({ value, count }));
}

// Remembers header names a field was imported from, so the next import maps automatically.
export function rememberAliases(type, mapping) {
  let added = 0;
  for (const [h, key] of Object.entries(mapping)) {
    const def = type.fieldDefs.find(f => f.key === key);
    if (!def) continue;
    const n = normName(h);
    if (!n || normName(def.key) === n || normName(def.label) === n) continue;
    def.aliases ||= [];
    if (!def.aliases.some(a => normName(a) === n)) { def.aliases.push(String(h).trim()); added++; }
  }
  return added;
}

export function guessFieldType(values) {
  const vals = values.map(v => String(v ?? '').trim()).filter(Boolean);
  if (!vals.length) return 'text';
  // most values (>= 75%) must fit; the rest are flagged in the preview instead of forcing "text"
  const most = test => vals.filter(test).length / vals.length >= 0.75;
  if (most(v => /^(https?:\/\/|www\.)\S+$/i.test(v))) return 'url';
  if (most(v => EMAIL_RE.test(v))) return 'email';
  if (most(v => /^[^\d]{0,4}\s?-?[\d.,]+\s?(k|m)?$/i.test(v) && parseNumber(v) != null)) return 'number';
  if (most(v => parseDateOrdered(v))) return 'date';
  if (vals.every(v => /^(yes|no|true|false|y|n|si|sí|0|1)$/i.test(v))) return 'checkbox';
  if (vals.some(v => v.length > 120 || v.includes('\n'))) return 'longtext';
  if (vals.length >= 3 && vals.filter(v => /[,;|]/.test(v)).length / vals.length > 0.5) return 'tags';
  const distinct = new Set(vals.map(v => normName(v)));
  if (vals.length >= 4 && distinct.size <= Math.min(12, Math.ceil(vals.length * 0.6))) return 'select';
  return 'text';
}

export function newFieldFromHeader(type, header, values) {
  const t = guessFieldType(values);
  const label = String(header).trim().replace(/\s+/g, ' ') || 'Field';
  const def = { key: slugKey(label, type.fieldDefs.map(f => f.key)), label, type: t, showInTable: false, showInCard: true, aiContext: true, aliases: [] };
  if (t === 'select') {
    const seen = new Map();
    for (const v of values) { const s = String(v ?? '').trim(); if (s && !seen.has(normName(s))) seen.set(normName(s), s); }
    def.options = [...seen.values()].map((v, i) => ({ value: v, color: COLOR_PALETTE[(i * 2 + 1) % COLOR_PALETTE.length] }));
  }
  return def;
}

// ---------------------------------------------------------------------------
// Import presets (stored in meta.importPresets)
// ---------------------------------------------------------------------------

export function presetOverlap(preset, headers) {
  const ph = Object.keys(preset.columns || {});
  if (!ph.length) return 0;
  const hs = new Set(headers.map(normName));
  return ph.filter(h => hs.has(normName(h))).length / Math.max(ph.length, headers.length);
}

// ---------------------------------------------------------------------------
// Duplicates & merge
// ---------------------------------------------------------------------------

export function duplicateKey(type, rec) {
  const keys = [];
  const emailDef = type.fieldDefs.find(f => f.type === 'email');
  if (emailDef && rec[emailDef.key]) keys.push('e:' + String(rec[emailDef.key]).trim().toLowerCase());
  const title = String(rec[type.titleField] || '').trim().toLowerCase();
  if (title) {
    const group = type.key === 'contacts' ? String(rec.contactGroup || '').trim().toLowerCase() : '';
    keys.push('n:' + title + '|' + group);
  }
  return keys;
}

export function findDuplicate(type, existing, rec) {
  const keys = duplicateKey(type, rec);
  if (!keys.length) return null;
  for (const r of existing) {
    const ks = duplicateKey(type, r);
    if (ks.some(k => keys.includes(k))) return r;
  }
  return null;
}

// Fills empty fields, unions tags, appends new notes. Returns number of changed fields.
export function mergeInto(type, target, incoming) {
  let changed = 0;
  for (const def of type.fieldDefs) {
    const v = incoming[def.key];
    if (v == null || v === '' || (Array.isArray(v) && !v.length)) continue;
    const cur = target[def.key];
    if (def.type === 'tags' || def.type === 'multiselect') {
      const merged = normalizeTags([...(cur || []), ...v]);
      if (merged.length !== (cur || []).length) { target[def.key] = merged; changed++; }
    } else if (cur == null || cur === '' || (Array.isArray(cur) && !cur.length)) {
      target[def.key] = v; changed++;
    }
  }
  const sig = n => `${n.date}|${n.time}|${String(n.content).trim()}`;
  const have = new Set((target.notes || []).map(sig));
  for (const n of incoming.notes || []) {
    if (!have.has(sig(n))) { (target.notes ||= []).push({ ...n, id: newNoteId() }); changed++; }
  }
  return changed;
}
