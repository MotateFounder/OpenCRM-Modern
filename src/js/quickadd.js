// Global quick-add window (Ctrl+Alt+N anywhere in Windows): pick a record, type a note, Ctrl+Enter.
import { h } from './dom.js';

const root = document.getElementById('qa');
let all = [];
let kinds = [];
let chosen = null;
let active = 0;

const search = h('input', { class: 'input', placeholder: 'Type a name…', autofocus: true });
const list = h('div', { class: 'qa-list' });
const kindSel = h('select', { class: 'input input-sm' });
const text = h('textarea', { class: 'input', rows: 6, placeholder: 'Note… (#red #orange #green #! #X work here too)\nCtrl+Enter to save · Esc to close' });
const target = h('div', { class: 'qa-target muted' }, 'No record chosen');
const msg = h('div', { class: 'error-text' });

function renderList() {
  const q = search.value.trim().toLowerCase();
  const items = all.filter(r => r.title.toLowerCase().includes(q)).slice(0, 8);
  active = Math.min(active, Math.max(0, items.length - 1));
  list.replaceChildren(...items.map((r, i) => h('div', { class: ['qa-item', i === active && 'on'], onclick: () => choose(r) }, r.title, h('span', { class: 'muted small' }, ` · ${r.typeLabel}`))));
  return items;
}

function choose(r) {
  chosen = r;
  target.replaceChildren('→ ', h('b', {}, r.title), h('span', { class: 'muted' }, ` (${r.typeLabel})`));
  text.focus();
}

async function save() {
  if (!chosen) { msg.textContent = 'Choose a record first.'; search.focus(); return; }
  if (!text.value.trim()) { msg.textContent = 'The note is empty.'; return; }
  try {
    await window.crm.quick.add({ type: chosen.type, id: chosen.id, content: text.value.trim(), kind: kindSel.value });
    text.value = ''; chosen = null; search.value = ''; target.textContent = 'Saved ✓'; msg.textContent = '';
  } catch (e) { msg.textContent = e.message; }
}

async function load() {
  const res = await window.crm.quick.records();
  all = res.records || [];
  kinds = res.noteKinds?.length ? res.noteKinds : [{ value: 'Note', icon: '📝' }];
  kindSel.replaceChildren(...kinds.map(k => h('option', { value: k.value }, `${k.icon} ${k.value}`)));
  msg.textContent = res.error || '';
  renderList();
  search.focus();
}

search.addEventListener('input', () => { active = 0; renderList(); });
search.addEventListener('keydown', (e) => {
  const items = renderList();
  if (e.key === 'ArrowDown') { e.preventDefault(); active = Math.min(items.length - 1, active + 1); renderList(); }
  if (e.key === 'ArrowUp') { e.preventDefault(); active = Math.max(0, active - 1); renderList(); }
  if (e.key === 'Enter' && items[active]) { e.preventDefault(); choose(items[active]); }
});
text.addEventListener('keydown', (e) => { if (e.key === 'Enter' && e.ctrlKey) { e.preventDefault(); save(); } });
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') window.crm.quick.close(); });
window.crm.quick.onShown(load);

root.append(
  h('h2', {}, 'Quick add note'),
  search, list, target,
  h('div', { class: 'row-gap' }, kindSel),
  text, msg,
  h('div', { class: 'row-gap' }, h('button', { class: 'btn btn-primary', onclick: save }, 'Save note'), h('button', { class: 'btn', onclick: () => window.crm.quick.close() }, 'Close')));
load();
