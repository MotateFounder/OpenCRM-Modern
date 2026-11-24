// Bulk send (mail merge): one personalised email per record, previewed, paced and stoppable.
import { h, replace } from './dom.js';
import { store, on } from './store.js';
import { getType, recordTitle, recordEmails, renderMailTemplate, sendTimeFields, isValidEmail } from './shared.js';
import { mail, defaultAccount } from './mail-state.js';
import { buildOutgoing } from './mail-compose.js';
import { mailFrame } from './mail-render.js';
import { openModal, toast, confirmDialog } from './ui.js';
import { hooks } from './hooks.js';

export function openBulkEmail(typeKey, ids) {
  if (!mail.accounts.length) { toast('Set up an email account first.', { action: { label: 'Settings', fn: () => hooks.openSettings?.('email') } }); return; }
  const type = getType(store.data, typeKey);
  const all = ids.map(id => (store.data[typeKey] || []).find(r => r.id === id)).filter(Boolean);
  const rows = all.map(rec => {
    const addr = recordEmails(type, rec)[0] || '';
    let reason = '';
    if (!addr) reason = 'no email address';
    else if (!isValidEmail(addr)) reason = 'invalid email';
    else if (rec.doNotEmail) reason = 'asked not to be emailed';
    else if (rec.emailInvalid) reason = 'address bounced before';
    return { rec, addr, reason, skip: !!reason, ask: {} };
  });
  const ok = () => rows.filter(r => !r.skip);
  const templates = store.data.meta.emailTemplates || [];
  let tplId = templates[0]?.id || '';
  const accSel = h('select', { class: 'input input-sm' }, mail.accounts.filter(a => a.enabled !== false).map(a => h('option', { value: a.id, selected: a.id === defaultAccount()?.id }, a.email)));
  const tplSel = h('select', { class: 'input input-sm' }, h('option', { value: '' }, '— write here —'), templates.map(t => h('option', { value: t.id, selected: t.id === tplId }, `${t.design || t.html ? '🎨' : '📝'} ${t.name}`)));
  const subject = h('input', { class: 'input', placeholder: 'Subject — {{fields}} allowed' });
  const body = h('textarea', { class: 'input compose-body', rows: 10 });
  const askBox = h('div', { class: 'ask-box' });
  const askVals = {};
  const spacing = h('select', { class: 'input input-sm' }, [[10, '10 s'], [20, '20 s (recommended)'], [45, '45 s'], [90, '90 s']].map(([v, l]) => h('option', { value: v, selected: v === (store.data.meta.settings.mail?.bulkSpacingSec || 20) }, l)));
  const list = h('div', { class: 'bulk-list' });
  const preview = h('div', { class: 'bulk-preview' });
  const summary = h('div', { class: 'bulk-summary' });
  let pIdx = 0;
  const bulkTrack = {};
  const bulkDesignText = () => { const t = templates.find(x => x.id === tplSel.value); return t ? (t.html || (t.design ? JSON.stringify(t.design) : '')) : ''; };

  const loadTemplate = () => {
    const t = templates.find(x => x.id === tplSel.value);
    if (t) { subject.value = t.subject || ''; body.value = t.body || ''; }
    renderAsk(); renderList(); renderPreview();
  };
  tplSel.addEventListener('change', loadTemplate);

  const renderAsk = () => {
    const fields = sendTimeFields(subject.value, body.value, bulkDesignText());
    replace(askBox, fields.map(k => h('div', { class: 'compose-row ask-row' }, h('label', {}, k),
      h('input', { class: 'input input-sm', value: askVals[k] || '', placeholder: 'Same for everyone (or set per person below)', oninput: e => { askVals[k] = e.target.value; renderPreview(); } }))));
  };

  const recFor = r => ({ type, rec: r.rec });
  const missingFor = r => {
    const o = { type, record: r.rec, me: store.config.ui.me || {}, ask: { ...askVals, ...r.ask }, ctx: { dateFormat: store.data.meta.settings.dateFormat } };
    return [...new Set([...renderMailTemplate(subject.value, o).missing, ...renderMailTemplate(body.value, o).missing])];
  };

  const renderList = () => {
    const fields = sendTimeFields(subject.value, body.value, bulkDesignText());
    replace(list, h('table', { class: 'grid-table bulk-table' },
      h('thead', {}, h('tr', {}, h('th', {}, ''), h('th', {}, 'Recipient'), h('th', {}, 'Email'), fields.map(f => h('th', {}, f)), h('th', {}, ''))),
      h('tbody', {}, rows.map((r, i) => {
        const miss = r.reason ? [] : missingFor(r).filter(m => !fields.includes(m));
        return h('tr', { class: [r.skip && 'skipped', i === pIdx && 'on'], onclick: e => { if (e.target.closest('input')) return; pIdx = i; renderList(); renderPreview(); } },
          h('td', {}, h('input', { type: 'checkbox', checked: !r.skip, disabled: !!r.reason, title: r.reason || 'Include', onchange: e => { r.skip = !e.target.checked; renderSummary(); renderList(); } })),
          h('td', {}, recordTitle(type, r.rec)),
          h('td', { class: 'muted small' }, r.reason ? h('span', { class: 'err' }, r.reason) : r.addr, miss.length ? h('div', { class: 'warn-line' }, `⚠ empty: ${miss.join(', ')}`) : null),
          fields.map(f => h('td', {}, h('input', { class: 'input input-sm', value: r.ask[f] || '', placeholder: askVals[f] || '', oninput: e => { r.ask[f] = e.target.value; if (i === pIdx) renderPreview(); } }))),
          h('td', {}, ''));
      }))));
    renderSummary();
  };

  const renderSummary = () => {
    const n = ok().length;
    const acc = mail.accounts.find(a => a.id === accSel.value);
    const limit = acc?.dailyLimit || 200;
    const secs = n * +spacing.value;
    replace(summary,
      h('b', {}, `${n} email${n === 1 ? '' : 's'} will be sent`),
      ` · one every ${spacing.value} s · about ${secs < 90 ? `${secs} s` : `${Math.round(secs / 60)} min`}`,
      n > limit ? h('span', { class: 'warn-line' }, ` · more than today's limit (${limit}): the rest go out automatically over the next days`) : null,
      rows.some(r => r.reason) ? h('div', { class: 'muted small' }, `${rows.filter(r => r.reason).length} skipped automatically (no address, invalid, “do not email” or bounced).`) : null);
  };

  let prevTimer = null;
  const renderPreview = () => {
    clearTimeout(prevTimer);
    prevTimer = setTimeout(async () => {
      const r = rows[pIdx];
      if (!r) { replace(preview); return; }
      const draft = { accountId: accSel.value, to: [{ name: recordTitle(type, r.rec), address: r.addr }], subject: subject.value, body: body.value, ask: { ...askVals, ...r.ask }, designTemplateId: tplSel.value && (templates.find(t => t.id === tplSel.value)?.design || templates.find(t => t.id === tplSel.value)?.html) ? tplSel.value : null };
      const built = await buildOutgoing(draft, recFor(r));
      replace(preview,
        h('div', { class: 'row-gap' }, h('button', { class: 'icon-btn', disabled: pIdx === 0, onclick: () => { pIdx--; renderList(); renderPreview(); } }, '‹'),
          h('span', { class: 'small' }, `${pIdx + 1} / ${rows.length} · ${recordTitle(type, r.rec)} <${r.addr || '—'}>`),
          h('button', { class: 'icon-btn', disabled: pIdx >= rows.length - 1, onclick: () => { pIdx++; renderList(); renderPreview(); } }, '›')),
        h('div', { class: 'small' }, h('b', {}, 'Subject: '), built.subject),
        mailFrame({ html: built.html }, { allowImages: true, maxHeight: 520 }));
    }, 150);
  };
  [subject, body].forEach(el => el.addEventListener('input', () => { renderAsk(); renderList(); renderPreview(); }));
  spacing.addEventListener('change', renderSummary);
  accSel.addEventListener('change', renderSummary);

  const start = async (api) => {
    const send = ok();
    if (!send.length) { toast('Nobody to send to.', { type: 'error' }); return; }
    if (!subject.value.trim()) { toast('Add a subject.', { type: 'error' }); return; }
    const fields = sendTimeFields(subject.value, body.value, bulkDesignText());
    const missingAsk = send.filter(r => fields.some(f => !String(r.ask[f] || askVals[f] || '').trim()));
    if (missingAsk.length) { toast(`Fill in ${fields.join(', ')} for: ${missingAsk.map(r => recordTitle(type, r.rec)).slice(0, 5).join(', ')}`, { type: 'error', timeout: 8000 }); return; }
    const withMissing = send.filter(r => missingFor(r).filter(m => !fields.includes(m)).length);
    if (withMissing.length && !(await confirmDialog(`${withMissing.length} recipient(s) have empty placeholders.`, { okLabel: 'Send anyway', detail: withMissing.slice(0, 8).map(r => `${recordTitle(type, r.rec)}: ${missingFor(r).join(', ')}`).join('\n') }))) return;
    if (!(await confirmDialog(`Send ${send.length} personalised email(s) from ${accSel.selectedOptions[0].textContent}?`, { okLabel: 'Start sending', detail: 'You can pause or stop at any time from the progress window.' }))) return;
    const items = [];
    const designTemplateId = tplSel.value && (templates.find(t => t.id === tplSel.value)?.design || templates.find(t => t.id === tplSel.value)?.html) ? tplSel.value : null;
    for (const r of send) {
      const draft = { accountId: accSel.value, to: [{ name: recordTitle(type, r.rec), address: r.addr }], subject: subject.value, body: body.value, ask: { ...askVals, ...r.ask }, refs: [`${typeKey}:${r.rec.id}`], designTemplateId, templateId: tplSel.value || null, bulk: true, tracking: bulkTrack.tracking };
      const built = await buildOutgoing(draft, recFor(r));
      items.push({ draft: { ...built, bulk: true }, meta: { ref: `${typeKey}:${r.rec.id}`, name: recordTitle(type, r.rec) } });
    }
    try {
      const res = await window.crm.mail.bulk({ items, accountId: accSel.value, spacingSec: +spacing.value });
      api.close();
      progressWindow(res.bulkId, items.length);
    } catch (e) { toast(e.message, { type: 'error' }); }
  };

  openModal({
    title: `Email ${rows.length} ${rows.length === 1 ? type.singular.toLowerCase() : type.label.toLowerCase()}`, size: 'xxl', className: 'bulk-modal', closeOnBackdrop: false,
    body: h('div', { class: 'bulk-grid' },
      h('div', { class: 'bulk-left' },
        h('div', { class: 'compose-row' }, h('label', {}, 'From'), accSel),
        h('div', { class: 'compose-row' }, h('label', {}, 'Template'), tplSel),
        h('div', { class: 'compose-row' }, h('label', {}, 'Subject'), subject),
        body, askBox,
        h('div', { class: 'compose-row' }, h('label', {}, 'Pace'), spacing, hooks.trackingToggle ? hooks.trackingToggle(bulkTrack) : null),
        summary, list),
      h('div', { class: 'bulk-right' }, preview)),
    actions: [{ label: 'Cancel' }, 'spacer', { label: 'Send to all…', primary: true, keepOpen: true, fn: async api => { await start(api); return false; } }],
  });
  if (tplId) loadTemplate(); else { renderAsk(); renderList(); renderPreview(); }
}

