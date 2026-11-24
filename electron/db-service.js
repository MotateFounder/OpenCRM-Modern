// Database file service: load + migrate, atomic save, external-change watcher, lock file.

import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { EventEmitter } from 'node:events';
import { migrate, validate } from '../src/shared/migrate.js';
import { maybeBackup, manualBackup, mirrorFiles, baseName } from './backup.js';

const sha1 = s => crypto.createHash('sha1').update(s).digest('hex');
const sleep = ms => new Promise(r => setTimeout(r, ms));

export function filesDirFor(dbPath) {
  return path.join(path.dirname(dbPath), `${baseName(dbPath)}.files`);
}

// Atomic write: tmp file + fsync + rename (with retries for Windows file locks).
export async function atomicWrite(target, content) {
  const tmp = `${target}.${process.pid}.tmp`;
  const fh = await fsp.open(tmp, 'w');
  try {
    await fh.writeFile(content, 'utf8');
    await fh.sync();
  } finally {
    await fh.close();
  }
  let lastErr;
  for (let i = 0; i < 6; i++) {
    try { await fsp.rename(tmp, target); return; } catch (e) { lastErr = e; await sleep(60 * (i + 1)); }
  }
  // Fallback when rename keeps failing (e.g. file held open by a sync client).
  try { await fsp.copyFile(tmp, target); await fsp.unlink(tmp); return; } catch (e) { lastErr = e; }
  throw lastErr;
}

export function parseDatabaseText(text) {
  const raw = JSON.parse(text.replace(/^﻿/, ''));
  const res = migrate(raw);
  const errors = validate(res.data);
  if (errors.length) throw new Error('Invalid database: ' + errors.slice(0, 5).join('; '));
  return res;
}

export class DbService extends EventEmitter {
  constructor() {
    super();
    this.path = null;
    this.data = null;
    this.lastHash = null;
    this.saving = Promise.resolve();
    this.watcher = null;
    this.watchTimer = null;
    this.lockTimer = null;
    this.lastMirror = 0;
  }

  lockPath(p = this.path) { return `${p}.lock`; }

  checkLock(p) {
    try {
      const info = JSON.parse(fs.readFileSync(this.lockPath(p), 'utf8'));
      const fresh = Date.now() - info.at < 3 * 60 * 1000;
      if (!fresh) return null;
      if (info.host === os.hostname() && info.pid === process.pid) return null;
      if (info.host === os.hostname()) {
        try { process.kill(info.pid, 0); } catch { return null; } // process gone -> stale lock
      }
      return info;
    } catch { return null; }
  }

  writeLock() {
    try { fs.writeFileSync(this.lockPath(), JSON.stringify({ pid: process.pid, host: os.hostname(), user: os.userInfo().username, at: Date.now() })); } catch { /* read-only folder */ }
  }

  releaseLock() {
    clearInterval(this.lockTimer);
    this.lockTimer = null;
    if (!this.path) return;
    try {
      const info = JSON.parse(fs.readFileSync(this.lockPath(), 'utf8'));
      if (info.pid === process.pid && info.host === os.hostname()) fs.unlinkSync(this.lockPath());
    } catch { /* ignore */ }
  }

  async open(p, { force = false } = {}) {
    const abs = path.resolve(p);
    const text = await fsp.readFile(abs, 'utf8');
    const res = parseDatabaseText(text); // throws on invalid -> file is never overwritten
    if (!force) {
      const lock = this.checkLock(abs);
      if (lock) return { locked: lock };
    }
    this.close();
    this.path = abs;
    this.data = res.data;
    this.lastHash = sha1(text);
    if (res.changed) {
      // Keep an untouched copy of pre-v3 files, then write the migrated version.
      if (res.fromVersion < 3) {
        const orig = path.join(path.dirname(abs), `${baseName(abs)}.v${res.fromVersion}-original.json`);
        if (!fs.existsSync(orig)) fs.copyFileSync(abs, orig);
      } else manualBackup(abs, 'pre-migration');
      await this.save(this.data);
    }
    this.writeLock();
    this.lockTimer = setInterval(() => this.writeLock(), 60 * 1000);
    this.startWatching();
    try { maybeBackup(abs, JSON.stringify(this.data, null, 2)); } catch { /* ignore */ }
    return { path: abs, data: this.data, migrated: res.changed, fromVersion: res.fromVersion, log: res.log };
  }

  async create(p, data) {
    const abs = path.resolve(p);
    const content = JSON.stringify(data, null, 2);
    await fsp.mkdir(path.dirname(abs), { recursive: true });
    await atomicWrite(abs, content);
    return this.open(abs, { force: true });
  }

  save(data) {
    // serialise saves so two writes can never interleave
    const job = this.saving.then(async () => {
      if (!this.path) throw new Error('No database open');
      const content = JSON.stringify(data, null, 2);
      const hash = sha1(content);
      this.data = data;
      if (hash === this.lastHash) return { savedAt: Date.now(), unchanged: true };
      this.lastHash = hash;
      await atomicWrite(this.path, content);
      try { maybeBackup(this.path, content); } catch (e) { this.emit('warning', 'Backup failed: ' + e.message); }
      if (Date.now() - this.lastMirror > 60 * 60 * 1000) {
        this.lastMirror = Date.now();
        setTimeout(() => { try { mirrorFiles(filesDirFor(this.path), this.path); } catch { /* ignore */ } }, 2000);
      }
      return { savedAt: Date.now() };
    });
    this.saving = job.catch(() => {});
    return job;
  }

  // Writes the current data to a new location and switches to it.
  async moveTo(newPath) {
    const content = JSON.stringify(this.data, null, 2);
    await atomicWrite(newPath, content);
    const oldFiles = filesDirFor(this.path);
    const newFiles = filesDirFor(newPath);
    if (fs.existsSync(oldFiles) && !fs.existsSync(newFiles)) await fsp.cp(oldFiles, newFiles, { recursive: true });
    return this.open(newPath, { force: true });
  }

  startWatching() {
    this.stopWatching();
    const dir = path.dirname(this.path);
    const name = path.basename(this.path);
    try {
      this.watcher = fs.watch(dir, (evt, fname) => {
        if (fname && fname !== name) return;
        clearTimeout(this.watchTimer);
        this.watchTimer = setTimeout(() => this.checkExternal(), 500);
      });
      this.watcher.on('error', () => {});
    } catch { /* watching not supported */ }
  }

  stopWatching() {
    clearTimeout(this.watchTimer);
    if (this.watcher) { try { this.watcher.close(); } catch { /* ignore */ } }
    this.watcher = null;
  }

  async checkExternal(retry = 0) {
    if (!this.path) return;
    await this.saving;
    let text;
    try { text = await fsp.readFile(this.path, 'utf8'); } catch { return; }
    const hash = sha1(text);
    if (hash === this.lastHash) return;
    try {
      const res = parseDatabaseText(text);
      this.lastHash = hash;
      this.data = res.data;
      this.emit('external-change', { data: res.data });
    } catch (e) {
      if (retry < 3) setTimeout(() => this.checkExternal(retry + 1), 1000);
      else this.emit('warning', 'The database file was changed outside OpenCRM but could not be read: ' + e.message);
    }
  }

  close() {
    this.stopWatching();
    this.releaseLock();
    this.path = null;
    this.data = null;
    this.lastHash = null;
  }
}
