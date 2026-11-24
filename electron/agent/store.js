// Per-database agent data, next to the database: <db>.agent/
//   approvals.json   requests waiting for / resolved by the user
//   changesets.json  before-images of agent changes (for "Undo this change"), last 500
//   campaigns.json   prepared email campaigns
//   activity.jsonl   one line per agent call (append-only)
//   state.json       daily counters (auto-sent emails, pre-agent backup day)
import fs from 'node:fs';
import path from 'node:path';
import { atomicWriteJson } from '../mail/store.js';

const readJson = (f, d) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return d; } };

export function agentDirFor(dbPath) {
  return path.join(path.dirname(dbPath), `${path.basename(dbPath).replace(/\.json$/i, '')}.agent`);
}

export class AgentStore {
  constructor(dir) {
    this.dir = dir;
    fs.mkdirSync(dir, { recursive: true });
    this.approvals = readJson(this.f('approvals'), []);
    this.changesets = readJson(this.f('changesets'), {});
    this.campaigns = readJson(this.f('campaigns'), {});
    this.state = readJson(this.f('state'), {});
    this.activity = [];
    try {
      const lines = fs.readFileSync(path.join(dir, 'activity.jsonl'), 'utf8').trim().split('\n').slice(-1000);
      this.activity = lines.filter(Boolean).map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
    } catch { /* new */ }
    this.timers = {};
    this.expire();
  }

  f(name) { return path.join(this.dir, `${name}.json`); }

  save(name) {
    clearTimeout(this.timers[name]);
    this.timers[name] = setTimeout(() => atomicWriteJson(this.f(name), this[name]).catch(() => {}), 200);
  }

  async flush() {
    for (const n of ['approvals', 'changesets', 'campaigns', 'state']) {
      clearTimeout(this.timers[n]);
      await atomicWriteJson(this.f(n), this[n]).catch(() => {});
    }
  }

  log(entry) {
    const e = { at: new Date().toISOString(), ...entry };
    this.activity.push(e);
    if (this.activity.length > 1000) this.activity.splice(0, this.activity.length - 1000);
    fs.appendFile(path.join(this.dir, 'activity.jsonl'), `${JSON.stringify(e)}\n`, () => {});
    return e;
  }

  addChangeset(cs) {
    this.changesets[cs.id] = cs;
    const ids = Object.keys(this.changesets);
    if (ids.length > 500) for (const id of ids.slice(0, ids.length - 500)) delete this.changesets[id];
    this.save('changesets');
  }

  /** Pending requests older than 7 days expire. */
  expire(now = Date.now()) {
    let changed = false;
    for (const a of this.approvals) {
      if (a.status === 'pending' && now - Date.parse(a.createdAt) > 7 * 864e5) { a.status = 'expired'; a.resolvedAt = new Date(now).toISOString(); changed = true; }
    }
    if (this.approvals.length > 2000) { this.approvals = this.approvals.slice(-2000); changed = true; }
    if (changed) this.save('approvals');
  }

  day(key) {
    const today = new Date().toISOString().slice(0, 10);
    this.state[key] ||= { day: today, n: 0 };
    if (this.state[key].day !== today) this.state[key] = { day: today, n: 0 };
    return this.state[key];
  }
}
