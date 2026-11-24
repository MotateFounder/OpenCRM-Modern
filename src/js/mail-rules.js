// What happens in the CRM when email events arrive (interest buttons, unsubscribes, bounces, reply intent).
// Built-in: notes on the record, "Do not email" / "invalid address" flags. User rules (meta.mailRules):
//   { id, on: 'interest'|'reply'|'click'|'unsubscribe'|'bounce', match: '' (any) | choice/intent code,
//     action: 'setField'|'addLabel'|'reminder'|'notify', field, value, days }
import { store, mutate, findRecord, touch } from './store.js';
import { getType, normalizeTags, toIsoDate, recordTitle } from './shared.js';
import { recordForRef } from './mail-state.js';
import { toast } from './ui.js';

const pad = n => String(n).padStart(2, '0');
const MON = ['JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN', 'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC'];
const noteNow = (content, kind = 'Email') => { const d = new Date(); return { id: 'n_' + Math.random().toString(36).slice(2, 10), date: `${d.getFullYear()}/${MON[d.getMonth()]}/${pad(d.getDate())}`, time: `${pad(d.getHours())}:${pad(d.getMinutes())}`, kind, content }; };

export const RULE_EVENTS = [
  ['interest', 'clicks an interest button'],
  ['reply', 'replies (AI reads the intent)'],
  ['click', 'clicks a link'],
  ['unsubscribe', 'unsubscribes'],
  ['bounce', 'email bounces'],
];
export const INTENTS = [['interested', 'Interested'], ['question', 'Has a question'], ['meeting', 'Wants a meeting'], ['not_now', 'Not now'], ['not_interested', 'Not interested'], ['unsubscribe', 'Asks to unsubscribe'], ['out_of_office', 'Out of office'], ['wrong_person', 'Wrong person']];

function setFieldValue(type, rec, fieldName, value) {
  const def = type.fieldDefs.find(f => f.key === fieldName || f.label.toLowerCase() === String(fieldName).toLowerCase());
  if (!def) return false;
  if (def.type === 'tags' || def.type === 'multiselect') rec[def.key] = normalizeTags([...(rec[def.key] || []), value]);
  else if (def.type === 'checkbox') rec[def.key] = /^(1|true|yes|sí|si)$/i.test(String(value));
  else if (def.type === 'number') rec[def.key] = Number(value);
  else rec[def.key] = value;
  return true;
}

/** ev: { kind, refs, subject, label?, choice?, intent?: {intent, summary, nextStep, returnDate}, url?, address? } */
export function applyMailEvent(ev) {
  const refs = (ev.refs || []).map(recordForRef).filter(Boolean);
  if (!refs.length) return;
  const rules = (store.data.meta.mailRules || []).filter(r => r.on === (ev.kind === 'intent' ? 'reply' : ev.kind) && (!r.match || r.match === (ev.choice || ev.intent?.intent)));
  const builtin = {
    interest: `👍 Clicked “${ev.label || ev.choice}” in the email “${ev.subject}”`,
    unsubscribe: `⊘ Unsubscribed from emails (“${ev.subject}”). Marked “Do not email”.`,
    bounce: `⚠ Email to ${ev.address || 'this address'} bounced${ev.reason ? `: ${ev.reason}` : ''}. Address marked as invalid.`,
    intent: ev.intent && ['interested', 'meeting', 'unsubscribe', 'out_of_office', 'not_interested'].includes(ev.intent.intent)
      ? `✨ Reply to “${ev.subject}”: ${(INTENTS.find(i => i[0] === ev.intent.intent) || [, ev.intent.intent])[1]}${ev.intent.summary ? ` — ${ev.intent.summary}` : ''}${ev.intent.nextStep ? `\nNext step: ${ev.intent.nextStep}` : ''}`
      : null,
  }[ev.kind];
  if (!builtin && !rules.length) return;
  mutate(`Email: ${ev.kind}`, () => {
    for (const { typeKey, id } of refs) {
      const rec = findRecord(typeKey, id);
      const type = getType(store.data, typeKey);
      if (!rec) continue;
      if (builtin) (rec.notes ||= []).push(noteNow(builtin));
      if (ev.kind === 'unsubscribe' || (ev.kind === 'intent' && ev.intent?.intent === 'unsubscribe')) rec.doNotEmail = true;
      if (ev.kind === 'bounce') rec.emailInvalid = true;
      for (const r of rules) {
        if (r.action === 'setField') setFieldValue(type, rec, r.field, r.value);
        else if (r.action === 'addLabel') rec.labels = normalizeTags([...(rec.labels || []), r.value]);
        else if (r.action === 'reminder') {
          const when = ev.intent?.returnDate && ev.intent.intent === 'out_of_office' ? ev.intent.returnDate : toIsoDate(new Date(Date.now() + (Number(r.days) || 2) * 864e5));
          if (!rec.reminder || rec.reminder.done) rec.reminder = { date: when, text: r.value || `Follow up on “${ev.subject}”`, done: false };
        }
      }
      touch(rec);
    }
  }, { undoable: true });
  for (const r of rules.filter(x => x.action === 'notify')) toast(`${refs.map(x => recordTitle(x.type, x.rec)).join(', ')}: ${r.value || ev.kind}`, { timeout: 8000 });
}
