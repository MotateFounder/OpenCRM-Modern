// Compose / reply / forward window: recipients with autocomplete from the CRM, templates with {{fields}},
// send-time fields, attachments, signature, read receipt, undo send, local drafts.
import { marked } from '/vendor/marked.js';
import DOMPurify from '/vendor/purify.js';
import { h, replace, debounce } from './dom.js';
import { store, findRecord } from './store.js';
import {
  recordTitle, getType, parseAddressList, formatAddressList, formatAddress, buildAddressIndex, refsForAddress, recordEmails,
  replySubject, replyRecipients, replyHeaders, quoteText, forwardText, renderMailTemplate, sendTimeFields, escapeHtml, isValidEmail, humanSize,
} from './shared.js';
import { simpleEmailHtml } from '../shared/email-design.js';
import { mail, defaultAccount, recordForRef } from './mail-state.js';
import { openModal, toast, confirmDialog, menu } from './ui.js';
import { hooks } from './hooks.js';

export function mdToEmailHtml(md) {
  return DOMPurify.sanitize(marked.parse(String(md || ''), { gfm: true, breaks: true }), { USE_PROFILES: { html: true } });
}

/** All addresses known to the CRM, for autocomplete. */
function addressBook() {
  const out = [];
  for (const t of store.data.meta.recordTypes) {
    for (const r of store.data[t.key] || []) {
      for (const a of recordEmails(t, r)) out.push({ name: recordTitle(t, r), address: a, ref: `${t.key}:${r.id}` });
    }
  }
  return out;
}

function recipientInput(value, book) {
  const input = h('input', { class: 'input rcpt-input', value, spellcheck: false, autocomplete: 'off' });
  const drop = h('div', { class: 'rcpt-drop hidden' });
  let items = [], sel = 0;
  const lastToken = () => { const v = input.value; const i = Math.max(v.lastIndexOf(','), v.lastIndexOf(';')); return { pre: i >= 0 ? v.slice(0, i + 1) + ' ' : '', tok: v.slice(i + 1).trim() }; };
  const choose = it => { const { pre } = lastToken(); input.value = `${pre}${formatAddress(it)}, `; drop.classList.add('hidden'); input.focus(); input.dispatchEvent(new Event('change')); };
  const show = () => {
    const { tok } = lastToken();
    if (tok.length < 1) { drop.classList.add('hidden'); return; }
    const q = tok.toLowerCase();
    items = book.filter(b => b.name.toLowerCase().includes(q) || b.address.includes(q)).slice(0, 8);
    sel = 0;
    if (!items.length) { drop.classList.add('hidden'); return; }
    replace(drop, ...items.map((it, i) => h('div', { class: ['rcpt-item', i === sel && 'on'], onmousedown: e => { e.preventDefault(); choose(it); } }, h('b', {}, it.name), h('span', { class: 'muted small' }, ` ${it.address}`))));
    drop.classList.remove('hidden');
  };
  input.addEventListener('input', show);
  input.addEventListener('blur', () => setTimeout(() => drop.classList.add('hidden'), 150));
  input.addEventListener('keydown', e => {
    if (drop.classList.contains('hidden')) return;
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') { e.preventDefault(); sel = (sel + (e.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length; [...drop.children].forEach((c, i) => c.classList.toggle('on', i === sel)); }
    if (e.key === 'Enter' || e.key === 'Tab') { if (items[sel]) { e.preventDefault(); choose(items[sel]); } }
    if (e.key === 'Escape') { e.stopPropagation(); drop.classList.add('hidden'); }
  });
  return { el: h('div', { class: 'rcpt-wrap' }, input, drop), input };
}

/**
 * opts: { mode: 'new'|'reply'|'replyAll'|'forward', message (full message for reply/forward), to: [{name,address}],
 *         refs: [ref], templateId, draft (restore), subject, body }
 */
