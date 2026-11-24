// Parses import files into a uniform shape:
//   tabular -> { format, headers: [...], rows: [{header: value}] }
//   json    -> { format: 'json', records: { typeKey: [...] }, meta? }

import fsp from 'node:fs/promises';
import path from 'node:path';
import Papa from 'papaparse';

export async function parseImportFile(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  if (ext === '.json') {
    const j = JSON.parse((await fsp.readFile(filePath, 'utf8')).replace(/^\uFEFF/, ''));
    const records = {};
    if (Array.isArray(j)) records.contacts = j;
    else {
      const types = j.meta?.recordTypes?.map(t => t.key) || Object.keys(j).filter(k => Array.isArray(j[k]));
      for (const k of types) if (Array.isArray(j[k])) records[k] = j[k];
    }
    return { format: 'json', records, recordTypes: j.meta?.recordTypes || null };
  }
  if (ext === '.csv' || ext === '.tsv' || ext === '.txt') {
    let text = (await fsp.readFile(filePath, 'utf8')).replace(/^\uFEFF/, '');
    // LinkedIn exports start with a few "Notes:" lines before the header row.
    const lines = text.split(/\r?\n/);
    const headerIdx = lines.findIndex(l => /first name|full name|^name[,;\t]|e-?mail/i.test(l));
    if (headerIdx > 0 && headerIdx < 10) text = lines.slice(headerIdx).join('\n');
    const res = Papa.parse(text, { header: true, skipEmptyLines: 'greedy', delimiter: ext === '.tsv' ? '\t' : '' });
    const headers = (res.meta.fields || []).filter(h => h && h.trim());
    return { format: 'csv', headers, rows: res.data };
  }
  if (ext === '.xlsx') {
    const ExcelJS = (await import('exceljs')).default;
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.readFile(filePath);
    const ws = wb.worksheets[0];
    if (!ws) return { format: 'xlsx', headers: [], rows: [] };
    const headers = [];
    ws.getRow(1).eachCell({ includeEmpty: true }, (cell, col) => { headers[col - 1] = String(cell.text || `Column ${col}`).trim(); });
    const rows = [];
    ws.eachRow((row, idx) => {
      if (idx === 1) return;
      const obj = {};
      headers.forEach((h, i) => {
        const cell = row.getCell(i + 1);
        let v = cell.value;
        if (v instanceof Date) v = v.toISOString().slice(0, 10);
        else if (v && typeof v === 'object') v = cell.text;
        obj[h] = v == null ? '' : String(v);
      });
      if (Object.values(obj).some(v => v !== '')) rows.push(obj);
    });
    return { format: 'xlsx', headers: headers.filter(Boolean), rows };
  }
  if (ext === '.vcf' || ext === '.vcard') {
    return parseVcf(await fsp.readFile(filePath, 'utf8'));
  }
  throw new Error('Unsupported file type. Use CSV, XLSX, vCard (.vcf) or JSON.');
}

function unfold(text) { return text.replace(/\r\n/g, '\n').replace(/\n[ \t]/g, ''); }
function decodeVal(v) { return v.replace(/\\n/gi, '\n').replace(/\\,/g, ',').replace(/\\;/g, ';').replace(/\\\\/g, '\\'); }

export function parseVcf(text) {
  const cards = unfold(text).split(/BEGIN:VCARD/i).slice(1);
  const rows = [];
  for (const card of cards) {
    const row = { Name: '', 'First Name': '', 'Last Name': '', Email: '', Phone: '', Company: '', Title: '', URL: '', Address: '', Notes: '', Categories: '', Birthday: '' };
    for (const line of card.split('\n')) {
      const m = line.match(/^([^:;]+)((?:;[^:]*)?):(.*)$/);
      if (!m) continue;
      const key = m[1].toUpperCase().replace(/^ITEM\d+\./, '');
      const val = decodeVal(m[3].trim());
      switch (key) {
        case 'FN': row.Name = val; break;
        case 'N': { const [last, first] = val.split(';'); row['Last Name'] = last || ''; row['First Name'] = first || ''; break; }
        case 'EMAIL': if (!row.Email) row.Email = val; break;
        case 'TEL': if (!row.Phone) row.Phone = val; break;
        case 'ORG': row.Company = val.split(';')[0]; break;
        case 'TITLE': row.Title = val; break;
        case 'URL': if (!row.URL) row.URL = val; break;
        case 'ADR': row.Address = val.split(';').filter(Boolean).join(', '); break;
        case 'NOTE': row.Notes = val; break;
        case 'CATEGORIES': row.Categories = val; break;
        case 'BDAY': row.Birthday = val; break;
        default: break;
      }
    }
    if (!row.Name) row.Name = `${row['First Name']} ${row['Last Name']}`.trim();
    rows.push(row);
  }
  const headers = ['Name', 'Email', 'Phone', 'Company', 'Title', 'URL', 'Address', 'Notes', 'Categories', 'Birthday'];
  return { format: 'vcf', headers, rows };
}

export function toVcf(contacts) {
  const esc = s => String(s || '').replace(/\\/g, '\\\\').replace(/\n/g, '\\n').replace(/,/g, '\\,').replace(/;/g, '\\;');
  return contacts.map(c => {
    const parts = String(c.fullName || '').trim().split(/\s+/);
    const last = parts.length > 1 ? parts.pop() : '';
    const lines = ['BEGIN:VCARD', 'VERSION:3.0', `FN:${esc(c.fullName)}`, `N:${esc(last)};${esc(parts.join(' '))};;;`];
    if (c.emailAddress) lines.push(`EMAIL;TYPE=INTERNET:${esc(c.emailAddress)}`);
    if (c.phoneNumber) lines.push(`TEL:${esc(c.phoneNumber)}`);
    if (c.contactGroup) lines.push(`ORG:${esc(c.contactGroup)}`);
    if (c.urlLink) lines.push(`URL:${esc(c.urlLink)}`);
    if (c.contactLocation) lines.push(`ADR:;;${esc(c.contactLocation)};;;;`);
    if (c.labels?.length) lines.push(`CATEGORIES:${c.labels.map(esc).join(',')}`);
    lines.push('END:VCARD');
    return lines.join('\r\n');
  }).join('\r\n') + '\r\n';
}
