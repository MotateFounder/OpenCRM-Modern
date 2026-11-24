// Schema helpers shared by the Electron main process, the renderer and tests.
// Pure ES module: no DOM, no Node APIs.

export const SCHEMA_VERSION = 4;

export const FIELD_TYPES = [
  { type: 'text', label: 'Text', column: true },
  { type: 'longtext', label: 'Long text', column: true },
  { type: 'markdown', label: 'Markdown', column: false },
  { type: 'select', label: 'Dropdown (select)', column: true },
  { type: 'multiselect', label: 'Multi-select', column: true },
  { type: 'tags', label: 'Tags', column: true },
  { type: 'url', label: 'URL', column: true },
  { type: 'email', label: 'Email', column: true },
  { type: 'phone', label: 'Phone', column: true },
  { type: 'date', label: 'Date', column: true },
  { type: 'number', label: 'Number', column: true },
  { type: 'checkbox', label: 'Checkbox', column: true },
  { type: 'relation', label: 'Relation (link to records)', column: true },
  { type: 'file', label: 'Files (attachments)', column: true },
  { type: 'image', label: 'Image (picture)', column: false },
];

export const TYPE_LABEL = Object.fromEntries(FIELD_TYPES.map(t => [t.type, t.label]));

// Virtual (computed) columns available for every record type.
export const VIRTUAL_COLUMNS = {
  _lastContact: { key: '_lastContact', label: 'Date', type: 'date', virtual: true },
  _nextAction: { key: '_nextAction', label: 'Next action', type: 'date', virtual: true },
  _noteCount: { key: '_noteCount', label: 'Notes', type: 'number', virtual: true },
  _files: { key: '_files', label: 'Files', type: 'number', virtual: true },
  _updatedAt: { key: '_updatedAt', label: 'Edited', type: 'date', virtual: true },
  _createdAt: { key: '_createdAt', label: 'Created', type: 'date', virtual: true },
  _lastEmail: { key: '_lastEmail', label: 'Last email', type: 'date', virtual: true },
  _emails: { key: '_emails', label: 'Emails', type: 'number', virtual: true },
  _lastOpened: { key: '_lastOpened', label: 'Last opened', type: 'date', virtual: true },
  _engagement: { key: '_engagement', label: 'Engagement', type: 'number', virtual: true },
};

// Record keys that are never treated as user fields.
export const RESERVED_KEYS = new Set([
  'id', 'type', 'controlTag', 'notes', 'createdAt', 'updatedAt', 'reminder', 'files',
  'extraEmails', 'doNotEmail', 'emailInvalid',
]);

export const DEFAULT_NOTE_KINDS = [
  { value: 'Note', icon: '📝' },
  { value: 'Email', icon: '📧' },
  { value: 'Call', icon: '📞' },
  { value: 'Meeting', icon: '🤝' },
  { value: 'Message', icon: '💬' },
];

export const COLOR_PALETTE = [
  '#9e9e9e', '#42a5f5', '#26c6da', '#66bb6a', '#d4e157', '#ffca28',
  '#ffa726', '#ef5350', '#ec407a', '#ab47bc', '#7e57c2', '#8d6e63',
];

export function contactBuiltinFields() {
  return [
    { key: 'picture', label: 'Picture', type: 'image', builtin: true, showInTable: false, showInCard: true, aiContext: false },
    { key: 'fullName', label: 'Name', type: 'text', builtin: true, showInTable: true, showInCard: true, aiContext: true },
    { key: 'contactGroup', label: 'Groups', type: 'text', builtin: true, showInTable: true, showInCard: true, aiContext: true },
    { key: 'contactLocation', label: 'Location', type: 'text', builtin: true, showInTable: true, showInCard: true, aiContext: true },
    { key: 'urlLink', label: 'URL', type: 'url', builtin: true, showInTable: true, showInCard: true, aiContext: true, displayField: 'urlName' },
    { key: 'urlName', label: 'URL text', type: 'text', builtin: true, showInTable: false, showInCard: true, aiContext: false },
    { key: 'emailAddress', label: 'Email', type: 'email', builtin: true, showInTable: true, showInCard: true, aiContext: true },
    { key: 'phoneNumber', label: 'Phone', type: 'phone', builtin: true, showInTable: true, showInCard: true, aiContext: true },
    { key: 'labels', label: 'Labels', type: 'tags', builtin: true, showInTable: true, showInCard: true, aiContext: true },
    { key: 'info', label: 'Info', type: 'markdown', builtin: true, showInTable: false, showInCard: true, aiContext: true },
  ];
}

export function genericBuiltinFields() {
  return [
    { key: 'name', label: 'Name', type: 'text', builtin: true, showInTable: true, showInCard: true, aiContext: true },
    { key: 'labels', label: 'Labels', type: 'tags', builtin: true, showInTable: true, showInCard: true, aiContext: true },
    { key: 'info', label: 'Info', type: 'markdown', builtin: true, showInTable: false, showInCard: true, aiContext: true },
  ];
}

export const CONTACT_DEFAULT_COLUMNS = [
  'fullName', 'contactGroup', 'contactLocation', 'urlLink', 'emailAddress', 'phoneNumber', 'labels', '_lastContact',
];

