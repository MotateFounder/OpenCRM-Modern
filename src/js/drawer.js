// Record card (right-side drawer): profile, schema-driven inline editing, markdown documents,
// files, reminder, relations, notes (v1 colours/wildcards) and timeline.
import { h, linkify, pictureSrc } from './dom.js';
import { store, mutate, findRecord, settings, touch, emit, currentType } from './store.js';
import {
  recordTitle, getType, notesForDisplay, isImportant, isHidden, stripWildcards, formatDate, noteDateString, noteTimeString,
  noteDateToIso, isoToNoteDate, WILDCARDS, composeNote, newNoteId, isEmptyValue, toIsoDate, reminderState, noteTime,
} from './shared.js';
import { displayValue, makeEditor, fileList, relationName } from './editors.js';
import { openMarkdownModal, renderMarkdown, markdownPreviewText } from './markdown.js';
import { addFieldDialog, optionsEditor } from './fields-ui.js';
import { closeRecord, setField, deleteRecords, duplicateRecord, openRecord, setColor } from './actions.js';
import { menu, toast, confirmDialog, promptDialog } from './ui.js';
import { colorOf } from './viewmodel.js';
import { avatar } from './avatar.js';
import { hooks } from './hooks.js';
import { printRecord } from './print.js';
import { mail, relTime } from './mail-state.js';
import { recordEmails } from './shared.js';
import { openModal } from './ui.js';
import { renderThread, refChip } from './mail-thread.js';
import { avatarDot } from './mail-render.js';

// emails of the open record (fetched from the mail service, refreshed on mail changes)
const drawerMail = { ref: null, threads: [], msgs: [], stale: true, loading: false };
export function invalidateDrawerMail() { drawerMail.stale = true; }
async function loadDrawerMail(ref, el) {
  if (drawerMail.loading) return;
  drawerMail.loading = true;
  try {
    const [t, m] = await Promise.all([window.crm.mail.threads({ ref, limit: 50 }), window.crm.mail.list({ ref, limit: 300 })]);
    drawerMail.ref = ref; drawerMail.threads = t.threads; drawerMail.msgs = m.messages; drawerMail.stale = false;
  } catch { drawerMail.ref = ref; drawerMail.threads = []; drawerMail.msgs = []; drawerMail.stale = false; }
  drawerMail.loading = false;
  renderDrawer(el);
}

export function openThreadModal(threadId, subject = '') {
  const holder = h('div', { class: 'thread-modal-body' });
  openModal({ title: subject || 'Conversation', size: 'lg', className: 'thread-modal', body: holder });
  renderThread(holder, { threadId });
}

function emailsSection(type, rec) {
  if (!mail.accounts.length) return null;
  const ref = `${type.key}:${rec.id}`;
  const addrs = recordEmails(type, rec);
  const threads = drawerMail.ref === ref ? drawerMail.threads : [];
  const self = new Set(mail.accounts.map(a => a.email.toLowerCase()));
  return h('section', { class: 'card-section emails-section' },
    h('div', { class: 'section-head' },
      h('h3', {}, `Emails${threads.length ? ` (${threads.length})` : ''}`),
      h('span', { class: 'spacer' }),
      threads.length > 5 ? h('button', { class: 'btn-link small', onclick: () => hooks.showMailFor?.(ref) }, 'Show all') : null,
      addrs.length ? h('button', { class: 'btn btn-sm', onclick: () => hooks.compose?.({ mode: 'new', to: [{ name: recordTitle(type, rec), address: addrs[0] }], refs: [ref] }) }, '✉ New email') : null),
    !addrs.length ? h('p', { class: 'muted small pad' }, 'Add an email address to this record to see and send emails.')
      : drawerMail.ref !== ref ? h('p', { class: 'muted small pad' }, 'Loading…')
        : !threads.length ? h('p', { class: 'muted small pad' }, 'No emails with this record yet.')
          : h('div', { class: 'drawer-threads' }, threads.slice(0, 5).map(t => {
            const last = t.last;
            const other = t.participants.find(p => !self.has(p.address));
            return h('div', { class: ['thread-row', 'compact', t.unread && 'unread'], onclick: () => openThreadModal(t.threadId, t.subject) },
              avatarDot(last.direction === 'out' ? 'Me' : other?.name, last.direction === 'out' ? 'me' : other?.address),
              h('div', { class: 'thread-main' },
                h('div', { class: 'thread-line1' }, h('span', { class: 'thread-subj' }, t.subject || '(no subject)'), t.count > 1 ? h('span', { class: 'thread-count' }, String(t.count)) : null, h('span', { class: 'spacer' }), last.tracking && hooks.trackingMini ? hooks.trackingMini(last) : null, h('span', { class: 'thread-date' }, relTime(t.date))),
                h('div', { class: 'thread-snip' }, `${last.direction === 'out' ? 'You: ' : ''}${last.snippet || ''}`)));
          })));
}

