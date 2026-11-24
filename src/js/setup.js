// First-run setup guide, the Setup checklist, and the built-in tutorial viewer.
// - The guide opens on first launch (or after the installer's "Choose features" page) and walks through the chosen
//   features. Every step can be skipped; the last page says where each skipped feature lives.
// - The checklist (? → Setup checklist, or the 🚀 chip in the status bar) lists every feature, its state, where to
//   find it, and a "Set up now" button that opens just that step.
import { h, replace } from './dom.js';
import { store, on } from './store.js';
import { TEMPLATES } from './shared.js';
import { openModal, toast, field } from './ui.js';
import { renderMarkdown } from './markdown.js';
import { mail, refreshMail } from './mail-state.js';
import { accountForm } from './mail-settings.js';
import { trackerConfigured, openTrackingSettings } from './mail-tracking-ui.js';
import { agentState, agentsSettingsPane, refreshAgentState } from './agent-ui.js';
import { updateConfig, aiSettingsPane, startWithWindowsToggle } from './settings.js';
import { lockPrompt } from './welcome.js';
import { hooks } from './hooks.js';

const setupCfg = () => store.config?.setup || {};

// ---------------------------------------------------------------- features
export const FEATURES = [
  {
    key: 'me', icon: '👤', title: 'About me',
    blurb: 'Your name, email signature and one line about you or your business. Emails and the AI writing help use them.',
    where: 'Settings ⚙ → General → About me', tab: 'general', chapter: '26-settings-worth-knowing',
    done: () => !!store.config?.ui?.me?.name,
    render: meStep,
  },
  {
    key: 'ai', icon: '✨', title: 'Local AI',
    blurb: 'Connect a local AI server (LM Studio, Ollama, llama.cpp…) for ✨ AI search, writing help, reading replies and filling fields from documents. Your data stays on this computer.',
    where: 'Settings ⚙ → AI', tab: 'ai', chapter: '14-local-ai-setup',
    done: () => !!store.config?.ai?.model,
    render: box => {
      box.append(h('div', { class: 'setup-tip' }, 'Easiest: pick a model under ', h('b', {}, 'Built-in AI'), ' and click ', h('b', {}, 'Download & use'), '. OpenCRM downloads it and runs it for you. Already run LM Studio, Ollama or llama.cpp? Fill in “Or use your own AI server” instead.'));
      const pane = h('div', { class: 'setup-embed' });
      aiSettingsPane(pane);
      box.append(pane);
    },
  },
  {
    key: 'email', icon: '✉', title: 'Email accounts',
    blurb: 'Send and receive email with the people in your CRM: Gmail, Outlook.com, Yahoo, iCloud, Zoho, GMX or any IMAP/SMTP provider. Passwords are encrypted by Windows and stay on this computer.',
    where: 'Settings ⚙ → Email → + Add email account', tab: 'email', chapter: '18-email-connect-an-account',
    done: () => mail.accounts.length > 0,
    render: emailStep,
  },
  {
    key: 'tracking', icon: '📊', title: 'Open & click tracking',
    blurb: 'See when contacts open your emails or click links like “Tell me more”. It needs a small free tracker that you own (Cloudflare Workers or any PHP hosting). OpenCRM guides you through it.',
    where: 'Settings ⚙ → Email → 📊 Open & click tracking…', chapter: '23-email-open--click-tracking',
    done: () => trackerConfigured(),
    open: () => openTrackingSettings(),
    render: (box, rerender) => {
      const off = on('config-changed', () => { if (box.isConnected) rerender(); else off(); });
      box.append(
        h('p', {}, trackerConfigured() ? h('span', { class: 'ok' }, '✓ Tracking is set up.') : 'Not set up yet. It takes about 10 minutes the first time.'),
        h('button', { class: 'btn btn-primary', onclick: () => openTrackingSettings() }, trackerConfigured() ? '📊 Tracking settings…' : '📊 Set up tracking…'),
        h('p', { class: 'muted small' }, 'You can skip this: email works without tracking. Replies are always recognised.'));
    },
  },
  {
    key: 'agents', icon: '🤖', title: 'AI agents (MCP)',
    blurb: 'Let Claude Desktop, Claude Code, Hermes or another MCP agent find leads, update records and prepare emails for you. Anything risky waits for your approval.',
    where: 'Settings ⚙ → AI agents (MCP) → + Connect an agent', tab: 'agents', chapter: '29-working-with-ai-agents-mcp',
    done: () => agentState.clients.length > 0,
    render: box => { const pane = h('div', { class: 'setup-embed' }); agentsSettingsPane(pane); box.append(pane); },
  },
  {
    key: 'windows', icon: '🪟', title: 'Tray, startup & notifications',
    blurb: 'Start OpenCRM with Windows, keep it running in the tray, show reminder notifications, and add notes from anywhere with a keyboard shortcut.',
    where: 'Settings ⚙ → General → This computer', tab: 'general', chapter: '11-reminders-and-quick-add',
    done: () => (setupCfg().configured || []).includes('windows'),
    render: windowsStep,
  },
];
const byKey = Object.fromEntries(FEATURES.map(f => [f.key, f]));
const DEFAULT_CHOSEN = ['me', 'ai', 'email'];

