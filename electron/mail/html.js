// First-pass HTML cleaning in the main process (the renderer runs DOMPurify again and shows mail in a
// sandboxed, script-less iframe with a CSP that blocks remote content until the user allows it).

const DROP_TAGS = ['script', 'iframe', 'frame', 'frameset', 'object', 'embed', 'applet', 'form', 'base', 'meta', 'link', 'noscript', 'template', 'portal', 'svg'];

export function cleanHtml(html, { inline = {} } = {}) {
  let s = String(html || '');
  for (const t of DROP_TAGS) {
    s = s.replace(new RegExp(`<${t}\\b[\\s\\S]*?<\\/${t}\\s*>`, 'gi'), '');
    s = s.replace(new RegExp(`<\\/?${t}\\b[^>]*>`, 'gi'), '');
  }
  s = s.replace(/<!--[\s\S]*?-->/g, '');
  s = s.replace(/\s(on[a-z]+)\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/gi, '');
  s = s.replace(/(href|src|action|formaction|background|poster|xlink:href)\s*=\s*(["']?)\s*(javascript|vbscript|data:text\/html)[^"'>\s]*\2/gi, '$1=""');
  s = s.replace(/expression\s*\(/gi, 'x(');
  // cid: images -> data: URLs from inline attachments
  s = s.replace(/(src\s*=\s*["']?)cid:([^"'\s>]+)/gi, (m, pre, cid) => {
    const key = decodeURIComponent(cid).replace(/^<|>$/g, '');
    return inline[key] ? `${pre}${inline[key]}` : `${pre}`;
  });
  const remote = /<img\b[^>]*\ssrc\s*=\s*["']?https?:/i.test(s) || /url\(\s*["']?https?:/i.test(s) || /background\s*=\s*["']?https?:/i.test(s);
  return { html: s, remoteImages: remote };
}

/** Very small HTML -> text, used when a message has no text part. */
export function htmlToText(html) {
  return String(html || '')
    .replace(/<(style|script|head)[\s\S]*?<\/\1>/gi, '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|h[1-6]|li|tr|table|blockquote)>/gi, '\n')
    .replace(/<li[^>]*>/gi, '• ')
    .replace(/<a\b[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi, (m, href, txt) => {
      const t = txt.replace(/<[^>]+>/g, '').trim();
      return t && !href.startsWith('mailto:') && t !== href ? `${t} (${href})` : t || href;
    })
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, '\'')
    .replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
}
