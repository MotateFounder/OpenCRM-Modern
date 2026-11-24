// Settings: General, Fields, Record types, AI, Database & backups, Templates, About.
import { h } from './dom.js';
import { store, mutate, currentType, emit, settings, replaceData, flush } from './store.js';
import { DATE_FORMATS, formatDate, getType } from './shared.js';
import { openModal, toast, field, confirmDialog, promptDialog } from './ui.js';
import { fieldManager, recordTypesManager } from './fields-ui.js';
import { hooks } from './hooks.js';
import { mailSettingsPane } from './mail-settings.js';
import { agentsSettingsPane } from './agent-ui.js';
import { builtinAiPanel } from './ai-runtime-ui.js';

const AI_PRESETS = [
  ['LM Studio', 'http://localhost:1234/v1'],
  ['Ollama', 'http://localhost:11434/v1'],
  ['llama.cpp server', 'http://localhost:8080/v1'],
  ['Jan', 'http://localhost:1337/v1'],
  ['vLLM', 'http://localhost:8000/v1'],
  ['LocalAI', 'http://localhost:8080/v1'],
  ['OpenAI (cloud)', 'https://api.openai.com/v1'],
];

export async function updateConfig(patch) {
  const res = await window.crm.config.update(patch);
  store.config = res.config;
  if (res.hotkey && !res.hotkey.ok) toast(res.hotkey.error || 'Could not register the shortcut', { type: 'error' });
  emit('config-changed');
  return res;
}

export function openSettings(tab = 'general') {
  const tabs = [
    ['general', 'General'], ['fields', 'Fields'], ['types', 'Record types'], ['ai', 'AI'], ['email', 'Email'], ['agents', 'AI agents (MCP)'],
    ['database', 'Database & backups'], ['templates', 'Templates'], ['about', 'About'],
  ];
  const nav = h('div', { class: 'settings-nav' });
  const pane = h('div', { class: 'settings-pane' });
  const show = (key) => {
    tab = key;
    nav.replaceChildren(...tabs.map(([k, l]) => h('button', { class: ['snav', k === tab && 'on'], onclick: () => show(k) }, l)));
    pane.replaceChildren();
    ({ general, fields, types, ai, email: mailSettingsPane, agents: agentsSettingsPane, database, templates, about })[key](pane);
  };
  openModal({ title: 'Settings', size: 'xxl', className: 'settings-modal', body: h('div', { class: 'settings-grid' }, nav, pane), onClose: () => emit('change') });
  show(tab);
}

