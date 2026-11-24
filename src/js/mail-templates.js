// Email template manager: categories, tags, subject/body with {{fields}}, live preview with a record.
import { h, replace } from './dom.js';
import { store, mutate, currentType, records } from './store.js';
import { newId, recordTitle, renderMailTemplate, sendTimeFields } from './shared.js';
import { openModal, toast, confirmDialog } from './ui.js';
import { hooks } from './hooks.js';
import { mdToEmailHtml } from './mail-compose.js';
import { simpleEmailHtml } from '../shared/email-design.js';
import { mailFrame } from './mail-render.js';

export function openMailTemplates({ selectId = null } = {}) {
  let sel = selectId || store.data.meta.emailTemplates?.[0]?.id || null;
  let cat = '';
  const list = h('div', { class: 'tpl-list' });
  const editor = h('div', { class: 'tpl-editor' });
  const cats = () => [...new Set((store.data.meta.emailTemplates || []).map(t => t.category || 'General'))].sort();
  const tpl = () => (store.data.meta.emailTemplates || []).find(t => t.id === sel);
  const upd = (label, fn) => mutate(label, d => { const t = d.meta.emailTemplates.find(x => x.id === sel); if (t) fn(t); }, { coalesce: `tpl:${sel}:${label}` });

  const renderList = () => {
    const items = (store.data.meta.emailTemplates || []).filter(t => !cat || (t.category || 'General') === cat);
    replace(list, 
      h('div', { class: 'row-gap' },
        h('select', { class: 'input input-sm', onchange: e => { cat = e.target.value; renderList(); } }, h('option', { value: '' }, 'All categories'), cats().map(c => h('option', { value: c, selected: c === cat }, c))),
        h('button', { class: 'btn btn-sm btn-primary', onclick: () => {
          const t = { id: newId('et'), name: 'New template', category: cat || 'General', tags: [], subject: '', body: 'Hi {{fullName|first|or:"there"}},\n\n\n\nBest regards,\n{{me.name}}', design: null, html: null, tracking: 'default', uses: 0, createdAt: new Date().toISOString() };
          mutate('New email template', d => { (d.meta.emailTemplates ||= []).push(t); });
          sel = t.id; renderList(); renderEditor();
        } }, '+ New'),
        hooks.newDesignedTemplate ? h('button', { class: 'btn btn-sm', onclick: () => hooks.newDesignedTemplate(id => { sel = id; renderList(); renderEditor(); }) }, '🎨 New design…') : null),
      ...items.map(t => h('div', { class: ['tpl-item', t.id === sel && 'on'], onclick: () => { sel = t.id; renderList(); renderEditor(); } },
        h('span', {}, t.design || t.html ? '🎨 ' : '📝 '), h('b', {}, t.name),
        h('div', { class: 'muted tiny' }, `${t.category || 'General'}${t.tags?.length ? ' · ' + t.tags.join(', ') : ''}${t.uses ? ` · used ${t.uses}×` : ''}`))));
  };

  const renderEditor = () => {
    const t = tpl();
    if (!t) { replace(editor, h('div', { class: 'empty-state' }, 'No template selected.')); return; }
    const type = currentType();
    const recs = records(type.key).slice(0, 300);
    const recSel = h('select', { class: 'input input-sm' }, recs.map(r => h('option', { value: r.id }, recordTitle(type, r))));
    const preview = h('div', { class: 'tpl-preview' });
    const name = h('input', { class: 'input', value: t.name, onchange: e => { upd('Template name', x => { x.name = e.target.value.trim() || 'Untitled'; }); renderList(); } });
    const category = h('input', { class: 'input input-sm', value: t.category || 'General', list: 'tpl-cats', onchange: e => { upd('Template category', x => { x.category = e.target.value.trim() || 'General'; }); renderList(); } });
    const tags = h('input', { class: 'input input-sm', value: (t.tags || []).join(', '), placeholder: 'tags, comma separated', onchange: e => upd('Template tags', x => { x.tags = e.target.value.split(',').map(s => s.trim()).filter(Boolean); }) });
    const subject = h('input', { class: 'input', value: t.subject || '', placeholder: 'Subject — can use {{fields}}', oninput: e => { upd('Template subject', x => { x.subject = e.target.value; }); doPreview(); } });
    const body = h('textarea', { class: 'input tpl-body', rows: 14, value: t.body || '', oninput: e => { upd('Template body', x => { x.body = e.target.value; }); doPreview(); } });
    const doPreview = () => {
      const cur = tpl();
      const rec = recs.find(r => r.id === +recSel.value);
      const ask = Object.fromEntries(sendTimeFields(cur.subject, cur.body).map(k => [k, `[${k}]`]));
      const o = { type, record: rec, me: store.config.ui.me || {}, ask, ctx: { dateFormat: store.data.meta.settings.dateFormat } };
      const s = renderMailTemplate(cur.subject, o);
      const b = renderMailTemplate(cur.body, o);
      const miss = [...new Set([...s.missing, ...b.missing])];
      const html = (cur.design || cur.html) && hooks.previewDesigned ? hooks.previewDesigned(cur, { rec: rec ? { type, rec } : null, ask, bodyMd: b.text }) : simpleEmailHtml({ bodyHtml: mdToEmailHtml(b.text), brand: store.data.meta.brand, subject: s.text });
      replace(preview, 
        h('div', { class: 'small' }, h('b', {}, 'Subject: '), s.text),
        miss.length ? h('div', { class: 'warn-line small' }, `⚠ Empty for this record: ${miss.join(', ')}`) : null,
        mailFrame({ html }, { allowImages: true }));
    };
    recSel.addEventListener('change', doPreview);
    const insertMenu = h('select', { class: 'input input-sm', onchange: e => {
      if (!e.target.value) return;
      const v = e.target.value;
      const pos = body.selectionStart ?? body.value.length;
      body.setRangeText(v, pos, body.selectionEnd ?? pos, 'end');
      body.dispatchEvent(new Event('input'));
      e.target.value = '';
      body.focus();
    } },
    h('option', { value: '' }, 'Insert field…'),
    type.fieldDefs.filter(f => !['image', 'file', 'markdown'].includes(f.type)).map(f => h('option', { value: `{{${f.label}}}` }, f.label)),
    h('option', { value: '{{fullName|first|or:"there"}}' }, 'First name (with fallback)'),
    h('option', { value: '{{me.name}}' }, 'My name'),
    h('option', { value: '{{today}}' }, 'Today’s date'),
    h('option', { value: '{{?Meeting link}}' }, 'Ask when sending: Meeting link'),
    h('option', { value: '{{?Your field}}' }, 'Ask when sending: custom…'));
    replace(editor, 
      h('datalist', { id: 'tpl-cats' }, cats().map(c => h('option', { value: c }))),
      h('div', { class: 'two-col' }, h('div', {}, h('label', { class: 'field-label' }, 'Name'), name), h('div', { class: 'two-col' }, h('div', {}, h('label', { class: 'field-label' }, 'Category'), category), h('div', {}, h('label', { class: 'field-label' }, 'Tags'), tags))),
      h('div', { class: 'row-gap' }, h('label', { class: 'field-label' }, 'Subject'), h('span', { class: 'spacer' }),
        h('label', { class: 'small muted' }, '📊 Tracking '),
        h('select', { class: 'input input-sm', onchange: e => upd('Template tracking', x => { x.tracking = e.target.value; }) },
          [['default', 'as in settings'], ['on', 'always'], ['off', 'never']].map(([v, l]) => h('option', { value: v, selected: (t.tracking || 'default') === v }, l)))),
      subject,
      h('div', { class: 'row-gap' }, h('label', { class: 'field-label' }, t.design || t.html ? 'Text (used for the plain-text version and the {{body}} block)' : 'Message (Markdown)'), h('span', { class: 'spacer' }), insertMenu),
      body,
      h('p', { class: 'muted tiny' }, 'Placeholders: {{Field name}} · filters |first |last |upper |title |or:"fallback" · {{?Question}} is asked when sending · {{me.name}} {{today}}'),
      h('div', { class: 'row-gap' },
        (t.design || t.html) && hooks.editDesign ? h('button', { class: 'btn btn-primary', onclick: () => hooks.editDesign(t.id, () => { renderList(); renderEditor(); }) }, '🎨 Edit design…') : null,
        h('button', { class: 'btn', onclick: () => {
          const c = { ...structuredClone(t), id: newId('et'), name: `${t.name} (copy)`, uses: 0, createdAt: new Date().toISOString() };
          mutate('Duplicate template', d => { d.meta.emailTemplates.push(c); });
          sel = c.id; renderList(); renderEditor();
        } }, 'Duplicate'),
        h('button', { class: 'btn btn-danger-soft', onclick: async () => {
          if (!(await confirmDialog(`Delete the template “${t.name}”?`, { danger: true, okLabel: 'Delete' }))) return;
          mutate('Delete template', d => { d.meta.emailTemplates = d.meta.emailTemplates.filter(x => x.id !== t.id); });
          sel = store.data.meta.emailTemplates[0]?.id || null; renderList(); renderEditor();
        } }, 'Delete'),
        h('span', { class: 'spacer' }),
        h('span', { class: 'muted small' }, 'Preview with'), recSel),
      preview);
    doPreview();
  };
  renderList(); renderEditor();
  openModal({ title: 'Email templates', size: 'xxl', className: 'tpl-modal', body: h('div', { class: 'tpl-grid' }, list, editor) });
  toast; // eslint quiet
}
