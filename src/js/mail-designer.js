// Visual email designer: blocks, brand kit, live preview (desktop/mobile, light/dark), send a test,
// starter gallery and HTML import.
import { h, replace, debounce } from './dom.js';
import { store, mutate, currentType, records } from './store.js';
import { newId, recordTitle, renderMailTemplate, escapeHtml, sendTimeFields } from './shared.js';
import { BLOCK_TYPES, newBlock, renderDesign, starterDesigns, FONT_STACKS } from '../shared/email-design.js';
import { mdToEmailHtml } from './mail-compose.js';
import { mailFrame } from './mail-render.js';
import { mail, defaultAccount } from './mail-state.js';
import { openModal, toast, confirmDialog, menu, field, promptDialog } from './ui.js';

const tplById = id => (store.data.meta.emailTemplates || []).find(t => t.id === id);

/** Renders a designed or imported-HTML template for a record. */
export function renderTemplateHtml(tpl, { rec = null, ask = {}, bodyMd = '', subject = '' } = {}) {
  const base = { type: rec?.type, record: rec?.rec, me: store.config.ui.me || {}, ask, ctx: { dateFormat: store.data.meta.settings.dateFormat } };
  if (tpl.html) {
    const parts = String(tpl.html).split(/\{\{\s*body\s*\}\}/);
    const filled = parts.map(p => renderMailTemplate(p, { ...base, escape: escapeHtml }).text);
    return { html: filled.join(mdToEmailHtml(bodyMd)), warnings: [] };
  }
  const out = renderDesign(tpl.design, { brand: store.data.meta.brand, type: rec?.type, record: rec?.rec, me: base.me, ask, dateFormat: base.ctx.dateFormat, md: mdToEmailHtml, bodyMd, subject });
  return out;
}

// ---------------------------------------------------------------- image helpers
export function pickImage({ maxWidth = 1200 } = {}) {
  return new Promise(resolve => {
    const input = h('input', { type: 'file', accept: 'image/png,image/jpeg,image/gif,image/webp', style: { display: 'none' } });
    input.addEventListener('change', async () => {
      const f = input.files?.[0];
      input.remove();
      if (!f) return resolve(null);
      try { resolve(await compressImage(f, maxWidth)); } catch (e) { toast(e.message, { type: 'error' }); resolve(null); }
    });
    document.body.appendChild(input);
    input.click();
  });
}

export async function compressImage(file, maxWidth = 1200) {
  const url = URL.createObjectURL(file);
  try {
    const img = await new Promise((res, rej) => { const i = new Image(); i.onload = () => res(i); i.onerror = () => rej(new Error('Not a readable image')); i.src = url; });
    if (file.type === 'image/gif' && file.size < 400 * 1024) return await new Promise(res => { const r = new FileReader(); r.onload = () => res(r.result); r.readAsDataURL(file); });
    const scale = Math.min(1, maxWidth / img.naturalWidth);
    const c = document.createElement('canvas');
    c.width = Math.round(img.naturalWidth * scale); c.height = Math.round(img.naturalHeight * scale);
    const g = c.getContext('2d');
    g.drawImage(img, 0, 0, c.width, c.height);
    // keep transparency (logos) as PNG, photos as JPEG
    const hasAlpha = file.type === 'image/png' && g.getImageData(0, 0, Math.min(c.width, 50), Math.min(c.height, 50)).data.some((v, i) => i % 4 === 3 && v < 250);
    const out = hasAlpha ? c.toDataURL('image/png') : c.toDataURL('image/jpeg', 0.84);
    return out;
  } finally { URL.revokeObjectURL(url); }
}