/** Features the person wanted but skipped and that are still not set up (drives the 🚀 chip). */
export function setupRemaining() {
  const s = setupCfg();
  if (!s.done) return [];
  return (s.skipped || []).filter(k => byKey[k] && !byKey[k].done());
}

async function saveSetup(patch) {
  await updateConfig({ setup: patch });
}

// ---------------------------------------------------------------- steps
function meStep(box) {
  const me = store.config.ui.me || {};
  const save = (k, v) => updateConfig({ ui: { me: { ...store.config.ui.me, [k]: v } } });
  box.append(
    field('Your name', h('input', { class: 'input', value: me.name || '', placeholder: 'e.g. Alex Morgan', autofocus: true, onchange: e => save('name', e.target.value.trim()) })),
    field('Email signature', h('textarea', { class: 'input', rows: 3, value: me.signature || '', placeholder: 'Alex Morgan\nRolling Sound Consulting\n+1 555 0100', onchange: e => save('signature', e.target.value) })),
    field('About me / my business', h('textarea', { class: 'input', rows: 2, value: me.about || '', placeholder: 'One or two sentences. The AI uses this when it writes for you.', onchange: e => save('about', e.target.value) })));
}

function emailStep(box, rerender) {
  box.append(
    mail.accounts.length
      ? h('div', { class: 'acct-list' }, mail.accounts.map(a => h('div', { class: 'acct-row' }, h('span', { class: 'status-dot ok' }), h('div', { class: 'acct-main' }, h('b', {}, a.email), a.fromName ? h('span', { class: 'muted' }, ` · ${a.fromName}`) : null))))
      : h('p', { class: 'muted' }, 'No email account yet.'),
    h('button', { class: 'btn btn-primary', onclick: () => accountForm(null, async () => { await refreshMail(); rerender(); }) }, mail.accounts.length ? '+ Add another account' : '+ Add email account'),
    h('div', { class: 'setup-tip' }, 'Gmail, Yahoo, iCloud, GMX and others need an ', h('b', {}, 'app password'), ' (not your normal password). The account form tells you exactly where to create one. Outlook.com uses “Sign in with Microsoft”.'),
    h('p', { class: 'muted small' }, 'More email options (what to download, notifications, undo send, templates, brand kit) are in Settings ⚙ → Email.'));
}