let editingKey = null; // field currently in inline-edit mode
let newNoteOpen = false;
let editingNoteId = null;

export function resetDrawerState() { editingKey = null; newNoteOpen = false; editingNoteId = null; }

export function renderDrawer(el) {
  const type = currentType();
  const rec = store.ui.activeId != null ? findRecord(type.key, store.ui.activeId) : null;
  document.body.classList.toggle('drawer-open', !!rec);
  if (!rec) { el.replaceChildren(); el.classList.add('hidden'); return; }
  el.classList.remove('hidden');
  const scroll = el.querySelector('.drawer-body')?.scrollTop || 0;

  const color = colorOf(rec);
  const mref = `${type.key}:${rec.id}`;
  if (mail.accounts.length && (drawerMail.ref !== mref || drawerMail.stale)) setTimeout(() => loadDrawerMail(mref, el), 0);
  const emails = recordEmails(type, rec);
  const head = h('div', { class: 'drawer-head' },
    h('button', { class: 'btn btn-sm', title: 'New note (N)', onclick: () => { newNoteOpen = true; renderDrawer(el); } }, '+ Note'),
    mail.accounts.length && emails.length ? h('button', { class: 'btn btn-sm', title: `Email ${emails[0]}`, onclick: () => hooks.compose?.({ mode: 'new', to: [{ name: recordTitle(type, rec), address: emails[0] }], refs: [mref] }) }, '✉ Email') : null,
    h('button', { class: 'btn btn-sm', title: 'Ask the local AI', onclick: () => hooks.openAI?.([rec.id]) }, '✨ AI'),
    h('button', { class: 'btn btn-sm', title: 'Fill fields from a document with AI', onclick: () => hooks.openDocFill?.(type.key, rec.id) }, '📄→ Fill'),
    h('button', { class: 'btn btn-sm', onclick: e => menu(e.currentTarget, [
      { label: 'Add field…', icon: '+', fn: () => addFieldDialog({ type, recordId: rec.id }) },
      { label: 'Add markdown document…', icon: '📄', fn: () => addFieldDialog({ type, recordId: rec.id, presetType: 'markdown' }) },
      'sep',
      { label: 'Set colour', icon: '●', sub: ['red', 'orange', 'green'].map(c => ({ label: c, fn: () => setColor(type.key, [rec.id], c) })).concat([{ label: 'none', fn: () => setColor(type.key, [rec.id], null) }]) },
      { label: 'Print…', icon: '🖨', fn: () => printRecord(type, rec, 'print') },
      { label: 'Save as PDF…', icon: '📑', fn: () => printRecord(type, rec, 'pdf') },
      { label: 'Duplicate', icon: '⧉', fn: () => { const c = duplicateRecord(type.key, rec.id); if (c) openRecord(c.id); } },
      'sep',
      { label: 'Delete', icon: '🗑', danger: true, fn: () => deleteRecords(type.key, [rec.id]) },
    ], { align: 'right' }) }, '⋯'),
    h('span', { class: 'spacer' }),
    h('button', { class: 'icon-btn', title: 'Previous (↑)', onclick: () => emit('nav', -1) }, '↑'),
    h('button', { class: 'icon-btn', title: 'Next (↓)', onclick: () => emit('nav', 1) }, '↓'),
    h('button', { class: 'icon-btn close-x', title: 'Close (Esc)', onclick: closeRecord }, '×'));

  const body = h('div', { class: 'drawer-body' },
    profileCard(type, rec, color, el),
    documentsSection(type, rec),
    emailsSection(type, rec),
    filesSection(type, rec),
    incomingSection(type, rec),
    notesSection(type, rec, el));

  // drop files anywhere on the card
  body.addEventListener('dragover', e => { if (e.dataTransfer.types.includes('Files')) { e.preventDefault(); body.classList.add('file-drop'); } });
  body.addEventListener('dragleave', e => { if (!body.contains(e.relatedTarget)) body.classList.remove('file-drop'); });
  body.addEventListener('drop', async e => {
    if (!e.dataTransfer.files.length) return;
    e.preventDefault(); body.classList.remove('file-drop');
    const paths = [...e.dataTransfer.files].map(f => window.crm.files.pathFor(f)).filter(Boolean);
    await attachFiles(type, rec, paths);
  });

  el.replaceChildren(h('div', { class: 'drawer-resize', title: 'Drag to resize', onmousedown: startDrawerResize }), head, body);
  body.scrollTop = scroll;
}

