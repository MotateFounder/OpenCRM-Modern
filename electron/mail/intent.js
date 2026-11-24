// Reply intent (local AI, JSON mode, no tool calling) and bounce / auto-reply detection. No Electron imports.
import { stripQuoted, normEmail, EMAIL_RE } from '../../src/shared/mail.js';
import { extractJson } from '../../src/shared/prompting.js';

export const INTENT_CODES = ['interested', 'question', 'meeting', 'not_now', 'not_interested', 'unsubscribe', 'out_of_office', 'wrong_person', 'other'];

const OOO_SUBJECT = /(out of (the )?office|automatic reply|auto(matic)?[- ]?reply|autoreply|abwesenheit|fuera de la oficina|respuesta autom[aá]tica|absence|r[ée]ponse automatique|risposta automatica|vacation|on leave)/i;

export function looksAutoReply(e, text = '') {
  return !!(e.autoSubmitted || OOO_SUBJECT.test(e.subject || '') || /^(i am|i'm) (currently )?(out of|away|on (vacation|holiday|leave))/im.test(text));
}

export function intentPrompt({ subject, from, text, today = new Date().toISOString().slice(0, 10) }) {
  return [
    { role: 'system', content: 'You classify email replies for a small business CRM. Answer ONLY with one JSON object, no other text.' },
    { role: 'user', content: [
      'Classify this email reply.',
      'Intents: interested (wants to go ahead or know more), question (asks something), meeting (wants to schedule a call or meeting), not_now (maybe later), not_interested, unsubscribe (asks to stop receiving emails), out_of_office (automatic absence reply), wrong_person (not the right contact), other.',
      'Return JSON: {"intent": "<one of the intents>", "summary": "<one short sentence>", "nextStep": "<my suggested next step, short>", "returnDate": "<YYYY-MM-DD if they say when they are back or available, else null>", "confidence": <0..1>}',
      'Write "summary" and "nextStep" in the SAME language as the reply text below (an English reply gets English text, a Spanish reply Spanish, a German reply German).',
      '',
      `Today: ${today}`,
      `Subject: ${subject || ''}`,
      `From: ${from || ''}`,
      'Reply:',
      '"""',
      String(text || '').slice(0, 3500),
      '"""',
    ].join('\n') },
  ];
}

export function parseIntent(raw) {
  const j = typeof raw === 'object' && raw ? raw : extractJson(raw);
  if (!j || typeof j !== 'object') return null;
  let intent = String(j.intent || '').toLowerCase().trim().replace(/[\s-]+/g, '_');
  if (intent === 'out_office' || intent === 'ooo') intent = 'out_of_office';
  if (!INTENT_CODES.includes(intent)) intent = 'other';
  const rd = /^\d{4}-\d{2}-\d{2}$/.test(String(j.returnDate || '')) ? j.returnDate : null;
  return {
    intent,
    summary: String(j.summary || '').slice(0, 240),
    nextStep: String(j.nextStep || j.next_step || '').slice(0, 200),
    returnDate: rd,
    confidence: Math.max(0, Math.min(1, Number(j.confidence) || 0.5)),
  };
}

/** Classifies one reply. chat = (opts) => Promise<string> (electron/ai-service chat). */
export async function classifyReply(chat, aiOpts, { subject, from, text }) {
  const body = stripQuoted(text);
  const messages = intentPrompt({ subject, from, text: body });
  let out;
  try { out = await chat({ ...aiOpts, messages, json: true, stream: false, maxTokens: 300, temperature: 0.1 }); }
  catch { out = await chat({ ...aiOpts, messages, stream: false, maxTokens: 300, temperature: 0.1 }); }
  return parseIntent(out);
}

/**
 * Reads a delivery-failure report. Returns { address, messageId, reason } or null.
 */
export function parseBounce(text, selfAddresses = []) {
  const t = String(text || '');
  const self = new Set(selfAddresses.map(normEmail));
  let address = (t.match(/^(?:Final|Original)-Recipient:\s*rfc822;\s*<?([^\s>]+)>?/im) || [])[1];
  if (!address) {
    const cand = (t.match(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g) || []).map(normEmail).filter(a => !self.has(a) && !/mailer-daemon|postmaster|no-?reply/i.test(a) && EMAIL_RE.test(a));
    address = cand[0];
  }
  if (!address) return null;
  const messageId = (t.match(/^Message-ID:\s*(<[^>]+>)/im) || [])[1] || null;
  const status = (t.match(/^Status:\s*([45]\.\d+\.\d+)/im) || [])[1] || '';
  const diag = (t.match(/^Diagnostic-Code:\s*(?:smtp;\s*)?(.+)$/im) || [])[1] || '';
  const human = /(does not exist|no such user|user unknown|unknown user|mailbox unavailable|address rejected|not found|recipient address rejected|invalid recipient|no existe|unbekannt)/i.exec(t)?.[0] || '';
  const reason = (diag || human || (status ? `status ${status}` : '')).trim().slice(0, 160);
  // temporary failures (4.x.x, mailbox full) are not marked invalid
  const permanent = !/^4\./.test(status) && !/(mailbox full|quota|over quota|temporar)/i.test(t);
  return { address: normEmail(address), messageId, reason, permanent };
}
