// Prompt manager: categories (one per prompt), tags (many), favourites, search, editor, import/export.
import { h } from './dom.js';
import { store, mutate } from './store.js';
import { newId, normalizeTags, starterPrompts } from './shared.js';
import { openModal, confirmDialog, toast, field } from './ui.js';
import { hooks } from './hooks.js';

const CONTEXT_OPTIONS = [
  ['fields:all', 'All fields'], ['docs:all', 'All markdown documents'],
  ['notes:all', 'All notes'], ['notes:last3', 'Last 3 notes'], ['notes:last5', 'Last 5 notes'], ['notes:important', 'Important notes (#!)'],
];

export function openPromptManager({ selectId = null } = {}) {
  let cat = '__all';
  let tagFilter = null;
  let q = '';
  let selected = selectId;
  const left = h('div', { class: 'pm-left' });
  const mid = h('div', { class: 'pm-mid' });
  const right = h('div', { class: 'pm-right' });
  const prompts = () => store.data.meta.prompts;

  const renderLeft = () => {
    const counts = new Map();
    for (const p of prompts()) counts.set(p.category || 'Uncategorised', (counts.get(p.category || 'Uncategorised') || 0) + 1);
    const tags = new Map();
    for (const p of prompts()) for (const t of p.tags || []) tags.set(t, (tags.get(t) || 0) + 1);
    const item = (key, label, n) => h('div', { class: ['pm-cat', cat === key && 'on'], onclick: () => { cat = key; renderAll(); } }, h('span', {}, label), h('span', { class: 'muted small' }, String(n)));
    left.replaceChildren(
      h('div', { class: 'menu-header' }, 'Categories'),
      item('__all', 'All prompts', prompts().length),
      item('__fav', '★ Favourites', prompts().filter(p => p.favorite).length),
      ...[...counts].sort((a, b) => a[0].localeCompare(b[0])).map(([c, n]) => item(c, c, n)),
      h('div', { class: 'menu-header' }, 'Tags'),
      h('div', { class: 'chips pm-tags' }, [...tags].sort((a, b) => b[1] - a[1]).map(([t, n]) => h('button', { class: ['chip', 'chip-btn-sm', tagFilter === t && 'on'], onclick: () => { tagFilter = tagFilter === t ? null : t; renderAll(); } }, `${t} ${n}`))),
    );
  };

  const filtered = () => prompts().filter(p => {
    if (cat === '__fav' && !p.favorite) return false;
    if (cat !== '__all' && cat !== '__fav' && (p.category || 'Uncategorised') !== cat) return false;
    if (tagFilter && !(p.tags || []).includes(tagFilter)) return false;
    if (q && !`${p.title} ${p.template} ${(p.tags || []).join(' ')} ${p.category}`.toLowerCase().includes(q)) return false;
    return true;
  }).sort((a, b) => (b.favorite - a.favorite) || a.title.localeCompare(b.title));

  const search = h('input', { class: 'input', placeholder: 'Search prompts…', oninput: e => { q = e.target.value.toLowerCase(); renderMid(); } });
  const renderMid = () => {
    const list = filtered();
    mid.replaceChildren(
      h('div', { class: 'row-gap' }, search, h('button', { class: 'btn btn-primary btn-sm', onclick: () => {
        const p = { id: newId('p'), title: 'New prompt', category: cat.startsWith('__') ? 'General' : cat, tags: [], system: '', template: 'Write … for {{title}}.\n\nContext:\n{{context}}', context: ['fields:all', 'notes:last5'], favorite: false, uses: 0, createdAt: new Date().toISOString(), lastUsedAt: null };
        mutate('New prompt', d => d.meta.prompts.push(p));
        selected = p.id; renderAll();
      } }, '+ New')),
      h('div', { class: 'pm-list' }, list.length ? list.map(p => h('div', { class: ['pm-item', p.id === selected && 'on'], onclick: () => { selected = p.id; renderAll(); } },
        h('div', { class: 'pm-item-title' }, p.favorite ? '★ ' : '', p.title),
        h('div', { class: 'muted tiny' }, p.category || 'Uncategorised', p.uses ? ` · used ${p.uses}×` : ''),
        (p.tags || []).length ? h('div', { class: 'chips' }, p.tags.map(t => h('span', { class: 'chip chip-sm' }, t))) : null))
        : h('p', { class: 'muted pad' }, 'No prompts here.')));
  };

  const renderRight = () => {
    const p = prompts().find(x => x.id === selected);
    if (!p) { right.replaceChildren(h('div', { class: 'empty-state' }, 'Select a prompt to edit it.')); return; }
    const upd = (label, fn) => mutate(label, d => fn(d.meta.prompts.find(x => x.id === p.id)), { coalesce: `prompt:${p.id}` });
    const cats = [...new Set(prompts().map(x => x.category).filter(Boolean))];
    const title = h('input', { class: 'input', value: p.title, onchange: e => { upd('Edit prompt', x => { x.title = e.target.value.trim() || 'Untitled'; }); renderLeft(); renderMid(); } });
    const category = h('input', { class: 'input', value: p.category || '', list: 'pm-cats', onchange: e => { upd('Edit prompt', x => { x.category = e.target.value.trim(); }); renderLeft(); renderMid(); } });
    const tags = h('input', { class: 'input', value: (p.tags || []).join(', '), placeholder: 'comma, separated', onchange: e => { upd('Edit prompt', x => { x.tags = normalizeTags(e.target.value); }); renderLeft(); renderMid(); } });
    const system = h('textarea', { class: 'input mono', rows: 3, value: p.system || '', onchange: e => upd('Edit prompt', x => { x.system = e.target.value; }) });
    const template = h('textarea', { class: 'input mono', rows: 12, value: p.template || '', onchange: e => upd('Edit prompt', x => { x.template = e.target.value; }) });
    const ctx = h('div', { class: 'ctx-defaults' }, CONTEXT_OPTIONS.map(([v, l]) => h('label', { class: 'check-row' },
      h('input', { type: 'checkbox', checked: (p.context || []).includes(v), onchange: e => upd('Edit prompt', x => { x.context = (x.context || []).filter(c => c !== v); if (e.target.checked) x.context.push(v); }) }), ` ${l}`)));
    right.replaceChildren(
      h('datalist', { id: 'pm-cats' }, cats.map(c => h('option', { value: c }))),
      field('Title', title),
      h('div', { class: 'two-col' }, field('Category', category), field('Tags', tags)),
      field('System instructions (optional)', system),
      field('Prompt template', template, 'Variables: {{title}} {{context}} {{today}} {{me.name}} {{me.signature}} {{field:Label}} {{notes:last3}}. Unknown {{words}} (e.g. {{goal}}) become input boxes when you use the prompt.'),
      field('Default context', ctx),
      h('div', { class: 'row-gap' },
        h('button', { class: 'btn btn-sm', onclick: () => { upd('Favourite', x => { x.favorite = !x.favorite; }); renderAll(); } }, p.favorite ? '★ Unfavourite' : '☆ Favourite'),
        h('button', { class: 'btn btn-sm', onclick: () => { const c = { ...structuredClone(p), id: newId('p'), title: `${p.title} (copy)`, uses: 0 }; mutate('Duplicate prompt', d => d.meta.prompts.push(c)); selected = c.id; renderAll(); } }, '⧉ Duplicate'),
        h('button', { class: 'btn btn-sm btn-danger-soft', onclick: async () => {
          if (!(await confirmDialog(`Delete prompt “${p.title}”?`, { danger: true, okLabel: 'Delete' }))) return;
          mutate('Delete prompt', d => { d.meta.prompts = d.meta.prompts.filter(x => x.id !== p.id); });
          selected = null; renderAll();
        } }, '🗑 Delete'),
        h('span', { class: 'spacer' }),
        store.ui.activeId != null ? h('button', { class: 'btn btn-primary btn-sm', onclick: () => { modal.close(); hooks.openAIWithPrompt?.(p.id); } }, 'Use now ▶') : null));
  };

  const renderAll = () => { renderLeft(); renderMid(); renderRight(); };
  renderAll();

  const modal = openModal({
    title: 'Prompt manager', size: 'xxl', className: 'pm-modal',
    headerExtra: h('div', { class: 'row-gap' },
      h('button', { class: 'btn btn-sm', onclick: async () => {
        const res = await window.crm.db.exportFile({ defaultName: 'prompts.json', kind: 'json', content: JSON.stringify({ openCrmPrompts: 1, prompts: prompts() }, null, 2) });
        if (res?.path) toast('Prompts exported');
      } }, 'Export'),
      h('button', { class: 'btn btn-sm', onclick: () => importPromptsFile(renderAll) }, 'Import'),
      h('button', { class: 'btn btn-sm', title: 'Add the built-in starter prompts again', onclick: () => {
        const existing = new Set(prompts().map(p => p.title));
        const add = starterPrompts().filter(p => !existing.has(p.title));
        if (!add.length) return toast('All starter prompts are already present');
        mutate('Add starter prompts', d => d.meta.prompts.push(...add));
        renderAll(); toast(`Added ${add.length} starter prompt(s)`);
      } }, '+ Starters')),
    body: h('div', { class: 'pm-grid' }, left, mid, right),
  });
}

async function importPromptsFile(done) {
  const input = h('input', { type: 'file', accept: '.json', style: { display: 'none' } });
  document.body.appendChild(input);
  input.addEventListener('change', async () => {
    const file = input.files[0];
    input.remove();
    if (!file) return;
    try {
      const j = JSON.parse(await file.text());
      const list = Array.isArray(j) ? j : (j.prompts || j.meta?.prompts || []);
      const existing = new Set(store.data.meta.prompts.map(p => p.title + '|' + p.template));
      const add = list.filter(p => p && p.template && !existing.has(p.title + '|' + p.template)).map(p => ({ favorite: false, uses: 0, tags: [], context: ['fields:all', 'notes:last5'], ...p, id: newId('p') }));
      mutate('Import prompts', d => d.meta.prompts.push(...add));
      toast(`Imported ${add.length} prompt(s)`);
      done?.();
    } catch (e) { toast(`Could not import: ${e.message}`, { type: 'error' }); }
  });
  input.click();
}
