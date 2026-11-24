// OpenCRM renderer entry point: boot, layout, toolbar, keyboard, events, database lifecycle.
import { h, $, debounce, replace } from './dom.js';
import {
  store, on, emit, currentType, loadDatabase, replaceData, startAutosave, flush, undo, redo, canUndo, canRedo,
  undoLabel, redoLabel, findRecord, mutate, touch, records,
} from './store.js';
import { getType, newNoteId, noteDateString, noteTimeString, TEMPLATES, recordTitle } from './shared.js';
import { renderTable, columnChooser } from './table.js';
import { renderBoard } from './board.js';
import { renderDashboard } from './dashboard.js';
import { renderFilterBar, renderBulkBar } from './filters.js';
import { renderDrawer, openNewNote, resetDrawerState } from './drawer.js';
import { visibleRecords } from './viewmodel.js';
import { createRecord, openRecord, closeRecord } from './actions.js';
import { openAIPanel } from './ai-panel.js';
import { openPromptManager } from './prompts.js';
import { openDocFill } from './docfill.js';
import { startImport, exportRecords } from './import-export.js';
import { viewsMenu, applyView, startReminders, remindersPopover, dueReminders } from './views.js';
import { openSettings } from './settings.js';
import { renderWelcome, openHelp, lockPrompt } from './welcome.js';
import { openSetupWizard, openSetupChecklist, openTutorial, setupChip } from './setup.js';
import { menu, toast, anyModalOpen, topModal, closePopover, openModal, confirmDialog } from './ui.js';
import { hooks } from './hooks.js';
import { semanticState, runSemantic, toggleSemantic, clearSemantic, renderSemanticBanner } from './semantic-ui.js';
import { initMail, refreshMail, mail } from './mail-state.js';
import { renderMailView, showMailFor, openOutbox } from './mail-view.js';
import { getActiveMessage } from './mail-thread.js';
import { openCompose } from './mail-compose.js';
import { openMailTemplates } from './mail-templates.js';
import { invalidateDrawerMail } from './drawer.js';
import { mailAI } from './mail-ai.js';
import { openBulkEmail } from './mail-bulk.js';
import { renderTemplateHtml, newDesignedTemplate, openDesigner, openBrandKit } from './mail-designer.js';
import { openTrackingSettings, trackingToggle, trackingMini } from './mail-tracking-ui.js';
import { applyMailEvent } from './mail-rules.js';
import { initAgentBridge } from './agent-ops.js';
import { initAgentUi, agentToolbarButton, openApprovals, openActivity, openTrash, refreshAgentState } from './agent-ui.js';

const KEYWORD_PLACEHOLDER = 'Search within names, fields, labels, documents and notes…   (tokens: group:apple  color:red  has:files  due:today)';
const AI_PLACEHOLDER = 'Ask in plain words, then press Enter — e.g. “who has audio signal processing experience?”';

const els = {};

// ---------- hooks for other modules ----------
Object.assign(hooks, {
  openAI: (ids) => openAIPanel(ids),
  openAIWithPrompt: (promptId) => { if (store.ui.activeId != null) openAIPanel([store.ui.activeId], { promptId }); },
  openPrompts: () => openPromptManager(),
  openDocFill: (typeKey, id, ref) => openDocFill(typeKey, id, ref),
  openSettings: (tab) => openSettings(tab),
  openHelp: () => openHelp(),
  openTutorial: (anchor) => openTutorial(anchor),
  openSetupChecklist: () => openSetupChecklist(),
  exportRecords: (kind, ids) => exportRecords(kind, ids),
  moveDatabase: () => moveDatabase(),
  openDatabase: () => openDatabase(),
  newDatabase: () => newDatabase(),
  closeDatabase: () => closeDatabase(),
  compose: (o) => openCompose(o),
  openMailTemplates: (o) => openMailTemplates(o),
  showMailFor: (ref) => { showMailFor(ref); store.ui.mode = 'mail'; saveUiPrefs(); schedule('toolbar', 'main'); },
  openOutbox: () => openOutbox(),
  openApprovals: () => openApprovals(),
  openAgentActivity: () => openActivity(),
  mailAI: (o) => mailAI(o),
  bulkEmail: (typeKey, ids) => openBulkEmail(typeKey, ids),
  renderDesignedEmail: async (tpl, o) => renderTemplateHtml(tpl, o).html,
  previewDesigned: (tpl, o) => renderTemplateHtml(tpl, o).html,
  newDesignedTemplate: (done) => newDesignedTemplate(done),
  editDesign: (id, done) => openDesigner(id, done),
  openBrandKit: () => openBrandKit(),
  openTrackingSettings: () => openTrackingSettings(),
  trackingToggle: (d) => trackingToggle(d),
  trackingMini: (m) => trackingMini(m),
});

