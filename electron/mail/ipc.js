// Electron glue for the mail service: one MailService per open database, IPC handlers, notifications.
import { app, dialog, shell, Notification } from 'electron';
import path from 'node:path';
import fs from 'node:fs';
import crypto from 'node:crypto';
import { MailService, testAccount } from './service.js';
import { mailDirFor } from './store.js';
import { PRESETS, guessAccount, presetById } from './presets.js';
import { resolveRel, addFiles } from '../attachments.js';
import { isDangerousFile } from '../../src/shared/mail.js';
import juice from 'juice';
import { cleanHtml } from './html.js';
import { prepareTracked, fetchEvents, applyEvents } from './tracking.js';
import { classifyReply, parseBounce, looksAutoReply } from './intent.js';
import { refsForAddress } from '../../src/shared/mail.js';
import { signIn, accessTokenFor } from './oauth.js';
import { recordTitle, getType } from '../../src/shared/schema.js';

export function setupMail({ h, db, config, getWin, isTest, showMain, iconPath, extraHooks = {}, aiOpts = () => ({}), aiChat = null }) {
  let svc = null;
  let svcPath = null;
  let trackTimer = null;
  let lastPoll = { at: null, total: 0, error: null };
  const trackerCfg = () => mailCfg().tracker || {};
  const trackerReady = () => { const c = trackerCfg(); return !!(c.kind && c.kind !== 'off' && c.url && config.getTrackerSecret()); };
  const refName = ref => {
    const k = ref.lastIndexOf(':');
    const t = getType(db.data, ref.slice(0, k));
    const r = t ? (db.data[t.key] || []).find(x => x.id === Number(ref.slice(k + 1))) : null;
    return r ? recordTitle(t, r) : '';
  };

  // ---- reply intent (local AI) and bounces, on each newly downloaded message body
  const intentQueue = [];
  let intentBusy = false;
  function onBody(s, e) {
    try {
      if (s !== svc || e.direction !== 'in' || e.local) return;
      const body = s.store.readBody(e.bodyId);
      if (!body) return;
      if (e.dsn || body.dsn) return handleBounce(s, e, body);
      if (!e.refs?.length || e.intent) return;
      if (Date.now() - Date.parse(e.date) > 14 * 864e5) return;
      if (db.data?.meta?.settings?.mail?.intentDetection === false) return;
      intentQueue.push({ e, body });
      runIntents();
    } catch { /* never break sync */ }
  }
  async function runIntents() {
    if (intentBusy) return;
    intentBusy = true;
    try {
      while (intentQueue.length) {
        const { e, body } = intentQueue.shift();
        if (!svc || e.intent) continue;
        let intent = null;
        const ai = aiOpts();
        if (aiChat && ai.baseUrl) {
          try { intent = await classifyReply(aiChat, ai, { subject: e.subject, from: e.from?.[0]?.name || e.from?.[0]?.address, text: body.text }); } catch { intent = null; }
        }
        if (!intent && looksAutoReply(e, body.text)) intent = { intent: 'out_of_office', summary: 'Automatic reply', nextStep: '', returnDate: null, confidence: 0.6 };
        if (!intent) continue;
        e.intent = { ...intent, at: Date.now() };
        svc.store.touch('index');
        send('intent', { refs: e.refs, subject: e.subject, key: e.key, intent: e.intent });
        svc.changed();
      }
    } finally { intentBusy = false; }
  }
  function handleBounce(s, e, body) {
    const st = s.store.state;
    st.__bounceSeen ||= {};
    if (st.__bounceSeen[e.key]) return;
    st.__bounceSeen[e.key] = true;
    const b = parseBounce(body.text, s.selfAddresses());
    s.store.touch('state');
    if (!b || !b.permanent) return;
    let subject = '';
    if (b.messageId) {
      (st.__bounced ||= {})[b.messageId] = true;
      const rec = Object.values(s.store.sends).find(r => r.messageId === b.messageId);
      if (rec) { rec.bounced = true; subject = rec.subject; s.store.touch('sends'); }
      const orig = [...s.store.index.values()].find(x => x.messageId === b.messageId);
      if (orig) subject ||= orig.subject;
    }
    const refs = refsForAddress(s.addrIndex, b.address);
    send('bounce', { refs, address: b.address, reason: b.reason, subject });
    s.changed();
  }

  async function pollTracker() {
    if (!svc || !trackerReady()) return { skipped: true };
    try {
      const api = await fetchEvents(trackerCfg(), config.getTrackerSecret());
      let total = 0;
      for (let round = 0; round < 10; round++) {
        const { events = [] } = await api.events();
        if (!events.length) break;
        const changes = applyEvents(svc.store.sends, events);
        svc.store.touch('sends', 0);
        await svc.store.flushOne('sends');
        // acknowledge what this database knows (other databases may share the tracker) and anything older than 30 days
        const ackIds = events.filter(e => svc.store.sends[e.code] || Date.now() - Number(e.ts) > 30 * 864e5).map(e => e.id);
        if (ackIds.length) await api.ack(ackIds);
        total += events.length;
        if (changes.length) {
          send('tracking', changes);
          for (const c of changes) {
            const who = c.refs?.map(refName).filter(Boolean).join(', ') || 'Someone';
            if (c.kind === 'interest') notify(`👍 ${who}`, `Clicked “${c.label}” in “${c.subject}”`, c.refs?.[0]);
            else if (c.kind === 'click' && (svc.store.sends[c.code]?.clicks || 0) === 1) notify(`🔗 ${who} clicked a link`, `In “${c.subject}”`, c.refs?.[0]);
            else if (c.kind === 'unsubscribe') notify(`⊘ ${who} unsubscribed`, `From “${c.subject}”`, c.refs?.[0]);
          }
        }
        if (events.length < 500 || ackIds.length < events.length) break;
      }
      lastPoll = { at: Date.now(), total, error: null };
      if (total) svc.changed();
      return lastPoll;
    } catch (e) {
      lastPoll = { at: Date.now(), total: 0, error: e.message };
      return lastPoll;
    }
  }
  function startTrackingPoll() {
    clearInterval(trackTimer);
    if (!trackerReady()) return;
    trackTimer = setInterval(() => pollTracker(), isTest ? 3000 : 2 * 60e3);
    setTimeout(() => pollTracker(), 1500);
  }
  const send = (type, payload) => { const w = getWin(); if (w && !w.isDestroyed()) w.webContents.send('mail:event', { type, payload }); };
  const mailCfg = () => config.get().mail;
  const accountsList = () => mailCfg().accounts || [];

  async function credentialsFor(account) {
    if (config.mailSecretUnreadable(account.id)) {
      throw new Error(`The password for ${account.email} was saved on another computer or Windows account. Windows encrypts saved passwords per computer, so enter it again here: Settings → Email → Edit.`);
    }
    const sec = config.getMailSecret(account.id) || {};
    if (account.auth?.startsWith('oauth')) {
      const o = mailCfg().oauth || {};
      const google = account.auth === 'oauth-google';
      return { accessToken: await accessTokenFor({
        secret: sec, clientId: google ? o.googleClientId : o.microsoftClientId, clientSecret: google ? o.googleClientSecret : '',
        saveSecret: s => config.setMailSecret(account.id, s),
      }) };
    }
    return { pass: sec.pass || '' };
  }

  function dbMailSettings() {
    return db.data?.meta?.settings?.mail || {};
  }

  async function attach() {
    if (!db.path) { await detach(); return; }
    if (svc && svcPath === db.path) { svc.setData(db.data); return; }
    await detach();
    svcPath = db.path;
    svc = new MailService({
      dir: mailDirFor(db.path),
      getAccounts: accountsList,
      getCredentials: credentialsFor,
      settings: () => ({ ...dbMailSettings(), pollMinutes: mailCfg().pollMinutes, undoSeconds: mailCfg().undoSeconds }),
    });
    svc.on('changed', p => send('changed', p));
    svc.on('status', p => send('status', p));
    svc.on('outbox', p => send('outbox', p));
    svc.on('sent', p => { send('sent', p); extraHooks.onSent?.(svc, p); });
    svc.on('send-error', p => {
      send('send-error', p);
      if (p.final) notify('Email not sent', `${p.subject || '(no subject)'}: ${p.error}`);
    });
    svc.on('warning', msg => send('warning', msg));
    svc.on('body', e => { onBody(svc, e); extraHooks.onBody?.(svc, e); });
    svc.on('new-mail', p => {
      send('new-mail', p);
      extraHooks.onNewMail?.(svc, p);
      if (mailCfg().notifyNewMail) notify(`✉ ${p.from?.name || p.from?.address || 'New email'}`, p.subject || '(no subject)', p.refs?.[0]);
    });
    svc.setData(db.data);
    await svc.start();
    startTrackingPoll();
    extraHooks.onAttach?.(svc);
  }

  async function detach() {
    const s = svc;
    svc = null; svcPath = null;
    clearInterval(trackTimer);
    if (s) { extraHooks.onDetach?.(s); await s.stop(); }
  }

  function notify(title, body, ref) {
    if (isTest || !Notification.isSupported() || !config.get().ui.notifications) return;
    const n = new Notification({ title, body, icon: fs.existsSync(iconPath()) ? iconPath() : undefined });
    n.on('click', () => {
      showMain();
      if (ref) { const i = ref.lastIndexOf(':'); getWin()?.webContents.send('app:open-record', { typeKey: ref.slice(0, i), id: Number(ref.slice(i + 1)) }); }
    });
    n.show();
  }

  const need = () => { if (!svc) throw new Error('Open a database first.'); return svc; };

  // ---- accounts
  h('mail:presets', async () => ({ presets: PRESETS }));
  h('mail:guess', async (_e, email) => guessAccount(email));
  h('mail:accounts', async () => ({ accounts: config.publicConfig().mail.accounts, statuses: svc ? svc.statuses() : [] }));
  h('mail:saveAccount', async (_e, { account, password }) => {
    if (!account?.email) throw new Error('Enter the email address.');
    const list = [...accountsList()];
    const a = { enabled: true, aliases: [], ...account, id: account.id || 'acc_' + crypto.randomBytes(5).toString('hex') };
    delete a.hasSecret;
    if (!a.dailyLimit) a.dailyLimit = presetById(a.preset).dailyLimit;
    const i = list.findIndex(x => x.id === a.id);
    if (i >= 0) list[i] = a; else list.push(a);
    config.update({ mail: { accounts: list } });
    if (password) config.setMailSecret(a.id, { ...(config.getMailSecret(a.id) || {}), pass: password });
    if (svc) await svc.restartAccount(a.id);
    return { account: { ...a, hasSecret: !!config.getMailSecret(a.id) } };
  });
  h('mail:removeAccount', async (_e, id) => {
    config.update({ mail: { accounts: accountsList().filter(a => a.id !== id) } });
    config.setMailSecret(id, null);
    if (svc) await svc.removeAccount(id);
    return { ok: true };
  });
  h('mail:testAccount', async (_e, { account, password }) => {
    const cred = password ? { pass: password } : await credentialsFor(account);
    return testAccount(account, cred);
  });
  h('mail:oauth', async (_e, { provider = 'microsoft', accountId, loginHint } = {}) => {
    const o = mailCfg().oauth || {};
    const google = provider === 'google';
    const res = await signIn({
      provider, clientId: google ? o.googleClientId : o.microsoftClientId, clientSecret: google ? o.googleClientSecret : '',
      tenant: o.microsoftTenant || 'consumers', loginHint, openUrl: url => shell.openExternal(url),
    });
    const id = accountId || 'acc_' + crypto.randomBytes(5).toString('hex');
    config.setMailSecret(id, res);
    getWin()?.focus();
    return { accountId: id, email: res.email };
  });
  h('mail:status', async () => ({ statuses: svc ? svc.statuses() : [], outbox: svc ? svc.outboxSummary() : [] }));
  h('mail:syncNow', async (_e, id) => ({ errors: svc ? await svc.syncNow(id) : [] }));

  // ---- reading
  h('mail:list', async (_e, o) => ({ messages: need().list(o) }));
  h('mail:threads', async (_e, o) => ({ threads: need().threads(o) }));
  h('mail:get', async (_e, key) => ({ message: await need().getMessage(key) }));
  h('mail:markRead', async (_e, { key, read = true }) => { await need().markRead(key, read); return { ok: true }; });
  h('mail:searchText', async () => ({ text: svc ? svc.searchText() : {} }));
  h('mail:stats', async () => ({ stats: svc ? svc.stats() : {}, unread: svc ? svc.unreadCount() : 0 }));
  h('mail:attachment', async (_e, { key, index, action, typeKey, id, confirmed }) => {
    const s = need();
    const e = s.store.index.get(key);
    const att = e?.attachments?.find(a => a.index === index);
    if (action === 'open') {
      if (att && isDangerousFile(att.filename) && !confirmed) return { dangerous: true, filename: att.filename };
      const file = await s.saveAttachment(key, index, path.join(app.getPath('temp'), 'OpenCRM-mail', crypto.randomBytes(4).toString('hex')));
      const err = await shell.openPath(file);
      if (err) throw new Error(err);
      return { path: file };
    }
    if (action === 'save') {
      const r = await dialog.showSaveDialog(getWin(), { title: 'Save attachment', defaultPath: path.join(app.getPath('downloads'), att?.filename || 'attachment') });
      if (r.canceled || !r.filePath) return { canceled: true };
      const tmp = await s.saveAttachment(key, index, path.join(app.getPath('temp'), 'OpenCRM-mail', crypto.randomBytes(4).toString('hex')));
      fs.copyFileSync(tmp, r.filePath);
      return { path: r.filePath };
    }
    if (action === 'keep') {
      if (!db.path) throw new Error('No database open');
      const tmp = await s.saveAttachment(key, index, path.join(app.getPath('temp'), 'OpenCRM-mail', crypto.randomBytes(4).toString('hex')));
      return { refs: await addFiles(db.path, typeKey, id, [tmp]) };
    }
    throw new Error('Unknown action');
  });

  // ---- writing
  h('mail:pickFiles', async () => {
    const r = await dialog.showOpenDialog(getWin(), { title: 'Attach files', properties: ['openFile', 'multiSelections'] });
    if (r.canceled) return { files: [] };
    return { files: r.filePaths.map(p => ({ path: p, filename: path.basename(p), size: fs.statSync(p).size })) };
  });
  /** record-file attachments -> paths; forwarded attachments; data: images -> inline (cid) parts. */
  const resolveDraft = async d => {
    const out = { ...d, attachments: (d.attachments || []).map(a => (a.rel ? { path: resolveRel(db.path, a.rel), filename: a.filename } : a)) };
    if (d.forwardFrom && svc) {
      const e = svc.store.index.get(d.forwardFrom);
      const dir = path.join(app.getPath('temp'), 'OpenCRM-mail', crypto.randomBytes(4).toString('hex'));
      for (const a of e?.attachments || []) {
        try { out.attachments.push({ path: await svc.saveAttachment(d.forwardFrom, a.index, dir), filename: a.filename }); } catch { /* skip */ }
      }
    }
    if (out.html) {
      const seen = new Map();
      out.html = out.html.replace(/(src=["'])data:(image\/[a-z0-9.+-]+);base64,([A-Za-z0-9+/=]+)(["'])/gi, (m, pre, ct, b64, post) => {
        let cid = seen.get(b64);
        if (!cid) {
          cid = `img${seen.size + 1}.${crypto.randomBytes(6).toString('hex')}@opencrm`;
          seen.set(b64, cid);
          out.attachments.push({ filename: `image${seen.size}.${ct.split('/')[1].replace('jpeg', 'jpg').replace(/\+.*/, '')}`, content: b64, contentType: ct, cid });
        }
        return `${pre}cid:${cid}${post}`;
      });
    }
    delete out.forwardFrom;
    return out;
  };
  const prepare = async d => {
    let r = await resolveDraft(d);
    const acc = accountsList().find(a => a.id === r.accountId) || accountsList()[0];
    const enabled = r.tracking !== 'off' && (r.tracking === 'on' || trackerCfg().defaultOn !== false) && trackerReady();
    const { draft: td, record } = prepareTracked(r, { cfg: trackerCfg(), secret: config.getTrackerSecret(), from: acc?.email || '', enabled });
    if (record && svc) { svc.store.sends[record.code] = record; svc.store.touch('sends'); }
    r = td;
    return extraHooks.prepareDraft ? extraHooks.prepareDraft(r) : r;
  };
  // ---- tracking
  const trackerFile = name => path.join(app.getAppPath(), 'resources', 'tracker', name);
  h('mail:tracker', async (_e, { action, cfg, kind } = {}) => {
    if (action === 'status') return { ready: trackerReady(), lastPoll, hasSecret: !!config.getTrackerSecret() };
    if (action === 'save') {
      const { secretEnc, hasSecret, ...rest } = cfg || {};
      config.update({ mail: { tracker: { ...trackerCfg(), ...rest } } });
      startTrackingPoll();
      return { ok: true, ready: trackerReady() };
    }
    if (action === 'newSecret') { const s = crypto.randomBytes(24).toString('base64url'); config.setTrackerSecret(s); startTrackingPoll(); return { secret: s }; }
    if (action === 'secret') return { secret: config.getTrackerSecret() };
    if (action === 'code') {
      let code = fs.readFileSync(trackerFile(kind === 'php' ? 'tracker.php' : 'cloudflare-worker.js'), 'utf8');
      if (kind === 'php') code = code.replace('__OPENCRM_SECRET__', config.getTrackerSecret() || '__OPENCRM_SECRET__');
      return { code };
    }
    if (action === 'savePhp') {
      const r = await dialog.showSaveDialog(getWin(), { title: 'Save tracker.php', defaultPath: path.join(app.getPath('documents'), 'tracker.php'), filters: [{ name: 'PHP', extensions: ['php'] }] });
      if (r.canceled || !r.filePath) return { canceled: true };
      fs.writeFileSync(r.filePath, fs.readFileSync(trackerFile('tracker.php'), 'utf8').replace('__OPENCRM_SECRET__', config.getTrackerSecret()));
      shell.showItemInFolder(r.filePath);
      return { path: r.filePath };
    }
    if (action === 'test') {
      if (!trackerReady()) throw new Error('Enter the tracker address and create a secret first.');
      const api = await fetchEvents(trackerCfg(), config.getTrackerSecret());
      return await api.health();
    }
    if (action === 'check') return pollTracker();
    if (action === 'sends') return { sends: svc ? svc.store.sends : {} };
    if (action === 'report') return svc ? svc.trackingReport() : { templates: {}, bulks: {} };
    throw new Error('Unknown tracker action');
  });
  h('mail:send', async (_e, { draft, delaySec }) => {
    const s = need();
    const item = s.queue(await prepare(draft), { delaySec });
    return { id: item.id, sendAt: item.sendAt };
  });
  h('mail:undo', async (_e, id) => ({ draft: need().undo(id) }));
  h('mail:inlineCss', async (_e, html) => {
    const src = String(html || '');
    if (src.length > 3 * 1024 * 1024) throw new Error('This HTML is too large for an email (over 3 MB).');
    const title = (src.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1] || '').trim();
    const removed = [/<script/i.test(src) && 'scripts', /<form/i.test(src) && 'forms', /<link[^>]+stylesheet/i.test(src) && 'external stylesheets'].filter(Boolean).join(', ');
    let inlined;
    try { inlined = juice(src, { removeStyleTags: false, preserveMediaQueries: true, applyWidthAttributes: true, applyHeightAttributes: true }); } catch (err) { throw new Error(`Could not read this HTML: ${err.message}`); }
    // keep <style> blocks that only hold media queries (responsive rules), drop scripts/forms/etc.
    const { html: clean } = cleanHtml(inlined.replace(/<title[^>]*>[\s\S]*?<\/title>/i, ''));
    return { html: clean, title, removed };
  });
  h('mail:outbox', async () => ({ outbox: svc ? svc.outboxSummary() : [] }));
  h('mail:retry', async (_e, id) => ({ ok: need().retry(id) }));
  h('mail:discard', async (_e, id) => ({ ok: need().discard(id) }));
  h('mail:bulk', async (_e, { items, accountId, spacingSec }) => {
    const s = need();
    const prepared = [];
    for (const it of items) prepared.push({ ...it, draft: await prepare(it.draft) });
    return s.queueBulk(prepared, { accountId, spacingSec });
  });
  h('mail:bulkControl', async (_e, { bulkId, action }) => ({ n: need().bulkControl(bulkId, action) }));
  h('mail:drafts', async (_e, { action, draft, id } = {}) => {
    const s = need();
    if (action === 'save') return { id: s.saveDraft(draft) };
    if (action === 'delete') { s.deleteDraft(id); return { ok: true }; }
    return { drafts: s.listDrafts() };
  });

  return {
    attach, detach,
    get service() { return svc; },
    setData: data => svc?.setData(data),
    notify,
  };
}
