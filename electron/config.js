// Machine-level configuration stored in %APPDATA%\OpenCRM\config.json.
// (Database-level settings live inside the database file, in meta.settings.)

import fs from 'node:fs';
import path from 'node:path';
import { app, safeStorage } from 'electron';
import { toStored, fromStored } from './paths.js';

const DEFAULTS = {
  lastDbPath: null,
  recentDbs: [],
  window: { width: 1400, height: 900, x: undefined, y: undefined, maximized: false, drawerWidth: 560 },
  ai: {
    baseUrl: 'http://localhost:1234/v1',
    model: '',
    temperature: 0.7,
    maxTokens: 1024,
    timeoutMs: 120000,
    stream: true,
    disableThinking: true, // recommended for Gemma 4 / Qwen3 / DeepSeek-R1: faster, no empty answers
    embedUrl: '', // optional separate embeddings server; blank = same as baseUrl
    embedModel: '',
    semanticMode: 'auto', // auto | embeddings | llm
    apiKeyEnc: null,
  },
  ui: {
    theme: 'system', // system | light | dark
    density: 'compact',
    closeToTray: false,
    hotkey: 'Control+Alt+N',
    hotkeyEnabled: true,
    notifications: true,
    startWithWindows: false, // mirrors the Windows "Run" entry (set by the installer or Settings → General)
    me: { name: '', signature: '', about: '' },
  },
  // First-run setup guide. done = finished or dismissed; chosen = features picked; skipped = left for later;
  // installer = choices made on the installer's "Choose features" page (read once from installer-choices.json).
  setup: { done: false, chosen: null, skipped: [], configured: [], hideChecklist: false, installer: null, finishedAt: null },
  agents: {
    clients: [], // [{ id, name, kind, profile: readonly|assistant|autopilot, tokenHash, confirmed, paused, readEmails, lastSeen }]
    paused: false,
    autoSendCap: 20,
    writesPerHour: 200,
    callsPerMinute: 120,
    httpEnabled: false,
    httpPort: 39271,
  },
  mail: {
    accounts: [], // [{ id, name, email, fromName, preset, imap{host,port,security,user}, smtp{...}, auth, allowSelfSigned, enabled, signature, dailyLimit, aliases }]
    secrets: {}, // accountId -> encrypted JSON ({pass} or {refreshToken,...}); never sent to the renderer
    pollMinutes: 5,
    undoSeconds: 10,
    notifyNewMail: true,
    oauth: { microsoftClientId: '', microsoftTenant: 'consumers', googleClientId: '', googleClientSecret: '' },
    tracker: { kind: 'off', url: '', secretEnc: null, pixel: true, clicks: true },
  },
};

let cache = null;

function file() { return path.join(app.getPath('userData'), 'config.json'); }

function deepMerge(base, over) {
  if (Array.isArray(base) || typeof base !== 'object' || base === null) return over === undefined ? base : over;
  const out = { ...base };
  for (const k of Object.keys(over || {})) out[k] = deepMerge(base[k], over[k]);
  return out;
}

export function load() {
  if (cache) return cache;
  try {
    const saved = JSON.parse(fs.readFileSync(file(), 'utf8'));
    saved.lastDbPath = fromStored(saved.lastDbPath);
    if (Array.isArray(saved.recentDbs)) saved.recentDbs = saved.recentDbs.map(fromStored);
    cache = deepMerge(structuredClone(DEFAULTS), saved);
    // People who used OpenCRM before the setup guide existed already have everything set up: don't nag them.
    if (!saved.setup && (saved.lastDbPath || saved.recentDbs?.length)) cache.setup.done = true;
  } catch {
    cache = structuredClone(DEFAULTS);
  }
  readInstallerChoices();
  return cache;
}

// The installer's "Choose features" page writes %APPDATA%\OpenCRM\installer-choices.json; consume it once.
export const SETUP_FEATURES = ['me', 'ai', 'email', 'tracking', 'agents', 'windows'];
function readInstallerChoices() {
  const f = path.join(app.getPath('userData'), 'installer-choices.json');
  let raw;
  try { raw = JSON.parse(fs.readFileSync(f, 'utf8').replace(/^\uFEFF/, '')); } catch { return; }
  const on = v => v === true || v === 1 || v === '1';
  const chosen = SETUP_FEATURES.filter(k => on(raw[k]));
  cache.setup.installer = { at: new Date().toISOString(), desktop: on(raw.desktop), startWithWindows: on(raw.startWithWindows), chosen };
  if (on(raw.startWithWindows)) cache.ui.startWithWindows = true;
  if (chosen.length) {
    // A fresh install (or a re-install where the person ticked things) shows the guide again with those features.
    cache.setup.chosen = chosen;
    cache.setup.done = false;
  }
  try { save(); fs.unlinkSync(f); } catch { /* read again next time */ }
}