// ---------- render scheduling ----------
const pending = new Set();
let raf = 0;
function schedule(...parts) {
  parts.forEach(p => pending.add(p));
  if (!raf) raf = requestAnimationFrame(doRender);
}
function doRender() {
  raf = 0;
  if (!store.data) return;
  const parts = new Set(pending);
  pending.clear();
  const all = parts.has('all');
  try {
    if (all || parts.has('toolbar')) renderToolbar();
    if (all || parts.has('filter')) renderFilterBar(els.filter);
    if (all || parts.has('bulk')) renderBulkBar(els.bulk);
    if (all || parts.has('main')) renderMain();
    if (all || parts.has('drawer')) renderDrawer(els.drawer);
    if (all || parts.has('status')) renderStatus();
    if (all || parts.has('semantic')) renderSearchMode();
  } catch (e) { console.error(e); toast(`Display error: ${e.message}`, { type: 'error' }); }
}

function renderMain() {
  const mode = store.ui.mode;
  els.main.dataset.mode = mode;
  if (mode === 'mail') renderMailView(els.view);
  else if (mode === 'board') renderBoard(els.view);
  else if (mode === 'dashboard') renderDashboard(els.view);
  else renderTable(els.view);
}

// ---------- layout ----------
function buildLayout() {
  els.app = $('#app');
  els.app.replaceChildren(
    els.toolbar = h('header', { id: 'toolbar' }),
    h('div', { id: 'searchrow' },
      els.aiToggle = h('button', { id: 'ai-search-toggle', class: 'ai-toggle', title: 'AI search: find records by meaning using your local AI (Enter to search)', onclick: onToggleSemantic }, '✨ AI search'),
      els.search = h('input', { id: 'search', type: 'search', placeholder: KEYWORD_PLACEHOLDER, spellcheck: false }),
      h('button', { class: 'icon-btn', title: 'Search help', onclick: openHelp }, '?')),
    els.semBanner = h('div', { id: 'semantic-banner', class: 'hidden' }),
    els.filter = h('div', { id: 'filterbar' }),
    els.bulk = h('div', { id: 'bulkbar', class: 'hidden' }),
    els.main = h('main', { id: 'main' }, els.view = h('div', { id: 'view' }), els.drawer = h('aside', { id: 'drawer', class: 'hidden' })),
    els.status = h('footer', { id: 'statusbar' }));
  const onSearch = debounce(() => {
    if (semanticState().on) return; // AI search runs on Enter only
    store.ui.query = els.search.value; schedule('filter', 'main', 'status');
  }, 120);
  els.search.addEventListener('input', onSearch);
  els.search.addEventListener('keydown', e => {
    if (e.key === 'Escape') {
      if (semanticState().on) { clearSemantic(false); els.search.value = ''; return; }
      els.search.value = ''; onSearch.flush(); els.search.blur();
    }
    if (e.key === 'Enter' && semanticState().on) { e.preventDefault(); runSemantic(els.search.value); return; }
    if (e.key === 'Enter') { const first = visibleRecords()[0]; if (first) openRecord(first.id); }
    if (e.key === 'ArrowDown') { e.preventDefault(); els.search.blur(); navigate(1); }
  });
}

function onToggleSemantic() {
  const on = toggleSemantic();
  if (on) {
    // keyword filtering is replaced by the AI question
    store.ui.query = '';
    els.search.value = '';
    els.search.focus();
  } else {
    els.search.value = store.ui.query || '';
  }
  schedule('filter', 'main', 'status', 'semantic');
}