// ---------- General ----------
function general(pane) {
  const s = settings();
  const ui = store.config.ui;
  const setS = (label, fn) => mutate(label, d => fn(d.meta.settings), { coalesce: `settings:${label}` });
  const kindsBox = h('div', {});
  const renderKinds = () => {
    const kinds = settings().noteKinds || [];
    kindsBox.replaceChildren(...kinds.map((k, i) => h('div', { class: 'row-gap' },
      h('input', { class: 'input input-sm icon-input', value: k.icon, onchange: e => setS('Note kinds', st => { st.noteKinds[i].icon = e.target.value; }) }),
      h('input', { class: 'input input-sm', value: k.value, disabled: k.value === 'Note', onchange: e => setS('Note kinds', st => { st.noteKinds[i].value = e.target.value.trim() || k.value; }) }),
      k.value !== 'Note' ? h('button', { class: 'icon-btn', onclick: () => { setS('Note kinds', st => st.noteKinds.splice(i, 1)); renderKinds(); } }, '×') : null)),
    h('button', { class: 'btn-link small', onclick: () => { setS('Note kinds', st => st.noteKinds.push({ value: 'New kind', icon: '•' })); renderKinds(); } }, '+ Add kind'));
  };
  renderKinds();
  pane.append(
    h('h3', {}, 'This database'),
    field('Date format', h('select', { class: 'input', onchange: e => setS('Date format', st => { st.dateFormat = e.target.value; }) },
      DATE_FORMATS.map(f => h('option', { value: f, selected: f === s.dateFormat }, `${f}  —  ${formatDate(new Date(), f)}`)))),
    field('Row colour rule', h('select', { class: 'input', onchange: e => setS('Colour rule', st => { st.colorRule = e.target.value; }) },
      h('option', { value: 'severity', selected: s.colorRule !== 'latest' }, 'Severity: red > orange > green across all notes (classic)'),
      h('option', { value: 'latest', selected: s.colorRule === 'latest' }, 'Latest: the most recent colour tag wins')),
    'Colours come from #red / #orange / #green written in notes. “Set colour” in menus replaces older tags.'),
    field('Mark records as stale after (days without a note)', h('input', { class: 'input input-sm', type: 'number', min: 0, value: s.staleDays || 0, onchange: e => setS('Stale days', st => { st.staleDays = Math.max(0, +e.target.value || 0); }) }), '0 = off. Stale dates are faded with ⏱ in the Date column.'),
    h('label', { class: 'check-row' }, h('input', { type: 'checkbox', checked: !!s.notesMarkdown, onchange: e => setS('Notes markdown', st => { st.notesMarkdown = e.target.checked; }) }), ' Render notes as markdown'),
    field('Note kinds', kindsBox),
    h('h3', {}, 'This computer'),
    field('Theme', h('select', { class: 'input', onchange: e => updateConfig({ ui: { theme: e.target.value } }) },
      [['system', 'Follow Windows'], ['light', 'Light'], ['dark', 'Dark']].map(([v, l]) => h('option', { value: v, selected: ui.theme === v }, l)))),
    field('Table density', h('select', { class: 'input', onchange: e => updateConfig({ ui: { density: e.target.value } }) },
      [['compact', 'Compact'], ['comfortable', 'Comfortable']].map(([v, l]) => h('option', { value: v, selected: ui.density === v }, l)))),
    startWithWindowsToggle(),
    h('label', { class: 'check-row' }, h('input', { type: 'checkbox', checked: !!ui.closeToTray, onchange: e => updateConfig({ ui: { closeToTray: e.target.checked } }) }), ' Closing the window keeps OpenCRM running in the system tray (reminders keep working)'),
    h('label', { class: 'check-row' }, h('input', { type: 'checkbox', checked: ui.notifications !== false, onchange: e => updateConfig({ ui: { notifications: e.target.checked } }) }), ' Windows notifications for reminders'),
    h('div', { class: 'row-gap' },
      h('label', { class: 'check-row' }, h('input', { type: 'checkbox', checked: ui.hotkeyEnabled !== false, onchange: e => updateConfig({ ui: { hotkeyEnabled: e.target.checked } }) }), ' Global quick-add shortcut'),
      h('input', { class: 'input input-sm', value: ui.hotkey || 'Control+Alt+N', title: 'Electron accelerator, e.g. Control+Alt+N', onchange: e => updateConfig({ ui: { hotkey: e.target.value.trim() } }) })),
    h('h3', {}, 'About me (used by AI prompts: {{me.name}}, {{me.signature}}, {{me.about}})'),
    field('Name', h('input', { class: 'input', value: ui.me?.name || '', onchange: e => updateConfig({ ui: { me: { ...store.config.ui.me, name: e.target.value } } }) })),
    field('Signature', h('textarea', { class: 'input', rows: 3, value: ui.me?.signature || '', onchange: e => updateConfig({ ui: { me: { ...store.config.ui.me, signature: e.target.value } } }) })),
    field('About me / my business', h('textarea', { class: 'input', rows: 3, value: ui.me?.about || '', onchange: e => updateConfig({ ui: { me: { ...store.config.ui.me, about: e.target.value } } }) })),
  );
}

// ---------- Fields ----------
function fields(pane) {
  let typeKey = currentType().key;
  const holder = h('div', {});
  const sel = h('select', { class: 'input input-sm', onchange: e => { typeKey = e.target.value; fieldManager(holder, typeKey); } },
    store.data.meta.recordTypes.map(t => h('option', { value: t.key, selected: t.key === typeKey }, t.label)));
  pane.append(h('div', { class: 'row-gap' }, h('b', {}, 'Record type: '), sel), holder);
  fieldManager(holder, typeKey);
}

function types(pane) {
  const holder = h('div', {});
  pane.append(holder);
  recordTypesManager(holder, () => emit('types-changed'));
}