// ---------------------------------------------------------------- brand kit
export function openBrandKit() {
  const b = () => store.data.meta.brand;
  const set = (label, fn) => { mutate(label, d => fn(d.meta.brand), { coalesce: `brand:${label}` }); paintPreview(); };
  const preview = h('div', { class: 'brand-preview' });
  const paintPreview = debounce(() => {
    const demo = { blocks: [newBlock('header'), { ...newBlock('heading'), text: 'Your brand, every email' }, { ...newBlock('text'), md: 'This is how your designed emails will look. Links look [like this](https://example.com).' }, newBlock('button'), newBlock('social'), newBlock('footer')] };
    const out = renderDesign(demo, { brand: b(), me: store.config.ui.me || {}, md: mdToEmailHtml, subject: 'Preview' });
    replace(preview, mailFrame({ html: out.html }, { allowImages: true }));
  }, 150);
  const logoBox = h('div', { class: 'row-gap' });
  const paintLogo = () => replace(logoBox,
    b().logo ? h('img', { src: b().logo, class: 'logo-thumb', alt: '' }) : h('span', { class: 'muted small' }, 'No logo'),
    h('button', { class: 'btn btn-sm', onclick: async () => { const d = await pickImage({ maxWidth: 600 }); if (d) { set('Logo', x => { x.logo = d; }); paintLogo(); } } }, b().logo ? 'Change…' : 'Upload logo…'),
    b().logo ? h('button', { class: 'btn btn-sm', onclick: () => { set('Logo', x => { x.logo = ''; }); paintLogo(); } }, 'Remove') : null,
    h('label', { class: 'small' }, 'Width ', h('input', { class: 'input input-sm', type: 'number', min: 40, max: 400, value: b().logoWidth || 140, style: { width: '70px' }, onchange: e => set('Logo width', x => { x.logoWidth = +e.target.value || 140; }) }), ' px'));
  paintLogo();
  const color = (key, label) => h('label', { class: 'color-field' }, h('input', { type: 'color', value: b()[key], oninput: e => set(`Colour ${key}`, x => { x[key] = e.target.value; }) }), ` ${label}`);
  const socialBox = h('div', {});
  const paintSocial = () => replace(socialBox,
    (b().social || []).map((s, i) => h('div', { class: 'row-gap' },
      h('select', { class: 'input input-sm', onchange: e => set('Social', x => { x.social[i].kind = e.target.value; }) }, ['linkedin', 'x', 'instagram', 'facebook', 'youtube', 'github', 'tiktok', 'web'].map(k => h('option', { value: k, selected: s.kind === k }, k))),
      h('input', { class: 'input input-sm', value: s.url, placeholder: 'https://…', onchange: e => set('Social', x => { x.social[i].url = e.target.value.trim(); }) }),
      h('button', { class: 'icon-btn', onclick: () => { set('Social', x => { x.social.splice(i, 1); }); paintSocial(); } }, '×'))),
    h('button', { class: 'btn-link small', onclick: () => { set('Social', x => { (x.social ||= []).push({ kind: 'linkedin', url: '' }); }); paintSocial(); } }, '+ Add link'));
  paintSocial();
  const fontSel = h('select', { class: 'input input-sm', onchange: e => { if (e.target.value === 'google') { googleName.classList.remove('hidden'); googleName.focus(); return; } googleName.classList.add('hidden'); set('Font', x => { x.font = e.target.value; }); } },
    Object.keys(FONT_STACKS).map(k => h('option', { value: k, selected: b().font === k }, { system: 'System (modern sans)', arial: 'Arial / Helvetica', georgia: 'Georgia (serif)', verdana: 'Verdana', trebuchet: 'Trebuchet' }[k])),
    h('option', { value: 'google', selected: String(b().font).startsWith('google:') }, 'Google font…'));
  const googleName = h('input', { class: ['input input-sm', !String(b().font).startsWith('google:') && 'hidden'], placeholder: 'e.g. Inter, Lato, Poppins', value: String(b().font).startsWith('google:') ? b().font.slice(7) : '', onchange: e => set('Font', x => { x.font = e.target.value.trim() ? `google:${e.target.value.trim()}` : 'system'; }) });
  openModal({
    title: '🎨 Brand kit', size: 'xxl', className: 'brand-modal',
    body: h('div', { class: 'brand-grid' },
      h('div', { class: 'brand-form' },
        field('Logo', logoBox),
        field('Company / brand name', h('input', { class: 'input', value: b().companyName || '', onchange: e => set('Company name', x => { x.companyName = e.target.value; }) })),
        field('Colours', h('div', { class: 'color-grid' }, color('primary', 'Primary'), color('accent', 'Accent'), color('background', 'Background'), color('surface', 'Card'), color('text', 'Text'), color('muted', 'Muted text'))),
        field('Font', h('div', { class: 'row-gap' }, fontSel, googleName), 'Google fonts show in Apple Mail and some apps; others fall back to a similar system font.'),
        h('div', { class: 'two-col' },
          field('Button shape', h('select', { class: 'input input-sm', onchange: e => set('Button shape', x => { x.buttonShape = e.target.value; }) }, [['rounded', 'Rounded'], ['pill', 'Pill'], ['square', 'Square']].map(([v, l]) => h('option', { value: v, selected: b().buttonShape === v }, l)))),
          field('Button style', h('select', { class: 'input input-sm', onchange: e => set('Button style', x => { x.buttonStyle = e.target.value; }) }, [['filled', 'Filled'], ['outline', 'Outline']].map(([v, l]) => h('option', { value: v, selected: b().buttonStyle === v }, l))))),
        field('Footer text', h('textarea', { class: 'input', rows: 2, value: b().footer || '', placeholder: 'e.g. You receive this email because we have been in touch.', onchange: e => set('Footer', x => { x.footer = e.target.value; }) })),
        field('Postal address', h('textarea', { class: 'input', rows: 2, value: b().address || '', placeholder: 'Recommended for marketing emails', onchange: e => set('Address', x => { x.address = e.target.value; }) })),
        field('Social links', socialBox),
        h('label', { class: 'check-row' }, h('input', { type: 'checkbox', checked: !!b().logoInPlain, onchange: e => set('Logo in plain emails', x => { x.logoInPlain = e.target.checked; }) }), ' Show the logo on top of normal (non-designed) emails too')),
      h('div', { class: 'brand-right' }, h('div', { class: 'muted small' }, 'Preview'), preview)),
  });
  paintPreview();
}