function windowsStep(box) {
  const ui = store.config.ui;
  box.append(
    startWithWindowsToggle(),
    h('label', { class: 'check-row' }, h('input', { type: 'checkbox', checked: !!ui.closeToTray, onchange: e => updateConfig({ ui: { closeToTray: e.target.checked } }) }), ' Closing the window keeps OpenCRM running in the tray'),
    h('label', { class: 'check-row' }, h('input', { type: 'checkbox', checked: ui.notifications !== false, onchange: e => updateConfig({ ui: { notifications: e.target.checked } }) }), ' Windows notifications for reminders'),
    h('div', { class: 'row-gap' },
      h('label', { class: 'check-row' }, h('input', { type: 'checkbox', checked: ui.hotkeyEnabled !== false, onchange: e => updateConfig({ ui: { hotkeyEnabled: e.target.checked } }) }), ' Quick-add a note from anywhere with'),
      h('input', { class: 'input input-sm', value: ui.hotkey || 'Control+Alt+N', onchange: e => updateConfig({ ui: { hotkey: e.target.value.trim() } }) })));
}

function databaseStep(box, { onOpened, next }) {
  const done = res => { if (!res || res.canceled) return; onOpened(res); next(); };
  const open = async (opts = {}) => {
    try {
      let res = await window.crm.db.open(opts);
      if (res?.locked) { if (!(await lockPrompt(res.locked))) return; res = await window.crm.db.open({ path: res.path, force: true }); }
      done(res);
    } catch (e) { toast(e.message, { type: 'error', timeout: 8000 }); }
  };
  const create = async key => {
    try { done(await window.crm.db.create({ templateKey: key })); } catch (e) { toast(e.message, { type: 'error', timeout: 8000 }); }
  };
  box.append(
    h('p', {}, 'Your CRM is one file on your computer (a .json database) with an attachments folder next to it. Pick a starting template. Every field can be changed later.'),
    h('div', { class: 'template-grid' }, TEMPLATES.map(t => h('button', { class: 'template-card', onclick: () => create(t.key) }, h('b', {}, t.label), h('span', { class: 'muted small' }, t.description)))),
    h('div', { class: 'row-gap' }, h('button', { class: 'btn', onclick: () => open({}) }, '📂 Open an existing database…'), h('span', { class: 'muted small' }, 'OpenCRM v1 files (db.json) are upgraded automatically.')),
    h('p', { class: 'muted small' }, 'Later: the Database ▾ menu creates, opens, moves and imports databases. Tip: put the file in a synced folder (OneDrive, Dropbox) for automatic off-site copies.'));
}

// ---------------------------------------------------------------- wizard
/**
 * opts.only: [keys] → just those steps (from the checklist). opts.onOpened(res): enter a database (first run without one).
 */