function startDrawerResize(e) {
  e.preventDefault();
  const move = ev => {
    const w = Math.min(window.innerWidth - 320, Math.max(380, window.innerWidth - ev.clientX));
    document.documentElement.style.setProperty('--drawer-w', `${w}px`);
  };
  const up = () => {
    document.removeEventListener('mousemove', move);
    document.removeEventListener('mouseup', up);
    const w = parseInt(getComputedStyle(document.documentElement).getPropertyValue('--drawer-w'), 10);
    if (w) window.crm.config.update({ drawerWidth: w });
  };
  document.addEventListener('mousemove', move);
  document.addEventListener('mouseup', up);
}

// ---------- profile + fields ----------
function profileCard(type, rec, color, el) {
  const titleDef = type.fieldDefs.find(f => f.key === type.titleField);
  const pic = type.pictureField ? h('div', { class: 'pic-wrap', title: 'Change picture', onclick: (e) => pictureMenu(e.currentTarget, type, rec) }, avatar(type, rec, 150)) : null;

  const titleEl = editingKey === type.titleField
    ? makeEditor(titleDef, rec[type.titleField], { record: rec, type, commit: v => commitField(type, rec, type.titleField, v, el), cancel: () => { editingKey = null; renderDrawer(el); } })
    : h('h1', { class: 'rec-title editable', title: 'Click to edit', onclick: () => { editingKey = type.titleField; renderDrawer(el); } }, recordTitle(type, rec));

  const fields = type.fieldDefs.filter(d => d.showInCard !== false && d.key !== type.titleField && d.key !== type.pictureField
    && !['markdown', 'file', 'image'].includes(d.type) && (!d.onlyFor || d.onlyFor.includes(rec.id) || !isEmptyValue(rec[d.key])));

  const rows = fields.map(def => {
    const editing = editingKey === def.key;
    const valueEl = editing
      ? makeEditor(def, rec[def.key], {
        record: rec, type,
        commit: v => commitField(type, rec, def.key, v, el),
        cancel: () => { editingKey = null; renderDrawer(el); },
        onEditOptions: def.type === 'select' || def.type === 'multiselect' ? () => optionsEditor(type.key, def.key) : null,
      })
      : h('div', { class: ['fv', 'editable'], title: 'Click to edit', onclick: (e) => { if (e.target.closest('a,.copyable')) return; editingKey = def.key; renderDrawer(el); } },
        displayValue(def, rec[def.key], { record: rec }));
    return h('div', { class: 'field-row' }, h('h2', {}, def.label), valueEl);
  });

  return h('section', { class: ['personal-info', color && `pi-${color}`] },
    pic,
    h('div', { class: 'info-text' },
      h('div', { class: 'title-row' }, titleEl, color ? h('span', { class: `color-badge cb-${color}`, title: `#${color}` }) : null),
      h('div', { class: 'meta-line muted tiny' }, `${type.singular} #${rec.id}`, rec._agent ? ` · 🤖 last changed by ${rec._agent.by}` : '', rec.createdAt ? ` · created ${formatDate(new Date(rec.createdAt), settings().dateFormat)}` : '', rec.updatedAt ? ` · edited ${formatDate(new Date(rec.updatedAt), settings().dateFormat)}` : ''),
      rows,
      reminderRow(type, rec, el),
      h('button', { class: 'btn-link small add-field-link', onclick: () => addFieldDialog({ type, recordId: rec.id }) }, '+ Add field')));
}

