// Recoverable Trash for records (meta.trash). Used for the user's own deletes and for agent deletes.
import { nextId } from './schema.js';

export const TRASH_DAYS = 30;

export function moveToTrash(data, typeKey, ids, by = 'user') {
  const set = new Set(ids);
  const moved = (data[typeKey] || []).filter(r => set.has(r.id));
  if (!moved.length) return [];
  data[typeKey] = data[typeKey].filter(r => !set.has(r.id));
  data.meta.trash ||= [];
  const now = new Date().toISOString();
  const entries = moved.map(record => ({ id: `t_${Math.random().toString(36).slice(2, 10)}`, typeKey, record, deletedAt: now, by }));
  data.meta.trash.push(...entries);
  return entries;
}

/** Restores a trash entry; returns the restored record (new id if the old one was reused meanwhile). */
export function restoreFromTrash(data, entryId) {
  const i = (data.meta.trash || []).findIndex(e => e.id === entryId);
  if (i < 0) return null;
  const [e] = data.meta.trash.splice(i, 1);
  if (!Array.isArray(data[e.typeKey])) data[e.typeKey] = [];
  const rec = e.record;
  if (data[e.typeKey].some(r => r.id === rec.id)) rec.id = nextId(data[e.typeKey]);
  data[e.typeKey].push(rec);
  return { typeKey: e.typeKey, record: rec };
}

export function purgeTrash(data, days = TRASH_DAYS, now = Date.now()) {
  const before = (data.meta.trash || []).length;
  data.meta.trash = (data.meta.trash || []).filter(e => now - Date.parse(e.deletedAt) < days * 864e5);
  return before - data.meta.trash.length;
}
