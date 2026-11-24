// Date helpers. Notes keep the v1 storage format "dd/mm/yyyy" + "hh:mm" for compatibility.
// Date fields (type "date") are stored as ISO "yyyy-mm-dd".

export const MONTHS = ['JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN', 'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC'];

export const DATE_FORMATS = ['YYYY/MMM/DD', 'DD/MM/YYYY', 'MM/DD/YYYY', 'YYYY-MM-DD', 'DD MMM YYYY'];

const pad = n => String(n).padStart(2, '0');

// Parses "dd/mm/yyyy", "d/m/yyyy", "yyyy-mm-dd" or a Date. Returns a local Date or null.
export function parseAnyDate(input, time) {
  if (!input) return null;
  if (input instanceof Date) return isNaN(input) ? null : input;
  const s = String(input).trim();
  let y, m, d;
  let mt;
  if ((mt = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})/))) { d = +mt[1]; m = +mt[2]; y = +mt[3]; }
  else if ((mt = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/))) { y = +mt[1]; m = +mt[2]; d = +mt[3]; }
  else {
    const dt = new Date(s);
    return isNaN(dt) ? null : dt;
  }
  if (!y || m < 1 || m > 12 || d < 1 || d > 31) return null;
  let hh = 0, mm = 0;
  const tm = String(time || '').match(/^(\d{1,2}):(\d{2})/);
  if (tm) { hh = +tm[1]; mm = +tm[2]; }
  const dt = new Date(y, m - 1, d, hh, mm);
  return isNaN(dt) ? null : dt;
}

export function formatDate(input, format = 'YYYY/MMM/DD') {
  const dt = input instanceof Date ? input : parseAnyDate(input);
  if (!dt) return '';
  const Y = dt.getFullYear(), M = dt.getMonth(), D = dt.getDate();
  switch (format) {
    case 'DD/MM/YYYY': return `${pad(D)}/${pad(M + 1)}/${Y}`;
    case 'MM/DD/YYYY': return `${pad(M + 1)}/${pad(D)}/${Y}`;
    case 'YYYY-MM-DD': return `${Y}-${pad(M + 1)}-${pad(D)}`;
    case 'DD MMM YYYY': return `${pad(D)} ${MONTHS[M]} ${Y}`;
    default: return `${Y}/${MONTHS[M]}/${pad(D)}`;
  }
}

export function toIsoDate(dt) {
  if (!dt) return '';
  return `${dt.getFullYear()}-${pad(dt.getMonth() + 1)}-${pad(dt.getDate())}`;
}

export function noteDateString(dt = new Date()) {
  return `${pad(dt.getDate())}/${pad(dt.getMonth() + 1)}/${dt.getFullYear()}`;
}

export function noteTimeString(dt = new Date()) {
  return `${pad(dt.getHours())}:${pad(dt.getMinutes())}`;
}

// Converts "dd/mm/yyyy" <-> "yyyy-mm-dd" for <input type=date>.
export function noteDateToIso(s) { return toIsoDate(parseAnyDate(s)); }
export function isoToNoteDate(s) { const d = parseAnyDate(s); return d ? noteDateString(d) : ''; }

export function startOfDay(dt = new Date()) {
  return new Date(dt.getFullYear(), dt.getMonth(), dt.getDate());
}

export function daysBetween(a, b) {
  return Math.round((startOfDay(b) - startOfDay(a)) / 86400000);
}

export function nowIso() { return new Date().toISOString(); }