// ---------------------------------------------------------------- gallery + HTML import
export function newDesignedTemplate(done) {
  const designs = starterDesigns();
  const create = (t) => {
    const tpl = { id: newId('et'), tracking: 'default', uses: 0, createdAt: new Date().toISOString(), html: null, ...structuredClone(t) };
    mutate('New designed template', d => { (d.meta.emailTemplates ||= []).push(tpl); });
    m.close();
    done?.(tpl.id);
    openDesigner(tpl.id, () => done?.(tpl.id));
  };
  const card = (t) => {
    const out = renderDesign(t.design, { brand: store.data.meta.brand, me: store.config.ui.me || {}, md: mdToEmailHtml, bodyMd: renderMailTemplate(t.body, { me: store.config.ui.me || {} }).text, ask: Object.fromEntries(sendTimeFields(t.subject, t.body, JSON.stringify(t.design)).map(k => [k, k])), subject: t.subject });
    const frame = mailFrame({ html: out.html }, { allowImages: true });
    frame.classList.add('thumb-frame');
    return h('button', { class: 'gallery-card', onclick: () => create(t) }, h('div', { class: 'thumb' }, frame), h('b', {}, t.name), h('span', { class: 'muted tiny' }, t.category));
  };
  const m = openModal({
    title: 'New designed email', size: 'xxl', className: 'gallery-modal',
    body: h('div', {},
      h('div', { class: 'row-gap' },
        h('button', { class: 'btn', onclick: () => create({ name: 'Blank design', category: 'General', tags: ['design'], subject: '', body: '', design: { width: 600, preheader: '', blocks: [newBlock('header'), newBlock('body'), newBlock('signature'), newBlock('footer')] } }) }, '＋ Start blank'),
        h('button', { class: 'btn', onclick: () => { m.close(); importHtmlTemplate(done); } }, '⟨/⟩ Paste or import HTML…'),
        h('span', { class: 'muted small' }, 'All designs use your brand kit (logo, colours, font).'),
        h('button', { class: 'btn-link small', onclick: () => openBrandKit() }, 'Edit brand kit…')),
      h('div', { class: 'gallery' }, designs.map(card))),
  });
}

