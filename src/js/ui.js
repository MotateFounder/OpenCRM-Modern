// Toasts, modals, dialogs, popovers and context menus.
import { h, clear } from './dom.js';

// ---------- toasts ----------
export function toast(message, { type = 'info', action = null, timeout = 3500 } = {}) {
  let host = document.getElementById('toasts');
  if (!host) { host = h('div', { id: 'toasts' }); document.body.appendChild(host); }
  const el = h('div', { class: `toast toast-${type}`, role: 'status' },
    h('span', { class: 'toast-msg' }, message),
    action ? h('button', { class: 'btn-link', onclick: () => { action.fn(); el.remove(); } }, action.label) : null,
    h('button', { class: 'toast-x', title: 'Dismiss', onclick: () => el.remove() }, '×'),
  );
  host.appendChild(el);
  if (timeout) setTimeout(() => el.remove(), action ? Math.max(timeout, 7000) : timeout);
  return el;
}

// ---------- modals ----------
const stack = [];

export function openModal({ title, body, actions = [], size = 'md', onClose, className = '', closeOnBackdrop = true, headerExtra = null } = {}) {
  const prevFocus = document.activeElement;
  const backdrop = h('div', { class: 'modal-backdrop' });
  const close = (result) => {
    if (!backdrop.isConnected) return;
    backdrop.remove();
    stack.splice(stack.indexOf(api), 1);
    onClose?.(result);
    prevFocus?.focus?.();
  };
  const footer = actions.length ? h('div', { class: 'modal-footer' },
    actions.map(a => a === 'spacer' ? h('span', { class: 'spacer' }) : h('button', {
      class: ['btn', a.primary && 'btn-primary', a.danger && 'btn-danger'], disabled: a.disabled,
      onclick: async () => { const r = await a.fn?.(api); if (r !== false && !a.keepOpen) close(a.value); },
    }, a.label))) : null;
  const dialog = h('div', { class: ['modal', `modal-${size}`, className], role: 'dialog', 'aria-modal': 'true' },
    h('div', { class: 'modal-header' },
      h('h2', { class: 'modal-title' }, title || ''),
      headerExtra,
      h('button', { class: 'icon-btn modal-x', title: 'Close (Esc)', onclick: () => close() }, '×')),
    h('div', { class: 'modal-body' }, body),
    footer);
  backdrop.appendChild(dialog);
  if (closeOnBackdrop) backdrop.addEventListener('mousedown', e => { if (e.target === backdrop) close(); });
  document.body.appendChild(backdrop);
  const api = { el: dialog, body: dialog.querySelector('.modal-body'), footer, close, setTitle: t => { dialog.querySelector('.modal-title').textContent = t; } };
  stack.push(api);
  setTimeout(() => (dialog.querySelector('[autofocus]') || dialog.querySelector('input,textarea,select,button.btn-primary'))?.focus(), 0);
  return api;
}

export function topModal() { return stack[stack.length - 1] || null; }
export function anyModalOpen() { return stack.length > 0; }

export function confirmDialog(message, { title = 'Please confirm', okLabel = 'OK', cancelLabel = 'Cancel', danger = false, detail = '' } = {}) {
  return new Promise(resolve => {
    let done = false;
    openModal({
      title, size: 'sm',
      body: h('div', {}, h('p', { class: 'pre' }, message), detail ? h('p', { class: 'muted pre' }, detail) : null),
      actions: [
        { label: cancelLabel, fn: () => { done = true; resolve(false); } },
        { label: okLabel, primary: !danger, danger, fn: () => { done = true; resolve(true); } },
      ],
      onClose: () => { if (!done) resolve(false); },
    });
  });
}

export function choiceDialog(message, choices, { title = 'Choose', detail = '' } = {}) {
  return new Promise(resolve => {
    let done = false;
    openModal({
      title, size: 'sm',
      body: h('div', {}, h('p', { class: 'pre' }, message), detail ? h('p', { class: 'muted pre' }, detail) : null),
      actions: choices.map(c => ({ label: c.label, primary: c.primary, danger: c.danger, fn: () => { done = true; resolve(c.value); } })),
      onClose: () => { if (!done) resolve(null); },
    });
  });
}

