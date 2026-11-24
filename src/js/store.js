// Central state: database data, UI state, undo/redo, zero-touch autosave.
import { getType, nowIso as _nowIso } from './shared.js';

const listeners = new Map();
export function on(evt, fn) { if (!listeners.has(evt)) listeners.set(evt, new Set()); listeners.get(evt).add(fn); return () => listeners.get(evt).delete(fn); }
export function emit(evt, payload) { for (const fn of listeners.get(evt) || []) { try { fn(payload); } catch (e) { console.error(e); } } }

export const store = {
  data: null,
  path: null,
  filesDir: null,
  config: null,
  version: '',
  ui: {
    typeKey: 'contacts',
    mode: 'table', // table | board | dashboard
    query: '',
    filters: { colors: [], due: [], fields: {} },
    selected: new Set(), // bulk selection (ids)
    activeId: null, // record shown in drawer
    expanded: new Set(),
    boardField: {}, // typeKey -> field key
    viewId: null,
    showHiddenNotes: false,
    notesMode: 'cards', // cards | timeline
  },
  save: { dirty: false, saving: false, error: null, lastSavedAt: null, rev: 0, savedRev: 0 },
};

export const nowIso = _nowIso;

export function currentType() { return getType(store.data, store.ui.typeKey) || store.data?.meta.recordTypes[0]; }
export function records(typeKey = store.ui.typeKey) { return store.data?.[typeKey] || []; }
export function findRecord(typeKey, id) { return records(typeKey).find(r => r.id === id) || null; }
export function settings() { return store.data?.meta.settings || {}; }

// ---------- undo / redo ----------
const undoStack = [];
const redoStack = [];
const MAX_UNDO = 100;
const MAX_UNDO_BYTES = 60 * 1024 * 1024;
let undoBytes = 0;

function pushUndo(label, coalesce) {
  const top = undoStack[undoStack.length - 1];
  if (coalesce && top && top.coalesce === coalesce && Date.now() - top.at < 60000) { top.at = Date.now(); return; }
  const snap = JSON.stringify(store.data);
  undoStack.push({ label, snap, coalesce, at: Date.now() });
  undoBytes += snap.length;
  while (undoStack.length > MAX_UNDO || (undoBytes > MAX_UNDO_BYTES && undoStack.length > 1)) undoBytes -= undoStack.shift().snap.length;
  redoStack.length = 0;
}

export function canUndo() { return undoStack.length > 0; }
export function canRedo() { return redoStack.length > 0; }
export function undoLabel() { return undoStack[undoStack.length - 1]?.label || ''; }
export function redoLabel() { return redoStack[redoStack.length - 1]?.label || ''; }

export function undo() {
  const e = undoStack.pop();
  if (!e) return null;
  undoBytes -= e.snap.length;
  redoStack.push({ label: e.label, snap: JSON.stringify(store.data) });
  store.data = JSON.parse(e.snap);
  afterChange();
  return e.label;
}

export function redo() {
  const e = redoStack.pop();
  if (!e) return null;
  const snap = JSON.stringify(store.data);
  undoStack.push({ label: e.label, snap, at: Date.now() });
  undoBytes += snap.length;
  store.data = JSON.parse(e.snap);
  afterChange();
  return e.label;
}

export function clearHistory() { undoStack.length = 0; redoStack.length = 0; undoBytes = 0; }

// ---------- mutations ----------
// Every data change goes through mutate(): undo snapshot + autosave + re-render.
export function mutate(label, fn, { coalesce = null, undoable = true, silent = false } = {}) {
  if (!store.data) return;
  if (undoable) pushUndo(label, coalesce);
  const result = fn(store.data);
  afterChange(silent);
  return result;
}

export function touch(record) { record.updatedAt = new Date().toISOString(); }

function afterChange(silent = false) {
  store.save.rev++;
  store.save.dirty = true;
  scheduleSave();
  emit('save-state');
  if (!silent) emit('change');
}

// ---------- autosave ----------
let saveTimer = null;
let periodic = null;
let retryTimer = null;
const SAVE_DELAY = 1000;

function scheduleSave() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => flush(), SAVE_DELAY);
}

export async function flush() {
  clearTimeout(saveTimer);
  if (!store.data || !store.path) return true;
  if (!store.save.dirty) return true;
  if (store.save.saving) { await store.save.saving; return flush(); }
  const rev = store.save.rev;
  const p = (async () => {
    try {
      await window.crm.db.save(store.data);
      store.save.savedRev = rev;
      store.save.lastSavedAt = Date.now();
      store.save.error = null;
      if (store.save.rev === rev) store.save.dirty = false;
      return true;
    } catch (e) {
      store.save.error = e.message || String(e);
      clearTimeout(retryTimer);
      retryTimer = setTimeout(() => flush(), 5000);
      return false;
    }
  })();
  store.save.saving = p;
  emit('save-state');
  const ok = await p;
  store.save.saving = false;
  emit('save-state');
  if (ok && store.save.dirty) scheduleSave();
  return ok;
}

export function startAutosave() {
  clearInterval(periodic);
  periodic = setInterval(() => { if (store.save.dirty && !store.save.saving) flush(); }, 15000);
  window.addEventListener('beforeunload', () => { if (store.save.dirty) flush(); });
  document.addEventListener('visibilitychange', () => { if (document.hidden && store.save.dirty) flush(); });
}

export function loadDatabase({ path, data, filesDir }) {
  store.data = data;
  store.path = path;
  store.filesDir = filesDir;
  store.save = { dirty: false, saving: false, error: null, lastSavedAt: Date.now(), rev: 0, savedRev: 0 };
  const types = data.meta.recordTypes.map(t => t.key);
  if (!types.includes(store.ui.typeKey)) store.ui.typeKey = types[0];
  store.ui.selected = new Set();
  store.ui.activeId = null;
  store.ui.expanded = new Set();
  clearHistory();
  emit('db-loaded');
  emit('change');
  emit('save-state');
}

// Replaces data after an external change (keeps UI state).
export function replaceData(data, { keepUndo = false } = {}) {
  if (keepUndo) pushUndo('External reload');
  store.data = data;
  store.save.dirty = false;
  emit('change');
  emit('save-state');
}