export function save() {
  const f = file();
  fs.mkdirSync(path.dirname(f), { recursive: true });
  const tmp = f + '.tmp';
  const out = { ...cache, lastDbPath: toStored(cache.lastDbPath), recentDbs: (cache.recentDbs || []).map(toStored) };
  fs.writeFileSync(tmp, JSON.stringify(out, null, 2));
  fs.renameSync(tmp, f);
}

export function get() { return load(); }

export function update(patch) {
  load();
  cache = deepMerge(cache, patch);
  save();
  return cache;
}

export function rememberDb(dbPath) {
  load();
  cache.lastDbPath = dbPath;
  cache.recentDbs = [dbPath, ...cache.recentDbs.filter(p => p !== dbPath)].slice(0, 10);
  save();
}

export function forgetDb(dbPath) {
  load();
  cache.recentDbs = cache.recentDbs.filter(p => p !== dbPath);
  if (cache.lastDbPath === dbPath) cache.lastDbPath = null;
  save();
}

export function setApiKey(key) {
  load();
  if (!key) cache.ai.apiKeyEnc = null;
  else if (safeStorage.isEncryptionAvailable()) cache.ai.apiKeyEnc = 'enc:' + safeStorage.encryptString(key).toString('base64');
  else cache.ai.apiKeyEnc = 'plain:' + Buffer.from(key).toString('base64');
  save();
}

export function getApiKey() {
  const v = load().ai.apiKeyEnc;
  if (!v) return '';
  try {
    if (v.startsWith('enc:')) return safeStorage.decryptString(Buffer.from(v.slice(4), 'base64'));
    if (v.startsWith('plain:')) return Buffer.from(v.slice(6), 'base64').toString();
  } catch { /* unreadable on this machine */ }
  return '';
}

function enc(str) {
  if (safeStorage.isEncryptionAvailable()) return 'enc:' + safeStorage.encryptString(str).toString('base64');
  return 'plain:' + Buffer.from(str).toString('base64');
}
function dec(v) {
  if (!v) return '';
  try {
    if (v.startsWith('enc:')) return safeStorage.decryptString(Buffer.from(v.slice(4), 'base64'));
    if (v.startsWith('plain:')) return Buffer.from(v.slice(6), 'base64').toString();
  } catch { /* unreadable on this machine */ }
  return '';
}

export function setMailSecret(accountId, secret) {
  load();
  if (!secret) delete cache.mail.secrets[accountId];
  else cache.mail.secrets[accountId] = enc(JSON.stringify(secret));
  save();
}
/** A secret exists but Windows can't decrypt it here (saved on another computer or Windows account, e.g. portable use). */
export function mailSecretUnreadable(accountId) {
  const v = load().mail.secrets[accountId];
  return !!v && v.startsWith('enc:') && !dec(v);
}
export function getMailSecret(accountId) {
  const v = load().mail.secrets[accountId];
  if (!v) return null;
  try { return JSON.parse(dec(v)); } catch { return null; }
}
export function setTrackerSecret(secret) { load(); cache.mail.tracker.secretEnc = secret ? enc(secret) : null; save(); }
export function getTrackerSecret() { return dec(load().mail.tracker.secretEnc); }

// Settings safe to expose to the renderer (never the API key itself).
export function publicConfig() {
  const c = load();
  return {
    lastDbPath: c.lastDbPath,
    recentDbs: c.recentDbs,
    ai: { ...c.ai, apiKeyEnc: undefined, hasApiKey: !!c.ai.apiKeyEnc },
    ui: c.ui,
    setup: c.setup,
    drawerWidth: c.window.drawerWidth,
    mail: {
      ...c.mail, secrets: undefined,
      accounts: c.mail.accounts.map(a => ({ ...a, hasSecret: !!c.mail.secrets[a.id] })),
      oauth: { ...c.mail.oauth, googleClientSecret: c.mail.oauth.googleClientSecret ? '••••' : '' },
      tracker: { ...c.mail.tracker, secretEnc: undefined, hasSecret: !!c.mail.tracker.secretEnc },
    },
  };
}
