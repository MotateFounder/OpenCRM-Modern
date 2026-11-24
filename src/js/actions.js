// Record-level operations used across views.
import { store, mutate, currentType, records, findRecord, touch, emit, undo } from './store.js';
import { emptyValueFor, nextId, newNoteId, noteDateString, noteTimeString, stripColorTags, getType, recordTitle, COLORS } from './shared.js';
import { toast, confirmDialog } from './ui.js';
import { moveToTrash } from '../shared/trash.js';

export function openRecord(id, typeKey = store.ui.typeKey) {
  if (typeKey !== store.ui.typeKey) { store.ui.typeKey = typeKey; emit('type-changed'); }
  store.ui.activeId = id;
  emit('active-changed');
}

export function closeRecord() {
  store.ui.activeId = null;
  emit('active-changed');
}

export function blankRecord(type) {
  const now = new Date().toISOString();
  const rec = { id: nextId(records(type.key)) };
  for (const def of type.fieldDefs) {
    if (def.onlyFor) continue;
    rec[def.key] = def.default !== undefined ? structuredClone(def.default) : emptyValueFor(def);
  }
  if (type.key === 'contacts') rec.type = 'contact';
  rec.notes = [];
  rec.createdAt = now;
  rec.updatedAt = now;
  return rec;
}

export function createRecord(type = currentType(), values = {}) {
  const rec = { ...blankRecord(type), ...values };
  mutate(`New ${type.singular || 'record'}`, (d) => { d[type.key].push(rec); });
  return rec;
}

export function setField(typeKey, id, key, value, { coalesce } = {}) {
  const type = getType(store.data, typeKey);
  const def = type?.fieldDefs.find(f => f.key === key);
  mutate(`Edit ${def?.label || key}`, () => {
    const r = findRecord(typeKey, id);
    if (!r) return;
    r[key] = value;
    touch(r);
  }, { coalesce });
}

export function addNote(typeKey, id, note, { label = 'Add note' } = {}) {
  mutate(label, () => {
    const r = findRecord(typeKey, id);
    if (!r) return;
    (r.notes ||= []).push({ id: newNoteId(), date: note.date || noteDateString(), time: note.time || noteTimeString(), content: note.content || '', ...(note.kind && note.kind !== 'Note' ? { kind: note.kind } : {}) });
    touch(r);
  });
}

// Quick colour: strips colour tags from older notes, then adds a dated tagged note.
export function setColor(typeKey, ids, color) {
  const n = ids.length;
  mutate(color ? `Set colour ${color}` : 'Clear colour', () => {
    for (const id of ids) {
      const r = findRecord(typeKey, id);
      if (!r) continue;
      for (const note of r.notes || []) {
        if (/#(red|orange|green)\b/.test(note.content)) note.content = stripColorTags(note.content);
      }
      if (color && COLORS.includes(color)) {
        (r.notes ||= []).push({ id: newNoteId(), date: noteDateString(), time: noteTimeString(), content: `#${color} Colour set to ${color}.` });
      }
      touch(r);
    }
  });
  toast(color ? `Marked ${n} as ${color}` : `Colour cleared on ${n}`, { action: { label: 'Undo', fn: () => undo() } });
}

export async function deleteRecords(typeKey, ids) {
  const type = getType(store.data, typeKey);
  if (!ids.length) return false;
  const names = ids.slice(0, 5).map(id => recordTitle(type, findRecord(typeKey, id))).join(', ');
  const ok = await confirmDialog(`Delete ${ids.length} ${ids.length === 1 ? type.singular?.toLowerCase() || 'record' : type.label.toLowerCase()}?`, {
    danger: true, okLabel: 'Move to Trash', detail: names + (ids.length > 5 ? '…' : '') + '\n\nDeleted records stay in the Trash (Database ▾ → Trash) for 30 days. Ctrl+Z also works.',
  });
  if (!ok) return false;
  const set = new Set(ids);
  mutate(`Delete ${ids.length} record(s)`, (d) => { moveToTrash(d, typeKey, ids, 'user'); });
  for (const id of ids) store.ui.selected.delete(id);
  if (set.has(store.ui.activeId)) closeRecord();
  toast(`Moved ${ids.length} to the Trash`, { action: { label: 'Undo', fn: () => undo() } });
  return true;
}

export function duplicateRecord(typeKey, id) {
  const type = getType(store.data, typeKey);
  const src = findRecord(typeKey, id);
  if (!src) return null;
  const now = new Date().toISOString();
  const copy = structuredClone(src);
  copy.id = nextId(records(typeKey));
  copy[type.titleField] = `${src[type.titleField] || ''} (copy)`;
  copy.notes = [];
  copy.createdAt = now; copy.updatedAt = now;
  for (const def of type.fieldDefs) if (def.type === 'file') copy[def.key] = [];
  delete copy.files;
  mutate('Duplicate record', (d) => { d[typeKey].push(copy); });
  return copy;
}

export function selectedIds() { return [...store.ui.selected]; }
