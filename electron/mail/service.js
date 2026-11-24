// Mail service: per-account IMAP sync (IDLE + polling), record linking, threads, queries,
// SMTP sending with outbox / undo / retries / bulk pacing. No Electron imports: tested in plain Node.
import { EventEmitter } from 'node:events';
import crypto from 'node:crypto';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import nodemailer from 'nodemailer';
import { simpleParser } from 'mailparser';

import { makeImap, makeTransport, friendlyError, isTransient } from './client.js';
import { MailStore, sha1 } from './store.js';
import { cleanHtml, htmlToText } from './html.js';
import { presetById } from './presets.js';
import { sendStatus, engagementScore } from './tracking.js';
import {
  buildAddressIndex, matchMessage, computeThreads, snippetOf, normEmail, parseAddressList, planBulk, remainingToday,
} from '../../src/shared/mail.js';

const SENT_NAMES = ['Sent', 'Sent Items', 'Sent Messages', 'Sent Mail', '[Gmail]/Sent Mail', '[Google Mail]/Sent Mail', 'INBOX.Sent', 'INBOX/Sent', 'Gesendet', 'Gesendete Objekte', 'Gesendete Elemente', 'Enviados', 'Elementos enviados', 'Envoyés', 'Éléments envoyés', 'Posta inviata', 'Inviati'];
const MAX_BODY = 15 * 1024 * 1024;
const RETRY = [60e3, 5 * 60e3, 15 * 60e3, 30 * 60e3, 60 * 60e3];
const sleep = ms => new Promise(r => setTimeout(r, ms));
const addrList = l => (l || []).filter(a => a?.address).map(a => ({ name: a.name || '', address: normEmail(a.address) }));
const refsFromHeader = buf => (String(buf || '').match(/<[^<>\s]+>/g) || []);

// ---------------------------------------------------------------------------------------------
// One IMAP connection per account. All IMAP work goes through a serial queue.
class AccountSync extends EventEmitter {
  constructor(svc, account) {
    super();
    this.svc = svc;
    this.account = account;
    this.client = null;
    this.queue = Promise.resolve();
    this.status = { state: 'idle', error: null, lastSync: null };
    this.stopped = false;
    this.backoff = 5000;
    this.pollTimer = null;
    this.existsTimer = null;
    this.reconnectTimer = null;
    this.folders = null; // { inbox, sent }
    this.initialDone = false;
  }

  setStatus(patch) {
    this.status = { ...this.status, ...patch };
    this.svc.emit('status', { accountId: this.account.id, ...this.status });
  }

  /** Serial IMAP work; afterwards INBOX is selected again and IDLE resumes (instant new-mail push). */
  run(fn) {
    const p = this.queue.then(fn, fn);
    this.queue = p.catch(() => {}).then(() => this.reIdle());
    return p;
  }

  async reIdle() {
    const c = this.client;
    if (!c?.usable || this.stopped || !this.folders?.inbox || c.idling) return;
    try {
      if (c.mailbox?.path !== this.folders.inbox) { const lock = await c.getMailboxLock(this.folders.inbox); lock.release(); }
      c.idle().catch(() => {});
    } catch { /* connection problems are handled by 'close' */ }
  }

  async connect() {
    if (this.client?.usable) return this.client;
    const cred = await this.svc.getCredentials(this.account);
    const c = makeImap(this.account, cred);
    c.on('error', () => {}); // handled through 'close'
    c.on('close', () => {
      if (this.client !== c) return;
      this.client = null;
      if (!this.stopped) { this.setStatus({ state: 'offline' }); this.scheduleReconnect(); }
    });
    c.on('exists', ev => {
      if (ev.path !== this.folders?.inbox) return;
      clearTimeout(this.existsTimer);
      this.existsTimer = setTimeout(() => this.syncNow(['inbox']).catch(() => {}), 800);
    });
    c.on('flags', () => {
      clearTimeout(this.flagsTimer);
      this.flagsTimer = setTimeout(() => this.syncNow(['inbox']).catch(() => {}), 1500);
    });
    this.setStatus({ state: 'connecting', error: null });
    await c.connect();
    this.client = c;
    this.folders = null; // folders may have changed while we were away
    this.backoff = 5000;
    return c;
  }

  scheduleReconnect() {
    clearTimeout(this.reconnectTimer);
    if (this.stopped) return;
    const wait = this.backoff;
    this.backoff = Math.min(this.backoff * 2, 5 * 60e3);
    this.reconnectTimer = setTimeout(() => this.syncNow().catch(() => {}), wait);
  }

  async start() {
    this.stopped = false;
    const poll = (this.svc.settings().pollMinutes || 5) * 60e3;
    clearInterval(this.pollTimer);
    this.pollTimer = setInterval(() => this.syncNow().catch(() => {}), poll);
    return this.syncNow().catch(() => {});
  }

  async stop() {
    this.stopped = true;
    clearInterval(this.pollTimer); clearTimeout(this.existsTimer); clearTimeout(this.reconnectTimer); clearTimeout(this.flagsTimer); clearTimeout(this.backfillTimer); this.backfillTimer = null;
    const c = this.client;
    this.client = null;
    if (c) { try { await Promise.race([c.logout(), sleep(2000)]); } catch { /* ignore */ } try { c.close(); } catch { /* ignore */ } }
    this.setStatus({ state: 'stopped' });
  }

