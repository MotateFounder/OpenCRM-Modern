// Safe display of an email body: DOMPurify + a sandboxed, script-less iframe whose own CSP blocks
// remote images/fonts until the user allows them (tracking-pixel protection).
import DOMPurify from '/vendor/purify.js';
import { h } from './dom.js';
import { escapeHtml } from './shared.js';

const BASE_CSS = `
html,body{margin:0;padding:0;background:#fff;color:#202124}
body{padding:12px 14px;font:14px/1.5 "Segoe UI",Arial,Helvetica,sans-serif;word-wrap:break-word;overflow-wrap:anywhere}
img{max-width:100%;height:auto}
table{max-width:100%}
pre.txt{white-space:pre-wrap;font:inherit;margin:0}
blockquote,.q{margin:6px 0;padding:0 0 0 10px;border-left:3px solid #c7cbd1;color:#5f6368}
a{color:#1a73e8}
details.quoted summary{cursor:pointer;color:#5f6368;font-size:12px;list-style:none;display:inline-block;padding:0 6px;border:1px solid #dadce0;border-radius:8px;margin:6px 0}
img.blocked{display:inline-block;min-width:16px;min-height:16px;background:#f1f3f4;border:1px dashed #dadce0}
`;

function linkifyEscaped(s) {
  return s.replace(/((?:https?:\/\/|www\.)[^\s<>"']+[^\s<>"'.,;:!?)\]])/gi, m => `<a href="${m.startsWith('www.') ? 'https://' + m : m}">${m}</a>`);
}

/** Plain text -> HTML with quoted history folded away. */
export function textToHtml(text) {
  const lines = String(text || '').replace(/\r\n/g, '\n').split('\n');
  let quoteStart = lines.findIndex((l, i) => /^\s*>/.test(l) && lines.slice(i).filter(x => x.trim()).every(x => /^\s*>/.test(x) || /wrote:\s*$/.test(x)));
  const wrote = quoteStart > 0 && /wrote:\s*$|escribió:\s*$/.test(lines[quoteStart - 1]) ? quoteStart - 1 : quoteStart;
  const main = (wrote >= 0 ? lines.slice(0, wrote) : lines).join('\n');
  const quoted = wrote >= 0 ? lines.slice(wrote).join('\n') : '';
  let out = `<pre class="txt">${linkifyEscaped(escapeHtml(main.trimEnd()))}</pre>`;
  if (quoted.trim()) out += `<details class="quoted"><summary>•••</summary><pre class="txt q">${linkifyEscaped(escapeHtml(quoted))}</pre></details>`;
  return out;
}

export function sanitizeMailHtml(html) {
  return DOMPurify.sanitize(html, {
    WHOLE_DOCUMENT: true,
    ADD_TAGS: ['style'],
    ADD_ATTR: ['target', 'bgcolor', 'background', 'align', 'valign', 'cellpadding', 'cellspacing', 'border', 'width', 'height'],
    FORBID_TAGS: ['form', 'input', 'button', 'textarea', 'select', 'iframe', 'object', 'embed', 'script', 'link', 'meta', 'base'],
    ALLOW_UNKNOWN_PROTOCOLS: false,
  });
}

/**
 * Returns an auto-sized iframe showing the message. opts: { allowImages, onLinkClick(url) }
 */
export function mailFrame(body, { allowImages = false, maxHeight = 0 } = {}) {
  let inner;
  if (body?.html) {
    const clean = sanitizeMailHtml(body.html);
    const m = clean.match(/<head[^>]*>([\s\S]*?)<\/head>\s*<body([^>]*)>([\s\S]*)<\/body>/i);
    inner = m ? { head: m[1], bodyAttrs: m[2].replace(/\son\w+=("[^"]*"|'[^']*')/gi, ''), body: m[3] } : { head: '', bodyAttrs: '', body: clean };
  } else {
    inner = { head: '', bodyAttrs: '', body: textToHtml(body?.text || '') };
  }
  if (!allowImages) {
    // don't even try to fetch remote content (the CSP below also blocks it)
    const strip = s => s
      .replace(/(<img\b[^>]*?)\ssrc\s*=\s*(["'])\s*(?:https?:)?\/\/[^"']*\2/gi, '$1 src="" data-blocked="1"')
      .replace(/\s(background)\s*=\s*(["'])\s*(?:https?:)?\/\/[^"']*\2/gi, '')
      .replace(/url\(\s*(["']?)\s*(?:https?:)?\/\/[^)]*\)/gi, 'none')
      .replace(/(<(?:source|img)\b[^>]*?)\ssrcset\s*=\s*(["'])[^"']*\2/gi, '$1');
    inner.head = strip(inner.head); inner.body = strip(inner.body); inner.bodyAttrs = strip(inner.bodyAttrs);
  }
  const img = allowImages ? 'data: https: http:' : 'data:';
  const csp = `default-src 'none'; style-src 'unsafe-inline'; img-src ${img}; font-src data:${allowImages ? ' https:' : ''}; media-src 'none'`;
  const doc = `<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="${csp}"><meta name="referrer" content="no-referrer"><style>${BASE_CSS}</style>${inner.head}</head><body${inner.bodyAttrs}>${inner.body}</body></html>`;
  const frame = h('iframe', { class: 'mail-frame', sandbox: 'allow-same-origin', referrerpolicy: 'no-referrer', title: 'Email content' });
  frame.srcdoc = doc;
  const fit = () => {
    try {
      const d = frame.contentDocument;
      if (!d?.documentElement) return;
      const hgt = Math.max(d.documentElement.scrollHeight, d.body?.scrollHeight || 0) + 2;
      frame.style.height = `${maxHeight ? Math.min(hgt, maxHeight) : hgt}px`;
    } catch { /* ignore */ }
  };
  frame.addEventListener('load', () => {
    const d = frame.contentDocument;
    if (!d) return;
    fit();
    d.addEventListener('click', e => {
      const a = e.target.closest?.('a[href]');
      if (!a) return;
      e.preventDefault();
      const href = a.getAttribute('href') || '';
      if (/^(https?:|mailto:)/i.test(href)) window.crm.app.openExternal(href);
    });
    for (const im of d.images) {
      im.addEventListener('load', fit);
      im.addEventListener('error', fit);
    }
    for (const det of d.querySelectorAll('details')) det.addEventListener('toggle', fit);
    setTimeout(fit, 300); setTimeout(fit, 1200);
  });
  return frame;
}

export function hasRemoteContent(body) { return !!body?.remoteImages; }

export function avatarDot(name, address) {
  const label = (name || address || '?').trim();
  const parts = label.split(/[\s@._-]+/).filter(Boolean);
  const ini = ((parts[0]?.[0] || '?') + (parts.length > 1 ? parts[1][0] : '')).toUpperCase();
  let x = 0;
  for (const ch of String(address || label)) x = (x * 31 + ch.charCodeAt(0)) >>> 0;
  return h('span', { class: 'mail-ava', style: { background: `hsl(${x % 360} 45% 55%)` } }, ini);
}
