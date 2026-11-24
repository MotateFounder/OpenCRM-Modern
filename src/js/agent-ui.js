// AI agents (MCP): toolbar menu, Approvals panel, Activity log with undo, Settings → AI agents, Trash.
import { h, replace } from './dom.js';
import { store, mutate, emit, on } from './store.js';
import { getType, recordTitle, restoreFromTrash, TRASH_DAYS } from './shared.js';
import { openModal, toast, confirmDialog, promptDialog, menu, field } from './ui.js';
import { mailFrame } from './mail-render.js';
import { openRecord } from './actions.js';
import { agentAccess } from './agent-ops.js';
import { hooks } from './hooks.js';

export const agentState = { paused: false, clients: [], pending: 0, http: { enabled: false } };

export async function refreshAgentState() {
  try { Object.assign(agentState, await window.crm.agent.state()); emit('agents-changed'); } catch { /* no db */ }
}

export function initAgentUi() {
  window.crm.agent.onChanged(s => { Object.assign(agentState, s); emit('agents-changed'); });
  refreshAgentState();
}

const PROFILE_LABEL = { readonly: 'Read-only', assistant: 'Assistant', autopilot: 'Autopilot' };
const PROFILE_HELP = {
  readonly: 'Can read records, notes and documents. Cannot change anything or read emails.',
  assistant: 'Reads everything and edits records, notes and reminders. Drafts emails. Sending, bulk edits, merges, deletions and new fields wait for your approval.',
  autopilot: 'Like Assistant, but may send a few emails on its own (existing contacts only, max 2 recipients, within the daily cap). Everything else still needs approval.',
};

// ---------------------------------------------------------------- toolbar
export function agentToolbarButton() {
  const any = agentState.clients.length > 0;
  if (!any && !agentState.pending) return null;
  return h('button', {
    class: ['icon-btn', 'agent-btn', agentState.paused && 'paused', agentState.pending && 'has-pending'],
    title: agentState.paused ? 'AI agents are paused' : agentState.pending ? `${agentState.pending} request(s) from AI agents need your approval` : 'AI agents',
    onclick: e => menu(e.currentTarget, [
      { label: `Approvals${agentState.pending ? ` (${agentState.pending})` : ''}`, icon: '✅', fn: openApprovals },
      { label: 'Activity & undo', icon: '📜', fn: openActivity },
      'sep',
      agentState.paused ? { label: 'Resume all agents', icon: '▶', fn: () => setPaused(false) } : { label: 'Pause all agents', icon: '⏸', fn: () => setPaused(true) },
      { label: 'AI agents settings…', icon: '⚙', fn: () => hooks.openSettings?.('agents') },
    ], { align: 'right' }),
  }, agentState.paused ? '⏸' : '🤖', agentState.pending ? h('span', { class: 'badge' }, String(agentState.pending)) : null);
}

async function setPaused(paused) {
  Object.assign(agentState, await window.crm.agent.global({ paused }));
  emit('agents-changed');
  toast(paused ? 'All AI agents are paused' : 'AI agents resumed');
}

// ---------------------------------------------------------------- approvals
export async function openApprovals() {
  const body = h('div', { class: 'approvals' });
  const m = openModal({ title: '✅ Requests from AI agents', size: 'xl', body });
  const off = on('agents-changed', () => { if (body.isConnected) render(); else off(); });
  async function render() {
    let data;
    try { data = await window.crm.agent.approvals({}); } catch (e) { replace(body, h('p', { class: 'err' }, e.message)); return; }
    const pending = data.approvals.filter(a => a.status === 'pending');
    const done = data.approvals.filter(a => a.status !== 'pending').slice(0, 30);
    replace(body,
      pending.length ? pending.map(a => approvalCard(a, data.campaigns, render)) : h('div', { class: 'empty-state' }, 'Nothing waiting for your approval.'),
      done.length ? h('details', { class: 'help-details' }, h('summary', {}, `History (${done.length})`),
        h('table', { class: 'grid-table' }, h('tbody', {}, done.map(a => h('tr', {},
          h('td', { class: 'nowrap small' }, new Date(a.resolvedAt || a.createdAt).toLocaleString()),
          h('td', {}, `🤖 ${a.clientName}`), h('td', {}, a.summary),
          h('td', {}, h('span', { class: ['status-chip', `st-${a.status}`] }, a.status), a.reason ? h('div', { class: 'muted small' }, a.reason) : null)))))) : null);
  }
  render();
  return m;
}