  async findFolders(c) {
    if (this.folders) return this.folders;
    const list = await c.list();
    const inbox = list.find(f => f.specialUse === '\\Inbox' || f.path.toUpperCase() === 'INBOX')?.path || 'INBOX';
    let sent = this.account.sentFolder && list.find(f => f.path === this.account.sentFolder)?.path;
    sent ||= list.find(f => f.specialUse === '\\Sent')?.path;
    sent ||= SENT_NAMES.map(n => list.find(f => f.path.toLowerCase() === n.toLowerCase())).find(Boolean)?.path;
    this.folders = { inbox, sent: sent || null, delimiter: list[0]?.delimiter || '/' };
    return this.folders;
  }

  async ensureSentFolder(c) {
    const f = await this.findFolders(c);
    if (f.sent) return f.sent;
    try { await c.mailboxCreate('Sent'); } catch { /* may exist */ }
    this.folders.sent = 'Sent';
    return 'Sent';
  }

  /** which: ['inbox','sent'] */
  syncNow(which = ['inbox', 'sent']) {
    return this.run(async () => {
      if (this.stopped) return;
      try {
        const c = await this.connect();
        const f = await this.findFolders(c);
        this.setStatus({ state: 'syncing' });
        let added = 0;
        if (which.includes('sent') && f.sent) added += await this.syncFolder(c, f.sent, 'sent');
        if (which.includes('inbox')) added += await this.syncFolder(c, f.inbox, 'inbox');
        // leave INBOX selected so the server pushes new mail (IDLE)
        this.initialDone = true;
        this.setStatus({ state: 'online', error: null, lastSync: new Date().toISOString() });
        this.scheduleBackfill();
        if (added) this.svc.changed();
      } catch (err) {
        const msg = friendlyError(err, this.account, 'imap');
        this.setStatus({ state: isTransient(err) ? 'offline' : 'error', error: msg });
        if (this.client) { try { this.client.close(); } catch { /* ignore */ } this.client = null; }
        if (isTransient(err)) this.scheduleReconnect();
        throw new Error(msg);
      }
    });
  }

  async syncFolder(c, folder, role) {
    const store = this.svc.store;
    const acc = this.account;
    const lock = await c.getMailboxLock(folder);
    let added = 0;
    try {
      const mb = c.mailbox;
      const uidValidity = String(mb.uidValidity);
      const st = store.folderState(acc.id, folder);
      if (st.uidValidity && st.uidValidity !== uidValidity) { store.dropFolder(acc.id, folder); Object.assign(st, store.folderState(acc.id, folder)); }
      st.uidValidity = uidValidity;
      let uids;
      if (!st.lastUid) {
        const days = this.svc.settings().days || 365;
        if (!mb.exists) uids = [];
        else uids = await c.search({ since: new Date(Date.now() - days * 864e5) }, { uid: true }) || [];
      } else uids = ((await c.search({ uid: `${st.lastUid + 1}:*` }, { uid: true })) || []).filter(u => u > st.lastUid);
      uids.sort((a, b) => a - b);
      for (let i = 0; i < uids.length; i += 200) {
        const batch = uids.slice(i, i + 200);
        for await (const m of c.fetch(batch, { uid: true, envelope: true, flags: true, internalDate: true, size: true, headers: ['references', 'disposition-notification-to', 'auto-submitted', 'content-type'] }, { uid: true })) {
          if (this.svc.addEntry(this.entryFrom(folder, role, uidValidity, m))) added++;
          if (m.uid > st.lastUid) st.lastUid = m.uid;
        }
        store.touch('state');
      }
      if (uids.length && uids[uids.length - 1] > st.lastUid) st.lastUid = uids[uids.length - 1];
      // refresh flags + detect deletions for the most recent 500 known messages
      const known = [...store.index.values()].filter(e => e.account === acc.id && e.folder === folder && e.uid).sort((a, b) => b.uid - a.uid).slice(0, 500);
      if (known.length) {
        const min = known[known.length - 1].uid;
        const seen = new Map();
        for await (const m of c.fetch(`${min}:*`, { uid: true, flags: true }, { uid: true })) seen.set(m.uid, m.flags);
        let changed = false;
        for (const e of known) {
          const fl = seen.get(e.uid);
          if (!fl) { store.index.delete(e.key); store.deleteBody(e.bodyId); changed = true; continue; }
          const s = fl.has('\\Seen'), a = fl.has('\\Answered'), fg = fl.has('\\Flagged');
          if (e.seen !== s || e.answered !== a || e.flagged !== fg) { e.seen = s; e.answered = a; e.flagged = fg; changed = true; }
        }
        if (changed) { store.touch('index'); this.svc.changed(); }
      }
      store.touch('state');
    } finally { lock.release(); }
    return added;
  }

  entryFrom(folder, role, uidValidity, m) {
    const env = m.envelope || {};
    const headers = String(m.headers || '');
    const refsHdr = headers.match(/^references:([\s\S]*?)(?=^\S|$(?![\s\S]))/im)?.[1] || '';
    const key = `${this.account.id}|${folder}|${uidValidity}|${m.uid}`;
    return {
      key, account: this.account.id, folder, role, uid: m.uid, uidValidity,
      messageId: env.messageId || null,
      inReplyTo: env.inReplyTo || null,
      references: refsFromHeader(refsHdr),
      subject: env.subject || '',
      date: (env.date || m.internalDate || new Date()).toISOString?.() || String(env.date),
      from: addrList(env.from), to: addrList(env.to), cc: addrList(env.cc), replyTo: addrList(env.replyTo),
      seen: m.flags?.has('\\Seen') || false, answered: m.flags?.has('\\Answered') || false, flagged: m.flags?.has('\\Flagged') || false,
      size: m.size || 0,
      autoSubmitted: /^auto-submitted:\s*auto-/im.test(headers),
      report: /content-type:\s*multipart\/report/i.test(headers),
      bodyId: sha1(key),
      snippet: '',
    };
  }