function progressWindow(bulkId, total) {
  const bar = h('div', { class: 'progress' }, h('div', { class: 'progress-fill' }));
  const text = h('div', { class: 'small' });
  const log = h('div', { class: 'bulk-log' });
  let sent = 0, failed = 0, paused = false;
  const pauseBtn = h('button', { class: 'btn', onclick: async () => {
    paused = !paused;
    await window.crm.mail.bulkControl({ bulkId, action: paused ? 'pause' : 'resume' });
    pauseBtn.textContent = paused ? 'Resume' : 'Pause';
    paint();
  } }, 'Pause');
  const paint = () => {
    const left = mail.outbox.filter(o => o.bulkId === bulkId);
    const next = left.filter(o => o.status === 'scheduled').sort((a, b) => a.sendAt - b.sendAt)[0];
    bar.firstChild.style.width = `${Math.round(((sent + failed) / total) * 100)}%`;
    text.textContent = `${sent} sent${failed ? `, ${failed} failed` : ''} of ${total}${paused ? ' · paused' : next ? ` · next at ${new Date(next.sendAt).toLocaleTimeString()}` : left.length ? ' · sending…' : ' · done'}`;
  };
  const offs = [
    on('mail-sent', p => { if (p.bulkId !== bulkId) return; sent++; log.prepend(h('div', { class: 'small' }, `✓ ${p.meta?.name || ''}`)); paint(); }),
    on('mail-outbox', () => {
      const f = mail.outbox.filter(o => o.bulkId === bulkId && o.status === 'failed').length;
      if (f !== failed) { failed = f; }
      paint();
    }),
  ];
  const m = openModal({
    title: 'Sending emails', size: 'md', closeOnBackdrop: false,
    body: h('div', {}, bar, text, h('p', { class: 'muted small' }, 'You can close this window: sending continues in the background (also while you work elsewhere in OpenCRM).'), log),
    actions: [
      { label: 'Stop', danger: true, keepOpen: true, fn: async () => {
        if (!(await confirmDialog('Stop and cancel the emails that have not been sent yet?', { okLabel: 'Stop sending', danger: true }))) return false;
        const r = await window.crm.mail.bulkControl({ bulkId, action: 'stop' });
        toast(`Stopped. ${r.n} email(s) cancelled.`);
        return false;
      } },
      'spacer',
      { label: 'Close', primary: true },
    ],
    headerExtra: pauseBtn,
    onClose: () => offs.forEach(o => o()),
  });
  paint();
  return m;
}
