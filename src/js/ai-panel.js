// AI assistant panel: prompt picker + variables, context picker (any text field / individual notes),
// streaming response, save as note / into field, refine, and bulk mode over several records.
import { h } from './dom.js';
import { store, mutate, findRecord, currentType, settings, touch } from './store.js';
import { contextItems, buildContextText, defaultSelection, renderTemplate, estimateTokens, recordTitle, newNoteId, noteDateString, noteTimeString, newId } from './shared.js';
import { openModal, toast, promptDialog, menu } from './ui.js';
import { renderMarkdown } from './markdown.js';
import { relCtx } from './editors.js';
import { incomingRelationsText } from './drawer.js';
import { hooks } from './hooks.js';

const KNOWN_VARS = new Set(['context', 'today', 'title', 'name', 'type', 'notes', 'field']);

export function promptVariables(template, type) {
  const out = [];
  for (const m of String(template || '').matchAll(/\{\{\s*([^}]+?)\s*\}\}/g)) {
    const head = m[1].split(':')[0].trim();
    if (KNOWN_VARS.has(head) || head.startsWith('me.')) continue;
    if (type.fieldDefs.some(f => f.key.toLowerCase() === head.toLowerCase() || f.label.toLowerCase() === head.toLowerCase())) continue;
    if (!out.includes(head)) out.push(head);
  }
  return out;
}

function sortedPrompts() {
  return [...(store.data.meta.prompts || [])].sort((a, b) => (b.favorite - a.favorite) || ((b.uses || 0) - (a.uses || 0)) || a.title.localeCompare(b.title));
}

function aiConfigured() { return !!store.config?.ai?.baseUrl; }