  /** Messages whose body should be downloaded in the background (linked to records, or all with scope=all). */
  bodiesNeeded() {
    const scope = this.svc.settings().scope || 'contacts';
    return [...this.svc.store.index.values()]
      .filter(e => e.account === this.account.id && !e.local && e.uid && !e.hasBody && !e.bodyFailed && (scope === 'all' || e.refs?.length || e.report || /mailer-daemon|postmaster/i.test(e.from?.[0]?.address || '')))
      .sort((a, b) => (a.date < b.date ? 1 : -1));
  }

  /** Downloads bodies in small background chunks (newest first) so checking for new mail stays instant. */
  scheduleBackfill() {
    if (this.backfillTimer || this.stopped) return;
    this.backfillTimer = setTimeout(() => {
      this.backfillTimer = null;
      const need = this.bodiesNeeded();
      if (!need.length) return;
      this.run(async () => {
        const c = await this.connect();
        const chunk = need.slice(0, 60);
        const byFolder = new Map();
        for (const e of chunk) { if (!byFolder.has(e.folder)) byFolder.set(e.folder, []); byFolder.get(e.folder).push(e); }
        for (const [folder, list] of byFolder) {
          const lock = await c.getMailboxLock(folder);
          const got = [];
          try {
            for (const e of list.filter(x => x.size > MAX_BODY)) await this.fetchBodyLocked(c, e);
            const small = list.filter(x => x.size <= MAX_BODY);
            if (small.length) for await (const m of c.fetch(small.map(e => e.uid), { uid: true, source: true }, { uid: true })) got.push(m);
          } finally { lock.release(); }
          const byUid = new Map(list.map(e => [e.uid, e]));
          for (const m of got) {
            const e = byUid.get(m.uid);
            if (!e || !m.source) continue;
            try { await this.svc.storeBody(e, await parseSource(m.source)); } catch { e.bodyFailed = true; }
          }
          for (const e of list) if (!e.hasBody && !got.some(m => m.uid === e.uid)) e.bodyFailed = true; // deleted meanwhile
        }
        this.svc.changed();
      }).catch(() => {}).finally(() => { if (this.bodiesNeeded().length) this.scheduleBackfill(); });
    }, 30);
  }

  async fetchBodyLocked(c, e) {
    if (e.size > MAX_BODY) {
      const body = { text: `(This message is ${Math.round(e.size / 1048576)} MB. Open it in your usual mail app to see it completely.)`, html: '', attachments: [], tooLarge: true };
      await this.svc.storeBody(e, body);
      return body;
    }
    const msg = await c.fetchOne(String(e.uid), { source: true }, { uid: true });
    if (!msg?.source) return null;
    const body = await parseSource(msg.source);
    await this.svc.storeBody(e, body);
    return body;
  }

  fetchBody(e) {
    return this.run(async () => {
      const c = await this.connect();
      const lock = await c.getMailboxLock(e.folder);
      try { return await this.fetchBodyLocked(c, e); } finally { lock.release(); }
    });
  }

  fetchSource(e) {
    return this.run(async () => {
      const c = await this.connect();
      const lock = await c.getMailboxLock(e.folder);
      try { return (await c.fetchOne(String(e.uid), { source: true }, { uid: true }))?.source || null; } finally { lock.release(); }
    });
  }

  setFlag(e, flag, on) {
    return this.run(async () => {
      const c = await this.connect();
      const lock = await c.getMailboxLock(e.folder);
      try { if (on) await c.messageFlagsAdd(String(e.uid), [flag], { uid: true }); else await c.messageFlagsRemove(String(e.uid), [flag], { uid: true }); } finally { lock.release(); }
    });
  }

  /** Puts a sent message into the Sent folder unless the server already did (Gmail does). */
  saveSent(raw, messageId) {
    return this.run(async () => {
      const c = await this.connect();
      const sent = await this.ensureSentFolder(c);
      await sleep(this.svc.opts.sentCheckDelayMs ?? 2500);
      const lock = await c.getMailboxLock(sent);
      try {
        const found = await c.search({ header: { 'message-id': messageId } }, { uid: true }).catch(() => []);
        if (found?.length) return { appended: false };
      } finally { lock.release(); }
      await c.append(sent, raw, ['\\Seen']);
      return { appended: true };
    }).then(r => { this.syncNow(['sent']).catch(() => {}); return r; });
  }
}

export async function parseSource(source) {
  const p = await simpleParser(source, { skipTextToHtml: true, skipImageLinks: true });
  const inline = {};
  const attachments = [];
  (p.attachments || []).forEach((a, i) => {
    const isInlineImg = a.contentId && /^image\//.test(a.contentType) && a.size < 600 * 1024;
    if (isInlineImg) inline[String(a.contentId).replace(/^<|>$/g, '')] = `data:${a.contentType};base64,${a.content.toString('base64')}`;
    if (!isInlineImg || a.contentDisposition === 'attachment') {
      attachments.push({ index: i, filename: a.filename || `attachment-${i + 1}`, contentType: a.contentType, size: a.size, related: !!a.related });
    }
  });
  let html = '', remoteImages = false;
  if (p.html) ({ html, remoteImages } = cleanHtml(p.html, { inline }));
  const text = p.text || (p.html ? htmlToText(p.html) : '');
  const dsn = /multipart\/report/i.test(p.headers.get('content-type')?.value || '') || /mailer-daemon|postmaster/i.test(p.from?.text || '');
  return { text, html, remoteImages, attachments, dsn, readReceiptTo: p.headers.get('disposition-notification-to')?.text || null };
}

