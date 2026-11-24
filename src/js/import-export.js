// Import wizard (CSV / XLSX / vCard / JSON) with column mapping + duplicate detection; exports.
import { lastContactFor } from './mail-state.js';
import { h } from './dom.js';
import { store, mutate, currentType, records, settings, findRecord } from './store.js';
import {
  findDuplicate, mergeInto, getType,
  valueToText, nextId, newNoteId, migrate, lastContactTime, formatDate,
} from './shared.js';
import { openModal, toast } from './ui.js';
import { columnDefs } from './table.js';
import { relCtx } from './editors.js';
import { openImportWizard } from './import-wizard.js';

export async function startImport(opts) {
  let parsed;
  try { parsed = await window.crm.db.importParse(opts); } catch (e) { toast(e.message, { type: 'error' }); return; }
  if (!parsed || parsed.canceled) return;
  if (parsed.format === 'json') return jsonImport(parsed);
  if (!parsed.rows?.length) { toast('The file has no rows', { type: 'error' }); return; }
  openImportWizard(parsed);
}

function dedupeControls(state) {
  return h('div', { class: 'form-row' }, h('label', { class: 'field-label' }, 'When a record already exists (same email, or same name + group):'),
    h('div', { class: 'seg' }, [['merge', 'Merge (fill empty fields, add notes)'], ['skip', 'Skip'], ['new', 'Import as new']].map(([v, l]) =>
      h('button', { class: ['seg-btn', state.policy === v && 'on'], onclick: e => { state.policy = v; e.currentTarget.parentElement.querySelectorAll('.seg-btn').forEach(b => b.classList.toggle('on', b === e.currentTarget)); state.onChange?.(); } }, l))));
}

function jsonImport(parsed) {
  const state = { policy: 'merge' };
  const typeKeys = Object.keys(parsed.records).filter(k => getType(store.data, k) || k === 'contacts');
  if (!typeKeys.length) { toast('No importable records in this JSON file', { type: 'error' }); return; }
  const counts = typeKeys.map(k => `${parsed.records[k].length} ${getType(store.data, k)?.label || k}`).join(', ');
  openModal({
    title: 'Import JSON', size: 'md',
    body: h('div', {}, h('p', {}, `${parsed.fileName}: ${counts}.`), h('p', { class: 'muted small' }, 'Fields that do not exist yet are created automatically.'), dedupeControls(state)),
    actions: [{ label: 'Cancel' }, { label: 'Import', primary: true, fn: () => {
      // run the incoming data through the migrator so v1 exports work
      const incomingDb = { contacts: [], ...parsed.records, ...(parsed.recordTypes ? { meta: { recordTypes: parsed.recordTypes } } : {}) };
      const { data: inc } = migrate(structuredClone(incomingDb));
      let added = 0, merged = 0, skipped = 0;
      mutate(`Import ${parsed.fileName}`, (d) => {
        for (const k of typeKeys) {
          const t = d.meta.recordTypes.find(x => x.key === k);
          if (!t) continue;
          const incT = inc.meta.recordTypes.find(x => x.key === k);
          for (const f of incT?.fieldDefs || []) if (!t.fieldDefs.some(x => x.key === f.key)) t.fieldDefs.push({ ...f, showInTable: false });
          for (const r of inc[k] || []) {
            const match = findDuplicate(t, d[k], r);
            if (match && state.policy === 'skip') { skipped++; continue; }
            if (match && state.policy === 'merge') { mergeInto(t, match, r); match.updatedAt = new Date().toISOString(); merged++; continue; }
            d[k].push({ ...r, id: nextId(d[k]), notes: (r.notes || []).map(n => ({ ...n, id: newNoteId() })) });
            added++;
          }
        }
      });
      toast(`Imported: ${added} new, ${merged} merged, ${skipped} skipped`);
    } }],
  });
}

// ---------- export ----------
const csvCell = v => {
  const s = String(v ?? '');
  return /[",\n\r;]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

export async function exportRecords(kind, ids = null, typeKey = store.ui.typeKey) {
  const type = getType(store.data, typeKey);
  const list = ids ? ids.map(id => findRecord(typeKey, id)).filter(Boolean) : records(typeKey);
  const stamp = new Date().toISOString().slice(0, 10);
  let res;
  if (kind === 'json') {
    const out = { schemaVersion: store.data.schemaVersion, meta: { recordTypes: [type] }, [typeKey]: list };
    res = await window.crm.db.exportFile({ defaultName: `${typeKey}-${stamp}.json`, kind: 'json', content: JSON.stringify(out, null, 2) });
  } else if (kind === 'db') {
    res = await window.crm.db.exportFile({ defaultName: `opencrm-copy-${stamp}.json`, kind: 'json', content: JSON.stringify(store.data, null, 2) });
  } else if (kind === 'vcf') {
    res = await window.crm.db.exportFile({ defaultName: `contacts-${stamp}.vcf`, kind: 'vcf', vcfContacts: list });
  } else {
    const defs = kind === 'csv-all'
      ? type.fieldDefs.filter(d => d.type !== 'image')
      : columnDefs(type);
    const header = [...defs.map(d => d.label), ...(kind === 'csv-all' ? ['Notes'] : [])];
    const rows = list.map(r => [
      ...defs.map(d => d.key === '_lastContact' ? (lastContactFor(typeKey, r) ? formatDate(new Date(lastContactFor(typeKey, r)), settings().dateFormat) : '')
        : d.virtual ? '' : valueToText(d, r[d.key], relCtx)),
      ...(kind === 'csv-all' ? [(r.notes || []).map(n => `[${n.date} ${n.time}] ${n.content}`).join('\n')] : []),
    ]);
    const csv = [header, ...rows].map(row => row.map(csvCell).join(',')).join('\r\n');
    res = await window.crm.db.exportFile({ defaultName: `${typeKey}-${stamp}.csv`, kind: 'csv', content: csv });
  }
  if (res?.path) toast(`Exported ${list.length} record(s)`);
}