export function openSetupWizard({ only = null, onOpened = null } = {}) {
  const s = setupCfg();
  const full = !only;
  let chosen = new Set(only || s.chosen || s.installer?.chosen || DEFAULT_CHOSEN);
  const skipped = new Set();
  let steps = [];
  let i = 0;
  const body = h('div', { class: 'setup' });
  const m = openModal({
    title: full ? '🚀 Set up OpenCRM' : `🚀 ${byKey[only[0]]?.title || 'Setup'}`,
    size: 'xl', className: 'setup-modal', closeOnBackdrop: false, body,
    onClose: () => { if (full && !finished) finish({ closedEarly: true }); else hooks.render?.(); },
  });
  let finished = false;

  const buildSteps = () => {
    steps = [];
    if (full) steps.push('welcome');
    if (!store.data && onOpened) steps.push('database');
    for (const f of FEATURES) if (chosen.has(f.key)) steps.push(f.key);
    if (full) steps.push('finish');
  };

  const go = d => { i = Math.max(0, Math.min(steps.length - 1, i + d)); paint(); };
  const leaveFeature = (key, how) => {
    if (how === 'skip') skipped.add(key);
    else { skipped.delete(key); if (key === 'windows') markConfigured('windows'); }
  };
  const next = async (how = 'next') => {
    const k = steps[i];
    if (byKey[k]) leaveFeature(k, how);
    if (!full && i === steps.length - 1) { await finishSingle(k, how); return; }
    go(1);
  };

  function rail() {
    return h('ol', { class: 'setup-rail' }, steps.map((k, n) => {
      const f = byKey[k];
      const label = f ? `${f.icon} ${f.title}` : { welcome: '👋 Welcome', database: '🗂 Your database', finish: '🏁 All set' }[k];
      const state = f ? (f.done() ? 'done' : skipped.has(k) ? 'skipped' : '') : n < i ? 'done' : '';
      return h('li', { class: [n === i && 'on', state] }, label, state === 'done' ? ' ✓' : state === 'skipped' ? ' ⏭' : '');
    }));
  }

  function paint() {
    const k = steps[i];
    const content = h('div', { class: 'setup-content' });
    const nav = h('div', { class: 'setup-nav' });
    const rerender = () => { if (body.isConnected && steps[i] === k) paint(); };
    if (k === 'welcome') welcomePage(content, nav);
    else if (k === 'database') {
      content.append(h('h2', {}, '🗂 Your database'));
      databaseStep(content, { onOpened: res => onOpened(res), next: () => go(1) });
      nav.append(h('span', { class: 'muted small' }, 'OpenCRM needs a database to continue.'));
    } else if (k === 'finish') finishPage(content, nav);
    else {
      const f = byKey[k];
      content.append(h('h2', {}, `${f.icon} ${f.title}`), h('p', { class: 'setup-blurb' }, f.blurb));
      const box = h('div', { class: 'setup-step-body' });
      f.render(box, rerender);
      content.append(box, h('p', { class: 'setup-later muted small' }, '⏭ Not now? Skip it. You\'ll find it later in ', h('b', {}, f.where), ', or under ? → Setup checklist. ',
        f.chapter ? h('a', { href: '#', onclick: e => { e.preventDefault(); openTutorial(f.chapter); } }, '📖 Read the tutorial') : null));
      if (i > 0 && full) nav.append(h('button', { class: 'btn', onclick: () => go(-1) }, '← Back'));
      nav.append(h('span', { class: 'spacer' }),
        h('button', { class: 'btn', onclick: () => next('skip') }, 'Skip for now'),
        h('button', { class: 'btn btn-primary', onclick: () => next('next') }, !full && i === steps.length - 1 ? 'Done' : 'Next →'));
    }
    replace(body, steps.length > 2 ? rail() : null, h('div', { class: 'setup-main' }, content, nav));
    content.querySelector('[autofocus]')?.focus();
  }

  function welcomePage(content, nav) {
    const list = h('div', { class: 'setup-choose' }, FEATURES.map(f => {
      const ready = store.data && f.key !== 'windows' && f.done();
      return h('label', { class: ['setup-feature', ready && 'ready'] },
        h('input', { type: 'checkbox', checked: chosen.has(f.key), dataset: { feature: f.key }, onchange: e => { e.target.checked ? chosen.add(f.key) : chosen.delete(f.key); } }),
        h('span', { class: 'sf-icon' }, f.icon),
        h('span', { class: 'sf-text' }, h('b', {}, f.title, ready ? h('span', { class: 'ok small' }, '  ✓ already set up') : null), h('span', { class: 'muted small' }, f.blurb)));
    }));
    content.append(
      h('h2', {}, '👋 Welcome to OpenCRM'),
      h('p', {}, 'Let\'s get you set up. Tick what you want to set up now. It takes a few minutes, and you can skip any step.'),
      s.installer?.chosen ? h('p', { class: 'muted small' }, 'Pre-selected from what you chose in the installer.') : null,
      list,
      h('div', { class: 'setup-tip' }, 'Not sure? Leave it unticked. Nothing is lost: ', h('b', {}, '? → Setup checklist'), ' lists every feature with where to find it, and every feature also has its own tab in Settings ⚙.'));
    nav.append(
      h('button', { class: 'btn', onclick: () => { chosen = new Set(); buildSteps(); i = 1; paint(); } }, 'Skip setup, I\'ll explore'),
      h('span', { class: 'spacer' }),
      h('button', { class: 'btn btn-primary', onclick: () => { buildSteps(); i = 1; paint(); } }, 'Start →'));
  }

  function finishPage(content, nav) {
    const ready = FEATURES.filter(f => f.done());
    const later = FEATURES.filter(f => !f.done());
    content.append(
      h('h2', {}, '🏁 You\'re all set'),
      ready.length ? h('div', {}, h('h3', {}, 'Ready'), h('ul', { class: 'setup-ready' }, ready.map(f => h('li', {}, `${f.icon} ${f.title} ✓`)))) : null,
      later.length ? h('div', {}, h('h3', {}, 'For later: here\'s where to find them'),
        h('table', { class: 'grid-table setup-where' }, h('tbody', {}, later.map(f => h('tr', {},
          h('td', {}, `${f.icon} ${f.title}`), h('td', {}, f.where),
          h('td', {}, h('button', { class: 'btn btn-sm', onclick: () => { m.close(); openSetupWizard({ only: [f.key] }); } }, 'Set up now'))))))) : null,
      h('h3', {}, 'Where to find everything'),
      whereTable());
    nav.append(
      h('button', { class: 'btn', onclick: () => openTutorial() }, '📖 Open the tutorial'),
      h('span', { class: 'spacer' }),
      h('button', { class: 'btn btn-primary', onclick: () => { finish(); m.close(); } }, 'Start using OpenCRM'));
  }

  async function finish({ closedEarly = false } = {}) {
    if (finished) return;
    finished = true;
    const wanted = [...chosen].filter(k => byKey[k]);
    // Features the person wanted but didn't finish (skipped, or the guide was closed before reaching them).
    const left = wanted.filter(k => !byKey[k].done());
    await saveSetup({ done: true, chosen: wanted, skipped: left, finishedAt: new Date().toISOString() });
    if (closedEarly) toast(left.length ? 'Setup closed. What\'s left is under ? → Setup checklist, with where to find each feature.' : 'Setup closed. You can run it again from ? → Setup guide.', { timeout: 8000 });
    hooks.render?.();
  }

  async function finishSingle(k, how) {
    const f = byKey[k];
    const left = new Set(setupCfg().skipped || []);
    if (how === 'next' && f.done()) left.delete(k); else if (how === 'skip') left.add(k);
    await saveSetup({ skipped: [...left] });
    finished = true;
    m.close();
    toast(f.done() ? `${f.title} is set up ✓` : `${f.title}: not set up yet. You'll find it in ${f.where}.`, { timeout: 6000 });
  }

  buildSteps();
  paint();
  return m;
}