// ---------- AI ----------
export function startWithWindowsToggle() {
  const can = store.config.canStartWithWindows;
  return h('label', { class: 'check-row', title: can ? '' : 'Available in the installed app (OpenCRM-Setup). The portable version can be added to Windows startup by hand.' },
    h('input', { type: 'checkbox', checked: !!store.config.ui.startWithWindows, disabled: !can, onchange: async e => {
      const r = await updateConfig({ ui: { startWithWindows: e.target.checked } });
      if (r.login && !r.login.ok) toast(r.login.error || 'Could not change the Windows startup entry', { type: 'error' });
    } }), ' Start OpenCRM with Windows, in the tray (reminders and new-mail alerts keep working)', can ? null : h('span', { class: 'muted small' }, ' (installed app only)'));
}

export { ai as aiSettingsPane };
function ai(pane) {
  const c = store.config.ai;
  const baseUrl = h('input', { class: 'input', value: c.baseUrl || '', placeholder: 'http://localhost:1234/v1' });
  const preset = h('select', { class: 'input input-sm', onchange: e => { if (e.target.value) { baseUrl.value = e.target.value; save(); } } },
    h('option', { value: '' }, 'Presets…'), AI_PRESETS.map(([l, u]) => h('option', { value: u }, `${l} — ${u}`)));
  const key = h('input', { class: 'input', type: 'password', placeholder: c.hasApiKey ? '•••••••• (stored encrypted — type to replace)' : 'Optional — local servers usually need none' });
  const model = h('input', { class: 'input', value: c.model || '', list: 'ai-models', placeholder: 'e.g. qwen2.5-7b-instruct, llama3.1:8b' });
  const models = h('datalist', { id: 'ai-models' });
  const temp = h('input', { class: 'input input-sm', type: 'number', step: '0.1', min: 0, max: 2, value: c.temperature ?? 0.7 });
  const maxTok = h('input', { class: 'input input-sm', type: 'number', min: 0, value: c.maxTokens ?? 1024 });
  const timeout = h('input', { class: 'input input-sm', type: 'number', min: 5, value: Math.round((c.timeoutMs ?? 120000) / 1000) });
  const stream = h('input', { type: 'checkbox', checked: c.stream !== false });
  const noThink = h('input', { type: 'checkbox', checked: c.disableThinking !== false });
  const embedUrl = h('input', { class: 'input', value: c.embedUrl || '', placeholder: 'blank = same server as above (e.g. http://127.0.0.1:8081/v1)' });
  const embedModel = h('input', { class: 'input', value: c.embedModel || '', placeholder: 'optional, e.g. embeddinggemma-300m, nomic-embed-text' });
  const semMode = h('select', { class: 'input' },
    [['auto', 'Automatic (recommended): embeddings shortlist + chat model checks and explains; without embeddings the chat model reads all records'], ['embeddings', 'Embeddings only (fastest, no explanations)'], ['llm', 'Chat model reads all records (no extra model needed; slower on large databases)']]
      .map(([v, l]) => h('option', { value: v, selected: (c.semanticMode || 'auto') === v }, l)));
  const result = h('div', { class: 'test-result' });
  const save = () => updateConfig({ ai: { baseUrl: baseUrl.value.trim(), model: model.value.trim(), temperature: +temp.value, maxTokens: +maxTok.value || 0, timeoutMs: (+timeout.value || 120) * 1000, stream: stream.checked, disableThinking: noThink.checked, embedUrl: embedUrl.value.trim(), embedModel: embedModel.value.trim(), semanticMode: semMode.value } });
  [baseUrl, model, temp, maxTok, timeout, stream, noThink, embedUrl, embedModel, semMode].forEach(el => el.addEventListener('change', save));
  key.addEventListener('change', async () => { await window.crm.ai.setKey(key.value.trim()); key.value = ''; store.config.ai.hasApiKey = true; toast('API key saved (encrypted with Windows DPAPI)'); });
  const fetchModels = async () => {
    await save();
    result.textContent = 'Fetching models…';
    try {
      const r = await window.crm.ai.models();
      models.replaceChildren(...r.models.map(m => h('option', { value: m })));
      result.replaceChildren(h('span', { class: 'ok' }, `✓ ${r.models.length} model(s): `), r.models.slice(0, 12).map(m => h('button', { class: 'chip chip-btn-sm', onclick: () => { model.value = m; save(); } }, m)));
      if (!model.value && r.models[0]) { model.value = r.models[0]; save(); }
    } catch (e) { result.replaceChildren(h('span', { class: 'err' }, `✗ ${e.message}`)); }
  };
  const test = async () => {
    await save();
    result.textContent = 'Testing… (first request can be slow while the model loads)';
    try {
      const r = await window.crm.ai.test();
      result.replaceChildren(h('span', { class: 'ok' }, `✓ Connected. Model replied “${r.reply}” in ${(r.ms / 1000).toFixed(1)} s. `),
        h('span', { class: 'muted' }, r.semanticMode === 'embeddings' ? 'AI search will use embeddings.' : 'AI search will use the chat model (no embeddings endpoint found).'));
    } catch (e) { result.replaceChildren(h('span', { class: 'err' }, `✗ ${e.message}`)); }
  };
  pane.append(
    builtinAiPanel({ onChange: () => { pane.replaceChildren(); ai(pane); } }),
    h('h3', {}, 'Or use your own AI server'),
    h('p', { class: 'muted' }, 'OpenCRM talks to any OpenAI-compatible server. Requests are sent from the app itself, so no CORS setup is needed. Nothing is sent anywhere else.'),
    field('Server base URL', h('div', { class: 'row-gap' }, baseUrl, preset)),
    field('API key', key),
    field('Model', h('div', { class: 'row-gap' }, model, models, h('button', { class: 'btn btn-sm', onclick: fetchModels }, 'Fetch models'))),
    h('div', { class: 'three-col' }, field('Temperature', temp), field('Max tokens (0 = server default)', maxTok), field('Timeout (seconds)', timeout)),
    h('label', { class: 'check-row' }, stream, ' Stream responses as they are generated'),
    h('label', { class: 'check-row' }, noThink, ' Disable thinking (recommended for Gemma 4, Qwen3, DeepSeek-R1: much faster, avoids empty answers)'),
    h('h3', {}, 'AI search (search by meaning)'),
    field('Mode', semMode),
    h('div', { class: 'two-col' }, field('Embeddings server URL', embedUrl), field('Embeddings model', embedModel)),
    h('p', { class: 'muted small' }, 'Embeddings are cached in a “.index.json” file next to your database (never inside it). llama.cpp needs a separate server started with --embeddings and a dedicated embedding model.'),
    h('div', { class: 'row-gap' }, h('button', { class: 'btn btn-primary', onclick: test }, 'Test connection'), h('button', { class: 'btn', onclick: () => hooks.openPrompts?.() }, 'Open prompt manager')),
    result,
    h('details', { class: 'help-details' }, h('summary', {}, 'Setup tips'),
      h('ul', {},
        h('li', {}, 'LM Studio: Developer tab → load a model → Start server (default port 1234).'),
        h('li', {}, 'Ollama: install, run “ollama pull llama3.1”, the server runs automatically on port 11434.'),
        h('li', {}, 'Small machines: 3–8B instruct models work well for messages and summaries; use 14B+ for “Fill from document”.'))),
  );
}