function commitField(type, rec, key, value, el) {
  editingKey = null;
  const cur = rec[key];
  if (JSON.stringify(cur ?? '') !== JSON.stringify(value ?? '')) setField(type.key, rec.id, key, value);
  else renderDrawer(el);
}

function pictureMenu(anchor, type, rec) {
  menu(anchor, [
    { label: 'Choose image file…', icon: '🖼', fn: async () => {
      const r = await window.crm.files.setPicture({ typeKey: type.key, id: rec.id });
      if (r?.value) setField(type.key, rec.id, type.pictureField, r.value);
    } },
    { label: 'Use image URL…', icon: '🔗', fn: async () => {
      const v = await promptDialog('Picture URL', { value: /^https?:/.test(rec[type.pictureField] || '') ? rec[type.pictureField] : '', placeholder: 'https://…' });
      if (v !== null) setField(type.key, rec.id, type.pictureField, v.trim());
    } },
    rec[type.pictureField] ? { label: 'Remove picture', icon: '×', fn: () => setField(type.key, rec.id, type.pictureField, '') } : null,
  ].filter(Boolean));
}

function reminderRow(type, rec, el) {
  const r = rec.reminder;
  const active = r?.date && !r.done;
  const state = reminderState(rec);
  if (editingKey === '__reminder') {
    const date = h('input', { class: 'input input-sm', type: 'date', value: r?.date || toIsoDate(new Date(Date.now() + 86400000 * 3)) });
    const text = h('input', { class: 'input input-sm', value: r?.text || '', placeholder: 'What should happen? e.g. Follow up on proposal' });
    const save = () => {
      editingKey = null;
      mutate('Set reminder', () => { const x = findRecord(type.key, rec.id); x.reminder = { date: date.value, text: text.value.trim(), done: false }; touch(x); });
    };
    text.addEventListener('keydown', e => { if (e.key === 'Enter') save(); if (e.key === 'Escape') { editingKey = null; renderDrawer(el); } });
    setTimeout(() => text.focus(), 0);
    return h('div', { class: 'field-row' }, h('h2', {}, 'Next action'), h('div', { class: 'reminder-edit' }, date, text,
      h('button', { class: 'btn btn-sm btn-primary', onclick: save }, 'Save'),
      h('button', { class: 'btn btn-sm', onclick: () => { editingKey = null; renderDrawer(el); } }, 'Cancel')));
  }
  return h('div', { class: 'field-row' }, h('h2', {}, 'Next action'),
    active
      ? h('div', { class: ['reminder', `due-${state}`] },
        h('input', { type: 'checkbox', title: 'Mark done', onchange: () => mutate('Reminder done', () => { const x = findRecord(type.key, rec.id); x.reminder.done = true; x.reminder.doneAt = new Date().toISOString(); touch(x); }) }),
        h('span', { class: 'editable', onclick: () => { editingKey = '__reminder'; renderDrawer(el); } },
          (state === 'overdue' || state === 'today') ? '⏰ ' : '📅 ', formatDate(r.date, settings().dateFormat), r.text ? ` — ${r.text}` : ''),
        h('button', { class: 'icon-btn', title: 'Remove reminder', onclick: () => mutate('Remove reminder', () => { const x = findRecord(type.key, rec.id); delete x.reminder; touch(x); }) }, '×'))
      : h('button', { class: 'btn-link small', onclick: () => { editingKey = '__reminder'; renderDrawer(el); } }, '+ Set reminder'));
}