function markConfigured(key) {
  const c = new Set(setupCfg().configured || []);
  if (!c.has(key)) { c.add(key); saveSetup({ configured: [...c] }); }
}

// ---------------------------------------------------------------- checklist & "where is it"
function whereTable() {
  const row = (what, where) => h('tr', {}, h('td', {}, what), h('td', {}, where));
  return h('table', { class: 'grid-table setup-where' }, h('tbody', {},
    row('📖 Tutorial (every feature, step by step)', '? → Tutorial'),
    row('🚀 This setup guide and checklist', '? → Setup guide / Setup checklist'),
    row('⌨ Shortcuts, search syntax, note wildcards', '? → Help, or F1'),
    row('⚙ All settings (fields, AI, email, agents…)', 'the ⚙ button at the top right'),
    row('🗂 Open, create, import, export, backups, Trash', 'Database ▾ (top left)'),
    row('✉ Email inbox, drafts and outbox', 'the ✉ Mail tab (Ctrl+4)'),
    row('🤖 AI agent approvals and activity', 'the 🤖 button (appears after you connect an agent)')));
}

export function openSetupChecklist() {
  const body = h('div', { class: 'setup-checklist' });
  const m = openModal({ title: '🚀 Setup checklist', size: 'lg', body });
  const paint = () => {
    const s = setupCfg();
    replace(body,
      h('p', { class: 'muted' }, 'Everything OpenCRM can do that needs a little setup. Each feature works on its own; set up only what you need.'),
      h('table', { class: 'grid-table setup-where' }, h('tbody', {}, FEATURES.map(f => {
        const done = f.done();
        return h('tr', { class: done ? 'done' : '', dataset: { feature: f.key } },
          h('td', {}, done ? '✅' : (s.skipped || []).includes(f.key) ? '⏭' : '○'),
          h('td', {}, h('b', {}, `${f.icon} ${f.title}`), h('div', { class: 'muted small' }, f.blurb)),
          h('td', { class: 'small' }, f.where),
          h('td', {}, h('button', { class: ['btn', 'btn-sm', !done && 'btn-primary'], onclick: () => { m.close(); openSetupWizard({ only: [f.key] }); } }, done ? 'Change' : 'Set up now')));
      }))),
      h('h3', {}, 'Where to find everything'),
      whereTable(),
      h('div', { class: 'row-gap' },
        h('button', { class: 'btn', onclick: () => { m.close(); openSetupWizard(); } }, '🚀 Run the full setup guide again'),
        h('button', { class: 'btn', onclick: () => openTutorial() }, '📖 Tutorial'),
        h('span', { class: 'spacer' }),
        h('label', { class: 'check-row' }, h('input', { type: 'checkbox', checked: !s.hideChecklist, onchange: async e => { await saveSetup({ hideChecklist: !e.target.checked }); hooks.render?.(); } }), ' Remind me in the status bar while something I chose is not set up')));
  };
  const off = on('config-changed', () => { if (body.isConnected) paint(); else off(); });
  Promise.all([refreshAgentState(), refreshMail()]).finally(() => { if (body.isConnected) paint(); });
  paint();
}

