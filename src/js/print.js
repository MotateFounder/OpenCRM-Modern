// Print / PDF of a record card including rendered markdown documents and visible notes.
import { h } from './dom.js';
import { settings } from './store.js';
import { recordTitle, notesForDisplay, formatDate, isImportant, isEmptyValue } from './shared.js';
import { displayValue } from './editors.js';
import { renderMarkdown } from './markdown.js';
import { avatar } from './avatar.js';
import { toast } from './ui.js';

export async function printRecord(type, rec, mode = 'print') {
  const df = settings().dateFormat;
  const fields = type.fieldDefs.filter(d => d.showInCard !== false && d.key !== type.titleField && !['markdown', 'image', 'file'].includes(d.type) && !isEmptyValue(rec[d.key]));
  const docs = type.fieldDefs.filter(d => d.type === 'markdown' && String(rec[d.key] || '').trim());
  const notes = notesForDisplay(rec);
  const root = h('div', { id: 'print-root' },
    h('div', { class: 'p-head' },
      type.pictureField ? avatar(type, rec, 110) : null,
      h('div', {},
        h('h1', {}, recordTitle(type, rec)),
        h('table', { class: 'p-fields' }, fields.map(d => h('tr', {}, h('th', {}, d.label), h('td', {}, displayValue(d, rec[d.key], { record: rec }))))))),
    docs.map(d => h('section', { class: 'p-doc' }, h('h2', {}, d.label), renderMarkdown(rec[d.key]))),
    notes.length ? h('section', { class: 'p-notes' }, h('h2', {}, 'Notes'),
      notes.map(n => h('div', { class: ['p-note', isImportant(n) && 'important'] },
        h('div', { class: 'p-note-date' }, `${formatDate(n.date, df)} ${n.time || ''}${n.kind ? ' · ' + n.kind : ''}`),
        h('div', { class: 'pre' }, String(n.content).replace(/#!|#X|#(red|orange|green)\b/g, '').trim())))) : null,
    h('div', { class: 'p-foot' }, `OpenCRM · printed ${formatDate(new Date(), df)}`));
  document.getElementById('print-root')?.remove();
  document.body.appendChild(root);
  // give images a moment to load
  await Promise.race([Promise.all([...root.querySelectorAll('img')].map(img => img.complete ? null : new Promise(r => { img.onload = img.onerror = r; }))), new Promise(r => setTimeout(r, 1500))]);
  try {
    if (mode === 'pdf') {
      const res = await window.crm.app.pdf({ defaultName: `${recordTitle(type, rec).replace(/[^\w -]/g, '_')}.pdf` });
      if (res?.path) toast('PDF saved');
    } else {
      await window.crm.app.print();
    }
  } catch (e) {
    toast(e.message, { type: 'error' });
  } finally {
    root.remove();
  }
}