// ---------- markdown documents ----------
function documentsSection(type, rec) {
  const docs = type.fieldDefs.filter(d => d.type === 'markdown' && d.showInCard !== false && (!d.onlyFor || d.onlyFor.includes(rec.id) || !isEmptyValue(rec[d.key])));
  if (!docs.length) return null;
  return h('section', { class: 'card-section' },
    h('div', { class: 'section-head' }, h('h3', {}, 'Documents'),
      h('button', { class: 'btn-link small', onclick: () => addFieldDialog({ type, recordId: rec.id, presetType: 'markdown' }) }, '+ Add document field')),
    h('div', { class: 'doc-tiles' }, docs.map(def => {
      const val = rec[def.key] || '';
      return h('button', { class: ['doc-tile', !val.trim() && 'empty'], onclick: () => openDoc(type, rec, def) },
        h('div', { class: 'doc-tile-head' }, h('span', { class: 'doc-icon' }, '📄'), h('b', {}, def.label)),
        h('div', { class: 'doc-preview' }, val.trim() ? markdownPreviewText(val, 160) : 'Empty — click to write'));
    })));
}

export function openDoc(type, rec, def) {
  openMarkdownModal({
    title: def.label,
    subtitle: recordTitle(type, rec),
    value: rec[def.key] || '',
    onSave: (text) => {
      const cur = findRecord(type.key, rec.id);
      if (!cur || (cur[def.key] || '') === text) return;
      setField(type.key, rec.id, def.key, text, { coalesce: `md:${type.key}:${rec.id}:${def.key}` });
    },
  });
}

// ---------- files ----------
async function attachFiles(type, rec, paths, fieldKey = null) {
  const res = await window.crm.files.add({ typeKey: type.key, id: rec.id, paths });
  if (!res?.refs?.length) return;
  mutate(`Attach ${res.refs.length} file(s)`, () => {
    const x = findRecord(type.key, rec.id);
    if (fieldKey) x[fieldKey] = [...(x[fieldKey] || []), ...res.refs];
    else x.files = [...(x.files || []), ...res.refs];
    touch(x);
  });
  toast(`Attached ${res.refs.length} file(s)`);
}

function filesSection(type, rec) {
  const fileDefs = type.fieldDefs.filter(d => d.type === 'file' && d.showInCard !== false);
  const groups = [{ key: null, label: 'Files', refs: rec.files || [] }, ...fileDefs.map(d => ({ key: d.key, label: d.label, refs: rec[d.key] || [] }))];
  const handlers = (key) => ({
    onOpen: f => window.crm.files.open(f.rel).catch(e => toast(e.message, { type: 'error' })),
    onReveal: f => window.crm.files.reveal(f.rel),
    onExtract: f => hooks.openDocFill?.(type.key, rec.id, f),
    onRemove: async f => {
      if (!(await confirmDialog(`Remove “${f.name}”?`, { detail: 'The file is moved to the .trash folder next to your database.', okLabel: 'Remove' }))) return;
      await window.crm.files.trash(f.rel).catch(() => {});
      mutate('Remove file', () => {
        const x = findRecord(type.key, rec.id);
        if (key) x[key] = (x[key] || []).filter(r => r.id !== f.id); else x.files = (x.files || []).filter(r => r.id !== f.id);
        touch(x);
      });
    },
  });
  return h('section', { class: 'card-section files-section' },
    groups.map(g => h('div', { class: 'file-group' },
      h('div', { class: 'section-head' }, h('h3', {}, `${g.label}${g.refs.length ? ` (${g.refs.length})` : ''}`),
        h('button', { class: 'btn-link small', onclick: () => attachFiles(type, rec, [], g.key) }, '+ Attach')),
      fileList(g.refs, handlers(g.key)))));
}