export function importHtmlTemplate(done) {
  const ta = h('textarea', { class: 'input mono', rows: 16, placeholder: '<html>…</html>  — paste the HTML of an email template (exported from another tool or written by hand). Use {{Field}} placeholders and {{body}} where the message you write should go.' });
  const name = h('input', { class: 'input', value: 'Imported template' });
  const fileBtn = h('input', { type: 'file', accept: '.html,.htm,text/html', class: 'input input-sm', onchange: async e => { const f = e.target.files?.[0]; if (f) { ta.value = await f.text(); name.value = f.name.replace(/\.html?$/i, ''); } } });
  openModal({
    title: 'Import an HTML template', size: 'lg',
    body: h('div', {}, field('Name', name), field('HTML file', fileBtn), ta,
      h('p', { class: 'muted small' }, 'CSS is converted to inline styles automatically (needed by Gmail and Outlook). Scripts, forms and external stylesheets are removed.')),
    actions: [{ label: 'Cancel' }, { label: 'Import', primary: true, fn: async () => {
      if (!ta.value.trim()) { toast('Paste some HTML first', { type: 'error' }); return false; }
      try {
        const r = await window.crm.mail.inlineCss(ta.value);
        const tpl = { id: newId('et'), name: name.value.trim() || 'Imported template', category: 'Imported', tags: ['html'], subject: r.title || '', body: '', design: null, html: r.html, tracking: 'default', uses: 0, createdAt: new Date().toISOString() };
        mutate('Import HTML template', d => { (d.meta.emailTemplates ||= []).push(tpl); });
        toast(`Imported${r.removed ? ` (removed: ${r.removed})` : ''}`);
        done?.(tpl.id);
        return true;
      } catch (e) { toast(e.message, { type: 'error' }); return false; }
    } }],
  });
}