export function makeContactsType() {
  return {
    key: 'contacts',
    label: 'Contacts',
    singular: 'Contact',
    titleField: 'fullName',
    pictureField: 'picture',
    builtin: true,
    fieldDefs: contactBuiltinFields(),
    ui: { columns: [...CONTACT_DEFAULT_COLUMNS], sort: [{ key: 'fullName', dir: 'asc' }], columnWidths: {} },
  };
}

export function singularize(word) {
  const w = String(word || '').trim();
  if (/(series|species|news)$/i.test(w)) return w;
  if (/ies$/i.test(w)) return w.replace(/ies$/i, m => (m === 'IES' ? 'Y' : 'y'));
  if (/(ss|sh|ch|x|z)es$/i.test(w)) return w.slice(0, -2);
  if (/ss$/i.test(w)) return w;
  if (/s$/i.test(w)) return w.slice(0, -1);
  return w;
}

export function makeGenericType(key, label, singular) {
  return {
    key,
    label,
    singular: singular || singularize(label),
    titleField: 'name',
    pictureField: null,
    builtin: false,
    fieldDefs: genericBuiltinFields(),
    ui: { columns: ['name', 'labels', '_lastContact'], sort: [{ key: 'name', dir: 'asc' }], columnWidths: {} },
  };
}

export function defaultSettings() {
  return {
    colorRule: 'severity', // 'severity' (red > orange > green, as v1) | 'latest'
    dateFormat: 'YYYY/MMM/DD',
    staleDays: 0, // 0 = off
    notesMarkdown: false,
    noteKinds: DEFAULT_NOTE_KINDS.map(k => ({ ...k })),
  };
}

export function defaultMeta() {
  return {
    recordTypes: [makeContactsType()],
    views: [],
    prompts: [],
    settings: defaultSettings(),
  };
}

export function emptyDatabase() {
  return { schemaVersion: SCHEMA_VERSION, meta: defaultMeta(), contacts: [] };
}

export function slugKey(label, existing = []) {
  let base = String(label || 'field')
    .normalize('NFKD').replace(/[̀-ͯ]/g, '')
    .replace(/[^a-zA-Z0-9]+(.)?/g, (_, c) => (c ? c.toUpperCase() : ''))
    .replace(/^[^a-zA-Z]+/, '');
  if (!base) base = 'field';
  base = base.charAt(0).toLowerCase() + base.slice(1);
  const taken = new Set(existing);
  let key = base;
  let i = 2;
  while (taken.has(key) || RESERVED_KEYS.has(key) || key.startsWith('_')) key = `${base}${i++}`;
  return key;
}

export function getType(data, typeKey) {
  return data?.meta?.recordTypes?.find(t => t.key === typeKey) || null;
}

export function getFieldDef(type, key) {
  if (!type) return null;
  if (VIRTUAL_COLUMNS[key]) return VIRTUAL_COLUMNS[key];
  return type.fieldDefs.find(f => f.key === key) || null;
}

export function recordTitle(type, record) {
  if (!record) return '';
  const v = record[type?.titleField || 'fullName'] ?? record.name ?? record.fullName;
  return (v == null || v === '') ? `#${record.id}` : String(v);
}

export function nextId(records) {
  return (records || []).reduce((m, r) => Math.max(m, Number(r.id) || 0), 0) + 1;
}

export function newNoteId() {
  return 'n_' + Math.random().toString(36).slice(2, 8) + Date.now().toString(36).slice(-4);
}

export function newId(prefix = 'x') {
  return prefix + '_' + Math.random().toString(36).slice(2, 10);
}

export function emptyValueFor(def) {
  switch (def?.type) {
    case 'tags': case 'multiselect': case 'relation': case 'file': return [];
    case 'checkbox': return false;
    case 'number': return null;
    default: return '';
  }
}

export function isEmptyValue(v) {
  return v == null || v === '' || (Array.isArray(v) && v.length === 0);
}

// Converts any stored value into plain text (for search, AI context, CSV export).
export function valueToText(def, value, ctx = {}) {
  if (value == null) return '';
  switch (def?.type) {
    case 'tags': case 'multiselect':
      return Array.isArray(value) ? value.join(', ') : String(value);
    case 'checkbox': return value ? 'Yes' : 'No';
    case 'relation': {
      if (!Array.isArray(value)) return '';
      return value.map(link => {
        const name = ctx.resolveRelation ? ctx.resolveRelation(def, link.id) : `#${link.id}`;
        return link.v ? `${name} (${link.v})` : name;
      }).join(', ');
    }
    case 'file': return Array.isArray(value) ? value.map(f => f.name).join(', ') : '';
    default: return String(value);
  }
}

export function normalizeTags(value) {
  if (value == null) return [];
  const arr = Array.isArray(value) ? value : String(value).split(',');
  const out = [];
  for (const raw of arr) {
    const t = String(raw ?? '').trim();
    if (t && !out.includes(t)) out.push(t);
  }
  return out;
}

export function selectOptionIndex(def, value) {
  if (!def?.options) return -1;
  return def.options.findIndex(o => o.value === value);
}

export function textFieldDefs(type) {
  return type.fieldDefs.filter(f => !['image', 'file'].includes(f.type));
}
