// OpenCRM — Electron main process.
import { app, BrowserWindow, ipcMain, dialog, shell, protocol, net, nativeTheme, Notification, Tray, Menu, globalShortcut, clipboard, powerMonitor, nativeImage } from 'electron';
import path from 'node:path';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { applyPaths, databasesDir, isPortable, PORTABLE_ROOT } from './electron/paths.js';
import * as config from './electron/config.js';
import { DbService, filesDirFor } from './electron/db-service.js';
import { listBackups, manualBackup } from './electron/backup.js';
import { addFiles, setPicture, trashFile, resolveRel } from './electron/attachments.js';
import * as ai from './electron/ai-service.js';
import { setupAiRuntime } from './electron/ai-runtime.js';
import { extractText } from './electron/doc-extract.js';
import * as semantic from './electron/semantic.js';
import { parseImportFile, toVcf } from './electron/importer.js';
import { createDatabase } from './src/shared/templates.js';
import { recordTitle } from './src/shared/schema.js';
import { migrate } from './src/shared/migrate.js';
import { setupMail } from './electron/mail/ipc.js';
import { setupAgents } from './electron/agent/gateway.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SRC = path.join(__dirname, 'src');
const IS_TEST = !!process.env.OPENCRM_TEST;

applyPaths(); // portable mode: settings in OpenCRM-data next to the program (see electron/paths.js)

protocol.registerSchemesAsPrivileged([
  { scheme: 'app', privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true } },
]);

const db = new DbService();
const searches = new Map(); // searchId -> AbortController
let win = null;
let quickWin = null;
let tray = null;
let quitting = false;
let flushDone = false;
let flushTimer = null;
let mailCtl = null;
let agents = null;
let aiRuntime = null;
let mailStopped = false;

if (!IS_TEST && !app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => showMain());
}

const VENDOR = {
  'marked.js': 'node_modules/marked/lib/marked.esm.js',
  'purify.js': 'node_modules/dompurify/dist/purify.es.mjs',
};

function registerProtocol() {
  protocol.handle('app', async (req) => {
    const url = new URL(req.url);
    let p = decodeURIComponent(url.pathname).replace(/^\/+/, '');
    let abs;
    if (p.startsWith('vendor/')) {
      const v = VENDOR[p.slice(7)];
      if (!v) return new Response('Not found', { status: 404 });
      abs = path.join(__dirname, v);
    } else if (p.startsWith('__files/')) {
      if (!db.path) return new Response('No database', { status: 404 });
      try { abs = resolveRel(db.path, p.slice(8)); } catch { return new Response('Forbidden', { status: 403 }); }
    } else if (p === 'docs/TUTORIAL.md' || /^docs\/screenshots\/[\w.-]+\.png$/.test(p)) {
      abs = path.join(__dirname, p); // the tutorial ships with the app (Help → Tutorial)
    } else if (p === 'icon.png') {
      abs = path.join(__dirname, 'assets', 'icon.png');
    } else {
      if (!p) p = 'index.html';
      abs = path.resolve(SRC, p);
      if (!abs.startsWith(SRC + path.sep)) return new Response('Forbidden', { status: 403 });
    }
    try {
      const res = await net.fetch(pathToFileURL(abs).toString());
      if (/\.m?js$/.test(abs)) {
        return new Response(res.body, { status: res.status, headers: { 'Content-Type': 'text/javascript; charset=utf-8' } });
      }
      return res;
    } catch {
      return new Response('Not found', { status: 404 });
    }
  });
}

function iconPath() { return path.join(__dirname, 'assets', 'icon.png'); }