// ---------------------------------------------------------------- designer
export function openDesigner(templateId, onDone) {
  let selId = null;
  let width = 'desktop', dark = false;
  const t = () => tplById(templateId);
  if (!t()?.design) { toast('This template has no design.', { type: 'error' }); return; }
  const upd = (label, fn, coalesce = true) => { mutate(label, d => { const x = d.meta.emailTemplates.find(y => y.id === templateId); if (x) fn(x); }, coalesce ? { coalesce: `design:${templateId}:${label}` } : {}); };
  const blocks = () => t().design.blocks;
  const blk = id => blocks().find(b => b.id === id);
  const updBlock = (label, fn) => { upd(label, x => { const b = x.design.blocks.find(y => y.id === selId); if (b) fn(b); }); schedule(); };

  const type = currentType();
  const recs = records(type.key).slice(0, 300);
  const recSel = h('select', { class: 'input input-sm', title: 'Preview with this record' }, h('option', { value: '' }, '(no record)'), recs.map(r => h('option', { value: r.id }, recordTitle(type, r))));
  if (recs[0]) recSel.value = String(recs[0].id);
  const listEl = h('div', { class: 'dz-blocks' });
  const propsEl = h('div', { class: 'dz-props' });
  const previewEl = h('div', { class: 'dz-preview' });
  const warnEl = h('div', { class: 'dz-warn' });
  const widthSeg = h('div', { class: 'seg' });
  const paintSeg = () => replace(widthSeg,
    h('button', { class: ['seg-btn', width === 'desktop' && 'on'], onclick: () => { width = 'desktop'; paintSeg(); paint(); } }, '🖥 Desktop'),
    h('button', { class: ['seg-btn', width === 'mobile' && 'on'], onclick: () => { width = 'mobile'; paintSeg(); paint(); } }, '📱 Mobile'),
    h('button', { class: ['seg-btn', dark && 'on'], title: 'Approximation of how dark-mode mail apps recolour emails', onclick: () => { dark = !dark; paintSeg(); paint(); } }, '🌙 Dark'));
  paintSeg();

  const currentRec = () => { const r = recs.find(x => x.id === +recSel.value); return r ? { type, rec: r } : null; };
  const askDemo = () => Object.fromEntries(sendTimeFields(t().subject, t().body, JSON.stringify(t().design)).map(k => [k, `[${k}]`]));

  const paint = () => {
    const tpl = t();
    const rec = currentRec();
    const bodyMd = renderMailTemplate(tpl.body || '', { type, record: rec?.rec, me: store.config.ui.me || {}, ask: askDemo() }).text;
    const out = renderTemplateHtml(tpl, { rec, ask: askDemo(), bodyMd, subject: tpl.subject });
    const frame = mailFrame({ html: out.html }, { allowImages: true });
    frame.style.width = width === 'mobile' ? '375px' : '100%';
    if (dark) frame.addEventListener('load', () => { try { const s = frame.contentDocument.createElement('style'); s.textContent = 'html{filter:invert(.9) hue-rotate(180deg)}img{filter:invert(1) hue-rotate(180deg)}'; frame.contentDocument.head.appendChild(s); } catch { /* ignore */ } });
    replace(previewEl, h('div', { class: ['dz-frame-wrap', width] }, frame));
    replace(warnEl, (out.warnings || []).map(w => h('div', { class: 'warn-line' }, `⚠ ${w}`)), h('span', { class: 'muted tiny' }, `${Math.round((out.size || out.html.length) / 1024)} KB`));
  };
  const schedule = debounce(paint, 200);
  recSel.addEventListener('change', paint);

  const summaryOf = b => {
    switch (b.type) {
      case 'heading': return b.text;
      case 'text': case 'signature': case 'quote': return (b.md || '').replace(/[*_#>\[\]()]/g, '').slice(0, 50);
      case 'button': return `${b.label} → ${b.url}`;
      case 'image': return b.src ? (b.alt || 'image') : 'no image yet';
      case 'interest': return (b.options || []).map(o => o.label).join(' / ');
      case 'header': return b.title || (store.data.meta.brand.logo ? 'logo' : store.data.meta.brand.companyName || 'brand');
      case 'body': return 'the message you write when sending';
      default: return '';
    }
  };

  const paintList = () => {
    replace(listEl, blocks().map((b, i) => {
      const meta = BLOCK_TYPES.find(x => x.type === b.type) || { icon: '?', label: b.type };
      const row = h('div', { class: ['dz-block', b.id === selId && 'on'], draggable: true, dataset: { i }, onclick: () => { selId = b.id; paintList(); paintProps(); } },
        h('span', { class: 'dz-ico' }, meta.icon),
        h('div', { class: 'dz-txt' }, h('b', {}, meta.label.split(' (')[0]), h('div', { class: 'muted tiny' }, summaryOf(b) || ''), b.showIf?.field ? h('div', { class: 'tiny cond' }, `only if ${b.showIf.field} ${b.showIf.op || 'set'} ${b.showIf.value || ''}`) : null),
        h('span', { class: 'dz-tools' },
          h('button', { class: 'icon-btn', title: 'Move up', disabled: i === 0, onclick: e => { e.stopPropagation(); move(i, i - 1); } }, '↑'),
          h('button', { class: 'icon-btn', title: 'Move down', disabled: i === blocks().length - 1, onclick: e => { e.stopPropagation(); move(i, i + 1); } }, '↓'),
          h('button', { class: 'icon-btn', title: 'Duplicate', onclick: e => { e.stopPropagation(); upd('Duplicate block', x => { x.design.blocks.splice(i + 1, 0, { ...structuredClone(b), id: newBlock(b.type).id }); }, false); paintList(); schedule(); } }, '⧉'),
          h('button', { class: 'icon-btn danger', title: 'Delete', onclick: e => { e.stopPropagation(); upd('Delete block', x => { x.design.blocks.splice(i, 1); }, false); if (selId === b.id) selId = null; paintList(); paintProps(); schedule(); } }, '🗑')));
      row.addEventListener('dragstart', e => { e.dataTransfer.setData('text/block', String(i)); });
      row.addEventListener('dragover', e => { if (e.dataTransfer.types.includes('text/block')) { e.preventDefault(); row.classList.add('drop'); } });
      row.addEventListener('dragleave', () => row.classList.remove('drop'));
      row.addEventListener('drop', e => { e.preventDefault(); row.classList.remove('drop'); const from = +e.dataTransfer.getData('text/block'); if (!Number.isNaN(from) && from !== i) move(from, i); });
      return row;
    }), h('button', { class: 'btn btn-sm dz-add', onclick: e => menu(e.currentTarget, BLOCK_TYPES.map(bt => ({ label: bt.label, icon: bt.icon, fn: () => {
      const nb = newBlock(bt.type);
      const at = selId ? blocks().findIndex(x => x.id === selId) + 1 : blocks().length;
      upd('Add block', x => { x.design.blocks.splice(at, 0, nb); }, false);
      selId = nb.id; paintList(); paintProps(); schedule();
    } }))) }, '+ Add block'));
  };
  const move = (from, to) => { upd('Move block', x => { const [b] = x.design.blocks.splice(from, 1); x.design.blocks.splice(to, 0, b); }, false); paintList(); schedule(); };

  const inp = (label, key, opts = {}) => {
    const b = blk(selId);
    const el = opts.multiline
      ? h('textarea', { class: 'input', rows: opts.rows || 5, value: b[key] ?? '', placeholder: opts.placeholder || '' })
      : h('input', { class: 'input', type: opts.type || 'text', value: b[key] ?? '', placeholder: opts.placeholder || '' });
    el.addEventListener('input', () => updBlock(`Edit ${label}`, x => { x[key] = opts.type === 'number' ? +el.value : el.value; }));
    return field(label, el, opts.hint);
  };
  const sel = (label, key, options) => {
    const b = blk(selId);
    return field(label, h('select', { class: 'input input-sm', onchange: e => updBlock(`Edit ${label}`, x => { x[key] = isNaN(+e.target.value) || e.target.value === '' ? e.target.value : +e.target.value; }) }, options.map(([v, l]) => h('option', { value: v, selected: String(b[key] ?? '') === String(v) }, l))));
  };
  const alignSel = () => sel('Alignment', 'align', [['left', 'Left'], ['center', 'Centre'], ['right', 'Right']]);
  const colorSel = (label, key) => sel(label, key, [['primary', 'Brand primary'], ['accent', 'Brand accent'], ['dark', 'Dark']]);

  const paintProps = () => {
    const b = blk(selId);
    if (!b) {
      replace(propsEl,
        h('h3', {}, 'Email settings'),
        field('Subject', (() => { const i = h('input', { class: 'input', value: t().subject || '' }); i.addEventListener('input', () => { upd('Subject', x => { x.subject = i.value; }); }); return i; })()),
        field('Preview text (shown after the subject in the inbox)', (() => { const i = h('input', { class: 'input', value: t().design.preheader || '' }); i.addEventListener('input', () => { upd('Preheader', x => { x.design.preheader = i.value; }); schedule(); }); return i; })()),
        field('Default message (the ✉ Message block; editable when sending)', (() => { const i = h('textarea', { class: 'input', rows: 7, value: t().body || '' }); i.addEventListener('input', () => { upd('Body', x => { x.body = i.value; }); schedule(); }); return i; })()),
        h('p', { class: 'muted small' }, 'Click a block on the left to edit it. Drag blocks to reorder. Use {{Field}} placeholders anywhere, {{?Question}} to ask when sending.'));
      return;
    }
    const parts = [];
    switch (b.type) {
      case 'header': parts.push(inp('Title (optional)', 'title'), sel('Style', 'style', [['brand', 'Brand colour'], ['plain', 'Plain (white)']]), alignSel(), h('button', { class: 'btn-link small', onclick: () => openBrandKit() }, 'Logo & colours: brand kit…')); break;
      case 'heading': parts.push(inp('Text', 'text'), sel('Size', 'level', [[1, 'Large'], [2, 'Medium']]), alignSel()); break;
      case 'text': parts.push(inp('Text (Markdown)', 'md', { multiline: true, rows: 8 }), alignSel()); break;
      case 'body': parts.push(h('p', { class: 'muted' }, 'Shows the message you write in the email window. Its default text is in the email settings (click an empty spot on the left).')); break;
      case 'image': parts.push(
        h('div', { class: 'row-gap' }, b.src ? h('img', { src: b.src, class: 'logo-thumb', alt: '' }) : null,
          h('button', { class: 'btn btn-sm', onclick: async () => { const d = await pickImage(); if (d) { updBlock('Image', x => { x.src = d; }); paintProps(); paintList(); } } }, b.src ? 'Replace image…' : 'Upload image…')),
        inp('…or image address (https://)', 'src', { placeholder: 'https://…' }), inp('Description (alt text)', 'alt'), inp('Link (optional)', 'link', { placeholder: 'https://…' }),
        inp('Width (%)', 'width', { type: 'number' }), sel('Rounded corners', 'radius', [['', 'No'], [1, 'Yes']]), alignSel()); break;
      case 'button': parts.push(inp('Label', 'label'), inp('Link', 'url', { placeholder: 'https://… or {{?Link}}' }), colorSel('Colour', 'color'), sel('Style', 'btnStyle', [['filled', 'Filled'], ['outline', 'Outline']]), alignSel()); break;
      case 'interest': {
        parts.push(inp('Question', 'question'),
          h('p', { class: 'muted small' }, 'Each button records the answer in OpenCRM (with open & click tracking on) or opens a pre-filled reply (tracking off).'),
          ...(b.options || []).map((o, i) => h('div', { class: 'row-gap' },
            h('input', { class: 'input input-sm', value: o.label, placeholder: 'Button text', oninput: e => updBlock('Interest option', x => { x.options[i].label = e.target.value; }) }),
            h('input', { class: 'input input-sm', value: o.choice, title: 'Answer code saved in the CRM', placeholder: 'answer code', oninput: e => updBlock('Interest option', x => { x.options[i].choice = e.target.value.trim().toLowerCase().replace(/\s+/g, '-'); }) }),
            h('select', { class: 'input input-sm', onchange: e => updBlock('Interest option', x => { x.options[i].style = e.target.value; }) }, [['filled', 'Filled'], ['outline', 'Outline'], ['link', 'Link']].map(([v, l]) => h('option', { value: v, selected: (o.style || 'filled') === v }, l))),
            h('button', { class: 'icon-btn', onclick: () => { updBlock('Interest option', x => { x.options.splice(i, 1); }); paintProps(); } }, '×'))),
          (b.options || []).length < 3 ? h('button', { class: 'btn-link small', onclick: () => { updBlock('Interest option', x => { x.options.push({ label: 'Option', choice: 'option', style: 'outline' }); }); paintProps(); } }, '+ Add option') : null);
        break;
      }
      case 'columns': parts.push(
        field('Columns', h('select', { class: 'input input-sm', onchange: e => { const n = +e.target.value; updBlock('Columns', x => { while (x.cols.length < n) x.cols.push({ md: '**New**\n\nText', src: '' }); x.cols.length = n; }); paintProps(); } }, [2, 3].map(n => h('option', { value: n, selected: (b.cols || []).length === n }, String(n))))),
        ...(b.cols || []).map((c, i) => h('div', { class: 'col-edit' }, h('b', { class: 'small' }, `Column ${i + 1}`),
          h('textarea', { class: 'input', rows: 4, value: c.md, oninput: e => updBlock('Column', x => { x.cols[i].md = e.target.value; }) }),
          h('div', { class: 'row-gap' }, c.src ? h('img', { src: c.src, class: 'logo-thumb', alt: '' }) : null,
            h('button', { class: 'btn btn-sm', onclick: async () => { const d = await pickImage({ maxWidth: 600 }); if (d) { updBlock('Column image', x => { x.cols[i].src = d; }); paintProps(); } } }, c.src ? 'Replace image' : 'Add image'),
            c.src ? h('button', { class: 'btn btn-sm', onclick: () => { updBlock('Column image', x => { x.cols[i].src = ''; }); paintProps(); } }, 'Remove image') : null))));
        break;
      case 'quote': parts.push(inp('Quote (Markdown)', 'md', { multiline: true }), inp('Author', 'author')); break;
      case 'spacer': parts.push(inp('Height (px)', 'height', { type: 'number' })); break;
      case 'social': parts.push(h('p', { class: 'muted small' }, 'Uses the social links of your brand kit.'), h('button', { class: 'btn btn-sm', onclick: () => openBrandKit() }, 'Edit links…'), alignSel()); break;
      case 'signature': parts.push(inp('Signature (Markdown)', 'md', { multiline: true })); break;
      case 'footer': parts.push(h('p', { class: 'muted small' }, 'Shows the footer text and postal address of your brand kit.'), h('label', { class: 'check-row' }, h('input', { type: 'checkbox', checked: b.unsubscribe !== false, onchange: e => updBlock('Unsubscribe link', x => { x.unsubscribe = e.target.checked; }) }), ' Unsubscribe link (recommended for bulk emails)')); break;
      default: break;
    }
    // common: background, spacing, condition
    const cond = b.showIf || {};
    const fieldsList = type.fieldDefs.filter(f => !['image', 'file', 'markdown'].includes(f.type));
    const condField = h('select', { class: 'input input-sm' }, h('option', { value: '' }, 'Always show'), fieldsList.map(f => h('option', { value: f.label, selected: cond.field === f.label }, f.label)));
    const condOp = h('select', { class: 'input input-sm' }, [['set', 'has a value'], ['empty', 'is empty'], ['eq', 'is'], ['neq', 'is not'], ['contains', 'contains']].map(([v, l]) => h('option', { value: v, selected: (cond.op || 'set') === v }, l)));
    const condVal = h('input', { class: 'input input-sm', value: cond.value || '', placeholder: 'value' });
    const saveCond = () => { updBlock('Condition', x => { x.showIf = condField.value ? { field: condField.value, op: condOp.value, value: condVal.value } : undefined; }); paintList(); };
    [condField, condOp].forEach(e => e.addEventListener('change', saveCond));
    condVal.addEventListener('input', saveCond);
    parts.push(h('details', { class: 'help-details', open: !!cond.field },
      h('summary', {}, 'Background, spacing & condition'),
      sel('Background', 'bg', [['', 'None'], ['#f7f8fa', 'Light grey'], ['primary', 'Brand primary'], ['accent', 'Brand accent']]),
      inp('Vertical padding (px)', 'pad', { type: 'number', placeholder: '16' }),
      field('Show this block only if', h('div', { class: 'row-gap' }, condField, condOp, condVal))));
    replace(propsEl, h('h3', {}, (BLOCK_TYPES.find(x => x.type === b.type) || {}).label || b.type), parts);
  };

  const sendTest = async () => {
    const acc = defaultAccount();
    if (!acc) { toast('Set up an email account first.', { type: 'error' }); return; }
    const rec = currentRec();
    const tpl = t();
    const ask = askDemo();
    const subject = renderMailTemplate(tpl.subject || '(test)', { type, record: rec?.rec, me: store.config.ui.me || {}, ask }).text;
    const bodyMd = renderMailTemplate(tpl.body || '', { type, record: rec?.rec, me: store.config.ui.me || {}, ask }).text;
    const out = renderTemplateHtml(tpl, { rec, ask, bodyMd, subject });
    try {
      await window.crm.mail.send({ draft: { accountId: acc.id, to: [{ name: 'Me', address: acc.email }], subject: `[TEST] ${subject}`, html: out.html, text: out.text || bodyMd, tracking: 'off' }, delaySec: 0 });
      toast(`Test sent to ${acc.email}`);
    } catch (e) { toast(e.message, { type: 'error' }); }
  };

  const name = h('input', { class: 'input dz-name', value: t().name });
  name.addEventListener('input', () => upd('Template name', x => { x.name = name.value.trim() || 'Untitled'; }));
  openModal({
    title: '🎨 Email designer', size: 'full', className: 'designer-modal', closeOnBackdrop: false,
    headerExtra: h('div', { class: 'dz-top' }, name, widthSeg, h('span', { class: 'muted small' }, 'Preview as'), recSel,
      h('button', { class: 'btn btn-sm', onclick: () => openBrandKit() }, '🎨 Brand kit'),
      h('button', { class: 'btn btn-sm', title: 'Send this design to your own address', onclick: sendTest }, '📨 Send test to me')),
    body: h('div', { class: 'designer' },
      h('div', { class: 'dz-left', onclick: e => { if (e.target === e.currentTarget) { selId = null; paintList(); paintProps(); } } }, listEl),
      propsEl,
      h('div', { class: 'dz-right' }, previewEl, warnEl)),
    onClose: () => onDone?.(),
  });
  paintList(); paintProps(); paint();
  confirmDialog; promptDialog; mail; // keep imports for future use
}