/** Status-bar chip: "🚀 Setup: 2 left" while features the person chose are still not set up. */
export function setupChip() {
  const left = setupRemaining();
  if (!left.length || setupCfg().hideChecklist) return null;
  return h('a', { href: '#', class: 'setup-chip', title: `Not set up yet: ${left.map(k => byKey[k].title).join(', ')}`, onclick: e => { e.preventDefault(); openSetupChecklist(); } }, `🚀 Setup: ${left.length} left`);
}

// ---------------------------------------------------------------- tutorial
const slug = t => t.toLowerCase().trim().replace(/[^\p{L}\p{N}\s-]/gu, '').replace(/\s/g, '-');

export async function openTutorial(anchor = '') {
  const body = h('div', { class: 'tutorial' }, h('p', { class: 'muted' }, 'Loading…'));
  openModal({ title: '📖 OpenCRM tutorial', size: 'xl', className: 'tutorial-modal', body });
  let md;
  try { md = await (await fetch('app://crm/docs/TUTORIAL.md')).text(); } catch (e) { replace(body, h('p', { class: 'err' }, `Could not load the tutorial: ${e.message}`)); return; }
  const doc = renderMarkdown(md);
  for (const img of doc.querySelectorAll('img')) {
    const src = img.getAttribute('src') || '';
    if (!/^[a-z]+:/i.test(src)) img.src = `app://crm/docs/${src.replace(/^\.?\//, '')}`;
    img.loading = 'lazy';
  }
  for (const hd of doc.querySelectorAll('h1,h2,h3')) hd.id = slug(hd.textContent);
  doc.addEventListener('click', e => {
    const a = e.target.closest('a[href^="#"]');
    if (!a) return;
    e.preventDefault();
    doc.querySelector(`[id="${CSS.escape(decodeURIComponent(a.getAttribute('href').slice(1)))}"]`)?.scrollIntoView({ block: 'start' });
  });
  replace(body, doc);
  if (anchor) setTimeout(() => doc.querySelector(`[id="${CSS.escape(anchor)}"]`)?.scrollIntoView({ block: 'start' }), 0);
}