function createWindow() {
  const c = config.get();
  nativeTheme.themeSource = c.ui.theme || 'system';
  win = new BrowserWindow({
    width: c.window.width, height: c.window.height, x: c.window.x, y: c.window.y,
    minWidth: 900, minHeight: 560,
    title: 'OpenCRM',
    icon: fs.existsSync(iconPath()) ? iconPath() : undefined,
    backgroundColor: nativeTheme.shouldUseDarkColors ? '#1e1f22' : '#f4f4f4',
    show: false,
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      spellcheck: true,
      backgroundThrottling: false,
    },
  });
  Menu.setApplicationMenu(null);
  if (c.window.maximized) win.maximize();
  // --hidden: started with Windows (Run entry written by the installer or Settings → General): stay in the tray.
  win.once('ready-to-show', () => { if (!process.env.OPENCRM_HIDDEN && !process.env.OPENCRM_START_HIDDEN && !process.argv.includes('--hidden')) win.show(); });
  win.loadURL('app://crm/index.html');

  win.webContents.setWindowOpenHandler(({ url }) => { openExternalSafe(url); return { action: 'deny' }; });
  win.webContents.on('will-navigate', (e, url) => { if (!url.startsWith('app://crm/')) { e.preventDefault(); openExternalSafe(url); } });
  win.webContents.on('before-input-event', (_e, input) => {
    if (input.type === 'keyDown' && input.key === 'F12') win.webContents.toggleDevTools();
    if (input.type === 'keyDown' && input.control && input.key.toLowerCase() === 'r' && input.shift) win.webContents.reload();
  });

  win.on('close', (e) => {
    saveWindowState();
    if (!quitting && config.get().ui.closeToTray && tray) {
      e.preventDefault();
      win.hide();
      requestFlush(false);
      return;
    }
    if (!flushDone && db.path) {
      e.preventDefault();
      requestFlush(true);
    }
  });
  win.on('closed', () => {
    win = null;
    if (quickWin && !quickWin.isDestroyed()) quickWin.destroy();
    app.quit();
  });
  win.on('session-end', () => requestFlush(false));
}

function requestFlush(thenClose) {
  if (!win) return;
  win.webContents.send('app:flush-request', { close: thenClose });
  if (thenClose) {
    clearTimeout(flushTimer);
    flushTimer = setTimeout(() => finishClose(), 4000); // never hang on exit
  }
}

function finishClose() {
  clearTimeout(flushTimer);
  flushDone = true;
  if (win) win.close();
}

function saveWindowState() {
  if (!win) return;
  const maximized = win.isMaximized();
  const b = win.getNormalBounds();
  config.update({ window: { ...config.get().window, ...b, maximized } });
}

function showMain() {
  if (!win) createWindow();
  if (win.isMinimized()) win.restore();
  win.show();
  win.focus();
}

function openExternalSafe(url) {
  try {
    const u = new URL(url);
    if (['http:', 'https:', 'mailto:', 'tel:'].includes(u.protocol)) shell.openExternal(url);
  } catch { /* ignore invalid */ }
}

// ---------- start with Windows ----------
// Same Run entry the installer writes: HKCU\…\Run\OpenCRM = "<exe>" --hidden. Only for the packaged app.
function loginExe() { return process.env.PORTABLE_EXECUTABLE_FILE || process.execPath; }
function canStartWithWindows() { return app.isPackaged && !IS_TEST && process.platform === 'win32'; }
function applyLoginItem(on) {
  if (!canStartWithWindows()) return { ok: false, error: 'Only available in the installed app.' };
  try { app.setLoginItemSettings({ openAtLogin: !!on, path: loginExe(), args: ['--hidden'], name: 'OpenCRM' }); return { ok: true }; } catch (e) { return { ok: false, error: e.message }; }
}
function startsWithWindows() {
  if (!canStartWithWindows()) return !!config.get().ui.startWithWindows;
  try { const s = app.getLoginItemSettings({ path: loginExe(), args: ['--hidden'] }); return !!(s.executableWillLaunchAtLogin ?? s.openAtLogin); } catch { return !!config.get().ui.startWithWindows; }
}
function publicConfigNow() {
  const pc = config.publicConfig();
  return { ...pc, ui: { ...pc.ui, startWithWindows: startsWithWindows() }, canStartWithWindows: canStartWithWindows() };
}

