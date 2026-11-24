// Note wildcard logic. Preserves the v1 semantics exactly:
//   #red / #orange / #green  -> row colour (v1 rule: red > orange > green across ALL notes)
//   #!                       -> important note (pinned first, orange)
//   #X                       -> hidden note
// Fixes v1 bugs: no in-place sorting of notes, real "last contact" date, working hide wildcard.

import { parseAnyDate, startOfDay } from './dates.js';

export const COLORS = ['red', 'orange', 'green'];
export const WILDCARDS = [
  { value: '', label: 'No wildcard' },
  { value: '#X', label: 'Hide note (#X)' },
  { value: '#!', label: 'Important note (#!)' },
  { value: '#red', label: 'Red contact (#red)' },
  { value: '#orange', label: 'Orange contact (#orange)' },
  { value: '#green', label: 'Green contact (#green)' },
];

const COLOR_TAG_RE = /#(red|orange|green)\b/g;

export function noteTime(note) {
  const d = parseAnyDate(note?.date, note?.time);
  return d ? d.getTime() : 0;
}

export const isImportant = note => String(note?.content || '').includes('#!');
export const isHidden = note => String(note?.content || '').includes('#X');

export function noteColors(note) {
  const found = new Set();
  const s = String(note?.content || '');
  for (const m of s.matchAll(COLOR_TAG_RE)) found.add(m[1]);
  return found;
}

// rule: 'severity' (v1 behaviour) or 'latest' (most recent colour tag wins)
export function recordColor(record, rule = 'severity') {
  const notes = Array.isArray(record?.notes) ? record.notes : [];
  if (rule === 'latest') {
    let best = null, bestT = -Infinity;
    for (const n of notes) {
      const cs = noteColors(n);
      if (!cs.size) continue;
      const t = noteTime(n);
      if (t >= bestT) {
        bestT = t;
        best = COLORS.find(c => cs.has(c));
      }
    }
    return best;
  }
  const all = new Set();
  for (const n of notes) for (const c of noteColors(n)) all.add(c);
  return COLORS.find(c => all.has(c)) || null;
}

// Latest note timestamp (ms) or 0 — independent of array order (fixes v1 Date column bug).
export function lastContactTime(record) {
  const notes = Array.isArray(record?.notes) ? record.notes : [];
  let max = 0;
  for (const n of notes) max = Math.max(max, noteTime(n));
  return max;
}

export function lastNote(record) {
  const notes = Array.isArray(record?.notes) ? record.notes : [];
  let best = null, bestT = -1;
  for (const n of notes) { const t = noteTime(n); if (t > bestT) { bestT = t; best = n; } }
  return best;
}

// Returns a NEW array: important first, then newest first. Never mutates the record.
export function notesForDisplay(record, { showHidden = false } = {}) {
  const notes = Array.isArray(record?.notes) ? record.notes.slice() : [];
  return notes
    .filter(n => showHidden || !isHidden(n))
    .sort((a, b) => (isImportant(b) - isImportant(a)) || (noteTime(b) - noteTime(a)));
}

export function stripWildcards(content) {
  return String(content || '')
    .replace(/#!|#X/g, '')
    .replace(COLOR_TAG_RE, '')
    .replace(/^[ \t]*\r?\n/, '')
    .trim();
}

export function stripColorTags(content) {
  return String(content || '').replace(COLOR_TAG_RE, '').replace(/^[ \t]*\r?\n/, '').replace(/^\s+/, '');
}

export function composeNote(wildcard, text) {
  const t = String(text || '').trim();
  return wildcard ? `${wildcard} ${t}`.trim() : t;
}

export function isStale(record, staleDays, now = new Date()) {
  if (!staleDays) return false;
  const t = lastContactTime(record);
  if (!t) return false;
  return (startOfDay(now) - startOfDay(new Date(t))) / 86400000 > staleDays;
}