function approvalCard(a, campaigns, rerender) {
  const resolve = async (action, extra = {}) => {
    try {
      const r = await window.crm.agent.resolve({ id: a.id, action, ...extra });
      toast(r.approval.status === 'failed' ? `Failed: ${r.approval.reason}` : action === 'approve' ? 'Approved' : action === 'reject' ? 'Rejected' : 'Done', { type: r.approval.status === 'failed' ? 'error' : 'info' });
    } catch (e) { toast(e.message, { type: 'error' }); }
    rerender();
  };
  const actions = h('div', { class: 'row-gap' },
    h('button', { class: 'btn btn-primary', onclick: () => resolve('approve') }, a.kind === 'email' ? 'Approve & send' : a.kind === 'campaign' ? `Approve & send to ${a.count}` : 'Approve'),
    a.kind === 'email' && a.payload?.draft ? h('button', { class: 'btn', title: 'Open it in the email window, change it and send it yourself', onclick: () => { hooks.compose?.({ draft: { ...a.payload.draft, draftId: null } }); resolve('edited'); } }, 'Edit…') : null,
    h('button', { class: 'btn btn-danger-soft', onclick: async () => {
      const reason = await promptDialog('Reject this request', { label: 'Reason for the agent (optional)', placeholder: 'e.g. not now, wrong person, too pushy' });
      if (reason !== null) resolve('reject', { reason });
    } }, 'Reject'));
  return h('div', { class: 'approval-card' },
    h('div', { class: 'approval-head' }, h('b', {}, `🤖 ${a.clientName}`), h('span', { class: 'muted small' }, ` · ${new Date(a.createdAt).toLocaleString()} · ${a.tool}`)),
    h('div', { class: 'approval-summary' }, a.summary),
    a.details?.reason ? h('div', { class: 'muted small' }, `Reason given: ${a.details.reason}`) : null,
    a.details?.why ? h('div', { class: 'muted small' }, a.details.why) : null,
    approvalDetails(a, campaigns),
    actions);
}

function refLink(ref, title) {
  const i = ref.lastIndexOf(':');
  return h('a', { href: '#', onclick: e => { e.preventDefault(); openRecord(Number(ref.slice(i + 1)), ref.slice(0, i)); } }, title || ref);
}
const fmt = v => (v == null || v === '' ? '—' : Array.isArray(v) ? v.join(', ') : typeof v === 'object' ? JSON.stringify(v) : String(v));

