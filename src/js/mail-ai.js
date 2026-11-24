// AI for email (plain chat, no tool calling — works with Gemma and other small local models):
// draft from an instruction, reply using the conversation, improve/shorten/tone/translate, summarise a thread.
import { h, replace } from './dom.js';
import { store, mutate, findRecord, touch } from './store.js';
import { contextItems, defaultSelection, buildContextText, newId, stripQuoted, recordTitle } from './shared.js';
import { relCtx } from './editors.js';
import { menu, openModal, promptDialog, toast } from './ui.js';
import { hooks } from './hooks.js';
import { recordForRef } from './mail-state.js';

const aiReady = () => !!store.config?.ai?.baseUrl;

export async function streamChat(messages, onText) {
  const streamId = newId('s');
  let acc = '';
  const off = window.crm.ai.onChunk(({ streamId: sid, delta }) => {
    if (sid !== streamId || !delta) return;
    acc += delta;
    onText?.(acc);
  });
  try {
    const res = await window.crm.ai.chat({ messages, streamId });
    return (res.text ?? acc).trim();
  } finally { off(); }
}

function me() { return store.config.ui.me || {}; }

function systemPrompt() {
  const m = me();
  return [
    `You write emails on behalf of ${m.name || 'the user'}${m.about ? ` (${m.about.replace(/\s+/g, ' ').slice(0, 400)})` : ''}.`,
    'Write natural, concise, friendly-professional emails. Write in the same language as the conversation or the instruction.',
    'Output ONLY the email body in plain text (Markdown allowed for **bold**, lists and links). No explanations, no placeholders like [Name] unless the information is really missing.',
    `Do not add a signature block; end with a short closing line and the sender's first name${m.name ? ` (${m.name.split(' ')[0]})` : ''}.`,
  ].join('\n');
}

function recordContext(rec) {
  if (!rec) return '';
  const ctx = { dateFormat: store.data.meta.settings.dateFormat, ...relCtx };
  const items = contextItems(rec.type, rec.rec, ctx);
  return buildContextText(rec.type, rec.rec, items, defaultSelection(items, null)).slice(0, 6000);
}

async function threadContext(message) {
  if (!message?.threadId) return message ? `From ${message.from?.[0]?.name || message.from?.[0]?.address}: ${stripQuoted(message.body?.text || '')}` : '';
  const { messages } = await window.crm.mail.list({ threadId: message.threadId, limit: 50 });
  messages.sort((a, b) => new Date(a.date) - new Date(b.date));
  const last = messages.slice(-6);
  const parts = [];
  for (const m of last) {
    let text = m.key === message.key ? message.body?.text : null;
    if (text == null) { try { text = (await window.crm.mail.get(m.key)).message.body?.text || ''; } catch { text = m.snippet || ''; } }
    parts.push(`--- ${m.direction === 'out' ? 'Me' : (m.from?.[0]?.name || m.from?.[0]?.address)} (${new Date(m.date).toLocaleString()}):\n${stripQuoted(text).slice(0, 2500)}`);
  }
  return parts.join('\n\n');
}

/** Splits the compose body into [own text, tail (signature + quoted history)] so AI only touches the own text. */
function splitBody(value) {
  const idx = [value.search(/\n-- \n/), value.search(/\n\nOn .{4,200} wrote:\n/), value.search(/\n\n---------- Forwarded message/)].filter(i => i >= 0);
  const cut = idx.length ? Math.min(...idx) : value.length;
  return [value.slice(0, cut), value.slice(cut)];
}

function aiGuard() {
  if (aiReady()) return true;
  toast('Set up your local AI first (Settings → AI).', { type: 'error', action: { label: 'Settings', fn: () => hooks.openSettings?.('ai') } });
  return false;
}

async function runInto(compose, messages, { replaceAll = true, setSubject = false } = {}) {
  const { body, subject } = compose;
  const [own, tail] = splitBody(body.value);
  const start = body.selectionStart, end = body.selectionEnd;
  const useSel = !replaceAll && end > start && end <= own.length;
  const before = useSel ? own.slice(0, start) : '';
  const after = useSel ? own.slice(end) : '';
  body.classList.add('ai-writing');
  body.readOnly = true;
  try {
    const text = await streamChat(messages, acc => { body.value = before + clean(acc, setSubject).text + after + tail; });
    const out = clean(text, setSubject);
    if (setSubject && out.subject && (!subject.value.trim() || /^(re|fwd):\s*$/i.test(subject.value.trim()))) subject.value = out.subject;
    body.value = before + out.text + after + (tail.startsWith('\n') ? tail : (tail ? `\n${tail}` : ''));
    compose.onChange?.();
  } catch (e) { toast(e.message, { type: 'error', timeout: 8000 }); body.value = own + tail; }
  finally { body.readOnly = false; body.classList.remove('ai-writing'); }
}

function clean(text, withSubject) {
  let t = String(text || '').replace(/^```[a-z]*\n?|```$/g, '').trim();
  let subject = '';
  const m = withSubject && t.match(/^\s*(?:subject|asunto|betreff|objet)\s*:\s*(.+)\n+/i);
  if (m) { subject = m[1].trim(); t = t.slice(m[0].length); }
  return { text: t.trim(), subject };
}

