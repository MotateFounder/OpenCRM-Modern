// Builds the text each record is searched by, for semantic search.
//   text    -> longer text for embeddings (fields, documents, notes), max ~2000 chars
//   summary -> compact one-paragraph summary for LLM mode, max ~450 chars

import { valueToText, isEmptyValue, recordTitle } from './schema.js';
import { notesForDisplay, stripWildcards } from './notes.js';

const squash = s => String(s || '').replace(/[#*_`>|]/g, ' ').replace(/\s+/g, ' ').trim();
const cut = (s, n) => (s.length > n ? s.slice(0, n - 1) + '…' : s);

export function semanticDoc(type, rec, ctx = {}) {
  const title = recordTitle(type, rec);
  const fields = [];
  const docs = [];
  for (const def of type.fieldDefs) {
    if (def.key === type.titleField || ['image', 'file'].includes(def.type) || def.aiContext === false) continue;
    const v = rec[def.key];
    if (isEmptyValue(v)) continue;
    if (def.type === 'markdown') { docs.push(`${def.label}: ${squash(v)}`); continue; }
    if (def.type === 'url') continue; // URLs carry little meaning
    const t = squash(valueToText(def, v, ctx));
    if (t) fields.push(`${def.label}: ${t}`);
  }
  const notes = notesForDisplay(rec, { showHidden: true }).map(n => squash(stripWildcards(n.content))).filter(Boolean);
  if (rec.reminder?.text && !rec.reminder.done) notes.unshift(`Next action: ${squash(rec.reminder.text)}`);

  const emails = ctx.extraText ? squash(ctx.extraText(rec) || '') : '';
  const text = cut([title, ...fields, ...docs.map(d => cut(d, 700)), notes.length ? `Notes: ${notes.join(' / ')}` : '', emails ? `Emails: ${cut(emails, 500)}` : ''].filter(Boolean).join('. '), 2000);
  const summary = cut([
    title,
    fields.join('; '),
    docs.length ? cut(docs.join(' '), 160) : '',
    notes.length ? `Notes: ${cut(notes.slice(0, 4).join(' / '), 170)}` : '',
    emails ? `Emails: ${cut(emails, 120)}` : '',
  ].filter(Boolean).join(' | '), 450);
  return { id: rec.id, text, summary };
}

export function semanticDocs(type, records, ctx = {}) {
  return records.map(r => semanticDoc(type, r, ctx));
}