export function openCompose(opts = {}) {
  if (!mail.accounts.length) {
    toast('Set up an email account first.', { action: { label: 'Settings', fn: () => hooks.openSettings?.('email') } });
    return null;
  }
  const book = addressBook();
  const idx = buildAddressIndex(store.data);
  const d = opts.draft || buildInitial(opts);
  const accSel = h('select', { class: 'input input-sm' }, mail.accounts.filter(a => a.enabled !== false).map(a => h('option', { value: a.id, selected: a.id === (d.accountId || defaultAccount()?.id) }, `${a.fromName ? `${a.fromName} <${a.email}>` : a.email}`)));
  const to = recipientInput(formatAddressList(d.to), book);
  const cc = recipientInput(formatAddressList(d.cc), book);
  const bcc = recipientInput(formatAddressList(d.bcc), book);
  const subject = h('input', { class: 'input', value: d.subject || '', placeholder: 'Subject' });
  const body = h('textarea', { class: 'input compose-body', rows: 14, value: d.body || '', placeholder: 'Write your message… (Markdown: **bold**, *italic*, [link](https://…), - lists)' });
  const askBox = h('div', { class: 'ask-box' });
  const attList = h('div', { class: 'compose-atts' });
  const readReceipt = h('input', { type: 'checkbox', checked: !!d.readReceipt });
  const showCc = h('button', { class: 'btn-link small', onclick: () => { ccRow.classList.remove('hidden'); bccRow.classList.remove('hidden'); showCc.remove(); } }, 'Cc / Bcc');
  const ccRow = h('div', { class: ['compose-row', !(d.cc?.length || d.bcc?.length) && 'hidden'] }, h('label', {}, 'Cc'), cc.el);
  const bccRow = h('div', { class: ['compose-row', !(d.cc?.length || d.bcc?.length) && 'hidden'] }, h('label', {}, 'Bcc'), bcc.el);
  const preview = h('div', { class: 'compose-preview hidden' });
  const warn = h('div', { class: 'compose-warn' });
  const tplBtn = h('button', { class: 'btn btn-sm', onclick: e => templateMenu(e.currentTarget) }, '📋 Template ▾');
  const attachments = [...(d.attachments || [])];
  let draftId = d.draftId || null;
  let ask = { ...(d.ask || {}) };
  let designId = d.designTemplateId || null;
  const designText = () => { const t = designId ? (store.data.meta.emailTemplates || []).find(x => x.id === designId) : null; return t ? (t.html || JSON.stringify(t.design || {})) : ''; };
  let dirty = false;

  const currentRefs = () => {
    const refs = new Set(opts.refs || d.refs || []);
    for (const a of [...parseAddressList(to.input.value), ...parseAddressList(cc.input.value)]) for (const r of refsForAddress(idx, a.address)) refs.add(r);
    return [...refs];
  };
  const firstRecord = () => { for (const r of currentRefs()) { const x = recordForRef(r); if (x) return x; } return null; };

  const renderAttachments = () => replace(attList, ...attachments.map((a, i) => h('span', { class: 'chip att-chip-sm' }, `📎 ${a.filename}`, a.size ? h('span', { class: 'muted tiny' }, ` ${humanSize(a.size)}`) : null,
    h('button', { class: 'icon-btn', title: 'Remove', onclick: () => { attachments.splice(i, 1); renderAttachments(); } }, '×'))));
  renderAttachments();

  const renderAsk = () => {
    const fields = sendTimeFields(subject.value, body.value, designText());
    replace(askBox, ...fields.map(k => h('div', { class: 'compose-row ask-row' }, h('label', { title: 'Filled in when sending' }, `${k}`),
      h('input', { class: 'input input-sm', value: ask[k] || '', placeholder: `Value for {{?${k}}}`, oninput: e => { ask[k] = e.target.value; } }))));
  };
  renderAsk();

  const resolve = (text, rec) => renderMailTemplate(text, { type: rec?.type, record: rec?.rec, me: { ...(store.config.ui.me || {}) }, ask, ctx: { dateFormat: store.data.meta.settings.dateFormat } });

  const applyTemplate = (t) => {
    const rec = firstRecord();
    const keepAsk = Object.fromEntries(sendTimeFields(t.subject, t.body).map(k => [k, ask[k] || `{{?${k}}}`]));
    const r = (txt) => renderMailTemplate(txt, { type: rec?.type, record: rec?.rec, me: store.config.ui.me || {}, ask: keepAsk, ctx: { dateFormat: store.data.meta.settings.dateFormat } }).text;
    if (!subject.value.trim() || dirty === false || subject.value === d.subject) subject.value = r(t.subject || '');
    const sig = signatureFor(accSel.value);
    body.value = r(t.body || '') + (sig && !/\n-- \n/.test(t.body || '') ? `\n\n-- \n${sig}` : '');
    designId = t.design || t.html ? t.id : null;
    if (t.tracking === 'on' || t.tracking === 'off') { d.tracking = t.tracking; const cb = document.querySelector('.compose-tools input[type=checkbox][data-track]'); if (cb) cb.checked = t.tracking === 'on'; }
    dirty = true;
    renderAsk(); updateWarn();
    window.crm.mail.drafts && (t.uses = (t.uses || 0) + 1);
  };

  const templateMenu = anchor => {
    const list = store.data.meta.emailTemplates || [];
    const cats = [...new Set(list.map(t => t.category || 'General'))];
    menu(anchor, [
      ...cats.map(c => ({ label: c, sub: list.filter(t => (t.category || 'General') === c).map(t => ({ label: t.name, icon: t.design || t.html ? '🎨' : '📝', fn: () => applyTemplate(t) })) })),
      'sep',
      { label: 'Manage templates…', icon: '⚙', fn: () => hooks.openMailTemplates?.() },
      designId ? { label: 'Remove design (plain email)', icon: '×', fn: () => { designId = null; updateWarn(); } } : null,
    ].filter(Boolean));
  };

  const updateWarn = () => {
    const bad = [...parseAddressList(to.input.value), ...parseAddressList(cc.input.value), ...parseAddressList(bcc.input.value)].filter(a => !isValidEmail(a.address));
    const dne = currentRefs().map(recordForRef).filter(x => x?.rec.doNotEmail);
    const rec = firstRecord();
    const missing = [...new Set([...resolve(subject.value, rec).missing, ...resolve(body.value, rec).missing])].filter(m => !sendTimeFields(subject.value, body.value, designText()).includes(m));
    replace(warn, 
      bad.length ? h('div', { class: 'warn-line' }, `⚠ Not a valid address: ${bad.map(a => a.address).join(', ')}`) : null,
      dne.length ? h('div', { class: 'warn-line' }, `⚠ ${dne.map(x => recordTitle(x.type, x.rec)).join(', ')} asked not to be emailed.`) : null,
      missing.length ? h('div', { class: 'warn-line' }, `⚠ No value for: ${missing.map(m => `{{${m}}}`).join(', ')}`) : null,
      designId ? h('div', { class: 'info-line' }, '🎨 Sent with the template design. ', h('button', { class: 'btn-link small', onclick: () => { designId = null; updateWarn(); } }, 'Send as plain email')) : null);
  };

  [to.input, cc.input, bcc.input].forEach(i => i.addEventListener('change', updateWarn));
  const onEdit = debounce(() => { dirty = true; renderAsk(); updateWarn(); saveDraft(); }, 600);
  [subject, body, to.input, cc.input, bcc.input].forEach(i => i.addEventListener('input', onEdit));
  accSel.addEventListener('change', () => { dirty = true; });

  const collect = () => ({
    accountId: accSel.value,
    to: parseAddressList(to.input.value), cc: parseAddressList(cc.input.value), bcc: parseAddressList(bcc.input.value),
    subject: subject.value, body: body.value, attachments: attachments.slice(), readReceipt: readReceipt.checked,
    inReplyTo: d.inReplyTo, references: d.references, forwardFrom: d.forwardFrom, refs: currentRefs(), ask: { ...ask }, mode: d.mode, designTemplateId: designId, tracking: d.tracking,
    draftId,
  });

  const saveDraft = async () => {
    if (!dirty) return;
    try { const r = await window.crm.mail.drafts({ action: 'save', draft: { ...collect(), id: draftId } }); draftId = r.id; } catch { /* no db */ }
  };

  const togglePreview = async () => {
    if (!preview.classList.contains('hidden')) { preview.classList.add('hidden'); body.classList.remove('hidden'); return; }
    const built = await buildOutgoing(collect(), firstRecord());
    const { mailFrame } = await import('./mail-render.js');
    replace(preview, h('div', { class: 'muted small pad' }, `Subject: ${built.subject}`), mailFrame({ html: built.html, text: built.text }, { allowImages: true }));
    preview.classList.remove('hidden'); body.classList.add('hidden');
  };

  const send = async () => {
    const draft = collect();
    if (!draft.to.length && !draft.cc.length && !draft.bcc.length) { toast('Add a recipient.', { type: 'error' }); return false; }
    const bad = [...draft.to, ...draft.cc, ...draft.bcc].filter(a => !isValidEmail(a.address));
    if (bad.length) { toast(`Not a valid address: ${bad.map(a => a.address).join(', ')}`, { type: 'error' }); return false; }
    const missingAsk = sendTimeFields(draft.subject, draft.body, designText()).filter(k => !String(ask[k] || '').trim() || ask[k] === `{{?${k}}}`);
    if (missingAsk.length) { toast(`Fill in: ${missingAsk.join(', ')}`, { type: 'error' }); askBox.querySelector('input')?.focus(); return false; }
    if (!draft.subject.trim() && !(await confirmDialog('Send without a subject?', { okLabel: 'Send' }))) return false;
    const rec = firstRecord();
    const miss = [...new Set([...resolve(draft.subject, rec).missing, ...resolve(draft.body, rec).missing])];
    if (miss.length && !(await confirmDialog(`Some placeholders have no value: ${miss.map(m => `{{${m}}}`).join(', ')}`, { okLabel: 'Send anyway', detail: 'They will be sent exactly as written.' }))) return false;
    const built = await buildOutgoing(draft, rec);
    try {
      const res = await window.crm.mail.send({ draft: { ...built, draftSnapshot: undefined } });
      if (draftId) window.crm.mail.drafts({ action: 'delete', id: draftId }).catch(() => {});
      const undoSec = store.config.mail?.undoSeconds ?? 10;
      toast(undoSec ? `Sending “${built.subject || '(no subject)'}”…` : 'Sent', {
        timeout: undoSec * 1000,
        action: undoSec ? { label: 'Undo', fn: async () => {
          const r = await window.crm.mail.undo(res.id);
          if (r?.draft) { openCompose({ draft: { ...draft, draftId: null } }); toast('Not sent — back in the editor.'); } else toast('Too late, it was already sent.');
        } } : null,
      });
      return true;
    } catch (e) { toast(e.message, { type: 'error', timeout: 8000 }); return false; }
  };

  const attachMenu = anchor => {
    const recs = currentRefs().map(recordForRef).filter(Boolean);
    const recFiles = recs.flatMap(x => (x.rec.files || []).map(f => ({ f, x })));
    menu(anchor, [
      { label: 'From this computer…', icon: '💻', fn: async () => { const r = await window.crm.mail.pickFiles(); attachments.push(...r.files); dirty = true; renderAttachments(); } },
      recFiles.length ? { header: 'Record files' } : null,
      ...recFiles.map(({ f, x }) => ({ label: f.name, hint: recordTitle(x.type, x.rec), icon: '📎', fn: () => { attachments.push({ rel: f.rel, filename: f.name, size: f.size }); dirty = true; renderAttachments(); } })),
    ].filter(Boolean));
  };

  const m = openModal({
    title: { reply: 'Reply', replyAll: 'Reply all', forward: 'Forward' }[d.mode] || 'New email',
    size: 'lg', className: 'compose-modal', closeOnBackdrop: false,
    body: h('div', { class: 'compose' },
      h('div', { class: 'compose-row' }, h('label', {}, 'From'), accSel),
      h('div', { class: 'compose-row' }, h('label', {}, 'To'), to.el, showCc),
      ccRow, bccRow,
      h('div', { class: 'compose-row' }, h('label', {}, 'Subject'), subject),
      askBox,
      h('div', { class: 'compose-tools' },
        tplBtn,
        h('button', { class: 'btn btn-sm', onclick: e => attachMenu(e.currentTarget) }, '📎 Attach'),
        hooks.mailAI ? h('button', { class: 'btn btn-sm', title: 'Write or improve with your local AI', onclick: e => hooks.mailAI({ action: 'menu', anchor: e.currentTarget, compose: { subject, body, collect, record: firstRecord, message: opts.message || null, onChange: () => { dirty = true; renderAsk(); updateWarn(); } } }) }, '✨ AI ▾') : null,
        h('button', { class: 'btn btn-sm', onclick: togglePreview }, '👁 Preview'),
        h('span', { class: 'spacer' }),
        h('label', { class: 'check-row small', title: 'Ask the recipient’s mail app to confirm reading (many people decline)' }, readReceipt, ' Read receipt'),
        hooks.trackingToggle ? hooks.trackingToggle(d) : null),
      body, preview, attList, warn),
    actions: [
      { label: 'Discard', fn: async () => { if (draftId) await window.crm.mail.drafts({ action: 'delete', id: draftId }).catch(() => {}); draftId = null; dirty = false; } },
      'spacer',
      { label: 'Save draft', fn: async () => { dirty = true; await saveDraft(); toast('Draft saved'); } },
      { label: 'Send', primary: true, keepOpen: true, fn: async api => { if (await send()) { dirty = false; api.close(); } return false; } },
    ],
    onClose: () => { if (dirty) { saveDraft(); toast('Draft saved', { timeout: 2000 }); } },
  });
  body.addEventListener('keydown', e => { if (e.key === 'Enter' && e.ctrlKey) { e.preventDefault(); m.el.querySelector('.modal-footer .btn-primary')?.click(); } });
  updateWarn();
  setTimeout(() => {
    if (!to.input.value) to.input.focus();
    else if (d.mode === 'reply' || d.mode === 'replyAll') { body.focus(); body.setSelectionRange(0, 0); } else if (!subject.value) subject.focus(); else body.focus();
  }, 30);
  if (opts.templateId) {
    const t = (store.data.meta.emailTemplates || []).find(x => x.id === opts.templateId);
    if (t) applyTemplate(t);
  }
  return m;
}