function renderSearchMode() {
  const on = !!semanticState().on;
  els.aiToggle.classList.toggle('on', on);
  els.search.placeholder = on ? AI_PLACEHOLDER : KEYWORD_PLACEHOLDER;
  els.search.classList.toggle('ai-mode', on);
  renderSemanticBanner(els.semBanner);
}

function modeBtn(mode, label, title, badge = 0) {
  return h('button', { class: ['seg-btn', store.ui.mode === mode && 'on'], dataset: { mode }, title, onclick: () => { store.ui.mode = mode; saveUiPrefs(); schedule('toolbar', 'main'); } }, label, badge ? h('span', { class: 'badge-inline' }, String(badge)) : null);
}

function renderToolbar() {
  const type = currentType();
  const views = (store.data.meta.views || []).filter(v => v.pinned);
  const due = dueReminders().length;
  replace(els.toolbar, 
    h('div', { class: 'tb-group' },
      h('button', { class: 'btn', onclick: e => databaseMenu(e.currentTarget) }, 'Database ▾'),
      h('button', { class: 'btn', title: `New ${type.singular} (Ctrl+N)`, onclick: newRecord }, `+ New ${type.singular || 'record'}`),
      h('button', { class: 'btn', title: 'AI assistant for the open/selected records', onclick: () => {
        const ids = store.ui.selected.size ? [...store.ui.selected] : store.ui.activeId != null ? [store.ui.activeId] : [];
        if (!ids.length) { toast('Open or select a record first, then click ✨ AI.'); return; }
        openAIPanel(ids);
      } }, '✨ AI'),
      h('button', { class: 'btn', onclick: e => viewsMenu(e.currentTarget) }, 'Views ▾')),
    h('nav', { class: 'tabs' },
      store.data.meta.recordTypes.map(t => h('button', {
        class: ['tab', t.key === store.ui.typeKey && !store.ui.viewId && 'on'],
        onclick: () => switchType(t.key),
      }, t.label, h('span', { class: 'tab-count' }, String(records(t.key).length)))),
      views.map(v => h('button', { class: ['tab', 'tab-view', store.ui.viewId === v.id && 'on'], title: `Saved view (${getType(store.data, v.typeKey)?.label || ''})`, onclick: () => applyView(v) }, '📌 ', v.name)),
      h('button', { class: 'tab tab-add', title: 'Add a record type (Companies, Deals, Projects…)', onclick: () => openSettings('types') }, '+')),
    h('span', { class: 'spacer' }),
    h('div', { class: 'seg' }, modeBtn('table', '▤ Table', 'Table (Ctrl+1)'), modeBtn('board', '▥ Board', 'Board grouped by a dropdown field (Ctrl+2)'), modeBtn('dashboard', '◔ Dashboard', 'Dashboard (Ctrl+3)'), modeBtn('mail', '✉ Mail', 'Email (Ctrl+4)', mail.unread)),
    agentToolbarButton(),
    h('button', { class: ['icon-btn', 'bell', due && 'has-due'], title: 'Reminders due', onclick: e => remindersPopover(e.currentTarget) }, '⏰', due ? h('span', { class: 'badge' }, String(due)) : null),
    h('button', { class: 'icon-btn', title: canUndo() ? `Undo: ${undoLabel()} (Ctrl+Z)` : 'Nothing to undo', disabled: !canUndo(), onclick: doUndo }, '↶'),
    h('button', { class: 'icon-btn', title: canRedo() ? `Redo: ${redoLabel()} (Ctrl+Y)` : 'Nothing to redo', disabled: !canRedo(), onclick: doRedo }, '↷'),
    h('button', { class: 'icon-btn', title: 'Settings', onclick: () => openSettings() }, '⚙'),
    h('button', { class: 'icon-btn', title: 'Help, tutorial and setup', onclick: e => helpMenu(e.currentTarget) }, '?'));
}

function helpMenu(anchor) {
  menu(anchor, [
    { label: 'Help: shortcuts, search, wildcards (F1)', icon: '⌨', fn: openHelp },
    { label: 'Tutorial', icon: '📖', fn: () => openTutorial() },
    'sep',
    { label: 'Setup checklist', icon: '🚀', fn: openSetupChecklist },
    { label: 'Setup guide…', icon: '🧭', fn: () => openSetupWizard() },
  ], { align: 'right' });
}