// ---------- tray & quick add ----------
function setupTray() {
  if (tray || IS_TEST) return;
  const img = fs.existsSync(iconPath()) ? nativeImage.createFromPath(iconPath()).resize({ width: 16, height: 16 }) : nativeImage.createEmpty();
  tray = new Tray(img);
  tray.setToolTip('OpenCRM');
  const hk = config.get().ui.hotkey;
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: 'Open OpenCRM', click: showMain },
    { label: `Quick add note${hk ? '  (' + hk.replace('Control', 'Ctrl') + ')' : ''}`, click: openQuickAdd },
    { type: 'separator' },
    { label: 'Quit', click: () => { quitting = true; app.quit(); } },
  ]));
  tray.on('click', showMain);
}

function registerHotkey() {
  globalShortcut.unregisterAll();
  const ui = config.get().ui;
  if (IS_TEST || !ui.hotkeyEnabled || !ui.hotkey) return { ok: true };
  try {
    const ok = globalShortcut.register(ui.hotkey, openQuickAdd);
    return { ok, error: ok ? null : `The shortcut ${ui.hotkey} is already used by another program.` };
  } catch (e) { return { ok: false, error: e.message }; }
}

function openQuickAdd() {
  if (quickWin && !quickWin.isDestroyed()) { quickWin.show(); quickWin.focus(); quickWin.webContents.send('quick:shown'); return; }
  quickWin = new BrowserWindow({
    width: 520, height: 430, resizable: false, minimizable: false, maximizable: false,
    alwaysOnTop: true, skipTaskbar: true, title: 'Quick add note', autoHideMenuBar: true, show: false,
    icon: fs.existsSync(iconPath()) ? iconPath() : undefined,
    backgroundColor: nativeTheme.shouldUseDarkColors ? '#1e1f22' : '#ffffff',
    webPreferences: { preload: path.join(__dirname, 'preload.cjs'), contextIsolation: true, sandbox: true, nodeIntegration: false, spellcheck: true },
  });
  quickWin.loadURL('app://crm/quickadd.html');
  quickWin.once('ready-to-show', () => quickWin.show());
  quickWin.on('blur', () => { if (quickWin && !quickWin.webContents.isDevToolsOpened()) quickWin.hide(); });
  quickWin.on('closed', () => { quickWin = null; });
}

// ---------- IPC ----------
const h = (ch, fn) => ipcMain.handle(ch, async (e, ...args) => {
  try { return await fn(e, ...args); } catch (err) { return { error: err?.message || String(err) }; }
});

function dbPayload(res) {
  if (!res) return null;
  if (res.locked) return { locked: res.locked };
  return { path: res.path, data: res.data, migrated: res.migrated, fromVersion: res.fromVersion, log: res.log, filesDir: filesDirFor(res.path) };
}

async function openDb(p, force) {
  const res = await db.open(p, { force });
  if (res.locked) return { locked: res.locked, path: path.resolve(p) };
  config.rememberDb(res.path);
  mailCtl?.attach().catch(e => win?.webContents.send('app:warning', 'Email: ' + e.message));
  return dbPayload(res);
}

const JSON_FILTER = [{ name: 'OpenCRM database', extensions: ['json'] }];

