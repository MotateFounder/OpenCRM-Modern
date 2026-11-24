// Markdown rendering (CommonMark + GFM via marked, sanitised by DOMPurify) and the markdown modal.
import { marked } from '/vendor/marked.js';
import DOMPurify from '/vendor/purify.js';
import { h } from './dom.js';
import { openModal, toast, confirmDialog } from './ui.js';

marked.setOptions({ gfm: true, breaks: false });

export function renderMarkdown(md, { interactiveTasks = false } = {}) {
  const html = DOMPurify.sanitize(marked.parse(String(md || '')), { USE_PROFILES: { html: true } });
  const div = h('div', { class: 'md' });
  div.innerHTML = html; // sanitised above
  for (const a of div.querySelectorAll('a[href]')) a.classList.add('ext');
  for (const img of div.querySelectorAll('img')) img.referrerPolicy = 'no-referrer';
  const boxes = [...div.querySelectorAll('input[type=checkbox]')];
  boxes.forEach((b, i) => { b.disabled = !interactiveTasks; b.dataset.taskIndex = i; });
  return div;
}

export function markdownPreviewText(md, max = 140) {
  const t = String(md || '')
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/^#+\s*/gm, '')
    .replace(/[*_`>|]/g, '')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/\s+/g, ' ')
    .trim();
  return t.length > max ? t.slice(0, max - 1) + '…' : t;
}

// Toggles the n-th GFM task checkbox in the source.
export function toggleTask(md, index) {
  let i = -1;
  return String(md).replace(/^(\s*(?:[-*+]|\d+[.)])\s+\[)( |x|X)(\])/gm, (m, a, mark, b) => {
    i++;
    if (i !== index) return m;
    return a + (mark === ' ' ? 'x' : ' ') + b;
  });
}

const TOOLBAR = [
  { label: 'B', title: 'Bold (Ctrl+B)', wrap: ['**', '**'] },
  { label: 'I', title: 'Italic (Ctrl+I)', wrap: ['_', '_'] },
  { label: 'H2', title: 'Heading', line: '## ' },
  { label: 'H3', title: 'Sub-heading', line: '### ' },
  { label: '•', title: 'Bullet list', line: '- ' },
  { label: '1.', title: 'Numbered list', line: '1. ' },
  { label: '☐', title: 'Task list', line: '- [ ] ' },
  { label: '❝', title: 'Quote', line: '> ' },
  { label: '</>', title: 'Code', wrap: ['`', '`'] },
  { label: '🔗', title: 'Link', wrap: ['[', '](https://)'] },
  { label: '▦', title: 'Table', insert: '\n| Column | Column |\n|---|---|\n| Value | Value |\n' },
  { label: '―', title: 'Horizontal rule', insert: '\n---\n' },
];

function applyTool(ta, tool) {
  const { selectionStart: s, selectionEnd: e, value } = ta;
  let next, cs, ce;
  if (tool.wrap) {
    const sel = value.slice(s, e) || 'text';
    next = value.slice(0, s) + tool.wrap[0] + sel + tool.wrap[1] + value.slice(e);
    cs = s + tool.wrap[0].length; ce = cs + sel.length;
  } else if (tool.line) {
    const ls = value.lastIndexOf('\n', s - 1) + 1;
    const block = value.slice(ls, e);
    const prefixed = block.split('\n').map(l => tool.line + l).join('\n');
    next = value.slice(0, ls) + prefixed + value.slice(e);
    cs = ls; ce = ls + prefixed.length;
  } else {
    next = value.slice(0, s) + tool.insert + value.slice(e);
    cs = ce = s + tool.insert.length;
  }
  ta.value = next;
  ta.focus();
  ta.setSelectionRange(cs, ce);
  ta.dispatchEvent(new Event('input'));
}

// Opens a markdown document. onSave(text) is called (debounced) while editing.
export function openMarkdownModal({ title, subtitle = '', value = '', onSave, startInEdit = false }) {
  let text = String(value || '');
  let mode = startInEdit || !text.trim() ? 'edit' : 'view';
  let split = true;
  let saveT = null;

  const content = h('div', { class: 'md-modal-content' });
  const modeBtn = h('button', { class: 'btn btn-primary' });
  const splitBtn = h('button', { class: 'btn', title: 'Toggle live preview' }, 'Preview ◧');
  const copyBtn = h('button', { class: 'btn', title: 'Copy markdown', onclick: () => { window.crm.app.clipboard(text); toast('Markdown copied'); } }, 'Copy');
  const status = h('span', { class: 'muted small md-status' });

  const commit = () => { clearTimeout(saveT); onSave?.(text); status.textContent = 'Saved'; };
  const scheduleSave = () => { status.textContent = 'Editing…'; clearTimeout(saveT); saveT = setTimeout(commit, 700); };

  const render = () => {
    content.replaceChildren();
    modeBtn.textContent = mode === 'view' ? '✎ Edit' : '✓ Done';
    splitBtn.style.display = mode === 'edit' ? '' : 'none';
    if (mode === 'view') {
      const md = text.trim() ? renderMarkdown(text, { interactiveTasks: true }) : h('p', { class: 'muted' }, 'Empty. Click Edit to write markdown.');
      md.addEventListener('change', (e) => {
        if (e.target.matches('input[type=checkbox][data-task-index]')) { text = toggleTask(text, +e.target.dataset.taskIndex); commit(); }
      });
      md.addEventListener('dblclick', () => { mode = 'edit'; render(); });
      content.appendChild(h('div', { class: 'md-view' }, md));
    } else {
      const ta = h('textarea', { class: 'md-editor', spellcheck: true, value: text, placeholder: '# Title\n\nWrite **markdown** here…' });
      const preview = h('div', { class: 'md-preview' });
      const refresh = () => preview.replaceChildren(renderMarkdown(text));
      ta.addEventListener('input', () => { text = ta.value; scheduleSave(); if (split) refresh(); });
      ta.addEventListener('keydown', (e) => {
        if (e.ctrlKey && e.key.toLowerCase() === 's') { e.preventDefault(); commit(); mode = 'view'; render(); }
        else if (e.ctrlKey && e.key.toLowerCase() === 'b') { e.preventDefault(); applyTool(ta, TOOLBAR[0]); }
        else if (e.ctrlKey && e.key.toLowerCase() === 'i') { e.preventDefault(); applyTool(ta, TOOLBAR[1]); }
        else if (e.key === 'Tab') { e.preventDefault(); const s = ta.selectionStart; ta.setRangeText('  ', s, ta.selectionEnd, 'end'); ta.dispatchEvent(new Event('input')); }
      });
      const tb = h('div', { class: 'md-toolbar' }, TOOLBAR.map(t => h('button', { class: 'tool-btn', title: t.title, onclick: () => applyTool(ta, t) }, t.label)),
        h('a', { class: 'muted small md-help', href: 'https://commonmark.org/help/' }, 'Markdown help'));
      if (split) refresh();
      content.appendChild(tb);
      content.appendChild(h('div', { class: ['md-edit-area', split && 'split'] }, ta, split ? preview : null));
      setTimeout(() => ta.focus(), 0);
    }
  };
  modeBtn.onclick = () => { if (mode === 'edit') commit(); mode = mode === 'view' ? 'edit' : 'view'; render(); };
  splitBtn.onclick = () => { split = !split; render(); };

  const modal = openModal({
    title, size: 'xl', className: 'md-modal',
    headerExtra: h('div', { class: 'md-header-actions' }, subtitle ? h('span', { class: 'muted' }, subtitle) : null, status, copyBtn, splitBtn, modeBtn),
    body: content,
    onClose: () => { if (saveT) commit(); },
  });
  render();
  return modal;
}

export { confirmDialog };