export function mailAI({ action, anchor, compose, message }) {
  if (action === 'summarize') return summarizeThread(message);
  if (action !== 'menu') return null;
  const rec = compose.record?.();
  const msg = compose.message;
  const own = () => splitBody(compose.body.value)[0].trim();
  const transform = (instruction) => () => {
    if (!aiGuard()) return;
    const sel = compose.body.selectionEnd > compose.body.selectionStart ? compose.body.value.slice(compose.body.selectionStart, compose.body.selectionEnd) : own();
    if (!sel.trim()) { toast('Write something first (or select text).'); return; }
    runInto(compose, [
      { role: 'system', content: 'You edit email text. Output ONLY the rewritten text, nothing else. Keep the meaning, names, links and facts. Keep Markdown formatting.' },
      { role: 'user', content: `${instruction}\n\nText:\n"""\n${sel}\n"""` },
    ], { replaceAll: !(compose.body.selectionEnd > compose.body.selectionStart) });
  };
  return menu(anchor, [
    { label: msg ? 'Write a reply…' : 'Write a draft…', icon: '✍', fn: async () => {
      if (!aiGuard()) return;
      const instr = await promptDialog(msg ? 'What should the reply say?' : 'What is the email about?', {
        placeholder: msg ? 'e.g. accept Tuesday 3pm, ask for their portfolio link' : 'e.g. invite them to a 20-minute call next week about the audio engineer role',
        multiline: true, okLabel: 'Write',
      });
      if (instr == null) return;
      const ctxRec = recordContext(rec);
      const conv = msg ? await threadContext(msg) : '';
      const user = [
        msg ? `Write my reply to this conversation.${instr.trim() ? ` What I want to say: ${instr.trim()}` : ''}` : `Write an email. ${instr.trim()}`,
        msg ? '' : 'Start with a line "Subject: …", then a blank line, then the email body.',
        rec ? `\nRecipient: ${recordTitle(rec.type, rec.rec)}\nWhat I know about them:\n${ctxRec}` : '',
        conv ? `\nConversation so far (oldest first):\n${conv}` : '',
      ].filter(Boolean).join('\n');
      runInto(compose, [{ role: 'system', content: systemPrompt() }, { role: 'user', content: user }], { setSubject: !msg });
    } },
    'sep',
    { label: 'Improve writing', icon: '✨', fn: transform('Improve the writing: clearer, warmer, well structured, correct grammar. Same language.') },
    { label: 'Fix spelling & grammar only', icon: '✓', fn: transform('Fix spelling, grammar and punctuation only. Do not change the wording otherwise.') },
    { label: 'Make shorter', icon: '✂', fn: transform('Make it about 40% shorter while keeping every important point.') },
    { label: 'More formal', icon: '🎩', fn: transform('Rewrite in a more formal, polite business tone.') },
    { label: 'More friendly', icon: '🙂', fn: transform('Rewrite in a warmer, more friendly and personal tone.') },
    { label: 'Translate…', icon: '🌐', fn: async () => {
      const lang = await promptDialog('Translate to which language?', { value: 'English' });
      if (lang) transform(`Translate into ${lang}. Keep names, links and formatting.`)();
    } },
  ]);
}

export async function summarizeThread(message) {
  if (!aiGuard()) return;
  const out = h('div', { class: 'md ai-summary pre-wrap' }, 'Reading the conversation…');
  const status = h('span', { class: 'muted small' });
  let text = '';
  const refs = message.refs || [];
  const m = openModal({
    title: `✨ Summary — ${message.subject || '(no subject)'}`, size: 'md', body: h('div', {}, out, status),
    actions: [
      { label: 'Copy', keepOpen: true, fn: () => { window.crm.app.clipboard(text); toast('Copied'); return false; } },
      ...refs.slice(0, 1).map(ref => ({ label: 'Save as note', primary: true, fn: () => {
        const r = recordForRef(ref);
        if (!r) return;
        const d = new Date(); const pad = n => String(n).padStart(2, '0');
        const MON = ['JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN', 'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC'];
        mutate('Email summary note', () => {
          const x = findRecord(r.typeKey, r.id);
          (x.notes ||= []).push({ id: newId('n'), date: `${d.getFullYear()}/${MON[d.getMonth()]}/${pad(d.getDate())}`, time: `${pad(d.getHours())}:${pad(d.getMinutes())}`, kind: 'Email', content: `Email summary — ${message.subject}\n\n${text}` });
          touch(x);
        });
        toast('Saved as a note');
      } })),
    ],
  });
  try {
    const conv = await threadContext(message);
    const t0 = Date.now();
    text = await streamChat([
      { role: 'system', content: 'You summarise email conversations for a busy professional. Be factual and brief. Use the language of the conversation.' },
      { role: 'user', content: `Summarise this email conversation in 3-5 bullet points, then a line "Next step:" with what I should do next (or "None").\n\n${conv}` },
    ], acc => { text = acc; replace(out, acc); });
    replace(out, text);
    status.textContent = `Done in ${((Date.now() - t0) / 1000).toFixed(1)} s`;
  } catch (e) { replace(out, h('div', { class: 'error-box' }, e.message)); }
  return m;
}