function databaseMenu(anchor) {
  menu(anchor, [
    { label: 'Open database…', icon: '📂', fn: openDatabase },
    { label: 'New database…', icon: '✚', fn: newDatabase },
    { label: 'Recent', icon: '🕘', sub: [{ label: 'Loading…', disabled: true }] },
    { label: 'Move / save as…', icon: '➜', fn: moveDatabase },
    'sep',
    { label: 'Import (CSV, Excel, vCard, JSON)…', icon: '⤓', fn: startImport },
    { label: 'Export', icon: '⤒', sub: [
      { label: `${currentType().label}: JSON`, fn: () => exportRecords('json') },
      { label: `${currentType().label}: CSV (visible columns)`, fn: () => exportRecords('csv') },
      { label: `${currentType().label}: CSV (all fields + notes)`, fn: () => exportRecords('csv-all') },
      currentType().key === 'contacts' ? { label: 'Contacts: vCard (.vcf)', fn: () => exportRecords('vcf') } : null,
      { label: 'Whole database copy (JSON)', fn: () => exportRecords('db') },
    ].filter(Boolean) },
    'sep',
    { label: 'Trash…', icon: '🗑', fn: () => openTrash() },
    { label: 'Backups…', icon: '🛟', fn: () => openSettings('database') },
    { label: 'Show in Explorer', icon: '📁', fn: () => window.crm.db.reveal() },
    { label: 'Close database', icon: '×', fn: closeDatabase },
  ]);
  // fill recent submenu
  window.crm.db.recent().then(list => {
    const sub = document.querySelector('.menu-pop .has-sub .submenu');
    if (!sub) return;
    sub.replaceChildren(...(list.length ? list : [{ path: 'No recent databases', exists: false }]).map(r => h('div', {
      class: ['menu-item', (!r.exists || r.path === store.path) && 'disabled'],
      onclick: () => { if (r.exists && r.path !== store.path) { closePopover(); openDatabase(r.path); } },
    }, h('span', { class: 'mi-icon' }, r.path === store.path ? '✓' : ''), h('span', { class: 'mi-label' }, r.path))));
  });
}

function renderStatus() {
  const s = store.save;
  let state, cls;
  if (s.error) { state = `● Not saved — ${s.error} (retrying)`; cls = 'err'; }
  else if (s.saving) { state = '● Saving…'; cls = 'saving'; }
  else if (s.dirty) { state = '● Unsaved changes'; cls = 'dirty'; }
  else { state = `● Saved ${s.lastSavedAt ? new Date(s.lastSavedAt).toLocaleTimeString() : ''}`; cls = 'ok'; }
  const total = store.data.meta.recordTypes.reduce((n, t) => n + records(t.key).length, 0);
  replace(els.status, 
    h('span', { class: ['save-pill', cls], title: s.error ? 'Click to retry now' : 'Autosave is on — changes are written to disk automatically', onclick: () => { if (s.error || s.dirty) flush(); } }, state),
    h('a', { href: '#', class: 'path', title: 'Show in Explorer', onclick: e => { e.preventDefault(); window.crm.db.reveal(); } }, store.path),
    h('span', { class: 'muted' }, `${total} records`),
    h('span', { class: 'spacer' }),
    setupChip(),
    store.config?.ai?.model ? h('span', { class: 'muted', title: store.config.ai.baseUrl }, `AI: ${store.config.ai.model}`) : h('a', { href: '#', class: 'muted', onclick: e => { e.preventDefault(); openSettings('ai'); } }, 'AI: not configured'));
}

// ---------- actions ----------
function switchType(key) {
  if (store.ui.typeKey !== key || store.ui.viewId) {
    store.ui.typeKey = key;
    store.ui.viewId = null;
    store.ui.activeId = null;
    store.ui.selected.clear();
    store.ui.filters = { colors: [], due: [], fields: {} };
    resetDrawerState();
    saveUiPrefs();
  }
  schedule('all');
}