// ---------------------------------------------------------------------------------------------
export class MailService extends EventEmitter {
  /**
   * opts: { dir, getAccounts(): account[], getCredentials(account): Promise<{pass}|{accessToken}>,
   *         settings(): {scope, days, pollMinutes, undoSeconds}, sentCheckDelayMs }
   */
  constructor(opts) {
    super();
    this.opts = opts;
    this.store = new MailStore(opts.dir);
    this.syncs = new Map();
    this.addrIndex = { exact: new Map(), loose: new Map() };
    this.addrHash = '';
    this.changeTimer = null;
    this.outboxTimer = null;
    this.sending = false;
    this.data = null;
  }

  get getCredentials() { return this.opts.getCredentials; }
  settings() { return { scope: 'contacts', days: 365, pollMinutes: 5, undoSeconds: 10, ...(this.opts.settings?.() || {}) }; }
  accounts() { return (this.opts.getAccounts() || []).filter(a => a && a.enabled !== false); }
  account(id) { return (this.opts.getAccounts() || []).find(a => a.id === id) || null; }
  selfAddresses() { return (this.opts.getAccounts() || []).flatMap(a => [a.email, ...(a.aliases || [])]).map(normEmail).filter(Boolean); }

  // ----- lifecycle
  async start() {
    for (const a of this.accounts()) this.startAccount(a);
    this.scheduleOutbox();
  }

  startAccount(a) {
    if (this.syncs.has(a.id)) return this.syncs.get(a.id);
    const s = new AccountSync(this, a);
    this.syncs.set(a.id, s);
    s.start();
    return s;
  }

  async restartAccount(id) {
    const s = this.syncs.get(id);
    if (s) { await s.stop(); this.syncs.delete(id); }
    const a = this.account(id);
    if (a && a.enabled !== false) this.startAccount(a);
  }

  async removeAccount(id) {
    const s = this.syncs.get(id);
    if (s) { await s.stop(); this.syncs.delete(id); }
    this.store.dropFolder(id, null);
    this.changed();
  }

  async stop() {
    clearTimeout(this.outboxTimer);
    clearTimeout(this.changeTimer);
    await Promise.all([...this.syncs.values()].map(s => s.stop()));
    this.syncs.clear();
    await this.store.flush();
  }

  syncNow(accountId) {
    const list = accountId ? [this.syncs.get(accountId)].filter(Boolean) : [...this.syncs.values()];
    return Promise.allSettled(list.map(s => s.syncNow())).then(r => r.map(x => (x.status === 'rejected' ? x.reason.message : null)).filter(Boolean));
  }

  statuses() {
    return this.accounts().map(a => ({ accountId: a.id, ...(this.syncs.get(a.id)?.status || { state: 'stopped' }) }));
  }

  // ----- records
  setData(data) {
    this.data = data;
    const idx = buildAddressIndex(data);
    const h = sha1(JSON.stringify([...idx.exact.entries()]));
    if (h === this.addrHash) return;
    this.addrHash = h;
    this.addrIndex = idx;
    const self = this.selfAddresses();
    let changed = false;
    for (const e of this.store.index.values()) {
      const refs = matchMessage(this.addrIndex, e, self);
      if (JSON.stringify(refs) !== JSON.stringify(e.refs || [])) { e.refs = refs; changed = true; }
    }
    if (changed) { this.store.touch('index'); this.changed(); for (const sy of this.syncs.values()) sy.scheduleBackfill(); }
  }

  addEntry(e) {
    const self = new Set(this.selfAddresses());
    e.direction = e.from.some(a => self.has(a.address)) ? 'out' : 'in';
    e.refs = matchMessage(this.addrIndex, e, [...self]);
    const existing = this.store.index.get(e.key);
    if (existing) { Object.assign(existing, { seen: e.seen, answered: e.answered, flagged: e.flagged }); return false; }
    // replace the local copy of a message we sent once the server copy shows up
    if (e.messageId) {
      for (const [k, x] of this.store.index) {
        if (x.local && x.account === e.account && x.messageId === e.messageId) {
          e.hasBody = x.hasBody; e.snippet = x.snippet; e.bodyId = x.bodyId; e.tracking = x.tracking; e.sendId = x.sendId;
          this.store.index.delete(k);
        }
      }
    }
    this.store.index.set(e.key, e);
    this.store.touch('index');
    const s = this.syncs.get(e.account);
    if (s?.initialDone && e.direction === 'in' && !e.seen && e.refs.length) this.emit('new-mail', { key: e.key, refs: e.refs, from: e.from[0], subject: e.subject });
    return true;
  }

  async storeBody(e, body) {
    await this.store.writeBody(e.bodyId, body);
    e.hasBody = true;
    e.snippet = snippetOf(body.text);
    e.attachments = body.attachments.filter(a => !a.related).map(a => ({ filename: a.filename, size: a.size, contentType: a.contentType, index: a.index }));
    e.dsn = body.dsn || undefined;
    this.store.touch('index');
    this.emit('body', e);
  }

  changed() {
    clearTimeout(this.changeTimer);
    this.changeTimer = setTimeout(() => {
      const threads = computeThreads([...this.store.index.values()], this.selfAddresses());
      for (const e of this.store.index.values()) e.threadId = threads.get(e.key);
      this.store.touch('index');
      this.emit('changed', { stats: this.stats(), unread: this.unreadCount() });
    }, 250);
  }