function signatureFor(accountId) {
  const a = mail.accounts.find(x => x.id === accountId) || defaultAccount();
  return (a?.signature || store.config.ui.me?.signature || '').trim();
}

function buildInitial(opts) {
  const acc = defaultAccount();
  const sig = signatureFor(acc?.id);
  const sigText = sig ? `\n\n-- \n${sig}` : '';
  const m = opts.message;
  const self = mail.accounts.map(a => a.email);
  if (m && (opts.mode === 'reply' || opts.mode === 'replyAll')) {
    const r = replyRecipients(m, self, { all: opts.mode === 'replyAll' });
    const hdr = replyHeaders(m);
    const myAcc = mail.accounts.find(a => [...(m.to || []), ...(m.cc || [])].some(x => x.address === a.email.toLowerCase()));
    return {
      mode: opts.mode, accountId: myAcc?.id || m.account || acc?.id, to: r.to, cc: r.cc, bcc: [], subject: replySubject(m.subject),
      body: `${sigText}${quoteText({ ...m, text: m.body?.text || '' }, { dateFormat: store.data.meta.settings.dateFormat })}`,
      inReplyTo: hdr.inReplyTo, references: hdr.references, refs: m.refs || [],
    };
  }
  if (m && opts.mode === 'forward') {
    return {
      mode: 'forward', accountId: m.account || acc?.id, to: [], cc: [], bcc: [], subject: replySubject(m.subject, 'forward'),
      body: `${sigText}${forwardText({ ...m, text: m.body?.text || '' }, { dateFormat: store.data.meta.settings.dateFormat })}`,
      forwardFrom: m.attachments?.length ? m.key : null, refs: [],
      attachments: [],
    };
  }
  return { mode: 'new', accountId: acc?.id, to: opts.to || [], cc: [], bcc: [], subject: opts.subject || '', body: (opts.body || '') + sigText, refs: opts.refs || [] };
}