function newRecord() {
  const type = currentType();
  const rec = createRecord(type);
  store.ui.query = ''; els.search.value = '';
  store.ui.filters = { colors: [], due: [], fields: {} };
  resetDrawerState();
  openRecord(rec.id);
  // start editing the title right away
  setTimeout(() => document.querySelector('#drawer .rec-title')?.click(), 60);
}

function navigate(dir) {
  const list = store.ui.mode === 'dashboard' ? [] : visibleRecords();
  if (!list.length) return;
  const i = list.findIndex(r => r.id === store.ui.activeId);
  const next = list[Math.max(0, Math.min(list.length - 1, i < 0 ? 0 : i + dir))];
  resetDrawerState();
  openRecord(next.id);
  requestAnimationFrame(() => document.querySelector(`#view tr[data-id="${next.id}"]`)?.scrollIntoView({ block: 'nearest' }));
}

function doUndo() { const l = undo(); if (l) toast(`Undone: ${l}`, { timeout: 1800 }); }
function doRedo() { const l = redo(); if (l) toast(`Redone: ${l}`, { timeout: 1800 }); }

function saveUiPrefs() {
  try { localStorage.setItem(`opencrm.ui:${store.path}`, JSON.stringify({ typeKey: store.ui.typeKey, mode: store.ui.mode, boardField: store.ui.boardField })); } catch { /* ignore */ }
}
function loadUiPrefs() {
  try {
    const p = JSON.parse(localStorage.getItem(`opencrm.ui:${store.path}`) || 'null');
    if (p) {
      if (getType(store.data, p.typeKey)) store.ui.typeKey = p.typeKey;
      if (['table', 'board', 'dashboard', 'mail'].includes(p.mode)) store.ui.mode = p.mode;
      store.ui.boardField = p.boardField || {};
    }
  } catch { /* ignore */ }
}

// ---------- database lifecycle ----------
function enterDatabase(res) {
  if (!res || res.canceled) return;
  $('#welcome').replaceChildren();
  $('#welcome').classList.add('hidden');
  $('#app').classList.remove('hidden');
  store.path = res.path;
  loadUiPrefs();
  store.ui.viewId = null;
  store.ui.query = ''; if (els.search) els.search.value = '';
  store.ui.filters = { colors: [], due: [], fields: {} };
  resetDrawerState();
  loadDatabase(res);
  if (res.migrated && res.fromVersion < 3) {
    toast(`Upgraded your v${res.fromVersion} database. The original file was kept as a copy next to it.`, { timeout: 9000 });
  }
  document.title = `OpenCRM — ${res.path.split(/[\\/]/).pop()}`;
  startReminders();
  refreshMail();
  refreshAgentState();
}

async function openDatabase(path) {
  await flush();
  try {
    let res = await window.crm.db.open(path ? { path } : {});
    if (res?.locked) {
      if (!(await lockPrompt(res.locked))) return;
      res = await window.crm.db.open({ path: res.path, force: true });
    }
    if (res && !res.canceled) enterDatabase(res);
  } catch (e) { toast(e.message, { type: 'error', timeout: 8000 }); }
}

async function newDatabase() {
  const body = h('div', { class: 'template-grid' }, TEMPLATES.map(t => h('button', { class: 'template-card', onclick: async () => {
    m.close();
    await flush();
    try { const res = await window.crm.db.create({ templateKey: t.key }); if (res && !res.canceled) enterDatabase(res); } catch (e) { toast(e.message, { type: 'error' }); }
  } }, h('b', {}, t.label), h('span', { class: 'muted small' }, t.description))));
  const m = openModal({ title: 'New database — choose a starting template', size: 'lg', body });
}

async function moveDatabase() {
  await flush();
  try { const res = await window.crm.db.moveTo(); if (res && !res.canceled) { enterDatabase(res); toast('Database moved. The old file was left in place.'); } } catch (e) { toast(e.message, { type: 'error' }); }
}

async function closeDatabase() {
  if (!(await confirmDialog('Close this database? OpenCRM will show the start screen next time.', { okLabel: 'Close database' }))) return;
  await flush();
  await window.crm.db.close();
  store.data = null; store.path = null;
  showWelcome();
}