function approvalDetails(a, campaigns) {
  const d = a.details || {};
  switch (a.kind) {
    case 'email':
      return h('div', { class: 'approval-email' }, h('div', { class: 'small' }, h('b', {}, 'To: '), (d.to || []).join(', ')), h('div', { class: 'small' }, h('b', {}, 'Subject: '), d.subject || ''), mailFrame({ html: d.html, text: d.text }, { allowImages: true, maxHeight: 420 }));
    case 'campaign': {
      const cmp = campaigns?.[a.payload?.campaignId];
      if (!cmp) return h('p', { class: 'err' }, 'The campaign data is missing.');
      let idx = 0;
      const prev = h('div', {});
      const show = () => { const it = cmp.items[idx]; replace(prev, h('div', { class: 'row-gap' }, h('button', { class: 'icon-btn', disabled: idx === 0, onclick: () => { idx--; show(); } }, '‹'), h('span', { class: 'small' }, `${idx + 1} / ${cmp.items.length} · ${it.name} <${it.address}>`), h('button', { class: 'icon-btn', disabled: idx >= cmp.items.length - 1, onclick: () => { idx++; show(); } }, '›')), h('div', { class: 'small' }, h('b', {}, 'Subject: '), it.built.subject), it.warning ? h('div', { class: 'warn-line' }, `⚠ ${it.warning}`) : null, mailFrame({ html: it.built.html, text: it.built.text }, { allowImages: true, maxHeight: 380 })); };
      show();
      const warned = cmp.items.filter(i => i.warning);
      return h('div', {}, d.note ? h('p', {}, d.note) : null, h('div', { class: 'small' }, `${cmp.items.length} recipients: `, cmp.items.slice(0, 30).map(i => i.name).join(', '), cmp.items.length > 30 ? '…' : ''),
        warned.length ? h('div', { class: 'warn-line' }, warned.map(i => h('div', {}, `⚠ ${i.name}: ${i.warning}`))) : null,
        cmp.skipped?.length ? h('div', { class: 'muted small' }, `Skipped: ${cmp.skipped.map(s => `${s.title || s.ref} (${s.reason})`).join('; ')}`) : null, prev);
    }
    case 'bulk_update':
      return h('table', { class: 'grid-table small' }, h('tbody', {}, (d.records || []).slice(0, 100).map(r => h('tr', {}, h('td', {}, refLink(r.ref, r.title)), h('td', {}, r.changes.map(c => h('div', {}, h('b', {}, `${c.field}: `), h('span', { class: 'muted' }, fmt(c.from)), ' → ', fmt(c.to))))))));
    case 'delete':
      return h('div', { class: 'small' }, (d.records || []).map(r => h('div', {}, '🗑 ', refLink(r.ref, r.title), r.notes ? h('span', { class: 'muted' }, ` (${r.notes} notes)`) : null)), h('div', { class: 'muted' }, `They go to the Trash and can be restored for ${TRASH_DAYS} days.`));
    case 'merge':
      return h('div', { class: 'small' }, h('div', {}, 'Keep: ', refLink(d.keep.ref, d.keep.title)), (d.merge || []).map(r => h('div', {}, 'Merge in (then Trash): ', refLink(r.ref, r.title), ` (${r.notes} notes)`)));
    case 'add_field':
      return h('div', { class: 'small' }, `${d.type}: new field “${d.field.label}” of type ${d.field.type}${d.field.options?.length ? ` with options ${d.field.options.join(', ')}` : ''}`);
    case 'template':
      return h('div', { class: 'two-col small' }, h('div', {}, h('b', {}, 'Now'), h('pre', { class: 'pre-wrap' }, `${d.before.subject}\n\n${d.before.body}`)), h('div', {}, h('b', {}, 'Proposed'), h('pre', { class: 'pre-wrap' }, `${d.after.subject}\n\n${d.after.body}`)));
    default: return null;
  }
}

// ---------------------------------------------------------------- activity
export async function openActivity() {
  const body = h('div', {});
  const render = async () => {
    const { activity } = await window.crm.agent.activity({ limit: 300 });
    replace(body, activity.length ? h('table', { class: 'grid-table activity-table' },
      h('thead', {}, h('tr', {}, h('th', {}, 'When'), h('th', {}, 'Agent'), h('th', {}, 'Action'), h('th', {}, 'Result'), h('th', {}, ''))),
      h('tbody', {}, activity.map(e => h('tr', {},
        h('td', { class: 'nowrap small' }, new Date(e.at).toLocaleString()),
        h('td', { class: 'nowrap' }, `🤖 ${e.clientName}`),
        h('td', {}, h('code', { class: 'small' }, e.tool), e.summary ? h('div', { class: 'small' }, e.summary) : null),
        h('td', {}, h('span', { class: ['status-chip', `st-${e.outcome}`] }, e.outcome)),
        h('td', {}, e.changeId && ['done', 'approved'].includes(e.outcome) ? h('button', { class: 'btn btn-sm', onclick: () => undoChange(e.changeId, render) }, '↶ Undo') : null)))))
      : h('div', { class: 'empty-state' }, 'No agent activity yet.'));
  };
  openModal({ title: '📜 AI agent activity', size: 'xl', body });
  render();
}

async function undoChange(id, rerender) {
  try {
    let r = await window.crm.agent.undo({ id });
    if (r.conflict) {
      if (!(await confirmDialog(`You (or another change) edited ${r.conflict.join(', ')} after this agent change.`, { title: 'Undo anyway?', okLabel: 'Undo anyway', danger: true, detail: 'Undoing restores the records exactly as they were before the agent changed them, so your later edits to them are lost (Ctrl+Z can bring them back).' }))) return;
      r = await window.crm.agent.undo({ id, force: true });
    }
    toast('Agent change undone');
  } catch (e) { toast(e.message, { type: 'error' }); }
  rerender?.();
}