// ---------- Database & backups ----------
function database(pane) {
  const list = h('div', { class: 'backup-list' }, h('p', { class: 'muted' }, 'Loading backups…'));
  pane.append(
    field('Current database', h('div', { class: 'row-gap' }, h('code', { class: 'path' }, store.path || '—'),
      h('button', { class: 'btn btn-sm', onclick: () => window.crm.db.reveal() }, 'Show in Explorer'))),
    h('p', { class: 'muted small' }, 'Every change is saved automatically about one second after you stop editing (atomic write: a crash can never corrupt the file). Attachments live in the “.files” folder next to it.'),
    h('div', { class: 'row-gap' },
      h('button', { class: 'btn', onclick: () => hooks.moveDatabase?.() }, 'Move / save database as…'),
      h('button', { class: 'btn', onclick: () => hooks.openDatabase?.() }, 'Open another database…'),
      h('button', { class: 'btn', onclick: () => hooks.newDatabase?.() }, 'New database…'),
      h('button', { class: 'btn btn-danger-soft', onclick: () => hooks.closeDatabase?.() }, 'Close database')),
    h('h3', {}, 'Backups'),
    h('p', { class: 'muted small' }, 'Kept automatically in the “backups” folder next to the database: one per hour while you work (last 48) and one per day (last 30).'),
    list);
  window.crm.db.backups().then(items => {
    if (!items.length) { list.replaceChildren(h('p', { class: 'muted' }, 'No backups yet.')); return; }
    list.replaceChildren(h('table', { class: 'grid-table' },
      h('thead', {}, h('tr', {}, h('th', {}, 'When'), h('th', {}, 'Kind'), h('th', {}, 'Records'), h('th', {}, ''))),
      h('tbody', {}, items.map(b => h('tr', {},
        h('td', {}, new Date(b.mtime).toLocaleString()),
        h('td', { class: 'muted' }, b.kind),
        h('td', { class: 'muted small' }, b.counts ? Object.entries(b.counts).map(([k, n]) => `${n} ${getType(store.data, k)?.label || k}`).join(', ') : 'unreadable'),
        h('td', {}, h('button', { class: 'btn btn-sm', onclick: async () => {
          if (!(await confirmDialog(`Restore the backup from ${new Date(b.mtime).toLocaleString()}?`, { detail: 'Your current data is saved as a “pre-restore” backup first, and Ctrl+Z can undo the restore.', okLabel: 'Restore' }))) return;
          const r = await window.crm.db.readBackup(b.file);
          replaceData(r.data, { keepUndo: true });
          store.save.dirty = true; await flush();
          toast('Backup restored');
        } }, 'Restore')))))));
  }).catch(e => list.replaceChildren(h('p', { class: 'err' }, e.message)));
}