function showWelcome(error) {
  $('#app').classList.add('hidden');
  const w = $('#welcome');
  w.classList.remove('hidden');
  renderWelcome(w, { onOpened: enterDatabase, error, onSetup: () => openSetupWizard({ onOpened: enterDatabase }), onTutorial: () => openTutorial() });
}

// ---------- keyboard ----------
function isTyping(e) {
  const t = e.target;
  return t && (t.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(t.tagName));
}

function onKey(e) {
  if (!store.data) return;
  const k = e.key.toLowerCase();
  if (e.key === 'F1') { e.preventDefault(); openHelp(); return; }
  if (e.ctrlKey && k === 'z' && !e.shiftKey && !isTyping(e)) { e.preventDefault(); doUndo(); return; }
  if (e.ctrlKey && (k === 'y' || (k === 'z' && e.shiftKey)) && !isTyping(e)) { e.preventDefault(); doRedo(); return; }
  if (anyModalOpen()) { if (e.key === 'Escape') topModal()?.close(); return; }
  if (e.key === 'Escape') {
    if (document.querySelector('.popover')) { closePopover(); return; }
    if (isTyping(e)) return;
    if (store.ui.activeId != null) { closeRecord(); return; }
    if (store.ui.selected.size) { store.ui.selected.clear(); emit('selection-changed'); }
    return;
  }
  if (e.ctrlKey && k === 'f') { e.preventDefault(); els.search.focus(); els.search.select(); return; }
  if (e.ctrlKey && k === 'n') { e.preventDefault(); newRecord(); return; }
  if (e.ctrlKey && ['1', '2', '3', '4'].includes(k)) { e.preventDefault(); store.ui.mode = ['table', 'board', 'dashboard', 'mail'][+k - 1]; saveUiPrefs(); schedule('toolbar', 'main'); return; }
  if (isTyping(e)) return;
  if (store.ui.mode === 'mail' && !e.ctrlKey && !e.altKey) {
    const msg = getActiveMessage();
    if (msg && (k === 'r' || k === 'a' || k === 'f')) { e.preventDefault(); openCompose({ mode: { r: 'reply', a: 'replyAll', f: 'forward' }[k], message: msg }); return; }
    if (k === 'j' || k === 'k') {
      const rows = [...document.querySelectorAll('.mail-list .thread-row')];
      const i = rows.findIndex(r => r.classList.contains('on'));
      const next = rows[Math.max(0, Math.min(rows.length - 1, i < 0 ? 0 : i + (k === 'j' ? 1 : -1)))];
      if (next) { e.preventDefault(); next.click(); next.scrollIntoView({ block: 'nearest' }); }
      return;
    }
  }
  if (k === '/') { e.preventDefault(); els.search.focus(); return; }
  if (e.key === 'ArrowDown') { e.preventDefault(); navigate(1); return; }
  if (e.key === 'ArrowUp') { e.preventDefault(); navigate(-1); return; }
  if (e.key === 'Enter' && store.ui.activeId == null) { const f = visibleRecords()[0]; if (f) openRecord(f.id); return; }
  if (k === 'n' && store.ui.activeId != null) { e.preventDefault(); openNewNote(els.drawer); }
}

// ---------- boot ----------
function applyConfig() {
  const c = store.config;
  document.body.classList.toggle('density-comfortable', c?.ui?.density === 'comfortable');
  if (c?.drawerWidth) document.documentElement.style.setProperty('--drawer-w', `${c.drawerWidth}px`);
}