// ---------------------------------------------------------------- settings tab
export function agentsSettingsPane(pane) {
  const box = h('div', {});
  const render = async () => {
    await refreshAgentState();
    const s = agentState;
    replace(box,
      h('p', {}, 'Let AI agents such as ', h('b', {}, 'Claude Desktop, Claude Code or Hermes Agent'), ' work with your CRM through the ', h('b', {}, 'Model Context Protocol (MCP)'), '. They can search, add and update records, write notes and prepare emails. Sending, bulk changes and deletions wait for your approval. Everything is logged and can be undone.'),
      h('div', { class: 'row-gap' },
        h('button', { class: 'btn btn-primary', onclick: () => connectWizard(render) }, '+ Connect an agent'),
        h('label', { class: 'check-row' }, h('input', { type: 'checkbox', checked: s.paused, onchange: async e => { await setPaused(e.target.checked); render(); } }), ' Pause all agents'),
        h('button', { class: 'btn', onclick: openApprovals }, `✅ Approvals${s.pending ? ` (${s.pending})` : ''}`),
        h('button', { class: 'btn', onclick: openActivity }, '📜 Activity & undo')),
      h('h3', {}, 'Connected agents'),
      s.clients.length ? h('table', { class: 'grid-table' },
        h('thead', {}, h('tr', {}, h('th', {}, 'Agent'), h('th', {}, 'Profile'), h('th', {}, 'Emails'), h('th', {}, 'Status'), h('th', {}, ''))),
        h('tbody', {}, s.clients.map(c => h('tr', {},
          h('td', {}, h('b', {}, c.name), h('div', { class: 'muted tiny' }, `${c.kind} · ${c.lastSeen ? `last used ${new Date(c.lastSeen).toLocaleString()}` : 'not used yet'}`)),
          h('td', {}, h('select', { class: 'input input-sm', title: PROFILE_HELP[c.profile], onchange: async e => { await window.crm.agent.updateClient({ id: c.id, patch: { profile: e.target.value } }); render(); } }, Object.entries(PROFILE_LABEL).map(([v, l]) => h('option', { value: v, selected: c.profile === v }, l)))),
          h('td', {}, h('label', { class: 'check-row small', title: 'Allow reading email content' }, h('input', { type: 'checkbox', checked: c.readEmails !== false, onchange: e => window.crm.agent.updateClient({ id: c.id, patch: { readEmails: e.target.checked } }) }), ' read')),
          h('td', {}, c.paused ? h('span', { class: 'status-chip st-paused', title: c.pausedReason || '' }, `paused${c.pausedReason ? `: ${c.pausedReason}` : ''}`) : c.confirmed ? h('span', { class: 'status-chip st-done' }, 'active') : h('span', { class: 'status-chip' }, 'waiting for first use')),
          h('td', { class: 'nowrap' },
            h('button', { class: 'btn btn-sm', onclick: async () => { await window.crm.agent.updateClient({ id: c.id, patch: { paused: !c.paused } }); render(); } }, c.paused ? 'Resume' : 'Pause'),
            h('button', { class: 'icon-btn danger', title: 'Revoke (its token stops working immediately)', onclick: async () => {
              if (!(await confirmDialog(`Revoke “${c.name}”?`, { danger: true, okLabel: 'Revoke', detail: 'Its token stops working immediately. You can connect it again with a new token.' }))) return;
              await window.crm.agent.revoke(c.id); render();
            } }, '🗑'))))))
        : h('p', { class: 'muted' }, 'No agents yet. Click “+ Connect an agent”.'),
      h('h3', {}, 'Profiles'),
      h('ul', { class: 'small' }, Object.entries(PROFILE_LABEL).map(([k, l]) => h('li', {}, h('b', {}, `${l}: `), PROFILE_HELP[k]))),
      h('h3', {}, 'Limits'),
      h('div', { class: 'two-col' },
        field('Emails Autopilot agents may send on their own per day', h('input', { class: 'input input-sm', type: 'number', min: 0, max: 200, value: s.autoSendCap ?? 20, onchange: e => window.crm.agent.global({ autoSendCap: Math.max(0, +e.target.value || 0) }) }), '0 = Autopilot never sends without approval.'),
        field('Record changes per agent per hour before it is paused', h('input', { class: 'input input-sm', type: 'number', min: 10, max: 5000, value: s.writesPerHour ?? 200, onchange: e => window.crm.agent.global({ writesPerHour: Math.max(10, +e.target.value || 200) }) }))),
      h('h3', {}, 'What agents can see'),
      fieldAccessEditor(),
      h('h3', {}, 'Advanced'),
      h('label', { class: 'check-row' }, h('input', { type: 'checkbox', checked: !!s.http?.enabled, onchange: async e => { await window.crm.agent.global({ httpEnabled: e.target.checked }); render(); } }),
        ' Local HTTP endpoint for clients that only accept a URL ', h('code', {}, `http://127.0.0.1:${s.http?.port || 39271}/mcp`), ' (only this computer; the agent token is sent as a Bearer token)'),
      h('p', { class: 'muted small' }, 'Agents never see passwords, tokens or settings, cannot email people outside your CRM or marked “do not email”, and never delete permanently. Before the first change of each day a “pre-agent” backup is made.'));
  };
  pane.append(box);
  render();
}