function setupIpc() {
  h('state:get', async () => {
    const c = config.get();
    let dbState = null;
    let openError = null;
    if (db.path) dbState = { path: db.path, data: db.data, filesDir: filesDirFor(db.path) };
    else if (process.env.OPENCRM_OPEN || c.lastDbPath) {
      const p = process.env.OPENCRM_OPEN || c.lastDbPath;
      if (fs.existsSync(p)) {
        try { dbState = await openDb(p, false); } catch (e) { openError = `Could not open ${p}: ${e.message}`; }
      } else openError = `The last database was not found: ${p}`;
    }
    return { config: publicConfigNow(), db: dbState, openError, version: app.getVersion(), isTest: IS_TEST, forceSetup: !!process.env.OPENCRM_TEST_SETUP, portable: isPortable() ? PORTABLE_ROOT : null };
  });

  h('db:open', async (_e, opts = {}) => {
    let p = opts.path;
    if (!p) {
      const r = await dialog.showOpenDialog(win, { title: 'Open database', properties: ['openFile'], filters: JSON_FILTER });
      if (r.canceled || !r.filePaths[0]) return { canceled: true };
      p = r.filePaths[0];
    }
    return openDb(p, !!opts.force);
  });

  h('db:create', async (_e, { templateKey = 'blank', customSchema = null, path: p } = {}) => {
    if (!p && IS_TEST && process.env.OPENCRM_TEST_SAVE_PATH) p = process.env.OPENCRM_TEST_SAVE_PATH;
    if (!p) {
      const r = await dialog.showSaveDialog(win, { title: 'Create new database', defaultPath: path.join(databasesDir(), 'crm.json'), filters: JSON_FILTER });
      if (r.canceled || !r.filePath) return { canceled: true };
      p = r.filePath;
    }
    if (fs.existsSync(p)) {
      const r = await dialog.showMessageBox(win, { type: 'warning', buttons: ['Cancel', 'Replace'], defaultId: 0, cancelId: 0, message: `${path.basename(p)} already exists. Replace it with a new empty database?`, detail: 'A backup of the existing file will be kept in the backups folder.' });
      if (r.response !== 1) return { canceled: true };
      manualBackup(p, 'replaced');
    }
    const data = createDatabase(templateKey, customSchema);
    const res = await db.create(p, data);
    config.rememberDb(res.path);
    mailCtl?.attach().catch(() => {});
    return dbPayload(res);
  });

  h('db:save', async (_e, data) => { const r = await db.save(data); mailCtl?.setData(db.data); return r; });
  h('db:moveTo', async () => {
    if (!db.path) throw new Error('No database open');
    const r = await dialog.showSaveDialog(win, { title: 'Move / save database as', defaultPath: db.path, filters: JSON_FILTER });
    if (r.canceled || !r.filePath) return { canceled: true };
    if (path.resolve(r.filePath) === db.path) return { canceled: true };
    await mailCtl?.detach();
    const res = await db.moveTo(r.filePath);
    config.rememberDb(res.path);
    mailCtl?.attach().catch(() => {});
    return dbPayload(res);
  });
  h('db:close', async () => { await mailCtl?.detach(); db.close(); config.update({ lastDbPath: null }); return { ok: true }; });
  h('db:recent', async () => config.get().recentDbs.map(p => ({ path: p, exists: fs.existsSync(p) })));
  h('db:forget', async (_e, p) => { config.forgetDb(p); return { ok: true }; });
  h('db:reveal', async (_e, p) => { shell.showItemInFolder(p || db.path); return { ok: true }; });
  h('db:backups', async () => (db.path ? listBackups(db.path) : []));
  h('db:readBackup', async (_e, file) => {
    const abs = path.resolve(file);
    if (!db.path || path.dirname(abs) !== path.join(path.dirname(db.path), 'backups')) throw new Error('Invalid backup file');
    const { data } = migrate(JSON.parse(await fsp.readFile(abs, 'utf8')));
    manualBackup(db.path, 'pre-restore');
    return { data };
  });
  h('db:exportFile', async (_e, { defaultName, content, kind = 'json', vcfContacts }) => {
    const filters = { json: JSON_FILTER, csv: [{ name: 'CSV', extensions: ['csv'] }], vcf: [{ name: 'vCard', extensions: ['vcf'] }], md: [{ name: 'Markdown', extensions: ['md'] }] }[kind];
    const r = await dialog.showSaveDialog(win, { title: 'Export', defaultPath: path.join(app.getPath('documents'), defaultName), filters });
    if (r.canceled || !r.filePath) return { canceled: true };
    const out = kind === 'vcf' ? toVcf(vcfContacts || []) : content;
    await fsp.writeFile(r.filePath, kind === 'csv' ? '﻿' + out : out, 'utf8');
    return { path: r.filePath };
  });
  h('db:importParse', async (_e, opts = {}) => {
    let file = IS_TEST && opts.path ? opts.path : null; // tests cannot drive the native file dialog
    if (!file) {
      const r = await dialog.showOpenDialog(win, { title: 'Import file', properties: ['openFile'], filters: [{ name: 'Importable', extensions: ['csv', 'tsv', 'xlsx', 'vcf', 'json'] }] });
      if (r.canceled || !r.filePaths[0]) return { canceled: true };
      file = r.filePaths[0];
    }
    const parsed = await parseImportFile(file);
    return { ...parsed, fileName: path.basename(file) };
  });

  // attachments
  h('files:add', async (_e, { typeKey, id, paths }) => {
    if (!db.path) throw new Error('No database open');
    let list = paths;
    if (!list?.length) {
      const r = await dialog.showOpenDialog(win, { title: 'Attach files', properties: ['openFile', 'multiSelections'] });
      if (r.canceled) return { canceled: true };
      list = r.filePaths;
    }
    return { refs: await addFiles(db.path, typeKey, id, list) };
  });
  h('files:open', async (_e, rel) => { const err = await shell.openPath(resolveRel(db.path, rel)); if (err) throw new Error(err); return { ok: true }; });
  h('files:reveal', async (_e, rel) => { shell.showItemInFolder(resolveRel(db.path, rel)); return { ok: true }; });
  h('files:trash', async (_e, rel) => ({ ok: await trashFile(db.path, rel) }));
  h('files:setPicture', async (_e, { typeKey, id, path: p }) => {
    let src = p;
    if (!src) {
      const r = await dialog.showOpenDialog(win, { title: 'Choose picture', properties: ['openFile'], filters: [{ name: 'Images', extensions: ['png', 'jpg', 'jpeg', 'gif', 'webp'] }] });
      if (r.canceled || !r.filePaths[0]) return { canceled: true };
      src = r.filePaths[0];
    }
    return { value: await setPicture(db.path, typeKey, id, src) };
  });
  h('files:extract', async (_e, { rel, path: p } = {}) => {
    let abs = p;
    if (rel) abs = resolveRel(db.path, rel);
    if (!abs) {
      const r = await dialog.showOpenDialog(win, { title: 'Choose a document', properties: ['openFile'], filters: [{ name: 'Documents', extensions: ['pdf', 'docx', 'txt', 'md', 'html', 'htm', 'csv'] }] });
      if (r.canceled || !r.filePaths[0]) return { canceled: true };
      abs = r.filePaths[0];
    }
    const res = await extractText(abs);
    return { ...res, name: path.basename(abs), path: abs };
  });

  // AI
  const aiOpts = (o = {}) => { const c = config.get().ai; return { noThinking: c.disableThinking !== false, ...c, ...o, apiKey: o.apiKey ?? config.getApiKey() }; };
  h('ai:models', async (_e, o) => ({ models: await ai.listModels(aiOpts(o)) }));
  h('ai:test', async (_e, o) => {
    const opts = aiOpts(o);
    const models = await ai.listModels(opts).catch(() => null);
    const t0 = Date.now();
    const text = await ai.chat({ ...opts, stream: false, maxTokens: opts.noThinking ? 64 : 1024, timeoutMs: 90000, messages: [{ role: 'user', content: 'Reply with the single word: OK' }] });
    const ms = Date.now() - t0;
    semantic.resetProbe();
    const semanticMode = await semantic.resolveMode(opts).catch(() => 'llm');
    return { ok: true, reply: text.slice(0, 80), ms, models, semanticMode };
  });
  h('ai:chat', async (e, o) => {
    const sender = e.sender;
    const text = await ai.chat(aiOpts(o), (delta, kind) => {
      if (sender.isDestroyed()) return;
      sender.send('ai:chunk', kind === 'reasoning' ? { streamId: o.streamId, reasoning: delta } : { streamId: o.streamId, delta });
    });
    return { text };
  });
  h('ai:abort', async (_e, id) => {
    const s = searches.get(id);
    if (s) { s.abort(); searches.delete(id); return { ok: true }; }
    return { ok: ai.abort(id) };
  });
  h('semantic:search', async (e, { searchId, typeKey, query, docs }) => {
    if (!db.path) throw new Error('No database open');
    const ctrl = new AbortController();
    searches.set(searchId, ctrl);
    const sender = e.sender;
    try {
      return await semantic.search({
        dbPath: db.path, typeKey, query, docs, ai: aiOpts(), signal: ctrl.signal,
        onProgress: p => { if (!sender.isDestroyed()) sender.send('semantic:progress', { searchId, ...p }); },
      });
    } finally { searches.delete(searchId); }
  });
  h('ai:setKey', async (_e, key) => { config.setApiKey(key); return { ok: true }; });

  // config & app
  h('config:update', async (_e, patch) => {
    const safe = {};
    if (patch.ai) { const { apiKeyEnc, hasApiKey, ...rest } = patch.ai; safe.ai = rest; semantic.resetProbe(); }
    if (patch.ui) safe.ui = patch.ui;
    if (patch.mail) {
      const { accounts, secrets, ...rest } = patch.mail;
      if (rest.tracker) { delete rest.tracker.secretEnc; delete rest.tracker.hasSecret; }
      if (rest.oauth?.googleClientSecret === '••••') delete rest.oauth.googleClientSecret;
      safe.mail = rest;
    }
    if (patch.setup) {
      const allowed = ['done', 'chosen', 'skipped', 'configured', 'hideChecklist', 'finishedAt'];
      safe.setup = Object.fromEntries(Object.entries(patch.setup).filter(([k]) => allowed.includes(k)));
    }
    let login = null;
    if (patch.ui && 'startWithWindows' in patch.ui) login = applyLoginItem(patch.ui.startWithWindows);
    if (patch.drawerWidth) safe.window = { ...config.get().window, drawerWidth: patch.drawerWidth };
    config.update(safe);
    if (patch.ui?.theme) nativeTheme.themeSource = patch.ui.theme;
    let hotkey = null;
    if (patch.ui && ('hotkey' in patch.ui || 'hotkeyEnabled' in patch.ui)) { hotkey = registerHotkey(); if (tray) { tray.destroy(); tray = null; setupTray(); } }
    return { config: publicConfigNow(), hotkey, login };
  });
  h('app:notify', async (_e, { title, body, ref }) => {
    if (IS_TEST || !Notification.isSupported() || !config.get().ui.notifications) return { ok: false };
    const n = new Notification({ title, body, icon: fs.existsSync(iconPath()) ? iconPath() : undefined });
    n.on('click', () => { showMain(); if (ref) win?.webContents.send('app:open-record', ref); });
    n.show();
    return { ok: true };
  });
  h('app:print', async () => new Promise(res => win.webContents.print({ printBackground: true }, (ok, err) => res({ ok, error: err || null }))));
  h('app:pdf', async (_e, { defaultName }) => {
    const r = await dialog.showSaveDialog(win, { title: 'Save as PDF', defaultPath: path.join(app.getPath('documents'), defaultName || 'card.pdf'), filters: [{ name: 'PDF', extensions: ['pdf'] }] });
    if (r.canceled || !r.filePath) return { canceled: true };
    const pdf = await win.webContents.printToPDF({ printBackground: true, pageSize: 'A4', margins: { marginType: 'default' } });
    await fsp.writeFile(r.filePath, pdf);
    shell.openPath(r.filePath);
    return { path: r.filePath };
  });
  h('app:openExternal', async (_e, url) => { openExternalSafe(url); return { ok: true }; });
  h('app:clipboard', async (_e, text) => { clipboard.writeText(String(text ?? '')); return { ok: true }; });
  h('app:flushed', async (_e, { close } = {}) => { if (close) finishClose(); return { ok: true }; });
  h('app:quit', async () => { quitting = true; app.quit(); return { ok: true }; });
  h('app:userTemplates', async (_e, { action, template, name } = {}) => {
    const dir = path.join(app.getPath('userData'), 'templates');
    await fsp.mkdir(dir, { recursive: true });
    if (action === 'save') {
      const file = path.join(dir, String(name).replace(/[^\w -]/g, '_') + '.json');
      await fsp.writeFile(file, JSON.stringify(template, null, 2));
      return { ok: true };
    }
    if (action === 'delete') { await fsp.unlink(path.join(dir, path.basename(name))); return { ok: true }; }
    const out = [];
    for (const f of await fsp.readdir(dir)) {
      if (!f.endsWith('.json')) continue;
      try { out.push({ file: f, ...JSON.parse(await fsp.readFile(path.join(dir, f), 'utf8')) }); } catch { /* skip */ }
    }
    return { templates: out };
  });
  h('app:importTemplateFile', async () => {
    const r = await dialog.showOpenDialog(win, { title: 'Import template', properties: ['openFile'], filters: JSON_FILTER });
    if (r.canceled || !r.filePaths[0]) return { canceled: true };
    const j = JSON.parse(await fsp.readFile(r.filePaths[0], 'utf8'));
    if (!j.recordTypes) throw new Error('Not an OpenCRM template file.');
    return { template: j };
  });

  // quick add
  h('quick:records', async () => {
    if (!db.data) return { records: [], error: 'No database is open in OpenCRM.' };
    const out = [];
    for (const t of db.data.meta.recordTypes) {
      for (const r of db.data[t.key] || []) out.push({ type: t.key, typeLabel: t.singular || t.label, id: r.id, title: recordTitle(t, r), updatedAt: r.updatedAt || '' });
    }
    out.sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)));
    return { records: out, noteKinds: db.data.meta.settings?.noteKinds || [] };
  });
  h('quick:add', async (_e, payload) => {
    if (!win) throw new Error('OpenCRM main window is not running.');
    win.webContents.send('quickadd:note', payload);
    quickWin?.hide();
    return { ok: true };
  });
  h('quick:close', async () => { quickWin?.hide(); return { ok: true }; });

  db.on('external-change', ({ data }) => { win?.webContents.send('db:external-change', { data }); mailCtl?.setData(data); });
  mailCtl = setupMail({ h, db, config, getWin: () => win, isTest: IS_TEST, showMain, iconPath, aiOpts: () => aiOpts(), aiChat: ai.chat });
  aiRuntime = setupAiRuntime({ handle: h, send: (ch, p) => { if (win && !win.isDestroyed()) win.webContents.send(ch, p); }, isTest: IS_TEST });
  ai.aiHooks.before = url => aiRuntime.ensureFor(url);
  agents = setupAgents({ h, db, config, getWin: () => win, notify: (t, b) => mailCtl.notify(t, b), isTest: IS_TEST });
  db.on('warning', msg => win?.webContents.send('app:warning', msg));
}

app.whenReady().then(() => {
  registerProtocol();
  setupIpc();
  createWindow();
  setupTray();
  registerHotkey();
  agents?.start();
  aiRuntime?.startIfWanted();
  powerMonitor.on('suspend', () => requestFlush(false));
  powerMonitor.on('lock-screen', () => requestFlush(false));
});

app.on('before-quit', (e) => {
  quitting = true;
  if (mailCtl?.service && !mailStopped) {
    e.preventDefault();
    mailStopped = true;
    Promise.race([mailCtl.detach(), new Promise(r => setTimeout(r, 3000))]).finally(() => app.quit());
  }
});
app.on('will-quit', () => { globalShortcut.unregisterAll(); agents?.stop(); aiRuntime?.stop(); db.close(); });
app.on('window-all-closed', () => { app.quit(); });