  // ----- queries
  entries() { return [...this.store.index.values()]; }

  list({ ref, filter = 'all', q = '', threadId, limit = 500, accountId } = {}) {
    const ql = q.trim().toLowerCase();
    let out = this.entries().filter(e => {
      if (accountId && e.account !== accountId) return false;
      if (ref && !(e.refs || []).includes(ref)) return false;
      if (threadId && e.threadId !== threadId) return false;
      if (filter === 'unread' && (e.seen || e.direction === 'out')) return false;
      if (filter === 'contacts' && !e.refs?.length) return false;
      if (filter === 'unknown' && (e.refs?.length || e.direction === 'out' || e.autoSubmitted || e.report || e.dsn || /mailer-daemon|postmaster/i.test(e.from?.[0]?.address || ''))) return false;
      if (filter === 'sent' && e.direction !== 'out') return false;
      if (ql && !`${e.subject} ${e.snippet} ${e.from.map(a => a.name + ' ' + a.address).join(' ')} ${e.to.map(a => a.name + ' ' + a.address).join(' ')}`.toLowerCase().includes(ql)) return false;
      return true;
    });
    out.sort((a, b) => new Date(b.date) - new Date(a.date));
    // dedupe the same message seen in INBOX and Sent (mail to yourself)
    const seenIds = new Set();
    out = out.filter(e => !e.messageId || !seenIds.has(e.messageId + e.account) && seenIds.add(e.messageId + e.account));
    const lastIn = this.lastInboundByThread();
    return out.slice(0, limit).map(e => this.decorate(e, lastIn));
  }

  /** Adds the tracking status (opened/clicked/interest/replied/bounced) to sent messages. */
  lastInboundByThread() {
    const m = new Map();
    for (const x of this.store.index.values()) if (x.direction === 'in' && !x.autoSubmitted && (!m.get(x.threadId) || x.date > m.get(x.threadId))) m.set(x.threadId, x.date);
    return m;
  }

  decorate(e, lastIn = this.lastInboundByThread()) {
    if (e.direction !== 'out') return e.intent ? { ...e } : e;
    const rec = e.tracking?.code ? this.store.sends[e.tracking.code] : null;
    const bounced = !!(rec?.bounced || (e.messageId && this.store.state.__bounced?.[e.messageId]));
    if (!rec && !bounced) return e;
    const replied = (lastIn.get(e.threadId) || '') > e.date;
    return { ...e, trackingState: rec ? sendStatus(rec, { replied, bounced }) : { status: 'bounced', label: '⚠ Bounced', title: 'The address does not exist or rejected the email' } };
  }

  threads(opts = {}) {
    const msgs = this.list({ ...opts, limit: 100000 });
    const map = new Map();
    for (const e of msgs) {
      const t = map.get(e.threadId) || { threadId: e.threadId, subject: e.subject, date: e.date, count: 0, unread: 0, participants: [], refs: [], last: e, hasAttachments: false };
      t.count++;
      if (!e.seen && e.direction === 'in') t.unread++;
      if (e.attachments?.length) t.hasAttachments = true;
      for (const a of [...e.from, ...e.to]) if (!t.participants.some(p => p.address === a.address)) t.participants.push(a);
      for (const r of e.refs || []) if (!t.refs.includes(r)) t.refs.push(r);
      map.set(e.threadId, t);
    }
    return [...map.values()].slice(0, opts.limit || 300);
  }

  async getMessage(key) {
    const e = this.store.index.get(key);
    if (!e) throw new Error('Message not found');
    let body = e.hasBody ? this.store.readBody(e.bodyId) : null;
    if (!body) {
      const s = this.syncs.get(e.account);
      if (!s) throw new Error('This account is not connected.');
      body = await s.fetchBody(e);
      this.changed();
    }
    return { ...e, body };
  }

  async markRead(key, read = true) {
    const e = this.store.index.get(key);
    if (!e || e.local) return;
    if (e.seen === read) return;
    e.seen = read;
    this.store.touch('index');
    this.changed();
    await this.syncs.get(e.account)?.setFlag(e, '\\Seen', read).catch(() => {});
  }