function fieldAccessEditor() {
  const box = h('div', { class: 'field-access' });
  const paint = () => replace(box, store.data.meta.recordTypes.map(t => h('details', { class: 'help-details' },
    h('summary', {}, `${t.label} `, t.agentAccess === 'hidden' ? h('span', { class: 'muted' }, '(hidden from agents)') : null),
    h('label', { class: 'check-row' }, h('input', { type: 'checkbox', checked: t.agentAccess !== 'hidden', onchange: e => { mutate('Agent access', d => { getType(d, t.key).agentAccess = e.target.checked ? undefined : 'hidden'; }, { undoable: false }); paint(); } }), ` Agents can see ${t.label}`),
    t.agentAccess === 'hidden' ? null : h('table', { class: 'grid-table small' }, h('tbody', {}, t.fieldDefs.map(f => h('tr', {},
      h('td', {}, f.label), h('td', { class: 'muted' }, f.type),
      h('td', {}, h('select', { class: 'input input-sm', onchange: e => { mutate('Agent access', d => { getType(d, t.key).fieldDefs.find(x => x.key === f.key).agentAccess = e.target.value; }, { undoable: false }); } },
        [['hidden', 'Hidden'], ['read', 'Read'], ['write', 'Read & write']].map(([v, l]) => h('option', { value: v, selected: agentAccess(t, f) === v }, l)))))))))));
  paint();
  return box;
}

const KINDS = [['claude-desktop', 'Claude Desktop'], ['claude-code', 'Claude Code'], ['hermes', 'Hermes Agent'], ['other', 'Other MCP client']];

async function connectWizard(done) {
  const name = h('input', { class: 'input', value: 'Claude', placeholder: 'A name you will recognise, e.g. “Claude – outreach”' });
  const kind = h('select', { class: 'input' }, KINDS.map(([v, l]) => h('option', { value: v }, l)));
  const profile = h('select', { class: 'input' }, Object.entries(PROFILE_LABEL).map(([v, l]) => h('option', { value: v, selected: v === 'assistant' }, l)));
  const help = h('p', { class: 'muted small' }, PROFILE_HELP.assistant);
  profile.addEventListener('change', () => { help.textContent = PROFILE_HELP[profile.value]; });
  kind.addEventListener('change', () => { if (!name.value || KINDS.some(([, l]) => l === name.value || name.value === 'Claude')) name.value = KINDS.find(k => k[0] === kind.value)[1].replace(' Desktop', '').replace(' Code', ' Code'); });
  openModal({
    title: '+ Connect an AI agent', size: 'md',
    body: h('div', {}, field('Name', name), field('Client', kind), field('Profile', profile), help),
    actions: [{ label: 'Cancel' }, { label: 'Create connection', primary: true, fn: async () => {
      const r = await window.crm.agent.createClient({ name: name.value.trim() || 'AI agent', kind: kind.value, profile: profile.value });
      showSnippets(r, kind.value);
      done?.();
    } }],
  });
}

