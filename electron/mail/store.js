// Per-database mail store: <db folder>/<db name>.mail/
//   index.json   message headers (map key -> entry)
//   state.json   per account/folder sync state
//   outbox.json  queued / scheduled sends
//   drafts.json  local drafts
//   sends.json   tracking codes and events (phase D)
//   bodies/<id>.json parsed bodies
// Everything is re-downloadable from the server except outbox, drafts and sends.
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';

export const sha1 = s => crypto.createHash('sha1').update(String(s)).digest('hex');
const sleep = ms => new Promise(r => setTimeout(r, ms));

export async function atomicWriteJson(file, obj) {
  const tmp = `${file}.${process.pid}.${Math.random().toString(36).slice(2, 7)}.tmp`;
  await fsp.writeFile(tmp, JSON.stringify(obj));
  for (let i = 0; i < 6; i++) {
    try { await fsp.rename(tmp, file); return; } catch { await sleep(50 * (i + 1)); }
  }
  await fsp.copyFile(tmp, file); await fsp.unlink(tmp).catch(() => {});
}

function readJson(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return fallback; }
}

export function mailDirFor(dbPath) {
  return path.join(path.dirname(dbPath), `${path.basename(dbPath).replace(/\.json$/i, '')}.mail`);
}

export class MailStore {
  constructor(dir) {
    this.dir = dir;
    fs.mkdirSync(path.join(dir, 'bodies'), { recursive: true });
    this.index = new Map(Object.entries(readJson(this.file('index'), {})));
    this.state = readJson(this.file('state'), {});
    this.outbox = readJson(this.file('outbox'), []);
    this.drafts = readJson(this.file('drafts'), {});
    this.sends = readJson(this.file('sends'), {});
    this.timers = {};
    this.pending = {};
  }

  file(name) { return path.join(this.dir, `${name}.json`); }

  /** Debounced save of one of: index, state, outbox, drafts, sends. */
  touch(name, delay = 400) {
    clearTimeout(this.timers[name]);
    this.timers[name] = setTimeout(() => this.flushOne(name), delay);
  }

  async flushOne(name) {
    clearTimeout(this.timers[name]);
    delete this.timers[name];
    const obj = name === 'index' ? Object.fromEntries(this.index) : this[name];
    const prev = this.pending[name] || Promise.resolve();
    this.pending[name] = prev.then(() => atomicWriteJson(this.file(name), obj)).catch(() => {});
    return this.pending[name];
  }

  async flush() {
    const names = ['index', 'state', 'outbox', 'drafts', 'sends'];
    await Promise.all(names.filter(n => this.timers[n]).map(n => this.flushOne(n)));
    await Promise.all(Object.values(this.pending));
  }

  bodyPath(id) { return path.join(this.dir, 'bodies', `${id}.json`); }
  hasBody(id) { return fs.existsSync(this.bodyPath(id)); }
  readBody(id) { return readJson(this.bodyPath(id), null); }
  async writeBody(id, body) { await atomicWriteJson(this.bodyPath(id), body); }
  async deleteBody(id) { await fsp.unlink(this.bodyPath(id)).catch(() => {}); }

  folderState(accountId, folder) {
    this.state[accountId] ||= {};
    this.state[accountId][folder] ||= { uidValidity: null, lastUid: 0 };
    return this.state[accountId][folder];
  }

  /** Removes all entries of a folder (UIDVALIDITY changed or account removed). */
  dropFolder(accountId, folder) {
    for (const [k, e] of this.index) {
      if (e.account === accountId && (folder == null || e.folder === folder)) { this.index.delete(k); this.deleteBody(e.bodyId); }
    }
    if (folder == null) delete this.state[accountId];
    else if (this.state[accountId]) delete this.state[accountId][folder];
    this.touch('index'); this.touch('state');
  }
}