export function openAIPanel(ids, { promptId = null } = {}) {
  const type = currentType();
  const recs = ids.map(id => findRecord(type.key, id)).filter(Boolean);
  if (!recs.length) { toast('Select a record first'); return; }
  const bulk = recs.length > 1;
  const me = store.config?.ui?.me || {};
  const ctxOpts = { dateFormat: settings().dateFormat, ...relCtx };

  // ---------- state ----------
  const prompts = sortedPrompts();
  let prompt = prompts.find(p => p.id === promptId) || null;
  const vars = {};
  let single = null;
  if (!bulk) {
    single = { rec: recs[0], items: contextItems(type, recs[0], { ...ctxOpts, incomingRelations: incomingRelationsText(type, recs[0]) }) };
    single.sel = defaultSelection(single.items, prompt);
  }
  const bulkSel = { fields: new Set(type.fieldDefs.filter(f => f.aiContext !== false && f.type !== 'image' && f.type !== 'markdown').map(f => `field:${f.key}`)), docs: false, notes: 'last5' };
  let conversation = [];
  let running = null;

  // ---------- left: prompt ----------
  const promptSel = h('select', { class: 'input' });
  const fillPromptSel = () => {
    const cats = new Map();
    for (const p of sortedPrompts()) { const c = p.category || 'Uncategorised'; if (!cats.has(c)) cats.set(c, []); cats.get(c).push(p); }
    promptSel.replaceChildren(h('option', { value: '' }, '✎ Free prompt'),
      ...[...cats].map(([c, ps]) => h('optgroup', { label: c }, ps.map(p => h('option', { value: p.id, selected: p.id === prompt?.id }, `${p.favorite ? '★ ' : ''}${p.title}`)))));
  };
  fillPromptSel();
  const systemTa = h('textarea', { class: 'input mono', rows: 3, placeholder: 'Optional system instructions (role, tone, language)…', value: prompt?.system || '' });
  const templateTa = h('textarea', { class: 'input mono prompt-ta', rows: 10, placeholder: 'Write what you want, e.g. “Write a short follow-up message to {{title}} about…”. Use {{context}} where the selected context should go (otherwise it is appended).', value: prompt?.template || '' });
  const varsBox = h('div', { class: 'vars-box' });
  const renderVars = () => {
    const names = promptVariables(templateTa.value, type);
    varsBox.replaceChildren(...names.map(n => h('div', { class: 'form-row' }, h('label', { class: 'field-label' }, n),
      (n === 'input' ? h('textarea', { class: 'input', rows: 4, value: vars[n] || '', oninput: e => { vars[n] = e.target.value; updateEstimate(); } })
        : h('input', { class: 'input', value: vars[n] || '', oninput: e => { vars[n] = e.target.value; updateEstimate(); } })))));
  };
  promptSel.addEventListener('change', () => {
    prompt = sortedPrompts().find(p => p.id === promptSel.value) || null;
    systemTa.value = prompt?.system || '';
    templateTa.value = prompt?.template || '';
    if (single) { single.sel = defaultSelection(single.items, prompt); renderContext(); }
    renderVars(); updateEstimate();
  });
  templateTa.addEventListener('input', () => { renderVars(); updateEstimate(); });

  const savePromptBtn = h('button', { class: 'btn btn-sm', onclick: (e) => menu(e.currentTarget, [
    prompt ? { label: `Update “${prompt.title}”`, fn: () => {
      mutate('Update prompt', d => { const p = d.meta.prompts.find(x => x.id === prompt.id); p.template = templateTa.value; p.system = systemTa.value; });
      toast('Prompt updated');
    } } : null,
    { label: 'Save as new prompt…', fn: async () => {
      const title = await promptDialog('Prompt title', { placeholder: 'e.g. Ask for a referral' });
      if (!title?.trim()) return;
      const p = { id: newId('p'), title: title.trim(), category: prompt?.category || 'General', tags: [], system: systemTa.value, template: templateTa.value, context: prompt?.context || ['fields:all', 'notes:last5'], favorite: false, uses: 0, createdAt: new Date().toISOString(), lastUsedAt: null };
      mutate('Save prompt', d => { d.meta.prompts.push(p); });
      prompt = p; fillPromptSel(); toast('Prompt saved');
    } },
  ].filter(Boolean)) }, '💾 Save prompt ▾');

  const left = h('div', { class: 'ai-col' },
    h('div', { class: 'ai-col-head' }, h('h3', {}, '1 · Prompt'), h('button', { class: 'btn-link small', onclick: () => hooks.openPrompts?.() }, 'Manage prompts…')),
    promptSel,
    h('details', { class: 'ai-system' }, h('summary', {}, 'System instructions'), systemTa),
    templateTa,
    h('div', { class: 'muted tiny' }, 'Variables: {{title}} {{context}} {{today}} {{me.name}} {{me.signature}} {{field:Label}} {{notes:last3}} — unknown {{words}} become input boxes.'),
    varsBox,
    h('div', { class: 'row-gap' }, savePromptBtn));

  // ---------- middle: context ----------
  const ctxBox = h('div', { class: 'ctx-box' });
  const estimate = h('div', { class: 'muted small' });
  const renderContext = () => {
    if (bulk) {
      const defs = type.fieldDefs.filter(f => f.aiContext !== false && f.type !== 'image');
      ctxBox.replaceChildren(
        h('p', { class: 'muted small' }, `Applied to each of the ${recs.length} selected records.`),
        h('div', { class: 'ctx-group' }, h('div', { class: 'ctx-group-head' }, 'Fields'),
          defs.map(d => h('label', { class: 'check-row' }, h('input', { type: 'checkbox', checked: bulkSel.fields.has(`field:${d.key}`), onchange: e => { e.target.checked ? bulkSel.fields.add(`field:${d.key}`) : bulkSel.fields.delete(`field:${d.key}`); updateEstimate(); } }), ` ${d.label}`))),
        h('div', { class: 'ctx-group' }, h('div', { class: 'ctx-group-head' }, 'Notes'),
          h('select', { class: 'input input-sm', onchange: e => { bulkSel.notes = e.target.value; updateEstimate(); } },
            [['none', 'No notes'], ['last3', 'Last 3 notes'], ['last5', 'Last 5 notes'], ['important', 'Important notes'], ['all', 'All notes']].map(([v, l]) => h('option', { value: v, selected: v === bulkSel.notes }, l)))));
      return;
    }
    const groups = ['Fields', 'Related', 'Documents', 'Notes'];
    ctxBox.replaceChildren(...groups.map(g => {
      const items = single.items.filter(i => i.group === g);
      if (!items.length) return null;
      const allOn = items.every(i => single.sel.has(i.id));
      const setAll = on => { items.forEach(i => (on ? single.sel.add(i.id) : single.sel.delete(i.id))); renderContext(); updateEstimate(); };
      return h('div', { class: 'ctx-group' },
        h('div', { class: 'ctx-group-head' }, h('label', { class: 'check-row' }, h('input', { type: 'checkbox', checked: allOn, onchange: e => setAll(e.target.checked) }), ` ${g} (${items.length})`),
          g === 'Notes' ? h('span', { class: 'ctx-quick' },
            h('button', { class: 'btn-link tiny', onclick: () => { items.forEach(i => single.sel.delete(i.id)); items.slice(0, 3).forEach(i => single.sel.add(i.id)); renderContext(); updateEstimate(); } }, 'last 3'),
            h('button', { class: 'btn-link tiny', onclick: () => { items.forEach(i => (i.important ? single.sel.add(i.id) : single.sel.delete(i.id))); renderContext(); updateEstimate(); } }, 'important')) : null),
        items.map(i => h('label', { class: 'check-row ctx-item', title: i.text.slice(0, 600) },
          h('input', { type: 'checkbox', checked: single.sel.has(i.id), onchange: e => { e.target.checked ? single.sel.add(i.id) : single.sel.delete(i.id); updateEstimate(); } }),
          h('span', { class: 'ctx-label' }, i.label), h('span', { class: 'ctx-snippet muted' }, i.text.replace(/\s+/g, ' ').slice(0, 80)))));
    }).filter(Boolean));
    if (!single.items.length) ctxBox.appendChild(h('p', { class: 'muted' }, 'This record has no text yet.'));
  };

  const contextFor = (rec) => {
    if (!bulk) return buildContextText(type, rec, single.items, single.sel);
    const items = contextItems(type, rec, { ...ctxOpts, incomingRelations: incomingRelationsText(type, rec) });
    const sel = new Set(items.filter(i => bulkSel.fields.has(i.id) || (i.group === 'Documents' && bulkSel.fields.has(i.id))).map(i => i.id));
    const notes = items.filter(i => i.group === 'Notes');
    const pick = bulkSel.notes === 'all' ? notes : bulkSel.notes === 'important' ? notes.filter(n => n.important) : bulkSel.notes === 'none' ? [] : notes.slice(0, +bulkSel.notes.slice(4));
    pick.forEach(n => sel.add(n.id));
    if (items.some(i => i.id === 'virtual:lastContact')) sel.add('virtual:lastContact');
    return buildContextText(type, rec, items, sel);
  };

  const buildMessages = (rec) => {
    const contextText = contextFor(rec);
    let user = renderTemplate(templateTa.value, { type, record: rec, contextText, me, ctx: ctxOpts, extra: vars });
    if (!/\{\{\s*context\s*\}\}/.test(templateTa.value) && contextText) user += `\n\nContext:\n${contextText}`;
    const msgs = [];
    if (systemTa.value.trim()) msgs.push({ role: 'system', content: renderTemplate(systemTa.value, { type, record: rec, me, ctx: ctxOpts, extra: vars }) });
    msgs.push({ role: 'user', content: user });
    return msgs;
  };

  const updateEstimate = () => {
    const msgs = buildMessages(recs[0]);
    const tokens = estimateTokens(msgs.map(m => m.content).join('\n'));
    estimate.textContent = `≈ ${tokens.toLocaleString()} tokens${bulk ? ' per record' : ''}`;
  };

  const middle = h('div', { class: 'ai-col' },
    h('div', { class: 'ai-col-head' }, h('h3', {}, '2 · Context'), h('button', { class: 'btn-link small', onclick: () => {
      const msgs = buildMessages(recs[0]);
      openModal({ title: 'What will be sent', size: 'lg', body: h('div', {}, msgs.map(m => h('div', { class: 'preview-msg' }, h('div', { class: 'muted small' }, m.role), h('pre', { class: 'pre-wrap' }, m.content)))), actions: [{ label: 'Close', primary: true }] });
    } }, 'Preview…')),
    ctxBox, estimate);

  // ---------- right: output ----------
  const out = h('div', { class: 'ai-output', tabindex: 0 });
  const status = h('div', { class: 'muted small ai-status' });
  const sendBtn = h('button', { class: 'btn btn-primary' }, bulk ? `▶ Run for ${recs.length}` : '▶ Send');
  const stopBtn = h('button', { class: 'btn hidden' }, '■ Stop');
  const actions = h('div', { class: 'ai-actions' });
  const refineIn = h('input', { class: 'input', placeholder: 'Refine: “shorter”, “more formal”, “in Spanish”…' });
  const refineRow = h('div', { class: 'refine-row hidden' }, refineIn, h('button', { class: 'btn', onclick: () => refine() }, 'Refine'));
  refineIn.addEventListener('keydown', e => { if (e.key === 'Enter') refine(); });
  let lastText = '';
  let formatted = false;

  const writableFields = type.fieldDefs.filter(f => ['text', 'longtext', 'markdown'].includes(f.type) && f.key !== type.titleField);

  const saveAsNote = (rec, text) => {
    mutate('AI result saved as note', () => { const x = findRecord(type.key, rec.id); (x.notes ||= []).push({ id: newNoteId(), date: noteDateString(), time: noteTimeString(), content: text }); touch(x); });
    toast(`Saved as note on ${recordTitle(type, rec)}`);
  };
  const saveIntoField = (anchor, rec, text) => menu(anchor, writableFields.map(f => ({ label: f.label, fn: () => {
    mutate(`AI result → ${f.label}`, () => { const x = findRecord(type.key, rec.id); x[f.key] = x[f.key] && f.type !== 'text' ? `${x[f.key]}\n\n${text}` : text; touch(x); });
    toast(`Saved into ${f.label}`);
  } })).concat(writableFields.length ? [] : [{ label: 'No text fields', disabled: true }]));

  const renderOutput = () => {
    out.replaceChildren(formatted && lastText ? renderMarkdown(lastText) : h('div', { class: 'pre-wrap' }, lastText || ''));
  };
  const renderActions = () => {
    if (bulk || !lastText) { actions.replaceChildren(); return; }
    actions.replaceChildren(
      h('button', { class: 'btn btn-sm', onclick: () => { window.crm.app.clipboard(lastText); toast('Copied'); } }, '📋 Copy'),
      h('button', { class: 'btn btn-sm', onclick: () => saveAsNote(recs[0], lastText) }, '📝 Save as note'),
      h('button', { class: 'btn btn-sm', onclick: e => saveIntoField(e.currentTarget, recs[0], lastText) }, '⤵ Save into field ▾'),
      h('button', { class: 'btn btn-sm', onclick: () => run() }, '↻ Regenerate'),
      h('label', { class: 'check-row small' }, h('input', { type: 'checkbox', checked: formatted, onchange: e => { formatted = e.target.checked; renderOutput(); } }), ' Formatted'));
  };

  const streamChat = async (messages, onText, onThinking) => {
    const streamId = newId('s');
    let acc = '';
    let thought = 0;
    const off = window.crm.ai.onChunk(({ streamId: sid, delta, reasoning }) => {
      if (sid !== streamId) return;
      if (reasoning) { thought += reasoning.length; onThinking?.(thought); }
      if (delta) { acc += delta; onText(acc); }
    });
    running = streamId;
    try {
      const res = await window.crm.ai.chat({ messages, streamId });
      return res.text ?? acc;
    } finally { off(); running = null; }
  };

  const markUsed = () => { if (prompt) mutate('Prompt used', d => { const p = d.meta.prompts.find(x => x.id === prompt.id); if (p) { p.uses = (p.uses || 0) + 1; p.lastUsedAt = new Date().toISOString(); } }, { undoable: false, silent: true }); };

  const setBusy = (busy) => { sendBtn.disabled = busy; stopBtn.classList.toggle('hidden', !busy); };

  async function run() {
    if (!aiConfigured()) { toast('Set up your local AI first (Settings → AI).', { type: 'error' }); hooks.openSettings?.('ai'); return; }
    if (!templateTa.value.trim()) { toast('Write or choose a prompt first'); templateTa.focus(); return; }
    setBusy(true);
    markUsed();
    if (bulk) return runBulk();
    conversation = buildMessages(recs[0]);
    await exchange();
  }

  async function exchange() {
    status.textContent = 'Thinking…';
    lastText = ''; formatted = false; renderOutput(); renderActions();
    const t0 = Date.now();
    try {
      const text = await streamChat(conversation,
        (acc) => { if (status.textContent.startsWith('Thinking')) status.textContent = 'Writing…'; lastText = acc; renderOutput(); out.scrollTop = out.scrollHeight; },
        (n) => { status.textContent = `Thinking… (${n.toLocaleString()} characters of reasoning)`; });
      lastText = text;
      conversation.push({ role: 'assistant', content: text });
      status.textContent = `Done in ${((Date.now() - t0) / 1000).toFixed(1)} s`;
      refineRow.classList.remove('hidden');
    } catch (e) {
      status.textContent = '';
      out.replaceChildren(h('div', { class: 'error-box' }, e.message));
    } finally {
      setBusy(false); renderOutput(); renderActions();
    }
  }

  async function refine() {
    const t = refineIn.value.trim();
    if (!t || !conversation.length) return;
    refineIn.value = '';
    conversation.push({ role: 'user', content: t });
    setBusy(true);
    await exchange();
  }

  async function runBulk() {
    const rows = recs.map(rec => ({ rec, status: 'pending', text: '', el: h('div', { class: 'bulk-item' }) }));
    out.replaceChildren(...rows.map(r => r.el));
    const paint = (r) => r.el.replaceChildren(
      h('div', { class: 'bulk-head' }, h('b', {}, recordTitle(type, r.rec)), h('span', { class: `muted small st-${r.status}` }, r.status),
        r.status === 'done' ? h('span', {},
          h('button', { class: 'icon-btn', title: 'Copy', onclick: () => { window.crm.app.clipboard(r.text); toast('Copied'); } }, '📋'),
          h('button', { class: 'icon-btn', title: 'Save as note', onclick: () => saveAsNote(r.rec, r.text) }, '📝'),
          h('button', { class: 'icon-btn', title: 'Save into field', onclick: e => saveIntoField(e.currentTarget, r.rec, r.text) }, '⤵')) : null),
      r.text ? h('div', { class: 'pre-wrap bulk-text' }, r.text) : null);
    rows.forEach(paint);
    let stopped = false;
    stopBtn.onclick = () => { stopped = true; if (running) window.crm.ai.abort(running); };
    for (const [i, r] of rows.entries()) {
      if (stopped) { r.status = 'skipped'; paint(r); continue; }
      status.textContent = `Running ${i + 1} / ${rows.length}…`;
      r.status = 'running'; paint(r);
      try {
        r.text = await streamChat(buildMessages(r.rec), acc => { r.text = acc; paint(r); });
        r.status = 'done';
      } catch (e) { r.status = 'error'; r.text = e.message; }
      paint(r);
    }
    status.textContent = stopped ? 'Stopped' : 'Finished — review each result, then save the ones you want.';
    setBusy(false);
  }

  sendBtn.onclick = run;
  stopBtn.onclick = () => { if (running) window.crm.ai.abort(running); };

  const right = h('div', { class: 'ai-col ai-col-out' },
    h('div', { class: 'ai-col-head' }, h('h3', {}, '3 · Response'), h('span', { class: 'muted small' }, store.config?.ai?.model || '')),
    h('div', { class: 'row-gap' }, sendBtn, stopBtn, status),
    out, actions, refineRow,
    !aiConfigured() ? h('div', { class: 'hint-box' }, 'No AI server configured. ', h('button', { class: 'btn-link', onclick: () => hooks.openSettings?.('ai') }, 'Open AI settings')) : null,
    aiConfigured() && !me.name && /\{\{\s*me\./.test(templateTa.value) ? h('div', { class: 'hint-box small' }, 'Tip: this prompt signs with {{me.name}}, which is empty. ', h('button', { class: 'btn-link', onclick: () => hooks.openSettings?.('general') }, 'Set your name and signature')) : null);

  renderContext(); renderVars(); updateEstimate();
  openModal({
    title: bulk ? `AI · ${recs.length} ${type.label.toLowerCase()}` : `AI · ${recordTitle(type, recs[0])}`,
    size: 'xxl', className: 'ai-modal',
    body: h('div', { class: 'ai-grid' }, left, middle, right),
    onClose: () => { if (running) window.crm.ai.abort(running); },
  });
}
