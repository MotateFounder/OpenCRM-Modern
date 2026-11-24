// Agent Gateway (main process): authenticates MCP clients, enforces profiles, limits and the kill switch,
// runs tools in the OpenCRM window (so undo/autosave/UI stay consistent), keeps approvals, the activity log,
// change sets (undo) and prepared campaigns.
import net from 'node:net';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { app, dialog, ipcMain } from 'electron';
import { pipePath, framed, hashToken, newToken } from './protocol.js';
import { TOOL_BY_NAME } from './tools.js';
import { AgentStore, agentDirFor } from './store.js';
import { manualBackup } from '../backup.js';
import { startHttp } from './http.js';

export const PROFILES = {
  readonly: { label: 'Read-only', allow: ['read', 'read-docs'] },
  assistant: { label: 'Assistant', allow: ['read', 'read-email', 'read-docs', 'write', 'sensitive', 'draft', 'send'] },
  autopilot: { label: 'Autopilot', allow: ['read', 'read-email', 'read-docs', 'write', 'sensitive', 'draft', 'send'], autoSend: true },
};

const ERR = (message, code = 'DENIED') => Object.assign(new Error(message), { code });
const sha = s => crypto.createHash('sha256').update(String(s)).digest('hex').slice(0, 16);

export function setupAgents({ h, db, config, getWin, notify, isTest, onState }) {
  let server = null;
  let store = null;
  let storePath = null;
  const pendingCalls = new Map();
  const usage = new Map(); // clientId -> { calls: [ts], writes: [{ts,n}], deletes: [ts], refusals }
  const cfg = () => config.get().agents;
  const clients = () => cfg().clients || [];
  const saveClients = list => config.update({ agents: { clients: list } });
  const broadcast = () => { getWin()?.webContents.send('agents:changed', publicState()); onState?.(publicState()); };

  function ensureStore() {
    if (!db.path) throw ERR('No database is open in OpenCRM.', 'NO_DB');
    if (!store || storePath !== db.path) { store?.flush(); store = new AgentStore(agentDirFor(db.path)); storePath = db.path; }
    return store;
  }

  function publicState() {
    const s = store && storePath === db.path ? store : null;
    return {
      paused: !!cfg().paused,
      autoSendCap: cfg().autoSendCap,
      writesPerHour: cfg().writesPerHour,
      http: { enabled: !!cfg().httpEnabled, port: cfg().httpPort, running: !!httpSrv, error: httpError },
      clients: clients().map(({ tokenHash, ...c }) => c),
      pending: s ? s.approvals.filter(a => a.status === 'pending').length : 0,
      pipe: pipePath(app.getPath('userData')),
    };
  }

  // ---------------------------------------------------------------- auth
  function clientForToken(token) {
    if (!token) throw ERR('Missing OPENCRM_AGENT_TOKEN. Connect the agent in OpenCRM → Settings → AI agents.', 'AUTH');
    const hsh = hashToken(token);
    const c = clients().find(x => x.tokenHash === hsh);
    if (!c) throw ERR('This agent token is not valid (it may have been revoked). Create a new one in OpenCRM → Settings → AI agents.', 'AUTH');
    return c;
  }

  const confirming = new Map();
  async function confirmClient(c) {
    if (c.confirmed) return c;
    if (isTest) { updateClient(c.id, { confirmed: true }); return { ...c, confirmed: true }; }
    if (!confirming.has(c.id)) {
      confirming.set(c.id, (async () => {
        const win = getWin();
        const r = await dialog.showMessageBox(win && !win.isDestroyed() ? win : undefined, {
          type: 'question', buttons: ['Deny', 'Allow'], defaultId: 1, cancelId: 0, title: 'OpenCRM — AI agent',
          message: `“${c.name}” wants to connect to OpenCRM.`,
          detail: `Profile: ${PROFILES[c.profile]?.label || c.profile}. You can change or revoke this at any time in Settings → AI agents.`,
        });
        if (r.response === 1) { updateClient(c.id, { confirmed: true }); return true; }
        updateClient(c.id, { paused: true });
        return false;
      })().finally(() => setTimeout(() => confirming.delete(c.id), 1000)));
    }
    if (!(await confirming.get(c.id))) throw ERR('The user did not allow this agent to connect.', 'AUTH');
    return { ...c, confirmed: true };
  }

  function updateClient(id, patch) {
    saveClients(clients().map(c => (c.id === id ? { ...c, ...patch } : c)));
    broadcast();
  }

  // ---------------------------------------------------------------- limits
  function use(c) {
    let u = usage.get(c.id);
    if (!u) { u = { calls: [], writes: [], deletes: [], refusals: 0 }; usage.set(c.id, u); }
    const now = Date.now();
    u.calls = u.calls.filter(t => now - t < 60e3);
    u.writes = u.writes.filter(w => now - w.ts < 3600e3);
    u.deletes = u.deletes.filter(t => now - t < 3600e3);
    return u;
  }

  function autoPause(c, why) {
    updateClient(c.id, { paused: true, pausedReason: why });
    ensureStore().log({ clientId: c.id, clientName: c.name, tool: '-', outcome: 'paused', summary: `Paused automatically: ${why}` });
    notify?.('🤖 Agent paused', `${c.name}: ${why}`);
  }

  function refuse(c, err) {
    const u = use(c);
    u.refusals++;
    if (u.refusals >= 10) autoPause(c, '10 refused requests in a row');
    throw err;
  }

  // ---------------------------------------------------------------- run in the window
  function callRenderer(channel, payload, timeoutMs = 60000) {
    const win = getWin();
    if (!win || win.isDestroyed()) return Promise.reject(ERR('OpenCRM window is not ready.', 'NOT_READY'));
    const reqId = crypto.randomUUID();
    return new Promise((resolve, reject) => {
      const t = setTimeout(() => { pendingCalls.delete(reqId); reject(ERR('OpenCRM did not answer in time.', 'TIMEOUT')); }, timeoutMs);
      pendingCalls.set(reqId, { resolve: v => { clearTimeout(t); resolve(v); }, reject: e => { clearTimeout(t); reject(e); } });
      win.webContents.send(channel, { reqId, ...payload });
    });
  }
  ipcMain.handle('agent:reply', (_e, { reqId, result }) => {
    const p = pendingCalls.get(reqId);
    if (p) { pendingCalls.delete(reqId); p.resolve(result); }
    return true;
  });

  function preAgentBackup(s) {
    const d = s.day('preAgentBackup');
    if (d.n) return;
    try { if (db.path && fs.existsSync(db.path)) manualBackup(db.path, 'pre-agent'); } catch { /* best effort */ }
    d.n = 1;
    s.save('state');
  }

  // ---------------------------------------------------------------- the main entry: one tool call
  async function call(token, tool, args = {}) {
    let c = clientForToken(token);
    c = await confirmClient(c);
    const s = ensureStore();
    const def = TOOL_BY_NAME[tool];
    const logBase = { clientId: c.id, clientName: c.name, tool };
    if (!def) throw ERR(`Unknown tool ${tool}`, 'BAD_REQUEST');
    if (cfg().paused) throw ERR('All AI agents are paused by the user in OpenCRM.', 'PAUSED');
    if (c.paused) throw ERR(`This agent is paused by the user in OpenCRM${c.pausedReason ? ` (${c.pausedReason})` : ''}.`, 'PAUSED');
    const profile = PROFILES[c.profile] || PROFILES.assistant;
    const u = use(c);
    if (u.calls.length >= (cfg().callsPerMinute || 120)) refuse(c, ERR('Too many requests: slow down (limit per minute reached).', 'RATE'));
    u.calls.push(Date.now());
    updateClientSeen(c);
    let category = def.category;
    if (category === 'read-email' && c.readEmails === false) category = 'none';
    if (!profile.allow.includes(category)) {
      s.log({ ...logBase, outcome: 'refused', summary: `Not allowed for the ${profile.label} profile` });
      refuse(c, ERR(`The ${profile.label} profile does not allow ${tool}. The user can change the profile in OpenCRM → Settings → AI agents.`));
    }
    const writes = u.writes.reduce((n, w) => n + w.n, 0);
    const isWrite = ['write', 'sensitive', 'draft', 'send'].includes(category);
    if (isWrite && !args.dryRun && writes >= (cfg().writesPerHour || 200)) {
      autoPause(c, 'hourly change limit reached');
      throw ERR('Hourly change limit reached; the agent has been paused. The user can resume it in OpenCRM.', 'RATE');
    }

    // handled here (no window needed)
    if (tool === 'get_request_status') return requestStatus(s, c, args.requestId);
    if (tool === 'send_campaign') return sendCampaign(s, c, args);
    if (isWrite && !args.dryRun) preAgentBackup(s);

    const res = await callRenderer('agent:call', { tool, args, client: { id: c.id, name: c.name, profile: c.profile, autoSend: !!profile.autoSend, autoSendLeft: autoSendLeft(s), readEmails: c.readEmails !== false } }, tool === 'ai_search' ? 180000 : 60000);
    if (res?.error) {
      s.log({ ...logBase, outcome: 'refused', summary: res.error });
      refuse(c, ERR(res.error, res.code || 'REFUSED'));
    }
    u.refusals = 0;
    if (res.changeset) {
      const cs = { id: `cs_${crypto.randomBytes(5).toString('hex')}`, clientId: c.id, clientName: c.name, tool, at: new Date().toISOString(), ...res.changeset };
      s.addChangeset(cs);
      res.result.changeId = cs.id;
      u.writes.push({ ts: Date.now(), n: res.changeset.records?.length || 1 });
    }
    if (res.campaign) {
      const id = `cmp_${crypto.randomBytes(5).toString('hex')}`;
      s.campaigns[id] = { id, clientId: c.id, clientName: c.name, createdAt: new Date().toISOString(), ...res.campaign };
      s.save('campaigns');
      res.result.campaignId = id;
    }
    if (res.autoSent) { const d = s.day('autoSent'); d.n += res.autoSent; s.save('state'); }
    if (res.approval) {
      if (tool === 'delete_records' || tool === 'merge_records') {
        u.deletes.push(...Array(res.approval.count || 1).fill(Date.now()));
        if (u.deletes.length > 20) autoPause(c, 'more than 20 deletions requested in an hour');
      }
      const a = createApproval(s, c, { tool, args, ...res.approval });
      res.result = { status: 'pending', requestId: a.id, message: 'Waiting for the user\'s approval in OpenCRM (🤖 Approvals). Tell the user what you asked for; check get_request_status later.', summary: a.summary };
    }
    s.log({ ...logBase, outcome: res.approval ? 'requested' : (args.dryRun ? 'dry-run' : 'done'), summary: res.summary || res.result?.summary || '', refs: res.refs || res.changeset?.records?.map(r => r.ref) || [], changeId: res.result?.changeId, requestId: res.result?.requestId });
    if (isWrite || res.approval) broadcast();
    return res.result;
  }

  let seenTimer = null;
  function updateClientSeen(c) {
    clearTimeout(seenTimer);
    seenTimer = setTimeout(() => saveClients(clients().map(x => (x.id === c.id ? { ...x, lastSeen: new Date().toISOString() } : x))), 1000);
  }

  function autoSendLeft(s) { return Math.max(0, (cfg().autoSendCap ?? 20) - s.day('autoSent').n); }

  // ---------------------------------------------------------------- approvals
  function createApproval(s, c, a) {
    const fingerprint = sha(JSON.stringify([a.tool, a.args]));
    if (s.approvals.some(x => x.fingerprint === fingerprint && x.status === 'rejected')) throw ERR('The user already rejected exactly this request. Change it (or ask the user) before trying again.', 'REJECTED');
    const existing = s.approvals.find(x => x.fingerprint === fingerprint && x.status === 'pending');
    if (existing) return existing;
    const item = {
      id: `req_${crypto.randomBytes(5).toString('hex')}`, fingerprint, clientId: c.id, clientName: c.name, tool: a.tool, args: a.args,
      kind: a.kind, summary: a.summary, details: a.details || null, payload: a.payload || null, count: a.count || 1,
      status: 'pending', createdAt: new Date().toISOString(),
    };
    s.approvals.push(item);
    s.save('approvals');
    notify?.(`🤖 ${c.name} asks for approval`, a.summary);
    return item;
  }

  function requestStatus(s, c, id) {
    const a = s.approvals.find(x => x.id === id && x.clientId === c.id);
    if (!a) throw ERR('Unknown request id.', 'NOT_FOUND');
    return { requestId: a.id, status: a.status, summary: a.summary, reason: a.reason || null, result: a.result || null, resolvedAt: a.resolvedAt || null };
  }

  function sendCampaign(s, c, { campaignId, note }) {
    const cmp = s.campaigns[campaignId];
    if (!cmp || cmp.clientId !== c.id) throw ERR('Unknown campaignId (prepare it with prepare_campaign first).', 'NOT_FOUND');
    if (!cmp.items?.length) throw ERR('This campaign has no recipients.', 'BAD_REQUEST');
    const a = createApproval(s, c, {
      tool: 'send_campaign', args: { campaignId }, kind: 'campaign', count: cmp.items.length,
      summary: `Send “${cmp.name}” to ${cmp.items.length} ${cmp.items.length === 1 ? 'person' : 'people'}${note ? ` — ${note}` : ''}`,
      details: { note: note || '', skipped: cmp.skipped || [] }, payload: { campaignId },
    });
    s.log({ clientId: c.id, clientName: c.name, tool: 'send_campaign', outcome: 'requested', summary: a.summary, requestId: a.id });
    broadcast();
    return { status: 'pending', requestId: a.id, message: 'Waiting for the user\'s approval in OpenCRM.', summary: a.summary };
  }

  async function resolveApproval(id, action, { reason = '' } = {}) {
    const s = ensureStore();
    const a = s.approvals.find(x => x.id === id);
    if (!a || a.status !== 'pending') throw new Error('This request is no longer pending.');
    const c = clients().find(x => x.id === a.clientId) || { id: a.clientId, name: a.clientName, profile: 'assistant' };
    if (action === 'reject' || action === 'edited') {
      a.status = action === 'reject' ? 'rejected' : 'edited';
      a.reason = reason || (action === 'edited' ? 'The user opened it to edit and send it themselves.' : '');
      a.resolvedAt = new Date().toISOString();
      s.save('approvals');
      s.log({ clientId: c.id, clientName: c.name, tool: a.tool, outcome: a.status, summary: a.summary, requestId: a.id });
      broadcast();
      return a;
    }
    let res;
    if (a.kind === 'campaign') {
      const cmp = s.campaigns[a.payload.campaignId];
      res = await callRenderer('agent:call', { tool: '__execute_campaign', args: { campaign: cmp }, client: { id: c.id, name: c.name, profile: c.profile }, approved: true });
    } else {
      res = await callRenderer('agent:call', { tool: a.tool, args: a.args, client: { id: c.id, name: c.name, profile: c.profile }, approved: true, payload: a.payload });
    }
    if (res?.error) { a.status = 'failed'; a.reason = res.error; } else {
      a.status = 'approved';
      a.result = res.result || null;
      if (res.changeset) {
        const cs = { id: `cs_${crypto.randomBytes(5).toString('hex')}`, clientId: c.id, clientName: c.name, tool: a.tool, at: new Date().toISOString(), requestId: a.id, ...res.changeset };
        s.addChangeset(cs);
        a.result = { ...(a.result || {}), changeId: cs.id };
      }
    }
    a.resolvedAt = new Date().toISOString();
    s.save('approvals');
    s.log({ clientId: c.id, clientName: c.name, tool: a.tool, outcome: a.status, summary: a.summary, requestId: a.id, changeId: a.result?.changeId });
    broadcast();
    return a;
  }

  // ---------------------------------------------------------------- pipe server
  function start() {
    if (server) return;
    const p = pipePath(app.getPath('userData'));
    if (process.platform !== 'win32') { try { fs.unlinkSync(p); } catch { /* none */ } }
    server = net.createServer(socket => {
      const ch = framed(socket, async msg => {
        const reply = (result, error) => ch.send(error ? { id: msg.id, error: { message: error.message, code: error.code } } : { id: msg.id, result });
        try {
          if (msg.method === 'hello') {
            let c = clientForToken(msg.token);
            c = await confirmClient(c);
            return reply({ client: c.name, profile: c.profile, version: app.getVersion(), db: db.path ? path.basename(db.path) : null });
          }
          if (msg.method === 'call') return reply(await call(msg.token, msg.params?.tool, msg.params?.args || {}));
          return reply(null, ERR('Unknown method', 'BAD_REQUEST'));
        } catch (e) { return reply(null, e); }
      });
      socket.on('error', () => {});
    });
    server.on('error', e => console.error('Agent pipe error:', e.message));
    server.listen(p);
    syncHttp();
  }

  let httpSrv = null;
  let httpPort = null;
  let httpError = null;
  async function syncHttp() {
    const want = cfg().httpEnabled ? Number(cfg().httpPort) || 39271 : null;
    if (httpSrv && httpPort === want) return;
    if (httpSrv) { await httpSrv.close().catch(() => {}); httpSrv = null; httpPort = null; }
    if (!want) return;
    try { httpSrv = await startHttp({ port: want, call, version: app.getVersion(), onError: e => console.error('MCP HTTP:', e.message) }); httpPort = want; httpError = null; } catch (e) { httpError = `Could not open port ${want}: ${e.message}`; notify?.('🤖 MCP HTTP endpoint', httpError); }
  }

  function stop() { try { server?.close(); } catch { /* ignore */ } server = null; httpSrv?.close(); httpSrv = null; store?.flush(); }

  // ---------------------------------------------------------------- IPC for the settings / approvals UI
  function exeCommand() {
    const env = process.env.OPENCRM_USER_DATA ? { OPENCRM_USER_DATA: process.env.OPENCRM_USER_DATA } : {};
    if (app.isPackaged) return { command: process.env.PORTABLE_EXECUTABLE_FILE || process.execPath, args: ['--mcp'], env };
    return { command: process.execPath, args: [app.getAppPath(), '--mcp'], env };
  }
  h('agents:state', async () => publicState());
  h('agents:createClient', async (_e, { name, kind = 'other', profile = 'assistant' }) => {
    const token = newToken();
    const c = { id: `ag_${crypto.randomBytes(4).toString('hex')}`, name: String(name || 'AI agent').slice(0, 60), kind, profile, tokenHash: hashToken(token), createdAt: new Date().toISOString(), lastSeen: null, paused: false, confirmed: false, readEmails: true };
    saveClients([...clients(), c]);
    broadcast();
    return { client: { ...c, tokenHash: undefined }, token, ...exeCommand() };
  });
  h('agents:updateClient', async (_e, { id, patch }) => {
    const allowed = ['name', 'profile', 'paused', 'readEmails'];
    const p = Object.fromEntries(Object.entries(patch || {}).filter(([k]) => allowed.includes(k)));
    if (p.paused === false) p.pausedReason = '';
    if (p.paused === false) usage.delete(id);
    updateClient(id, p);
    return publicState();
  });
  h('agents:revoke', async (_e, id) => { saveClients(clients().filter(c => c.id !== id)); usage.delete(id); broadcast(); return publicState(); });
  h('agents:global', async (_e, patch = {}) => {
    const allowed = ['paused', 'autoSendCap', 'writesPerHour', 'httpEnabled', 'httpPort'];
    config.update({ agents: Object.fromEntries(Object.entries(patch).filter(([k]) => allowed.includes(k))) });
    if ('httpEnabled' in patch || 'httpPort' in patch) await syncHttp();
    broadcast();
    return publicState();
  });
  h('agents:command', async () => exeCommand());
  h('agents:approvals', async (_e, { status } = {}) => { const s = ensureStore(); s.expire(); return { approvals: s.approvals.filter(a => !status || a.status === status).slice(-300).reverse(), campaigns: s.campaigns }; });
  h('agents:resolve', async (_e, { id, action, reason }) => ({ approval: await resolveApproval(id, action, { reason }) }));
  h('agents:activity', async (_e, { limit = 300 } = {}) => ({ activity: ensureStore().activity.slice(-limit).reverse() }));
  h('agents:changeset', async (_e, id) => ({ changeset: ensureStore().changesets[id] || null }));
  h('agents:undo', async (_e, { id, force = false }) => {
    const s = ensureStore();
    const cs = s.changesets[id];
    if (!cs) throw new Error('This change can no longer be undone (too old).');
    if (cs.undone) throw new Error('Already undone.');
    const res = await callRenderer('agent:undo', { changeset: cs, force });
    if (res?.conflict) return { conflict: res.conflict };
    if (res?.error) throw new Error(res.error);
    cs.undone = new Date().toISOString();
    s.save('changesets');
    s.log({ clientId: cs.clientId, clientName: cs.clientName, tool: cs.tool, outcome: 'undone', summary: `Undone by the user: ${cs.summary || ''}`, changeId: cs.id });
    broadcast();
    return { ok: true };
  });

  return { start, stop, call, publicState, resolveApproval, get store() { return store; }, exeCommand };
}