// ---------- incoming relations ("Linked from") ----------
function incomingSection(type, rec) {
  const items = [];
  for (const t of store.data.meta.recordTypes) {
    for (const def of t.fieldDefs.filter(d => d.type === 'relation' && d.target === type.key)) {
      for (const r of store.data[t.key] || []) {
        const link = (r[def.key] || []).find(l => l.id === rec.id);
        if (link) items.push({ t, def, r, link });
      }
    }
  }
  if (!items.length) return null;
  return h('section', { class: 'card-section' },
    h('div', { class: 'section-head' }, h('h3', {}, 'Linked from')),
    h('div', { class: 'linked-list' }, items.map(({ t, def, r, link }) => h('div', { class: 'linked-row', onclick: () => openRecord(r.id, t.key) },
      h('span', { class: 'muted small' }, `${t.singular} · ${def.label}`),
      h('b', {}, recordTitle(t, r)),
      link.v ? h('span', { class: 'chip chip-sm' }, link.v) : null))));
}

export function incomingRelationsText(type, rec) {
  const out = [];
  for (const t of store.data.meta.recordTypes) {
    for (const def of t.fieldDefs.filter(d => d.type === 'relation' && d.target === type.key)) {
      for (const r of store.data[t.key] || []) {
        const link = (r[def.key] || []).find(l => l.id === rec.id);
        if (link) out.push({ id: `${t.key}:${r.id}:${def.key}`, label: `${t.singular} (${def.label})`, text: `${recordTitle(t, r)}${link.v ? ` — ${link.v}` : ''}` });
      }
    }
  }
  return out;
}

// ---------- notes ----------
function kindIcon(kind) {
  const k = (settings().noteKinds || []).find(x => x.value === kind);
  return k?.icon || (kind ? '•' : '📝');
}

function noteForm(type, rec, el, note = null) {
  const kinds = settings().noteKinds || [];
  const kindSel = h('select', { class: 'input input-sm' }, kinds.map(k => h('option', { value: k.value, selected: (note?.kind || 'Note') === k.value }, `${k.icon} ${k.value}`)));
  const wcSel = h('select', { class: 'input input-sm', title: 'Wildcard' }, WILDCARDS.map(w => h('option', { value: w.value }, w.label)));
  const date = h('input', { class: 'input input-sm', type: 'date', value: noteDateToIso(note?.date || noteDateString()) });
  const time = h('input', { class: 'input input-sm', type: 'time', value: note?.time || noteTimeString() });
  const text = h('textarea', { class: 'input note-text', rows: 5, value: note ? note.content : '', placeholder: 'Write a note… (#red #orange #green #! #X wildcards work anywhere in the text)' });
  const save = () => {
    const content = note ? text.value : composeNote(wcSel.value, text.value);
    if (!content.trim()) { toast('The note is empty'); return; }
    if (note) {
      editingNoteId = null;
      mutate('Edit note', () => {
        const x = findRecord(type.key, rec.id);
        const n = x.notes.find(nn => nn.id === note.id);
        if (!n) return;
        n.content = content; n.date = isoToNoteDate(date.value) || n.date; n.time = time.value || n.time;
        if (kindSel.value && kindSel.value !== 'Note') n.kind = kindSel.value; else delete n.kind;
        touch(x);
      });
    } else {
      newNoteOpen = false;
      mutate('Add note', () => {
        const x = findRecord(type.key, rec.id);
        (x.notes ||= []).push({ id: newNoteId(), date: isoToNoteDate(date.value) || noteDateString(), time: time.value || noteTimeString(), content, ...(kindSel.value !== 'Note' ? { kind: kindSel.value } : {}) });
        touch(x);
      });
    }
  };
  text.addEventListener('keydown', e => {
    if (e.key === 'Enter' && e.ctrlKey) { e.preventDefault(); save(); }
    if (e.key === 'Escape') { e.stopPropagation(); newNoteOpen = false; editingNoteId = null; renderDrawer(el); }
  });
  setTimeout(() => text.focus(), 0);
  return h('div', { class: 'note-form' },
    h('div', { class: 'note-form-row' }, kindSel, note ? null : wcSel, date, time),
    text,
    h('div', { class: 'note-form-row' },
      h('button', { class: 'btn btn-primary btn-sm', onclick: save }, note ? 'Save note' : 'Add note'),
      h('button', { class: 'btn btn-sm', onclick: () => { newNoteOpen = false; editingNoteId = null; renderDrawer(el); } }, 'Cancel'),
      h('span', { class: 'muted tiny' }, 'Ctrl+Enter to save')));
}