  /** Saves attachment #index of a message into dir; returns the file path. */
  async saveAttachment(key, index, dir = os.tmpdir()) {
    const e = this.store.index.get(key);
    if (!e) throw new Error('Message not found');
    let source;
    if (e.local) source = this.store.readBody(e.bodyId)?.raw ? Buffer.from(this.store.readBody(e.bodyId).raw, 'base64') : null;
    else source = await this.syncs.get(e.account)?.fetchSource(e);
    if (!source) throw new Error('Could not download the message.');
    const p = await simpleParser(source);
    const a = p.attachments[index];
    if (!a) throw new Error('Attachment not found');
    const name = path.basename(String(a.filename || `attachment-${index + 1}`)).replace(/[<>:"/\\|?*\x00-\x1f]/g, '_');
    await fsp.mkdir(dir, { recursive: true });
    let file = path.join(dir, name);
    for (let i = 2; await fsp.access(file).then(() => true, () => false); i++) file = path.join(dir, name.replace(/(\.[^.]*)?$/, ` (${i})$1`));
    await fsp.writeFile(file, a.content);
    return file;
  }

  /** Per-template and per-bulk results of tracked sends. */
  trackingReport() {
    const lastIn = this.lastInboundByThread();
    const byKey = new Map([...this.store.index.values()].filter(e => e.messageId).map(e => [e.messageId, e]));
    const groups = { templates: {}, bulks: {} };
    for (const rec of Object.values(this.store.sends || {})) {
      if (!rec.sentAt) continue;
      const e = rec.messageId ? byKey.get(rec.messageId) : null;
      const replied = e ? (lastIn.get(e.threadId) || '') > e.date : false;
      const add = (bucket, id, label) => {
        const g = bucket[id] ||= { id, label, sent: 0, opened: 0, clicked: 0, interest: 0, replied: 0, bounced: 0, unsub: 0, last: 0 };
        g.sent++; g.last = Math.max(g.last, rec.sentAt);
        if (rec.opens) g.opened++;
        if (rec.clicks) g.clicked++;
        if (rec.interest.length) g.interest++;
        if (replied) g.replied++;
        if (rec.bounced) g.bounced++;
        if (rec.unsub) g.unsub++;
      };
      add(groups.templates, rec.templateId || '_none', rec.templateId ? '' : '(no template)');
    }
    return groups;
  }

  /** Subjects + previews of each record's latest emails (for keyword and AI search). */
  searchText() {
    const per = {};
    for (const e of [...this.store.index.values()].sort((a, b) => (a.date < b.date ? 1 : -1))) {
      for (const r of e.refs || []) {
        const list = per[r] ||= [];
        if (list.length < 30) list.push(`${e.subject} ${e.snippet || ''}`.trim());
      }
    }
    return Object.fromEntries(Object.entries(per).map(([r, l]) => [r, l.join(' / ').slice(0, 1500)]));
  }

  unreadCount() {
    let n = 0;
    for (const e of this.store.index.values()) if (e.direction === 'in' && !e.seen && !e.autoSubmitted && e.folder !== 'local') n++;
    return n;
  }

  stats() {
    const out = {};
    const items = {};
    const push = (r, it) => { (items[r] ||= []).push(it); };
    for (const rec of Object.values(this.store.sends || {})) {
      for (const r of rec.refs || []) {
        const s = out[r] ||= { count: 0, unread: 0, lastIn: null, lastOut: null, last: null };
        s.opens = (s.opens || 0) + rec.opens; s.clicks = (s.clicks || 0) + rec.clicks;
        if (rec.lastOpen && (!s.lastOpened || rec.lastOpen > s.lastOpened)) s.lastOpened = rec.lastOpen;
        if (rec.lastClick && (!s.lastClicked || rec.lastClick > s.lastClicked)) s.lastClicked = rec.lastClick;
        if (rec.interest.length) s.interest = rec.interest[rec.interest.length - 1];
        if (rec.unsub) s.unsub = true;
        if (rec.lastOpen) push(r, { type: 'open', ts: rec.lastOpen });
        for (const ev of rec.events) if (ev.type === 'click' && ev.kind === 'human') push(r, { type: 'click', ts: ev.ts });
        for (const i of rec.interest) push(r, { type: 'interest', ts: i.ts });
        if (rec.unsub) push(r, { type: 'unsubscribe', ts: Date.now() });
      }
    }
    for (const e of this.store.index.values()) {
      if (e.direction === 'in' && !e.autoSubmitted && !e.report) for (const r of e.refs || []) push(r, { type: e.intent?.intent === 'interested' ? 'reply-interested' : 'reply', ts: Date.parse(e.date) });
      if (e.intent) for (const r of e.refs || []) { const s = out[r] ||= { count: 0, unread: 0, lastIn: null, lastOut: null, last: null }; if (!s.intent || e.date > s.intent.date) s.intent = { ...e.intent, date: e.date, key: e.key }; }
    }
    for (const [r, list] of Object.entries(items)) { const s = out[r] ||= { count: 0, unread: 0, lastIn: null, lastOut: null, last: null }; s.engagement = engagementScore(list); }
    for (const e of this.store.index.values()) {
      for (const r of e.refs || []) {
        const s = out[r] ||= { count: 0, unread: 0, lastIn: null, lastOut: null, last: null };
        s.count++;
        if (e.direction === 'in' && !e.seen) s.unread++;
        if (e.direction === 'in' && (!s.lastIn || e.date > s.lastIn)) s.lastIn = e.date;
        if (e.direction === 'out' && (!s.lastOut || e.date > s.lastOut)) s.lastOut = e.date;
        if (!s.last || e.date > s.last) s.last = e.date;
      }
    }
    return out;
  }

  // ----- sending
  /**
   * draft: { accountId, to, cc, bcc (strings or [{name,address}]), subject, text, html, attachments:[{path,filename}|{filename,content(base64),contentType,cid}],
   *          inReplyTo, references[], readReceipt, headers{}, refs[] }
   * opts: { delaySec (undo window), sendAt, bulkId }
   */
  queue(draft, { delaySec, sendAt, bulkId, meta } = {}) {
    const acc = this.account(draft.accountId) || this.accounts()[0];
    if (!acc) throw new Error('Add an email account first (Settings → Email).');
    const rcpt = [...parseAddressList(draft.to), ...parseAddressList(draft.cc), ...parseAddressList(draft.bcc)];
    if (!rcpt.length) throw new Error('Add at least one recipient.');
    const delay = delaySec ?? this.settings().undoSeconds;
    const item = {
      id: crypto.randomUUID(), accountId: acc.id, draft: { ...draft, accountId: acc.id },
      status: 'scheduled', sendAt: sendAt || Date.now() + delay * 1000, attempts: 0, bulkId: bulkId || null, meta: meta || null, createdAt: Date.now(),
    };
    this.store.outbox.push(item);
    this.store.touch('outbox', 0);
    this.emit('outbox', this.outboxSummary());
    this.scheduleOutbox();
    return item;
  }

  undo(id) {
    const i = this.store.outbox.findIndex(x => x.id === id && x.status === 'scheduled');
    if (i < 0) return null;
    const [item] = this.store.outbox.splice(i, 1);
    this.store.touch('outbox', 0);
    this.emit('outbox', this.outboxSummary());
    return item.draft;
  }

  outboxSummary() {
    return this.store.outbox.map(x => ({ id: x.id, status: x.status, sendAt: x.sendAt, error: x.error || null, attempts: x.attempts, bulkId: x.bulkId, subject: x.draft.subject, to: x.draft.to, refs: x.draft.refs || [] }));
  }

  scheduleOutbox() {
    clearTimeout(this.outboxTimer);
    const due = this.store.outbox.filter(x => x.status === 'scheduled' || x.status === 'retry');
    if (!due.length) return;
    const next = Math.min(...due.map(x => x.sendAt));
    this.outboxTimer = setTimeout(() => this.processOutbox(), Math.max(0, Math.min(next - Date.now(), 2 ** 31 - 1)));
  }

  async processOutbox() {
    if (this.sending) return;
    this.sending = true;
    try {
      for (;;) {
        const now = Date.now();
        const item = this.store.outbox.filter(x => (x.status === 'scheduled' || x.status === 'retry') && x.sendAt <= now).sort((a, b) => a.sendAt - b.sendAt)[0];
        if (!item) break;
        await this.sendItem(item);
      }
    } finally {
      this.sending = false;
      this.scheduleOutbox();
    }
  }

  async sendItem(item) {
    const acc = this.account(item.accountId);
    item.status = 'sending';
    this.emit('outbox', this.outboxSummary());
    try {
      if (!acc) throw Object.assign(new Error('The email account was removed.'), { permanent: true });
      const { raw, messageId, envelope, mail } = await this.buildRaw(acc, item.draft);
      const cred = await this.getCredentials(acc);
      const tx = makeTransport(acc, cred);
      try { await tx.sendMail({ envelope, raw }); } finally { tx.close(); }
      this.store.outbox.splice(this.store.outbox.indexOf(item), 1);
      this.store.touch('outbox', 0);
      const sentTimes = (this.store.state.__sentTimes ||= {});
      (sentTimes[acc.id] ||= []).push(Date.now());
      sentTimes[acc.id] = sentTimes[acc.id].filter(t => Date.now() - t < 864e5);
      this.store.touch('state');
      const entry = await this.addLocalSent(acc, item, mail, messageId, raw);
      const tr = item.draft.tracking?.code ? this.store.sends[item.draft.tracking.code] : null;
      if (tr) { tr.sentAt = Date.now(); tr.messageId = messageId; tr.key = entry.key; tr.refs = entry.refs?.length ? entry.refs : tr.refs; this.store.touch('sends'); }
      this.emit('sent', { id: item.id, key: entry.key, refs: entry.refs, bulkId: item.bulkId, meta: item.meta, messageId, tracking: item.draft.tracking || null });
      this.emit('outbox', this.outboxSummary());
      const s = this.syncs.get(acc.id);
      if (s) s.saveSent(raw, messageId).catch(err => this.emit('warning', `Sent, but could not copy to the Sent folder: ${err.message}`));
    } catch (err) {
      item.attempts++;
      const msg = acc ? friendlyError(err, acc, 'smtp') : err.message;
      item.error = msg;
      if (!err.permanent && isTransient(err) && item.attempts <= RETRY.length) {
        item.status = 'retry';
        item.sendAt = Date.now() + RETRY[item.attempts - 1];
      } else item.status = 'failed';
      this.store.touch('outbox', 0);
      this.emit('outbox', this.outboxSummary());
      this.emit('send-error', { id: item.id, error: msg, final: item.status === 'failed', subject: item.draft.subject });
    }
  }

  retry(id) {
    const item = this.store.outbox.find(x => x.id === id);
    if (!item) return false;
    item.status = 'scheduled'; item.sendAt = Date.now(); item.error = null;
    this.store.touch('outbox', 0);
    this.scheduleOutbox();
    return true;
  }

  discard(id) {
    const i = this.store.outbox.findIndex(x => x.id === id && x.status !== 'sending');
    if (i < 0) return false;
    this.store.outbox.splice(i, 1);
    this.store.touch('outbox', 0);
    this.emit('outbox', this.outboxSummary());
    return true;
  }

  async buildRaw(acc, d) {
    const domain = (acc.email.split('@')[1] || 'opencrm.local').toLowerCase();
    const messageId = `<${crypto.randomUUID()}@${domain}>`;
    const fromName = d.fromName ?? acc.fromName ?? '';
    const mail = {
      from: { name: fromName, address: acc.email },
      to: parseAddressList(d.to), cc: parseAddressList(d.cc), bcc: parseAddressList(d.bcc),
      subject: d.subject || '',
      text: d.text || (d.html ? htmlToText(d.html) : ''),
      html: d.html || undefined,
      messageId,
      date: new Date(),
      inReplyTo: d.inReplyTo || undefined,
      references: d.references?.length ? d.references : undefined,
      headers: { ...(d.headers || {}) },
      attachments: (d.attachments || []).map(a => (a.path
        ? { path: a.path, filename: a.filename || path.basename(a.path), contentType: a.contentType }
        : { filename: a.filename, content: Buffer.from(a.content, 'base64'), contentType: a.contentType, cid: a.cid, contentDisposition: a.cid ? 'inline' : 'attachment' })),
      list: d.list || undefined,
    };
    if (d.readReceipt) mail.headers['Disposition-Notification-To'] = acc.email;
    if (acc.replyTo) mail.replyTo = acc.replyTo;
    const builder = nodemailer.createTransport({ streamTransport: true, buffer: true, newline: 'windows' });
    const info = await builder.sendMail({ ...mail, bcc: undefined });
    const envelope = { from: acc.email, to: [...mail.to, ...mail.cc, ...mail.bcc].map(a => a.address) };
    return { raw: info.message, messageId, envelope, mail };
  }

  async addLocalSent(acc, item, mail, messageId, raw) {
    const key = `${acc.id}|local|${messageId}`;
    const e = {
      key, account: acc.id, folder: 'local', role: 'sent', local: true, uid: 0, uidValidity: '',
      messageId, inReplyTo: mail.inReplyTo || null, references: mail.references || [],
      subject: mail.subject, date: new Date().toISOString(),
      from: [mail.from], to: mail.to, cc: mail.cc, replyTo: [], seen: true, answered: false, flagged: false,
      size: raw.length, bodyId: sha1(key), snippet: '', tracking: item.draft.tracking || null, sendId: item.id, bulkId: item.bulkId || null,
    };
    this.addEntry(e);
    const body = await parseSource(raw);
    body.raw = raw.length < 8 * 1024 * 1024 ? raw.toString('base64') : undefined;
    await this.storeBody(e, body);
    this.changed();
    return e;
  }

  // ----- bulk
  /** items: [{ draft }] — paced by planBulk with the account's daily limit. */
  queueBulk(items, { accountId, spacingSec = 20, dailyLimit } = {}) {
    const acc = this.account(accountId) || this.accounts()[0];
    if (!acc) throw new Error('Add an email account first (Settings → Email).');
    const limit = dailyLimit || acc.dailyLimit || presetById(acc.preset).dailyLimit || 200;
    const sentTimes = this.store.state.__sentTimes?.[acc.id] || [];
    const queued = this.store.outbox.filter(x => x.accountId === acc.id && x.status !== 'failed').map(x => x.sendAt);
    const plan = planBulk(items.length, { spacingSec, dailyLimit: limit, sentTimes: [...sentTimes, ...queued], now: Date.now() + 3000 });
    const bulkId = crypto.randomUUID();
    items.forEach((it, i) => this.queue({ ...it.draft, accountId: acc.id }, { sendAt: plan[i], bulkId, meta: it.meta }));
    return { bulkId, plan, remainingToday: remainingToday(limit, sentTimes) };
  }

  bulkControl(bulkId, action) {
    let n = 0;
    for (const x of [...this.store.outbox]) {
      if (x.bulkId !== bulkId) continue;
      if (action === 'stop' && x.status !== 'sending') { this.store.outbox.splice(this.store.outbox.indexOf(x), 1); n++; }
      if (action === 'pause' && x.status === 'scheduled') { x.status = 'paused'; n++; }
      if (action === 'resume' && x.status === 'paused') { x.status = 'scheduled'; n++; }
    }
    if (action === 'resume') {
      // re-space the remaining items from now on
      const rest = this.store.outbox.filter(x => x.bulkId === bulkId && x.status === 'scheduled').sort((a, b) => a.sendAt - b.sendAt);
      const gap = rest.length > 1 ? rest[1].sendAt - rest[0].sendAt : 20000;
      rest.forEach((x, i) => { x.sendAt = Date.now() + 2000 + i * Math.max(gap, 1000); });
    }
    this.store.touch('outbox', 0);
    this.emit('outbox', this.outboxSummary());
    this.scheduleOutbox();
    return n;
  }

  // ----- drafts
  saveDraft(d) { const id = d.id || crypto.randomUUID(); this.store.drafts[id] = { ...d, id, savedAt: Date.now() }; this.store.touch('drafts'); return id; }
  deleteDraft(id) { delete this.store.drafts[id]; this.store.touch('drafts'); }
  listDrafts() { return Object.values(this.store.drafts).sort((a, b) => b.savedAt - a.savedAt); }
}

// ---------------------------------------------------------------------------------------------
/** Checks IMAP and SMTP separately. Returns { imap: {ok, error, sent}, smtp: {ok, error}, ms }. */
export async function testAccount(account, cred) {
  const t0 = Date.now();
  const out = { imap: { ok: false }, smtp: { ok: false } };
  await Promise.all([
    (async () => {
      const c = makeImap(account, cred);
      c.on('error', () => {});
      try {
        await c.connect();
        const list = await c.list();
        const sent = list.find(f => f.specialUse === '\\Sent')?.path || SENT_NAMES.map(n => list.find(f => f.path.toLowerCase() === n.toLowerCase())).find(Boolean)?.path || null;
        out.imap = { ok: true, sent, folders: list.length };
        await c.logout().catch(() => {});
      } catch (err) { out.imap = { ok: false, error: friendlyError(err, account, 'imap') }; try { c.close(); } catch { /* ignore */ } }
    })(),
    (async () => {
      const tx = makeTransport(account, cred);
      try { await tx.verify(); out.smtp = { ok: true }; } catch (err) { out.smtp = { ok: false, error: friendlyError(err, account, 'smtp') }; } finally { tx.close(); }
    })(),
  ]);
  out.ms = Date.now() - t0;
  return out;
}
