// Built-in AI: downloads llama.cpp + models on request and runs llama-server in the background.
// - Two servers on 127.0.0.1 only: chat (port 39281) and embeddings (39282, CPU). These ports differ from the
//   usual 8080/1234/11434, so a server you run yourself is never disturbed.
// - Start mode: "auto" starts the AI the first time OpenCRM needs it and stops it after 15 idle minutes (frees
//   RAM/VRAM); "startup" starts it with OpenCRM; "manual" only with the Start button.
// - If the graphics card can't run the model, it retries on the CPU.
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawn, execFile } from 'node:child_process';
import { shell } from 'electron';
import * as config from './config.js';
import { aiDir as getAiDir, isPortable } from './paths.js';
import { RUNTIME, MODELS, EMBED_MODEL, modelById, serverExe, modelPath, modelPresent, runtimeInstalled, installRuntime, installModel, suggestChatModel, modelsDir } from './ai-catalog.js';

export const PORTS = { chat: 39281, embed: 39282 };
const IDLE_MS = 15 * 60e3;

export function setupAiRuntime({ handle, send, isTest = false }) {
  const aiDir = getAiDir();
  const procs = { chat: null, embed: null }; // { child, port, model, ready: Promise, device }
  const downloads = new Map(); // id -> { ctrl, done, total, error }
  let idleTimer = null;

  const cfg = () => config.get().ai.builtin || {};
  const emit = () => send('ai-runtime:state', state());

  function state() {
    const ramGb = Math.round(os.totalmem() / 2 ** 30);
    return {
      aiDir, portable: isPortable(), ramGb, suggested: suggestChatModel(ramGb),
      runtime: { ...RUNTIME, installed: runtimeInstalled(aiDir), downloading: dl('runtime') },
      models: MODELS.map(m => ({ ...m, url: undefined, present: modelPresent(aiDir, m), downloading: dl(m.id) })),
      builtin: { enabled: false, chatModel: null, startMode: 'auto', ...cfg() },
      running: Object.fromEntries(Object.entries(procs).map(([k, p]) => [k, p ? { port: p.port, model: p.model, ready: !!p.isReady, device: p.device, error: p.error || null } : null])),
      ports: PORTS,
    };
  }
  function dl(id) {
    const d = downloads.get(id);
    return d ? { done: d.done, total: d.total, error: d.error || null } : null;
  }

  // ---------------------------------------------------------------- downloads
  async function runDownload(id, fn) {
    if (downloads.get(id) && !downloads.get(id).error) return { ok: true, already: true };
    const d = { ctrl: new AbortController(), done: 0, total: 0 };
    downloads.set(id, d);
    emit();
    try {
      await fn({ signal: d.ctrl.signal, onProgress: p => { d.done = p.done; d.total = p.total; send('ai-runtime:progress', { id, ...p }); } });
      downloads.delete(id);
      emit();
      return { ok: true };
    } catch (e) {
      const canceled = d.ctrl.signal.aborted;
      if (canceled) downloads.delete(id); else d.error = e.message;
      emit();
      return { ok: false, canceled, error: canceled ? 'Canceled. Start again to resume.' : e.message };
    }
  }
  const downloadRuntime = () => runDownload('runtime', o => installRuntime(aiDir, o));
  const downloadModel = id => {
    const m = modelById(id);
    if (!m) throw new Error('Unknown model');
    return runDownload(id, o => installModel(aiDir, m, o));
  };

  // ---------------------------------------------------------------- servers
  function argsFor(kind, m, device) {
    const common = ['--model', modelPath(aiDir, m), '--host', '127.0.0.1', '--port', String(PORTS[kind]), '--alias', m.id];
    if (kind === 'embed') return [...common, '--embeddings', '--pooling', 'mean', '--device', 'none', '--n-gpu-layers', '0', '--ctx-size', '2048', '--batch-size', '2048', '--ubatch-size', '2048', '--parallel', '2'];
    return [...common, '--ctx-size', '8192', '--jinja', '--parallel', '1', ...(device === 'cpu' ? ['--device', 'none', '--n-gpu-layers', '0'] : [])];
  }

  async function waitHealthy(p, ms) {
    const t0 = Date.now();
    while (Date.now() - t0 < ms) {
      if (p.exited) throw new Error(p.lastErr || `llama-server stopped (exit ${p.exitCode})`);
      try { const r = await fetch(`http://127.0.0.1:${p.port}/health`); if (r.ok) return; } catch { /* starting */ }
      await new Promise(r => setTimeout(r, 400));
    }
    throw new Error('The AI did not start in time.');
  }

  function launch(kind, m, device) {
    const logDir = path.join(aiDir, 'logs');
    fs.mkdirSync(logDir, { recursive: true });
    const log = fs.createWriteStream(path.join(logDir, `llama-${kind}.log`), { flags: 'w' });
    const child = spawn(serverExe(aiDir), argsFor(kind, m, device), { cwd: path.dirname(serverExe(aiDir)), windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    const p = { child, port: PORTS[kind], model: m.id, device, isReady: false, exited: false, lastErr: '' };
    const onData = d => { log.write(d); const s = String(d); const line = s.split(/\r?\n/).reverse().find(l => /error|failed|out of memory|unable/i.test(l)); if (line) p.lastErr = line.trim().slice(0, 300); };
    child.stdout.on('data', onData);
    child.stderr.on('data', onData);
    child.on('error', e => { p.exited = true; p.lastErr = e.message; });
    child.on('exit', code => { p.exited = true; p.exitCode = code; log.end(); if (procs[kind] === p) { procs[kind] = null; emit(); } });
    return p;
  }

  // A crash of OpenCRM can leave our llama-server running (holding the port). Stop only processes started from
  // OUR copy of llama.cpp, never a llama-server you run yourself.
  let orphansChecked = null;
  function killOrphans() {
    const exe = serverExe(aiDir).replace(/'/g, "''");
    const ps = `Get-CimInstance Win32_Process -Filter "Name='llama-server.exe'" | Where-Object { $_.ExecutablePath -eq '${exe}' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force }`;
    return new Promise(r => execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', ps], { windowsHide: true, timeout: 20000 }, () => r()));
  }

  async function startOne(kind, m) {
    if (!runtimeInstalled(aiDir)) throw new Error('The AI engine is not downloaded yet.');
    if (!procs.chat && !procs.embed) await (orphansChecked ||= killOrphans());
    if (!modelPresent(aiDir, m)) throw new Error(`${m.label} is not downloaded yet.`);
    const cur = procs[kind];
    if (cur && cur.model === m.id && !cur.exited) { await cur.ready; return; }
    if (cur) await stopOne(kind);
    const attempt = async device => {
      const p = launch(kind, m, device);
      procs[kind] = p;
      emit();
      p.ready = waitHealthy(p, kind === 'embed' ? 60e3 : 240e3).then(() => { p.isReady = true; emit(); });
      await p.ready;
    };
    try { await attempt(kind === 'embed' ? 'cpu' : 'gpu'); }
    catch (e) {
      if (kind === 'embed') { procs[kind] = null; emit(); throw e; }
      await stopOne(kind);
      try { await attempt('cpu'); } // graphics card missing / not enough VRAM: run on the processor
      catch (e2) { procs[kind] = null; emit(); throw new Error(`The AI could not start: ${e2.message || e.message}. See ${path.join(aiDir, 'logs')}.`); }
    }
  }

  async function stopOne(kind) {
    const p = procs[kind];
    if (!p) return;
    procs[kind] = null;
    if (!p.exited) {
      await new Promise(r => execFile('taskkill', ['/PID', String(p.child.pid), '/T', '/F'], { windowsHide: true }, () => r()));
    }
    emit();
  }

  async function start() {
    const b = cfg();
    const chat = modelById(b.chatModel);
    if (!chat) throw new Error('Choose and download a model first.');
    const embed = modelById(EMBED_MODEL);
    await startOne('chat', chat);
    if (modelPresent(aiDir, embed)) await startOne('embed', embed).catch(() => { /* AI search falls back to the chat model */ });
    touch();
  }
  async function stop() { clearTimeout(idleTimer); await Promise.all([stopOne('chat'), stopOne('embed')]); }

  function touch() {
    clearTimeout(idleTimer);
    if ((cfg().startMode || 'auto') === 'auto') idleTimer = setTimeout(() => stop().catch(() => {}), IDLE_MS);
  }

  /** Called before every AI request (ai-service hook): starts the built-in AI when a request goes to its port. */
  async function ensureFor(url) {
    const b = cfg();
    if (!b.enabled) return;
    let port;
    try { port = +new URL(/^https?:/i.test(url) ? url : `http://${url}`).port; } catch { return; }
    if (port !== PORTS.chat && port !== PORTS.embed) return;
    if ((b.startMode || 'auto') === 'manual' && !procs.chat) throw new Error('The built-in AI is stopped. Start it in Settings → AI.');
    const kind = port === PORTS.embed ? 'embed' : 'chat';
    if (kind === 'embed') { const em = modelById(EMBED_MODEL); if (modelPresent(aiDir, em)) await startOne('embed', em); }
    else await startOne('chat', modelById(b.chatModel));
    touch();
  }

  /** Point OpenCRM's AI settings at the built-in servers. */
  function use({ chatModel, startMode }) {
    const m = modelById(chatModel);
    if (!m || m.role !== 'chat') throw new Error('Unknown model');
    const embedReady = modelPresent(aiDir, modelById(EMBED_MODEL));
    const prev = config.get().ai;
    config.update({
      ai: {
        // remember the previous server so "Use my own server" can restore it
        ...(prev.builtin?.enabled ? {} : { previous: { baseUrl: prev.baseUrl, model: prev.model, embedUrl: prev.embedUrl, embedModel: prev.embedModel } }),
        baseUrl: `http://127.0.0.1:${PORTS.chat}/v1`, model: m.id, disableThinking: true,
        embedUrl: embedReady ? `http://127.0.0.1:${PORTS.embed}/v1` : '', embedModel: embedReady ? EMBED_MODEL : '',
        builtin: { enabled: true, chatModel: m.id, startMode: startMode || prev.builtin?.startMode || 'auto' },
      },
    });
    emit();
    return config.publicConfig();
  }
  async function disable() {
    await stop();
    const prev = config.get().ai.previous || {};
    config.update({ ai: { baseUrl: prev.baseUrl || '', model: prev.model || '', embedUrl: prev.embedUrl || '', embedModel: prev.embedModel || '', builtin: { ...cfg(), enabled: false } } });
    emit();
    return config.publicConfig();
  }

  async function removeModel(id) {
    const m = modelById(id);
    if (!m) return;
    for (const k of ['chat', 'embed']) if (procs[k]?.model === id) await stopOne(k);
    await fsp.rm(modelPath(aiDir, m), { force: true });
    await fsp.rm(modelPath(aiDir, m) + '.part', { force: true });
    emit();
  }

  handle('ai-runtime:state', async () => state());
  handle('ai-runtime:download', async (_e, { id }) => (id === 'runtime' ? downloadRuntime() : downloadModel(id)));
  handle('ai-runtime:cancel', async (_e, { id }) => { downloads.get(id)?.ctrl.abort(); return { ok: true }; });
  handle('ai-runtime:use', async (_e, opts) => ({ config: use(opts) }));
  handle('ai-runtime:disable', async () => ({ config: await disable() }));
  handle('ai-runtime:setMode', async (_e, { startMode }) => { config.update({ ai: { builtin: { ...cfg(), startMode } } }); touch(); emit(); return { config: config.publicConfig() }; });
  handle('ai-runtime:start', async () => { await start(); return state(); });
  handle('ai-runtime:stop', async () => { await stop(); return state(); });
  handle('ai-runtime:remove', async (_e, { id }) => { await removeModel(id); return state(); });
  handle('ai-runtime:openFolder', async () => { fs.mkdirSync(modelsDir(aiDir), { recursive: true }); shell.openPath(aiDir); return { ok: true }; });

  return {
    ensureFor,
    startIfWanted: () => { const b = cfg(); if (!isTest && b.enabled && b.startMode === 'startup') start().catch(() => {}); },
    stop,
    state,
  };
}