/** Resolves placeholders and builds text + HTML for sending (also used by bulk send). */
export async function buildOutgoing(draft, rec) {
  const ctx = { dateFormat: store.data.meta.settings.dateFormat };
  const me = store.config.ui.me || {};
  const ask = draft.ask || {};
  const subject = renderMailTemplate(draft.subject, { type: rec?.type, record: rec?.rec, me, ask, ctx }).text;
  const textMd = renderMailTemplate(draft.body, { type: rec?.type, record: rec?.rec, me, ask, ctx }).text;
  let html;
  const tpl = draft.designTemplateId ? (store.data.meta.emailTemplates || []).find(t => t.id === draft.designTemplateId) : null;
  if (tpl && hooks.renderDesignedEmail) {
    html = await hooks.renderDesignedEmail(tpl, { rec, ask, bodyMd: textMd, subject });
  } else {
    html = simpleEmailHtml({ bodyHtml: mdToEmailHtml(textMd), brand: store.data.meta.brand, subject });
  }
  const text = textMd.replace(/\*\*(.+?)\*\*/g, '$1').replace(/\[([^\]]+)\]\(([^)]+)\)/g, '$1 ($2)');
  return {
    accountId: draft.accountId, to: draft.to, cc: draft.cc, bcc: draft.bcc, subject, text, html,
    attachments: draft.attachments, readReceipt: draft.readReceipt, inReplyTo: draft.inReplyTo, references: draft.references,
    forwardFrom: draft.forwardFrom, refs: draft.refs, tracking: draft.tracking, templateId: draft.designTemplateId || draft.templateId || null,
  };
}

export { escapeHtml, findRecord, getType };