// ---------- Templates ----------
function templates(pane) {
  const list = h('div', {});
  const refresh = async () => {
    const r = await window.crm.app.userTemplates({});
    list.replaceChildren(r.templates.length ? h('table', { class: 'grid-table' }, h('tbody', {}, r.templates.map(t => h('tr', {},
      h('td', {}, h('b', {}, t.name || t.file)), h('td', { class: 'muted small' }, (t.recordTypes || []).map(x => x.label).join(', ')),
      h('td', {}, h('button', { class: 'icon-btn danger', onclick: async () => { await window.crm.app.userTemplates({ action: 'delete', name: t.file }); refresh(); } }, '🗑'))))))
      : h('p', { class: 'muted' }, 'No saved templates yet.'));
  };
  const schema = () => ({
    name: '', createdAt: new Date().toISOString(),
    recordTypes: store.data.meta.recordTypes, settings: store.data.meta.settings, prompts: store.data.meta.prompts,
  });
  pane.append(
    h('p', {}, 'A template is your field setup (record types, fields, dropdown options, columns), settings and prompts — without any records. Use it when creating a new database.'),
    h('div', { class: 'row-gap' },
      h('button', { class: 'btn btn-primary', onclick: async () => {
        const name = await promptDialog('Template name', { placeholder: 'e.g. My consulting CRM' });
        if (!name?.trim()) return;
        await window.crm.app.userTemplates({ action: 'save', name: name.trim(), template: { ...schema(), name: name.trim() } });
        toast('Template saved'); refresh();
      } }, 'Save current setup as template'),
      h('button', { class: 'btn', onclick: async () => {
        const r = await window.crm.db.exportFile({ defaultName: 'opencrm-template.json', kind: 'json', content: JSON.stringify({ ...schema(), name: 'Exported template' }, null, 2) });
        if (r?.path) toast('Template exported');
      } }, 'Export to file…')),
    h('h3', {}, 'Saved templates'), list);
  refresh();
}

function about(pane) {
  pane.append(
    h('h2', {}, 'OpenCRM ', h('span', { class: 'muted' }, store.version)),
    h('p', {}, 'Local-first, schema-driven CRM. Your data is a plain JSON file you own.'),
    h('ul', {},
      h('li', {}, 'Database: ', h('code', {}, store.path || '—')),
      h('li', {}, 'Attachments: ', h('code', {}, store.filesDir || '—')),
      h('li', {}, 'Backups: the “backups” folder next to the database'),
      h('li', {}, 'App settings: %APPDATA%\\OpenCRM\\config.json')),
    h('div', { class: 'row-gap' },
      h('button', { class: 'btn', onclick: () => hooks.openTutorial?.() }, '📖 Tutorial'),
      h('button', { class: 'btn', onclick: () => hooks.openSetupChecklist?.() }, '🚀 Setup checklist'),
      h('button', { class: 'btn', onclick: () => hooks.openHelp?.() }, 'Keyboard shortcuts & wildcards')),
    h('p', { class: 'muted small' }, 'Licensed under GPL-3.0. Markdown by marked, sanitising by DOMPurify, PDF text by pdf.js.'));
}
