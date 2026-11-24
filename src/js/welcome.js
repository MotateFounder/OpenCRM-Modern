// First-launch screen (only shown when no database is remembered) + help panel.
import { h } from './dom.js';
import { TEMPLATES } from './shared.js';
import { openModal, toast } from './ui.js';

export async function renderWelcome(container, { onOpened, error, onSetup, onTutorial }) {
  const recent = await window.crm.db.recent().catch(() => []);
  const userTpl = await window.crm.app.userTemplates({}).catch(() => ({ templates: [] }));
  const open = async (opts) => {
    try {
      const res = await window.crm.db.open(opts);
      if (res?.canceled) return;
      if (res?.locked) {
        const ok = await lockPrompt(res.locked);
        if (ok) return open({ ...opts, path: opts?.path || res.path, force: true });
        return;
      }
      onOpened(res);
    } catch (e) { toast(e.message, { type: 'error', timeout: 8000 }); }
  };
  const create = async (templateKey, customSchema) => {
    try {
      const res = await window.crm.db.create({ templateKey, customSchema });
      if (res?.canceled) return;
      onOpened(res);
    } catch (e) { toast(e.message, { type: 'error', timeout: 8000 }); }
  };
  container.replaceChildren(h('div', { class: 'welcome' },
    h('div', { class: 'welcome-card' },
      h('div', { class: 'welcome-logo' }, h('img', { src: 'app://crm/icon.png', alt: '', width: 64, height: 64 }), h('div', {}, h('h1', {}, 'OpenCRM'), h('p', { class: 'muted' }, 'Your local-first CRM. Choose a database once — next time it opens automatically.'))),
      error ? h('div', { class: 'error-box' }, error) : null,
      h('div', { class: 'welcome-actions' },
        h('button', { class: 'btn btn-primary btn-lg', onclick: () => open({}) }, '📂 Open existing database…'),
        h('span', { class: 'muted small' }, 'Works with OpenCRM v1 files (e.g. db.json) — they are upgraded automatically and the original is kept as a copy.')),
      recent.length ? h('div', { class: 'welcome-recent' }, h('h3', {}, 'Recent'), recent.map(r => h('div', { class: ['recent-row', !r.exists && 'missing'] },
        h('a', { href: '#', onclick: e => { e.preventDefault(); if (r.exists) open({ path: r.path }); } }, r.path),
        !r.exists ? h('span', { class: 'muted small' }, ' (not found)') : null,
        h('button', { class: 'icon-btn', title: 'Forget', onclick: async () => { await window.crm.db.forget(r.path); renderWelcome(container, { onOpened, error }); } }, '×')))) : null,
      h('h3', {}, 'Or create a new database'),
      h('div', { class: 'template-grid' },
        TEMPLATES.map(t => h('button', { class: 'template-card', onclick: () => create(t.key) }, h('b', {}, t.label), h('span', { class: 'muted small' }, t.description))),
        (userTpl.templates || []).map(t => h('button', { class: 'template-card user', onclick: () => create(null, t) }, h('b', {}, `★ ${t.name || t.file}`), h('span', { class: 'muted small' }, 'Your saved template'))),
        h('button', { class: 'template-card dashed', onclick: async () => {
          try { const r = await window.crm.app.importTemplateFile(); if (r?.template) create(null, r.template); } catch (e) { toast(e.message, { type: 'error' }); }
        } }, h('b', {}, 'From template file…'), h('span', { class: 'muted small' }, 'A template exported from OpenCRM'))),
      h('p', { class: 'muted small' }, 'Templates only pre-fill fields; you can add, rename or remove any field later. Nothing here is recruitment- or sales-specific unless you want it to be.'),
      onSetup ? h('div', { class: 'row-gap welcome-help' },
        h('button', { class: 'btn', onclick: onSetup }, '🚀 Setup guide'),
        h('button', { class: 'btn', onclick: onTutorial }, '📖 Tutorial'),
        h('span', { class: 'muted small' }, 'Later, both are under the ? button.')) : null)));
}

export function lockPrompt(info) {
  return new Promise(resolve => {
    let done = false;
    openModal({
      title: 'Database may be open elsewhere', size: 'sm',
      body: h('div', {}, h('p', {}, `This database appears to be open on “${info.host}” by ${info.user || 'another user'} (last seen ${new Date(info.at).toLocaleTimeString()}).`),
        h('p', { class: 'muted' }, 'Editing it from two places at once can overwrite changes. Open anyway?')),
      actions: [{ label: 'Cancel', fn: () => { done = true; resolve(false); } }, { label: 'Open anyway', primary: true, fn: () => { done = true; resolve(true); } }],
      onClose: () => { if (!done) resolve(false); },
    });
  });
}

export function openHelp() {
  const row = (k, d) => h('tr', {}, h('td', {}, h('code', {}, k)), h('td', {}, d));
  openModal({
    title: 'Help: wildcards, search & shortcuts', size: 'lg',
    body: h('div', { class: 'help' },
      h('h3', {}, 'Note wildcards (write them anywhere in a note)'),
      h('table', { class: 'grid-table' }, h('tbody', {},
        row('#red  #orange  #green', 'Colours the record row. Classic rule: red beats orange beats green across all notes (configurable in Settings).'),
        row('#!', 'Important note: pinned on top, shown in orange.'),
        row('#X', 'Hidden note (toggle “Show hidden” in the card to see them).'))),
      h('h3', {}, 'Search'),
      h('table', { class: 'grid-table' }, h('tbody', {},
        row('alice python', 'All words must appear somewhere (any field, documents or notes).'),
        row('"machine learning"', 'Exact phrase.'),
        row('group:apple  label:c++  stage:offer', 'Search one field (by name or label).'),
        row('color:red  color:none', 'By wildcard colour.'),
        row('has:files  has:reminder  has:picture  has:resume', 'Records that have something.'),
        row('due:today  due:overdue  due:week', 'Reminders.'),
        row('-label:java', 'Exclude (minus sign).'))),
      h('h3', {}, 'Keyboard'),
      h('table', { class: 'grid-table' }, h('tbody', {},
        row('Ctrl+F  or  /', 'Search'), row('Ctrl+N', 'New record'), row('↑ ↓', 'Move between records'), row('Enter', 'Open the selected record'),
        row('N', 'New note (card open)'), row('Esc', 'Close card / dialog'), row('Ctrl+Z / Ctrl+Y', 'Undo / redo (last 100 changes)'),
        row('Ctrl+1 / 2 / 3', 'Table / Board / Dashboard'), row('Ctrl+Alt+N (anywhere in Windows)', 'Quick-add a note (configurable)'), row('F1', 'This help'))),
      h('h3', {}, 'Mouse'),
      h('ul', {}, h('li', {}, 'Click a row to open its card; Ctrl+Click to select; right-click for actions.'),
        h('li', {}, 'Click column headers to sort (Shift+Click adds a secondary sort); drag headers to reorder; drag the edge to resize; right-click a header to choose columns.'),
        h('li', {}, 'Click an email to copy it (Ctrl+Click opens your mail app). Click a phone number to copy it.'),
        h('li', {}, 'Drop files on a card to attach them.'))),
    actions: [{ label: 'Close', primary: true }],
  });
}