export function promptDialog(title, { value = '', placeholder = '', multiline = false, label = '', okLabel = 'OK', validate } = {}) {
  return new Promise(resolve => {
    let done = false;
    const input = multiline
      ? h('textarea', { class: 'input', rows: 6, value, placeholder, autofocus: true })
      : h('input', { class: 'input', value, placeholder, autofocus: true });
    const err = h('div', { class: 'error-text' });
    const submit = (m) => {
      const v = input.value;
      const msg = validate?.(v);
      if (msg) { err.textContent = msg; return false; }
      done = true; resolve(v); m?.close();
      return true;
    };
    const m = openModal({
      title, size: 'sm',
      body: h('div', {}, label ? h('label', { class: 'field-label' }, label) : null, input, err),
      actions: [
        { label: 'Cancel', fn: () => { done = true; resolve(null); } },
        { label: okLabel, primary: true, keepOpen: true, fn: (api) => { submit(api); return false; } },
      ],
      onClose: () => { if (!done) resolve(null); },
    });
    if (!multiline) input.addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); submit(m); } });
  });
}

// ---------- popovers / menus ----------
let openPop = null;

export function closePopover() { if (openPop) { const p = openPop; openPop = null; p.remove(); p._onClose?.(); } }

export function popover(anchor, content, { className = '', onClose, align = 'left' } = {}) {
  closePopover();
  const pop = h('div', { class: ['popover', className] }, content);
  pop._onClose = onClose;
  document.body.appendChild(pop);
  const r = anchor.getBoundingClientRect ? anchor.getBoundingClientRect() : { left: anchor.x, right: anchor.x, top: anchor.y, bottom: anchor.y };
  const pw = pop.offsetWidth, ph = pop.offsetHeight;
  let left = align === 'right' ? r.right - pw : r.left;
  let top = r.bottom + 4;
  if (left + pw > window.innerWidth - 8) left = window.innerWidth - pw - 8;
  if (top + ph > window.innerHeight - 8) top = Math.max(8, r.top - ph - 4);
  pop.style.left = `${Math.max(8, left)}px`;
  pop.style.top = `${top}px`;
  openPop = pop;
  setTimeout(() => {
    const off = (e) => {
      if (!openPop || openPop !== pop) { document.removeEventListener('mousedown', off, true); return; }
      if (!pop.contains(e.target) && !(anchor instanceof Element && anchor.contains(e.target))) {
        document.removeEventListener('mousedown', off, true);
        closePopover();
      }
    };
    document.addEventListener('mousedown', off, true);
  }, 0);
  return pop;
}

// items: [{label, icon, fn, danger, disabled, sub:[...], checked}] or 'sep' or {header}
export function menu(anchor, items, opts = {}) {
  const build = list => h('div', { class: 'menu' }, list.map(it => {
    if (it === 'sep') return h('div', { class: 'menu-sep' });
    if (it.header) return h('div', { class: 'menu-header' }, it.header);
    if (it.sub) {
      const row = h('div', { class: 'menu-item has-sub' }, h('span', { class: 'mi-icon' }, it.icon || ''), h('span', { class: 'mi-label' }, it.label), h('span', { class: 'mi-arrow' }, '▸'));
      const sub = build(it.sub);
      sub.classList.add('submenu');
      row.appendChild(sub);
      return row;
    }
    return h('div', {
      class: ['menu-item', it.danger && 'danger', it.disabled && 'disabled'],
      onclick: (e) => { if (it.disabled) return; e.stopPropagation(); closePopover(); it.fn?.(); },
    }, h('span', { class: 'mi-icon' }, it.checked ? '✓' : (it.icon || '')), h('span', { class: 'mi-label' }, it.label), it.hint ? h('span', { class: 'mi-hint' }, it.hint) : null);
  }));
  return popover(anchor, build(items), { className: 'menu-pop', ...opts });
}

export function contextMenuAt(x, y, items) {
  return menu({ getBoundingClientRect: () => ({ left: x, right: x, top: y, bottom: y }) }, items);
}

export function field(label, control, hint) {
  return h('div', { class: 'form-row' }, h('label', { class: 'field-label' }, label), control, hint ? h('div', { class: 'hint' }, hint) : null);
}

export function emptyState(text, action) {
  return h('div', { class: 'empty-state' }, h('p', {}, text), action || null);
}

export { clear };