function noteBody(n) {
  const clean = String(n.content || '').replace(/#!|#X/g, '').trim();
  if (settings().notesMarkdown) return renderMarkdown(clean);
  return h('div', { class: 'note-content' }, linkify(clean.replace(/^\s*\n/, '')));
}

function noteTags(n) {
  const tags = [];
  for (const c of ['red', 'orange', 'green']) if (new RegExp(`#${c}\\b`).test(n.content)) tags.push(h('span', { class: `ntag ntag-${c}`, title: `#${c}` }));
  if (isHidden(n)) tags.push(h('span', { class: 'ntag-text' }, 'hidden'));
  return tags;
}

function notesSection(type, rec, el) {
  const notes = notesForDisplay(rec, { showHidden: store.ui.showHiddenNotes });
  const hiddenCount = (rec.notes || []).filter(isHidden).length;
  const df = settings().dateFormat;
  const timeline = store.ui.notesMode === 'timeline';

  const del = async (n) => {
    if (!(await confirmDialog('Delete this note?', { danger: true, okLabel: 'Delete', detail: stripWildcards(n.content).slice(0, 200) }))) return;
    mutate('Delete note', () => { const x = findRecord(type.key, rec.id); x.notes = x.notes.filter(nn => nn.id !== n.id); touch(x); });
    toast('Note deleted', { action: { label: 'Undo', fn: () => emit('undo') } });
  };

  const noteCard = (n) => {
    if (editingNoteId === n.id) return noteForm(type, rec, el, n);
    return h('div', { class: ['note', isImportant(n) ? 'note-important' : 'note-normal', isHidden(n) && 'note-hidden'] },
      h('div', { class: 'note-head' },
        h('span', { class: 'note-kind', title: n.kind || 'Note' }, kindIcon(n.kind || 'Note')),
        n._agent ? h('span', { class: 'agent-mark', title: `Written by the AI agent “${n._agent}”` }, `🤖 ${n._agent}`) : null,
        h('span', { class: 'note-date' }, formatDate(n.date, df)), h('span', { class: 'note-time' }, n.time || ''),
        noteTags(n),
        h('span', { class: 'spacer' }),
        h('button', { class: 'icon-btn', title: 'Edit note', onclick: () => { editingNoteId = n.id; renderDrawer(el); } }, '✎'),
        h('button', { class: 'icon-btn', title: 'Delete note', onclick: () => del(n) }, '✕')),
      noteBody(n));
  };

  let list;
  if (!notes.length) list = h('p', { class: 'muted pad' }, 'No notes available for this record.');
  else if (timeline) {
    const ref = `${type.key}:${rec.id}`;
    const mails = drawerMail.ref === ref ? drawerMail.msgs.map(m => ({ __mail: m, _t: Date.parse(m.date) })) : [];
    const sorted = [...notes.map(n => ({ ...n, _t: noteTime(n) })), ...mails].sort((a, b) => b._t - a._t);
    const byMonth = new Map();
    for (const n of sorted) {
      const d = new Date(n._t || 0);
      const k = n._t ? d.toLocaleDateString('en', { month: 'long', year: 'numeric' }) : 'Undated';
      if (!byMonth.has(k)) byMonth.set(k, []);
      byMonth.get(k).push(n);
    }
    list = h('div', { class: 'timeline' }, [...byMonth].map(([m, ns]) => h('div', { class: 'tl-month' },
      h('div', { class: 'tl-month-label' }, m),
      ns.map(n => n.__mail ? mailTimelineItem(n.__mail) : editingNoteId === n.id ? noteForm(type, rec, el, notes.find(x => x.id === n.id)) : h('div', { class: ['tl-item', isImportant(n) && 'important', isHidden(n) && 'note-hidden'] },
        h('span', { class: 'tl-icon' }, kindIcon(n.kind || 'Note')),
        h('div', { class: 'tl-body' },
          h('div', { class: 'tl-meta' }, `${formatDate(n.date, df)} ${n.time || ''} · ${n.kind || 'Note'}`, noteTags(n),
            h('button', { class: 'icon-btn', title: 'Edit', onclick: () => { editingNoteId = n.id; renderDrawer(el); } }, '✎')),
          noteBody(n)))))));
  } else list = h('div', { class: 'notes-list' }, notes.map(noteCard));

  return h('section', { class: 'card-section notes-section' },
    h('div', { class: 'section-head' },
      h('h3', {}, `Notes (${(rec.notes || []).length})`),
      h('span', { class: 'spacer' }),
      hiddenCount ? h('label', { class: 'check-row small' }, h('input', { type: 'checkbox', checked: store.ui.showHiddenNotes, onchange: e => { store.ui.showHiddenNotes = e.target.checked; renderDrawer(el); } }), ` Show hidden (${hiddenCount})`) : null,
      h('div', { class: 'seg' },
        h('button', { class: ['seg-btn', !timeline && 'on'], onclick: () => { store.ui.notesMode = 'cards'; renderDrawer(el); } }, 'Cards'),
        h('button', { class: ['seg-btn', timeline && 'on'], onclick: () => { store.ui.notesMode = 'timeline'; renderDrawer(el); } }, 'Timeline')),
      h('button', { class: 'btn btn-sm', onclick: () => { newNoteOpen = true; renderDrawer(el); } }, '+ New note')),
    newNoteOpen ? noteForm(type, rec, el) : null,
    list);
}

export function openNewNote(el) { newNoteOpen = true; renderDrawer(el); }

function mailTimelineItem(m) {
  const who = m.direction === 'out' ? `To ${m.to.map(a => a.name || a.address).join(', ')}` : `From ${m.from[0]?.name || m.from[0]?.address || ''}`;
  return h('div', { class: ['tl-item', 'tl-mail', m.direction === 'in' && !m.seen && 'unread'], onclick: () => openThreadModal(m.threadId, m.subject) },
    h('span', { class: 'tl-icon' }, m.direction === 'out' ? '📤' : '📥'),
    h('div', { class: 'tl-body' },
      h('div', { class: 'tl-meta' }, `${new Date(m.date).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' })} · Email · ${who}`, m.tracking && hooks.trackingMini ? hooks.trackingMini(m) : null),
      h('div', { class: 'note-content' }, h('b', {}, m.subject || '(no subject)'), m.snippet ? ` — ${m.snippet}` : '')));
}

