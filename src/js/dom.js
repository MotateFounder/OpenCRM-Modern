// Tiny DOM helpers. All user data goes through text nodes / properties, never innerHTML.

export function h(tag, props, ...children) {
  const el = document.createElement(tag);
  if (props) {
    for (const [k, v] of Object.entries(props)) {
      if (v == null || v === false) continue;
      if (k === 'class') el.className = Array.isArray(v) ? v.filter(Boolean).join(' ') : v;
      else if (k === 'style' && typeof v === 'object') {
        for (const [sk, sv] of Object.entries(v)) {
          if (sv == null) continue;
          if (sk.startsWith('--')) el.style.setProperty(sk, sv); else el.style[sk] = sv;
        }
      }
      else if (k === 'dataset') Object.assign(el.dataset, v);
      else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2).toLowerCase(), v);
      else if (k in el && !['list', 'form', 'type'].includes(k) && typeof v !== 'string') el[k] = v;
      else if (k === 'value' || k === 'checked' || k === 'selected' || k === 'disabled' || k === 'title' || k === 'placeholder') el[k] = v;
      else el.setAttribute(k, v === true ? '' : String(v));
    }
  }
  append(el, children);
  return el;
}

export function append(el, children) {
  for (const c of children.flat(Infinity)) {
    if (c == null || c === false || c === true) continue;
    el.appendChild(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  return el;
}

export function clear(el) { while (el.firstChild) el.removeChild(el.firstChild); return el; }

export function replace(el, ...children) { clear(el); return append(el, children); }

export const $ = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

export function debounce(fn, ms) {
  let t;
  const d = (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); };
  d.cancel = () => clearTimeout(t);
  d.flush = (...a) => { clearTimeout(t); fn(...a); };
  return d;
}

export function initials(name) {
  const parts = String(name || '?').trim().split(/\s+/).filter(Boolean);
  return ((parts[0]?.[0] || '?') + (parts.length > 1 ? parts[parts.length - 1][0] : '')).toUpperCase();
}

export function hashColor(s) {
  let x = 0;
  for (const ch of String(s)) x = (x * 31 + ch.charCodeAt(0)) >>> 0;
  return `hsl(${x % 360} 45% 55%)`;
}

export function fmtSize(n) {
  if (!n && n !== 0) return '';
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

const URL_RE = /((?:https?:\/\/|www\.)[^\s<>"']+[^\s<>"'.,;:!?)\]])/gi;

// Plain text with clickable links and preserved line breaks (v1 note rendering, safer).
export function linkify(text) {
  const frag = document.createDocumentFragment();
  const lines = String(text || '').split(/\r\n|\r|\n/);
  lines.forEach((line, i) => {
    let last = 0;
    for (const m of line.matchAll(URL_RE)) {
      if (m.index > last) frag.appendChild(document.createTextNode(line.slice(last, m.index)));
      const url = m[0];
      frag.appendChild(h('a', { href: url.startsWith('www.') ? `https://${url}` : url, class: 'ext' }, url));
      last = m.index + url.length;
    }
    if (last < line.length) frag.appendChild(document.createTextNode(line.slice(last)));
    if (i < lines.length - 1) frag.appendChild(document.createElement('br'));
  });
  return frag;
}

export function externalHref(url) {
  const u = String(url || '').trim();
  if (!u) return '';
  if (/^[a-z][a-z0-9+.-]*:/i.test(u)) return u;
  return `https://${u}`;
}

export function pictureSrc(value) {
  const v = String(value || '').trim();
  if (!v) return '';
  if (v.startsWith('file:')) return `app://crm/__files/${v.slice(5).split('/').map(encodeURIComponent).join('/')}`;
  if (/^https?:\/\//i.test(v) || v.startsWith('data:image/')) return v;
  if (v.startsWith('www.')) return `https://${v}`;
  return '';
}