function wireEvents() {
  on('change', () => schedule('all'));
  on('view-changed', () => schedule('filter', 'main', 'status', 'toolbar'));
  on('selection-changed', () => schedule('bulk', 'main'));
  on('active-changed', () => { resetDrawerState(); schedule('main', 'drawer'); });
  on('type-changed', () => { saveUiPrefs(); schedule('all'); });
  on('types-changed', () => schedule('all'));
  on('save-state', () => schedule('status', 'toolbar'));
  on('config-changed', () => { applyConfig(); schedule('status', 'main'); });
  on('query-reset', () => { if (els.search) els.search.value = store.ui.query || ''; });
  on('reminders', () => schedule('toolbar'));
  on('new-note', () => openNewNote(els.drawer));
  on('nav', dir => navigate(dir));
  on('undo', () => doUndo());
  on('semantic-changed', () => schedule('filter', 'main', 'status', 'semantic'));
  on('semantic-progress', () => renderSemanticBanner(els.semBanner));
  on('mail-changed', () => { invalidateDrawerMail(); schedule('main', 'drawer', 'toolbar'); });
  on('mail-status', () => { if (store.ui.mode === 'mail') schedule('main'); });
  on('mail-outbox', () => { if (store.ui.mode === 'mail') schedule('main'); });
  on('mail-search-text', () => { if (store.ui.query) schedule('main', 'filter'); });
  on('agents-changed', () => schedule('toolbar'));
  on('mail-tracking', changes => { for (const c of changes || []) if (c.kind === 'interest' || c.kind === 'unsubscribe') applyMailEvent(c); });
  on('mail-intent', ev => applyMailEvent({ ...ev, kind: 'intent' }));
  on('mail-bounce', ev => applyMailEvent({ ...ev, kind: 'bounce' }));

  document.addEventListener('keydown', onKey);
  // open every link outside the app in the default browser / mail client
  document.addEventListener('click', e => {
    const a = e.target.closest('a[href]');
    if (!a || e.defaultPrevented) return;
    const href = a.getAttribute('href');
    if (!href || href === '#' || href.startsWith('app://')) return;
    e.preventDefault();
    window.crm.app.openExternal(a.href);
  });

  window.crm.db.onExternalChange(async ({ data }) => {
    if (!store.data) return;
    if (!store.save.dirty) {
      replaceData(data);
      toast('The database file changed on disk — reloaded.', { timeout: 4000 });
      return;
    }
    const reload = await confirmDialog('The database file was changed outside OpenCRM (e.g. by a sync tool) while you have unsaved edits.', {
      title: 'External change', okLabel: 'Reload from disk', cancelLabel: 'Keep my version',
      detail: 'Reload discards your last unsaved edits (Ctrl+Z can bring them back). Keep my version overwrites the file.',
    });
    if (reload) replaceData(data, { keepUndo: true }); else flush();
  });
  window.crm.app.onFlushRequest(async ({ close }) => {
    await flush();
    window.crm.app.flushed({ close });
  });
  window.crm.app.onWarning(msg => toast(msg, { type: 'error', timeout: 8000 }));
  window.crm.app.onOpenRecord(({ typeKey, id }) => { if (findRecord(typeKey, id)) openRecord(id, typeKey); });
  window.crm.app.onQuickAddNote(({ type, id, content, kind }) => {
    if (!findRecord(type, id)) { toast('Quick note: record not found', { type: 'error' }); return; }
    mutate('Quick note', () => {
      const r = findRecord(type, id);
      (r.notes ||= []).push({ id: newNoteId(), date: noteDateString(), time: noteTimeString(), content, ...(kind && kind !== 'Note' ? { kind } : {}) });
      touch(r);
    });
    const t = getType(store.data, type);
    toast(`Note added to ${recordTitle(t, findRecord(type, id))}`);
  });
}

async function boot() {
  buildLayout();
  wireEvents();
  initMail();
  initAgentBridge();
  initAgentUi();
  startAutosave();
  let state;
  try { state = await window.crm.state(); } catch (e) { showWelcome(e.message); return; }
  store.config = state.config;
  store.version = state.version;
  if (state.isTest) window.__opencrmTest = { startImport: (p) => startImport({ path: p }) };
  applyConfig();
  if (state.db?.locked) {
    if (await lockPrompt(state.db.locked)) {
      try { const res = await window.crm.db.open({ path: state.db.path, force: true }); enterDatabase(res); return; } catch (e) { showWelcome(e.message); return; }
    }
    showWelcome();
    return;
  }
  if (state.db?.data) enterDatabase(state.db);
  else showWelcome(state.openError);
  // First run (or after the installer's "Choose features" page): the setup guide. Tests opt in with OPENCRM_TEST_SETUP.
  if (!state.config.setup?.done && (!state.isTest || state.forceSetup)) openSetupWizard({ onOpened: enterDatabase });
}

boot();

