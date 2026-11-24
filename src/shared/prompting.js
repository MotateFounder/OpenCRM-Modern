// AI prompt helpers: context items for a record, context text, template variables.

import { valueToText, isEmptyValue, recordTitle } from './schema.js';
import { notesForDisplay, stripWildcards, isImportant, lastContactTime } from './notes.js';
import { formatDate } from './dates.js';

// Lists every piece of text-bearing information of a record as selectable context items.
export function contextItems(type, record, ctx = {}) {
  const items = [];
  const df = ctx.dateFormat || 'YYYY/MMM/DD';
  for (const def of type.fieldDefs) {
    if (def.type === 'image' || def.aiContext === false) continue;
    const text = valueToText(def, record[def.key], ctx);
    if (isEmptyValue(record[def.key]) || !text.trim()) continue;
    items.push({ id: `field:${def.key}`, group: def.type === 'markdown' ? 'Documents' : 'Fields', label: def.label, text, markdown: def.type === 'markdown' });
  }
  const lc = lastContactTime(record);
  if (lc) items.push({ id: 'virtual:lastContact', group: 'Fields', label: 'Last contact date', text: formatDate(new Date(lc), df) });
  if (record.reminder?.date && !record.reminder.done) {
    items.push({ id: 'virtual:reminder', group: 'Fields', label: 'Next action', text: `${formatDate(record.reminder.date, df)} — ${record.reminder.text || ''}`.trim() });
  }
  for (const rel of ctx.incomingRelations || []) {
    items.push({ id: `rel:${rel.id}`, group: 'Related', label: rel.label, text: rel.text });
  }
  for (const n of notesForDisplay(record, { showHidden: true })) {
    const clean = stripWildcards(n.content);
    if (!clean) continue;
    items.push({
      id: `note:${n.id}`,
      group: 'Notes',
      label: `${formatDate(n.date, df)} ${n.time || ''}${n.kind && n.kind !== 'Note' ? ' · ' + n.kind : ''}${isImportant(n) ? ' · important' : ''}`,
      text: clean,
      noteDate: n.date, noteTime: n.time, kind: n.kind, important: isImportant(n),
    });
  }
  return items;
}

export function buildContextText(type, record, items, selectedIds) {
  const sel = items.filter(i => selectedIds.has(i.id));
  if (!sel.length) return '';
  const lines = [`${type.singular || 'Record'}: ${recordTitle(type, record)}`];
  const fields = sel.filter(i => i.group === 'Fields' || i.group === 'Related');
  const docs = sel.filter(i => i.group === 'Documents');
  const notes = sel.filter(i => i.group === 'Notes');
  for (const f of fields) lines.push(`${f.label}: ${f.text}`);
  for (const d of docs) lines.push('', `### ${d.label}`, d.text.trim());
  if (notes.length) {
    lines.push('', 'Notes (newest first):');
    for (const n of notes) lines.push(`- [${n.label.trim()}] ${n.text.replace(/\s*\n\s*/g, ' / ')}`);
  }
  return lines.join('\n');
}

// Default context selection for a prompt (prompt.context: array of ids or shortcuts).
export function defaultSelection(items, prompt) {
  const sel = new Set();
  const spec = prompt?.context;
  if (!spec || !spec.length) {
    items.filter(i => i.group === 'Fields').forEach(i => sel.add(i.id));
    items.filter(i => i.group === 'Notes').slice(0, 5).forEach(i => sel.add(i.id));
    return sel;
  }
  const notes = items.filter(i => i.group === 'Notes');
  for (const s of spec) {
    if (s === 'fields:all') items.filter(i => i.group === 'Fields').forEach(i => sel.add(i.id));
    else if (s === 'docs:all') items.filter(i => i.group === 'Documents').forEach(i => sel.add(i.id));
    else if (s === 'notes:all') notes.forEach(i => sel.add(i.id));
    else if (s === 'notes:important') notes.filter(i => i.important).forEach(i => sel.add(i.id));
    else if (/^notes:last\d+$/.test(s)) notes.slice(0, +s.slice(10)).forEach(i => sel.add(i.id));
    else if (items.some(i => i.id === s)) sel.add(s);
  }
  return sel;
}

// Renders {{variables}} in a template.
export function renderTemplate(template, { type, record, contextText = '', me = {}, ctx = {}, extra = {} } = {}) {
  const df = ctx.dateFormat || 'YYYY/MMM/DD';
  const findDef = name => {
    const n = String(name).trim().toLowerCase();
    return type?.fieldDefs.find(f => f.key.toLowerCase() === n || f.label.toLowerCase() === n) || null;
  };
  const notesText = (list) => list.map(n => `- [${formatDate(n.date, df)} ${n.time || ''}] ${stripWildcards(n.content).replace(/\s*\n\s*/g, ' / ')}`).join('\n');
  return String(template || '').replace(/\{\{\s*([^}]+?)\s*\}\}/g, (whole, expr) => {
    const [head, ...restParts] = expr.split(':');
    const rest = restParts.join(':').trim();
    const h = head.trim();
    if (h === 'context') return contextText;
    if (h === 'today') return formatDate(new Date(), df);
    if (h === 'title' || (h === 'name' && !findDef('name'))) return record ? recordTitle(type, record) : '';
    if (h === 'type') return type?.singular || '';
    if (h.startsWith('me.')) return me[h.slice(3)] ?? '';
    if (h in extra) return extra[h];
    if (h === 'notes') {
      if (!record) return '';
      const visible = notesForDisplay(record);
      if (!rest || rest === 'all') return notesText(visible);
      if (rest === 'important') return notesText(visible.filter(isImportant));
      const m = rest.match(/^last(\d+)$/);
      if (m) return notesText(visible.slice(0, +m[1]));
      return notesText(visible);
    }
    if (h === 'field') {
      const def = findDef(rest);
      return def && record ? valueToText(def, record[def.key], ctx) : '';
    }
    const def = findDef(h);
    if (def && record) return valueToText(def, record[def.key], ctx);
    return whole; // leave unknown variables visible
  });
}

export function estimateTokens(text) {
  return Math.ceil(String(text || '').length / 4);
}

// Extracts the first JSON object from a model answer (handles ```json fences).
export function extractJson(text) {
  const s = String(text || '');
  const fence = s.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidates = [];
  if (fence) candidates.push(fence[1]);
  const start = s.indexOf('{');
  const end = s.lastIndexOf('}');
  if (start >= 0 && end > start) candidates.push(s.slice(start, end + 1));
  for (const c of candidates) {
    try { return JSON.parse(c); } catch { /* try next */ }
  }
  return null;
}