export function snippetsFor({ command, args, token, env: extra = {} }) {
  const q = s => (/\s/.test(s) ? `"${s}"` : s);
  const env = { OPENCRM_AGENT_TOKEN: token, ...extra };
  return {
    'claude-desktop': { file: 'Claude Desktop → Settings → Developer → Edit config (claude_desktop_config.json), then restart Claude Desktop', text: JSON.stringify({ mcpServers: { opencrm: { command, args, env } } }, null, 2) },
    'claude-code': { file: 'Run once in a terminal (use --scope project to limit it to one folder)', text: `claude mcp add opencrm --scope user ${Object.entries(env).map(([k, v]) => `--env ${k}=${q(v)}`).join(' ')} -- ${[command, ...args].map(q).join(' ')}` },
    hermes: { file: '~/.hermes/config.yaml (or: hermes mcp add)', text: `mcp_servers:\n  opencrm:\n    command: ${JSON.stringify(command)}\n    args: ${JSON.stringify(args)}\n    env:\n${Object.entries(env).map(([k, v]) => `      ${k}: ${JSON.stringify(v)}`).join('\n')}` },
    other: { file: 'Any MCP client (stdio): command, arguments and environment variables', text: `command: ${command}\nargs: ${JSON.stringify(args)}\nenv: ${Object.entries(env).map(([k, v]) => `${k}=${v}`).join('  ')}` },
  };
}

function showSnippets(r, kind) {
  const sn = snippetsFor(r);
  const box = h('div', {});
  const show = k => replace(box,
    h('div', { class: 'seg' }, KINDS.map(([v, l]) => h('button', { class: ['seg-btn', v === k && 'on'], onclick: () => show(v) }, l))),
    h('p', { class: 'small' }, sn[k].file),
    h('pre', { class: 'snippet' }, sn[k].text),
    h('button', { class: 'btn', onclick: async () => { await window.crm.app.clipboard(sn[k].text); toast('Copied'); } }, '📋 Copy'));
  show(kind);
  openModal({
    title: `Connect “${r.client.name}”`, size: 'lg',
    body: h('div', {},
      h('p', {}, 'Paste this into your agent’s configuration. ', h('b', {}, 'The token is shown only once'), ' — keep it private (anyone with it can use your CRM with this profile).'),
      box,
      h('p', { class: 'muted small' }, 'The first time the agent connects, OpenCRM asks you to allow it. If OpenCRM is closed, the agent starts it in the tray.')),
    actions: [{ label: 'Done', primary: true }],
  });
}

// ---------------------------------------------------------------- trash
export function openTrash() {
  const body = h('div', {});
  const paint = () => {
    const items = [...(store.data.meta.trash || [])].sort((a, b) => (a.deletedAt < b.deletedAt ? 1 : -1));
    replace(body, items.length ? h('table', { class: 'grid-table' },
      h('thead', {}, h('tr', {}, h('th', {}, 'Record'), h('th', {}, 'Type'), h('th', {}, 'Deleted'), h('th', {}, 'By'), h('th', {}, ''))),
      h('tbody', {}, items.map(e => {
        const t = getType(store.data, e.typeKey);
        return h('tr', {},
          h('td', {}, h('b', {}, t ? recordTitle(t, e.record) : `#${e.record.id}`)), h('td', { class: 'muted' }, t?.label || e.typeKey),
          h('td', { class: 'small' }, new Date(e.deletedAt).toLocaleString()), h('td', { class: 'small' }, e.by?.startsWith('agent:') ? `🤖 ${e.by.slice(6)}` : e.by === 'user' ? 'you' : e.by),
          h('td', { class: 'nowrap' },
            h('button', { class: 'btn btn-sm', onclick: () => { let res; mutate('Restore from Trash', d => { res = restoreFromTrash(d, e.id); }); paint(); if (res) toast(`Restored ${recordTitle(getType(store.data, res.typeKey), res.record)}`); } }, 'Restore'),
            h('button', { class: 'icon-btn danger', title: 'Delete forever', onclick: async () => {
              if (!(await confirmDialog('Delete this record forever?', { danger: true, okLabel: 'Delete forever', detail: 'It disappears from the Trash. Older backups still contain it.' }))) return;
              mutate('Delete forever', d => { d.meta.trash = d.meta.trash.filter(x => x.id !== e.id); }); paint();
            } }, '✕')));
      })))
      : h('div', { class: 'empty-state' }, `The Trash is empty. Deleted records stay here for ${TRASH_DAYS} days.`));
  };
  paint();
  openModal({ title: '🗑 Trash', size: 'lg', body });
}
