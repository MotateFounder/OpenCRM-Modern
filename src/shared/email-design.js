// Email-safe HTML builder (tables + inline styles, works in Gmail, Outlook incl. desktop Word engine,
// Apple Mail and phones). Pure module: the caller passes a markdown->html function.
//
// design = { width: 600, preheader: '', blocks: [ { id, type, ...props, bg?, pad?, showIf?: { field, op, value } } ] }
// Special link targets (rewritten at send time by the main process):
//   crm-interest:<choice>   interest buttons      crm-unsubscribe:   unsubscribe link
import { escapeHtml, renderMailTemplate } from './mail.js';

export const FONT_STACKS = {
  system: '-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Helvetica,Arial,sans-serif',
  arial: 'Arial,Helvetica,sans-serif',
  georgia: 'Georgia,"Times New Roman",Times,serif',
  verdana: 'Verdana,Geneva,sans-serif',
  trebuchet: '"Trebuchet MS",Helvetica,sans-serif',
};

export function fontStack(font) {
  if (String(font || '').startsWith('google:')) return `'${font.slice(7).replace(/'/g, '')}',${FONT_STACKS.system.replace(/"/g, '\'')}`;
  return (FONT_STACKS[font] || FONT_STACKS.system).replace(/"/g, '\'');
}

export function googleFontLink(font) {
  if (!String(font || '').startsWith('google:')) return '';
  const fam = encodeURIComponent(font.slice(7).trim()).replace(/%20/g, '+');
  return `<link href="https://fonts.googleapis.com/css2?family=${fam}:wght@400;700&display=swap" rel="stylesheet">`;
}

/** Inline styles for HTML produced by markdown (p, a, lists, blockquote, headings, img, hr). */
export function inlineBasicStyles(html, brand = {}, { color, size = 15, align } = {}) {
  const text = color || brand.text || '#1f2933';
  const link = brand.primary || '#2f6fed';
  const ff = fontStack(brand.font);
  const al = align ? `text-align:${align};` : '';
  return String(html || '')
    .replace(/<p>/g, `<p style="margin:0 0 12px 0;font-family:${ff};font-size:${size}px;line-height:1.6;color:${text};${al}">`)
    .replace(/<a (?![^>]*style=)/g, `<a style="color:${link};text-decoration:underline;" `)
    .replace(/<ul>/g, `<ul style="margin:0 0 12px 0;padding-left:22px;font-family:${ff};font-size:${size}px;line-height:1.6;color:${text};">`)
    .replace(/<ol>/g, `<ol style="margin:0 0 12px 0;padding-left:22px;font-family:${ff};font-size:${size}px;line-height:1.6;color:${text};">`)
    .replace(/<li>/g, '<li style="margin:0 0 4px 0;">')
    .replace(/<blockquote>/g, '<blockquote style="margin:8px 0;padding:0 0 0 12px;border-left:3px solid #d0d5dd;color:#667085;">')
    .replace(/<h1>/g, `<h1 style="margin:0 0 12px 0;font-family:${ff};font-size:26px;line-height:1.25;color:${text};${al}">`)
    .replace(/<h2>/g, `<h2 style="margin:0 0 10px 0;font-family:${ff};font-size:21px;line-height:1.3;color:${text};${al}">`)
    .replace(/<h3>/g, `<h3 style="margin:0 0 8px 0;font-family:${ff};font-size:17px;line-height:1.3;color:${text};${al}">`)
    .replace(/<img (?![^>]*style=)/g, '<img style="max-width:100%;height:auto;border:0;" ')
    .replace(/<hr>/g, '<hr style="border:0;border-top:1px solid #e4e7ec;margin:16px 0;">')
    .replace(/<table>/g, '<table style="border-collapse:collapse;" cellpadding="6">');
}

/** A normal email: just your text, in a clean readable layout. */
export function simpleEmailHtml({ bodyHtml, brand = {}, subject = '' }) {
  const font = fontStack(brand.font);
  const logo = brand.logo && brand.logoInPlain ? `<div style="margin:0 0 16px 0;"><img src="${brand.logo}" width="${Number(brand.logoWidth) || 140}" alt="${escapeHtml(brand.companyName || '')}" style="display:block;border:0;max-width:100%;height:auto;"></div>` : '';
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapeHtml(subject)}</title></head>`
    + `<body style="margin:0;padding:0;"><div style="font-family:${font};font-size:15px;line-height:1.55;color:${brand.text || '#1f2933'};max-width:640px;padding:4px 2px;">`
    + `${logo}${inlineBasicStyles(bodyHtml, brand)}</div></body></html>`;
}

// ---------------------------------------------------------------------------------------------
export const BLOCK_TYPES = [
  { type: 'header', label: 'Header (logo + title)', icon: '🏷' },
  { type: 'heading', label: 'Heading', icon: 'H' },
  { type: 'text', label: 'Text', icon: '¶' },
  { type: 'body', label: 'Message (what you write when sending)', icon: '✉' },
  { type: 'image', label: 'Image', icon: '🖼' },
  { type: 'button', label: 'Button', icon: '▭' },
  { type: 'interest', label: 'Interest buttons (“Tell me more”)', icon: '👍' },
  { type: 'columns', label: 'Columns', icon: '▥' },
  { type: 'quote', label: 'Quote / testimonial', icon: '❝' },
  { type: 'divider', label: 'Divider', icon: '—' },
  { type: 'spacer', label: 'Spacer', icon: '↕' },
  { type: 'social', label: 'Social icons', icon: '🔗' },
  { type: 'signature', label: 'Signature', icon: '✍' },
  { type: 'footer', label: 'Footer (address, unsubscribe)', icon: '▁' },
];

let idSeq = 0;
export const blockId = () => `b${Date.now().toString(36)}${(idSeq++).toString(36)}`;

export function newBlock(type) {
  const b = { id: blockId(), type };
  switch (type) {
    case 'header': return { ...b, title: '', align: 'center', style: 'brand' };
    case 'heading': return { ...b, text: 'A clear headline', level: 1, align: 'left' };
    case 'text': return { ...b, md: 'Write your text here. You can use **bold**, [links](https://example.com) and {{fields}}.', align: 'left' };
    case 'body': return { ...b };
    case 'image': return { ...b, src: '', alt: '', width: 100, link: '', align: 'center' };
    case 'button': return { ...b, label: 'Learn more', url: 'https://', align: 'center', color: 'primary' };
    case 'interest': return { ...b, question: 'Would you like to know more?', options: [{ label: 'Yes, tell me more', choice: 'interested', style: 'primary' }, { label: 'Book a call', choice: 'call', style: 'outline' }, { label: 'Not now', choice: 'not-now', style: 'link' }] };
    case 'columns': return { ...b, cols: [{ md: '**First**\n\nSome text.', src: '' }, { md: '**Second**\n\nSome text.', src: '' }] };
    case 'quote': return { ...b, md: '“Working with them was a great experience.”', author: 'Happy client' };
    case 'divider': return { ...b };
    case 'spacer': return { ...b, height: 24 };
    case 'social': return { ...b, align: 'center' };
    case 'signature': return { ...b, md: '{{me.name}}' };
    case 'footer': return { ...b, unsubscribe: true };
    default: return b;
  }
}

const esc = escapeHtml;
const px = n => `${Math.max(0, Number(n) || 0)}px`;

function colorOf(c, brand) {
  if (c === 'primary' || !c) return brand.primary || '#2f6fed';
  if (c === 'accent') return brand.accent || '#ff8a3d';
  if (c === 'dark') return brand.text || '#1f2933';
  return c;
}

function contrastText(hex) {
  const m = String(hex || '').replace('#', '').match(/^([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i);
  if (!m) return '#ffffff';
  const [r, g, b] = m.slice(1).map(x => parseInt(x, 16) / 255).map(v => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));
  return 0.2126 * r + 0.7152 * g + 0.0722 * b > 0.45 ? '#111111' : '#ffffff';
}

/** Bulletproof button (VML for desktop Outlook, styled <a> for everyone else). */
export function buttonHtml({ label, url, color, style = 'filled', align = 'center', brand = {} }) {
  const bg = colorOf(color, brand);
  const ff = fontStack(brand.font);
  const radius = brand.buttonShape === 'square' ? 0 : brand.buttonShape === 'pill' ? 24 : 6;
  const outline = style === 'outline' || brand.buttonStyle === 'outline' && style !== 'filled';
  if (style === 'link') {
    return `<a href="${esc(url)}" style="font-family:${ff};font-size:14px;color:${brand.muted || '#6b7785'};text-decoration:underline;">${esc(label)}</a>`;
  }
  const fg = outline ? bg : contrastText(bg);
  const w = Math.max(140, Math.min(320, String(label).length * 9 + 56));
  const arc = radius ? Math.round((radius / 44) * 100) : 0;
  return `<table role="presentation" border="0" cellspacing="0" cellpadding="0" align="${align}" style="display:inline-table;margin:4px;"><tr><td align="center" ${outline ? '' : `bgcolor="${bg}"`} style="border-radius:${radius}px;${outline ? `border:2px solid ${bg};` : ''}">`
    + `<!--[if mso]><v:roundrect xmlns:v="urn:schemas-microsoft-com:vml" xmlns:w="urn:schemas-microsoft-com:office:word" href="${esc(url)}" style="height:44px;v-text-anchor:middle;width:${w}px;" arcsize="${arc}%" ${outline ? `strokecolor="${bg}" fill="f"` : `stroke="f" fillcolor="${bg}"`}><w:anchorlock/><center style="color:${fg};font-family:Arial,sans-serif;font-size:15px;font-weight:bold;">${esc(label)}</center></v:roundrect><![endif]-->`
    + `<!--[if !mso]><!--><a href="${esc(url)}" style="display:inline-block;padding:12px 24px;font-family:${ff};font-size:15px;font-weight:bold;line-height:20px;color:${fg};text-decoration:none;border-radius:${radius}px;${outline ? '' : `background:${bg};`}">${esc(label)}</a><!--<![endif]-->`
    + '</td></tr></table>';
}

const SOCIAL_LABEL = { linkedin: 'LinkedIn', x: 'X', twitter: 'X', instagram: 'Instagram', facebook: 'Facebook', youtube: 'YouTube', web: 'Website', github: 'GitHub', tiktok: 'TikTok' };

/** Evaluates a block's showIf condition. */
export function blockVisible(block, ctx) {
  const c = block.showIf;
  if (!c?.field) return true;
  const v = renderMailTemplate(`{{${c.field}}}`, { type: ctx.type, record: ctx.record }).text;
  const val = v.startsWith('{{') ? '' : v.trim();
  switch (c.op) {
    case 'empty': return !val;
    case 'eq': return val.toLowerCase() === String(c.value || '').trim().toLowerCase();
    case 'neq': return val.toLowerCase() !== String(c.value || '').trim().toLowerCase();
    case 'contains': return val.toLowerCase().includes(String(c.value || '').trim().toLowerCase());
    default: return !!val; // 'set'
  }
}

/**
 * Renders a design to { html, text, size, warnings }.
 * ctx: { brand, type, record, me, ask, dateFormat, md: (markdown)=>html, bodyMd, subject, preheader }
 */
export function renderDesign(design, ctx) {
  const brand = ctx.brand || {};
  const ff = fontStack(brand.font);
  const textColor = brand.text || '#1f2933';
  const muted = brand.muted || '#6b7785';
  const surface = brand.surface || '#ffffff';
  const bgc = brand.background || '#f3f5f8';
  const width = Number(design.width) || 600;
  const tplOpts = { type: ctx.type, record: ctx.record, me: ctx.me || {}, ask: ctx.ask || {}, ctx: { dateFormat: ctx.dateFormat } };
  const fill = (s, html = false) => renderMailTemplate(s || '', { ...tplOpts, escape: html ? esc : null }).text;
  const md = (s, opts) => inlineBasicStyles(ctx.md(fill(s)), brand, opts);
  const rows = [];
  const text = [];
  const warnings = [];
  const pad = b => (b.pad != null ? `${px(b.pad)} 32px` : '16px 32px');
  const row = (b, inner, style = '') => rows.push(`<tr><td class="px" style="padding:${pad(b)};${b.bg ? `background:${colorOf(b.bg, brand)};` : ''}${style}">${inner}</td></tr>`);

  for (const b of design.blocks || []) {
    if (!blockVisible(b, ctx)) continue;
    switch (b.type) {
      case 'header': {
        const isBrand = b.style !== 'plain';
        const bg = isBrand ? brand.primary || '#2f6fed' : surface;
        const fg = isBrand ? contrastText(bg) : textColor;
        const logo = brand.logo ? `<img src="${brand.logo}" width="${Number(brand.logoWidth) || 140}" alt="${esc(brand.companyName || '')}" style="display:inline-block;border:0;max-width:100%;height:auto;">` : (brand.companyName ? `<span style="font-family:${ff};font-size:20px;font-weight:bold;color:${fg};">${esc(brand.companyName)}</span>` : '');
        const title = b.title ? `<div style="font-family:${ff};font-size:24px;line-height:1.3;font-weight:bold;color:${fg};margin-top:${logo ? 14 : 0}px;">${esc(fill(b.title))}</div>` : '';
        if (logo || title) rows.push(`<tr><td class="px" align="${b.align || 'center'}" style="padding:28px 32px;background:${bg};text-align:${b.align || 'center'};${isBrand ? '' : `border-bottom:1px solid #eef0f3;`}">${logo}${title}</td></tr>`);
        if (b.title) text.push(fill(b.title).toUpperCase(), '');
        break;
      }
      case 'heading': {
        const size = b.level === 2 ? 20 : 26;
        row(b, `<h${b.level === 2 ? 2 : 1} style="margin:0;font-family:${ff};font-size:${size}px;line-height:1.25;color:${textColor};text-align:${b.align || 'left'};">${esc(fill(b.text))}</h${b.level === 2 ? 2 : 1}>`);
        text.push(fill(b.text), '');
        break;
      }
      case 'text':
        row(b, md(b.md, { align: b.align }));
        text.push(fill(b.md), '');
        break;
      case 'body':
        row(b, inlineBasicStyles(ctx.md(ctx.bodyMd || ''), brand));
        text.push(ctx.bodyMd || '', '');
        break;
      case 'image': {
        if (!b.src) break;
        const pct = Math.max(10, Math.min(100, Number(b.width) || 100));
        const wpx = Math.round((width - 64) * pct / 100);
        const img = `<img src="${esc(b.src)}" width="${wpx}" alt="${esc(fill(b.alt))}" style="display:block;width:100%;max-width:${wpx}px;height:auto;border:0;border-radius:${b.radius ? 8 : 0}px;margin:0 auto;">`;
        row(b, `<div style="text-align:${b.align || 'center'};">${b.link ? `<a href="${esc(fill(b.link))}">${img}</a>` : img}</div>`);
        if (b.alt) text.push(`[${fill(b.alt)}]${b.link ? ` ${fill(b.link)}` : ''}`, '');
        break;
      }
      case 'button': {
        const url = fill(b.url);
        if (!/\{\{\s*\?/.test(b.url || '') &&!/^(https?:|mailto:|tel:|crm-)/i.test(url)) warnings.push(`Button “${b.label}” has no valid link.`);
        row(b, `<div style="text-align:${b.align || 'center'};">${buttonHtml({ label: fill(b.label), url, color: b.color, style: b.btnStyle || 'filled', brand })}</div>`);
        text.push(`${fill(b.label)}: ${url}`, '');
        break;
      }
      case 'interest': {
        const q = b.question ? `<p style="margin:0 0 12px 0;font-family:${ff};font-size:16px;font-weight:bold;color:${textColor};text-align:center;">${esc(fill(b.question))}</p>` : '';
        const btns = (b.options || []).filter(o => o.label).map(o => buttonHtml({ label: fill(o.label), url: `crm-interest:${encodeURIComponent(o.choice || o.label)}`, color: o.color || (o.style === 'outline' ? 'primary' : 'primary'), style: o.style || 'filled', brand })).join(' ');
        row(b, `${q}<div style="text-align:center;">${btns}</div>`);
        if (b.question) text.push(fill(b.question));
        for (const o of b.options || []) if (o.label) text.push(`- ${fill(o.label)}: crm-interest:${encodeURIComponent(o.choice || o.label)}`);
        text.push('');
        break;
      }
      case 'columns': {
        const cols = (b.cols || []).slice(0, 3);
        const w = Math.floor(100 / Math.max(1, cols.length));
        const cells = cols.map(c => `<td class="col" width="${w}%" valign="top" style="padding:0 8px;">${c.src ? `<img src="${esc(c.src)}" width="${Math.round((width - 64) / cols.length) - 16}" alt="" style="display:block;width:100%;height:auto;border:0;border-radius:6px;margin:0 0 10px 0;">` : ''}${md(c.md, { size: 14 })}</td>`).join('');
        row(b, `<table role="presentation" width="100%" border="0" cellspacing="0" cellpadding="0"><tr>${cells}</tr></table>`);
        for (const c of cols) text.push(fill(c.md), '');
        break;
      }
      case 'quote':
        row(b, `<table role="presentation" width="100%" border="0" cellspacing="0" cellpadding="0"><tr><td style="border-left:4px solid ${brand.accent || '#ff8a3d'};padding:6px 0 6px 16px;">${md(b.md, { size: 17, color: textColor })}${b.author ? `<p style="margin:0;font-family:${ff};font-size:13px;color:${muted};">— ${esc(fill(b.author))}</p>` : ''}</td></tr></table>`);
        text.push(`"${fill(b.md)}"${b.author ? ` — ${fill(b.author)}` : ''}`, '');
        break;
      case 'divider':
        row(b, '<table role="presentation" width="100%" border="0" cellspacing="0" cellpadding="0"><tr><td style="border-top:1px solid #e4e7ec;font-size:0;line-height:0;height:1px;">&nbsp;</td></tr></table>');
        text.push('----------', '');
        break;
      case 'spacer':
        rows.push(`<tr><td style="height:${px(b.height || 24)};font-size:0;line-height:0;">&nbsp;</td></tr>`);
        break;
      case 'social': {
        const links = (brand.social || []).filter(s => s.url);
        if (!links.length) break;
        const items = links.map(s => `<a href="${esc(s.url)}" style="display:inline-block;margin:0 6px;padding:6px 12px;border:1px solid #d0d5dd;border-radius:16px;font-family:${ff};font-size:13px;color:${textColor};text-decoration:none;">${esc(SOCIAL_LABEL[s.kind] || s.kind || 'Link')}</a>`).join('');
        row(b, `<div style="text-align:${b.align || 'center'};">${items}</div>`);
        text.push(links.map(s => `${SOCIAL_LABEL[s.kind] || s.kind}: ${s.url}`).join(' | '), '');
        break;
      }
      case 'signature':
        row(b, md(b.md, { size: 15 }));
        text.push(fill(b.md), '');
        break;
      case 'footer': {
        const lines = [brand.footer, brand.address].filter(Boolean).map(s => esc(fill(s)).replace(/\n/g, '<br>'));
        const unsub = b.unsubscribe !== false && b.unsubscribe !== 'false' ? `<a href="crm-unsubscribe:" style="color:${muted};text-decoration:underline;">Unsubscribe</a>` : '';
        rows.push(`__FOOTER__<tr><td class="px" align="center" style="padding:20px 32px;font-family:${ff};font-size:12px;line-height:1.6;color:${muted};text-align:center;">${lines.join('<br>')}${unsub ? `${lines.length ? '<br>' : ''}${unsub}` : ''}</td></tr>`);
        if (brand.footer) text.push(fill(brand.footer));
        if (brand.address) text.push(fill(brand.address));
        if (b.unsubscribe !== false) text.push('Unsubscribe: crm-unsubscribe:');
        break;
      }
      default: break;
    }
  }
  const footer = rows.filter(r => r.startsWith('__FOOTER__')).map(r => r.slice(10)).join('');
  const card = rows.filter(r => !r.startsWith('__FOOTER__')).join('');
  const preheader = fill(ctx.preheader || design.preheader || '');
  const html = '<!doctype html><html lang="en" xmlns="http://www.w3.org/1999/xhtml" xmlns:v="urn:schemas-microsoft-com:vml" xmlns:o="urn:schemas-microsoft-com:office:office"><head>'
    + '<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="x-apple-disable-message-reformatting">'
    + '<meta name="color-scheme" content="light"><meta name="supported-color-schemes" content="light">'
    + `<title>${esc(ctx.subject || '')}</title>${googleFontLink(brand.font)}`
    + '<!--[if mso]><noscript><xml><o:OfficeDocumentSettings><o:PixelsPerInch>96</o:PixelsPerInch></o:OfficeDocumentSettings></xml></noscript><style>table,td,div,h1,h2,p,a{font-family:Arial,sans-serif !important;}</style><![endif]-->'
    + `<style>body{margin:0;padding:0;-webkit-text-size-adjust:100%;}table{border-collapse:collapse;}img{border:0;outline:none;text-decoration:none;}@media only screen and (max-width:${width + 20}px){.card{width:100% !important;}.px{padding-left:18px !important;padding-right:18px !important;}.col{display:block !important;width:100% !important;padding:0 0 12px 0 !important;}}</style>`
    + `</head><body style="margin:0;padding:0;background:${bgc};">`
    + (preheader ? `<div style="display:none;max-height:0;overflow:hidden;mso-hide:all;font-size:1px;line-height:1px;color:${bgc};">${esc(preheader)}${'&nbsp;&zwnj;'.repeat(30)}</div>` : '')
    + `<table role="presentation" width="100%" border="0" cellspacing="0" cellpadding="0" bgcolor="${bgc}" style="background:${bgc};"><tr><td align="center" style="padding:24px 10px;">`
    + `<!--[if mso]><table role="presentation" width="${width}" border="0" cellspacing="0" cellpadding="0"><tr><td><![endif]-->`
    + `<table role="presentation" class="card" width="${width}" border="0" cellspacing="0" cellpadding="0" style="width:100%;max-width:${width}px;background:${surface};border-radius:10px;overflow:hidden;">${card}</table>`
    + (footer ? `<table role="presentation" class="card" width="${width}" border="0" cellspacing="0" cellpadding="0" style="width:100%;max-width:${width}px;">${footer}</table>` : '')
    + '<!--[if mso]></td></tr></table><![endif]-->'
    + '</td></tr></table></body></html>';
  const size = html.replace(/data:[^"')\s]+/g, 'cid:x').length;
  if (size > 95 * 1024) warnings.push(`The email is ${Math.round(size / 1024)} KB. Gmail cuts emails larger than about 100 KB (“Message clipped”).`);
  const textOut = text.join('\n').replace(/\n{3,}/g, '\n\n').replace(/\*\*(.+?)\*\*/g, '$1').replace(/\[([^\]]+)\]\(([^)]+)\)/g, '$1 ($2)').trim();
  return { html, text: textOut, size, warnings };
}

// ---------------------------------------------------------------------------------------------
/** Eight generic starter designs (all use the brand kit). */
export function starterDesigns() {
  const B = (type, props = {}) => ({ ...newBlock(type), ...props });
  const t = (name, category, subject, body, blocks, preheader = '') => ({ name, category, tags: ['design'], subject, body, design: { width: 600, preheader, blocks } });
  return [
    t('Introduction (designed)', 'Outreach', 'Nice to meet you, {{fullName|first|or:"there"}}',
      'Hi {{fullName|first|or:"there"}},\n\nI came across your profile and I think there could be a great fit with what you do.\n\nWould you be open to a short call?',
      [B('header'), B('body'), B('interest', { question: 'Interested?' }), B('signature', { md: 'Best regards,\n\n**{{me.name}}**' }), B('footer')], 'A quick introduction'),
    t('Follow-up (designed)', 'Outreach', 'Just following up',
      'Hi {{fullName|first|or:"there"}},\n\nJust checking whether my last message reached you. Happy to share more whenever it suits you.',
      [B('header', { style: 'plain' }), B('body'), B('button', { label: 'Book a time that suits you', url: '{{?Booking link}}' }), B('signature'), B('footer')]),
    t('Newsletter / update', 'Updates', '{{?Headline}}',
      'Here is what is new this month.',
      [B('header', { title: '{{?Headline}}' }), B('body'), B('image', { src: '', alt: 'Feature image' }), B('heading', { text: 'Highlights', level: 2 }), B('columns'), B('button', { label: 'Read more', url: '{{?Link}}' }), B('divider'), B('social'), B('footer')], 'News and highlights'),
    t('Event invitation', 'Events', 'You are invited: {{?Event name}}',
      'Hi {{fullName|first|or:"there"}},\n\nWe would love to see you at **{{?Event name}}** on {{?Date}}.',
      [B('header', { title: 'You’re invited' }), B('body'), B('columns', { cols: [{ md: '**When**\n\n{{?Date}}' }, { md: '**Where**\n\n{{?Place}}' }] }), B('button', { label: 'Save my seat', url: '{{?RSVP link}}' }), B('signature'), B('footer')], 'An invitation for you'),
    t('Offer / proposal', 'Sales', 'Your proposal, {{fullName|first|or:"there"}}',
      'Hi {{fullName|first|or:"there"}},\n\nAs discussed, here is our proposal. The key points are below.',
      [B('header', { title: 'Your proposal' }), B('body'), B('quote', { md: '{{?Key benefit}}', author: '' }), B('button', { label: 'View the proposal', url: '{{?Proposal link}}' }), B('interest', { question: 'What would you like to do next?', options: [{ label: 'Let’s go ahead', choice: 'accept', style: 'filled' }, { label: 'I have questions', choice: 'questions', style: 'outline' }, { label: 'Not now', choice: 'not-now', style: 'link' }] }), B('signature'), B('footer')]),
    t('Thank you (designed)', 'General', 'Thank you, {{fullName|first|or:"there"}}!',
      'Hi {{fullName|first|or:"there"}},\n\nThank you for your time today. It was great to talk with you.',
      [B('header', { style: 'plain' }), B('heading', { text: 'Thank you!', align: 'center' }), B('body'), B('signature'), B('footer', { unsubscribe: false })]),
    t('Meeting request (designed)', 'Meetings', 'A quick call, {{fullName|first|or:"there"}}?',
      'Hi {{fullName|first|or:"there"}},\n\nWould you have 20 minutes for a quick call this week or next?',
      [B('header', { style: 'plain' }), B('body'), B('button', { label: 'Pick a time', url: '{{?Booking link}}' }), B('signature'), B('footer', { unsubscribe: false })]),
    t('Announcement', 'Updates', '{{?Announcement}}',
      'We have some news to share with you.',
      [B('header', { title: '{{?Announcement}}' }), B('image', { src: '', alt: '' }), B('body'), B('button', { label: 'Find out more', url: '{{?Link}}', color: 'accent' }), B('social'), B('footer')]),
  ];
}
