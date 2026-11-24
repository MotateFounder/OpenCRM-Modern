// "Fill from document": extract text locally (PDF/DOCX/TXT…), let the local AI propose values for
// fields the user picks, review a per-field diff, apply accepted values.
import { h } from './dom.js';
import { store, mutate, findRecord, touch } from './store.js';
import { getType, recordTitle, extractJson, normalizeTags, parseAnyDate, toIsoDate, isEmptyValue, valueToText, COLOR_PALETTE } from './shared.js';
import { openModal, toast } from './ui.js';
import { relCtx } from './editors.js';
import { hooks } from './hooks.js';

const FILLABLE = ['text', 'longtext', 'markdown', 'select', 'multiselect', 'tags', 'url', 'email', 'phone', 'date', 'number', 'checkbox'];

function typeHint(def) {
  switch (def.type) {
    case 'select': return `one of: ${def.options.map(o => JSON.stringify(o.value)).join(', ')} (or "" if unknown)`;
    case 'multiselect': return `array, values from: ${def.options.map(o => JSON.stringify(o.value)).join(', ')}`;
    case 'tags': return 'array of short strings';
    case 'date': return 'date as "YYYY-MM-DD"';
    case 'number': return 'number';
    case 'checkbox': return 'true or false';
    case 'markdown': return 'markdown text (well structured with headings/lists)';
    case 'longtext': return 'plain text, may be multi-line';
    default: return 'short plain text';
  }
}

function coerce(def, v) {
  if (v == null) return { value: null };
  switch (def.type) {
    case 'select': {
      const s = String(Array.isArray(v) ? v[0] ?? '' : v).trim();
      if (!s) return { value: '' };
      const opt = def.options.find(o => o.value.toLowerCase() === s.toLowerCase());
      return opt ? { value: opt.value } : { value: s, warn: 'not in the option list (will be added)' };
    }
    case 'multiselect': {
      const arr = normalizeTags(Array.isArray(v) ? v : String(v).split(','));
      const mapped = arr.map(x => def.options.find(o => o.value.toLowerCase() === x.toLowerCase())?.value || x);
      const unknown = mapped.filter(x => !def.options.some(o => o.value === x));
      return { value: mapped, warn: unknown.length ? `new options: ${unknown.join(', ')}` : null };
    }
    case 'tags': return { value: normalizeTags(Array.isArray(v) ? v : String(v).split(',')) };
    case 'number': { const n = parseFloat(String(v).replace(',', '.')); return { value: Number.isFinite(n) ? n : null }; }
    case 'checkbox': return { value: v === true || /^(true|yes|1)$/i.test(String(v)) };
    case 'date': { const d = parseAnyDate(String(v)); return { value: d ? toIsoDate(d) : '' }; }
    default: return { value: Array.isArray(v) ? v.join(', ') : typeof v === 'object' ? JSON.stringify(v) : String(v) };
  }
}

export async function openDocFill(typeKey, id, fileRef = null) {
  const type = getType(store.data, typeKey);
  const rec = findRecord(typeKey, id);
  if (!type || !rec) return;
  if (!store.config?.ai?.baseUrl) { toast('Set up your local AI first (Settings → AI).', { type: 'error' }); hooks.openSettings?.('ai'); return; }

  let doc = null; // {name, text, truncated}
  const body = h('div', { class: 'docfill' });
  const modal = openModal({ title: `Fill ${recordTitle(type, rec)} from a document`, size: 'xl', body });

  const allFiles = [...(rec.files || []), ...type.fieldDefs.filter(d => d.type === 'file').flatMap(d => rec[d.key] || [])]
    .filter(f => /\.(pdf|docx|txt|md|html?|csv)$/i.test(f.name));

  const load = async (opts) => {
    body.replaceChildren(h('p', { class: 'muted' }, 'Extracting text locally…'));
    try {
      const res = await window.crm.files.extract(opts);
      if (res?.canceled) return step1();
      doc = res;
      step2();
    } catch (e) { body.replaceChildren(h('div', { class: 'error-box' }, e.message), h('button', { class: 'btn', onclick: step1 }, 'Back')); }
  };

  const step1 = () => {
    body.replaceChildren(
      h('p', {}, 'Choose a document. Its text is extracted on this computer and sent only to your local AI server.'),
      allFiles.length ? h('div', { class: 'file-list' }, allFiles.map(f => h('div', { class: 'file-item clickable', onclick: () => load({ rel: f.rel }) }, '📄 ', h('b', {}, f.name)))) : h('p', { class: 'muted' }, 'No attached documents on this record.'),
      h('div', { class: 'row-gap' },
        h('button', { class: 'btn btn-primary', onclick: () => load({}) }, 'Choose a file from disk…'),
        h('button', { class: 'btn', onclick: () => { doc = { name: 'Pasted text', text: '' }; step2(true); } }, 'Paste text instead')));
  };

  const step2 = (paste = false) => {
    const ta = h('textarea', { class: 'input mono', rows: 12, value: doc.text, placeholder: 'Paste the text here…' });
    const fillable = type.fieldDefs.filter(d => FILLABLE.includes(d.type) && d.key !== type.titleField || (d.key === type.titleField && isEmptyValue(rec[d.key])));
    const chosen = new Set(fillable.filter(d => isEmptyValue(rec[d.key]) && d.type !== 'checkbox').map(d => d.key));
    const instr = h('input', { class: 'input', placeholder: 'Optional extra instruction, e.g. “summary in 5 bullets, in English”' });
    body.replaceChildren(
      h('div', { class: 'two-col docfill-grid' },
        h('div', {}, h('h3', {}, `Text from ${doc.name}`), doc.truncated ? h('p', { class: 'muted small' }, 'Long document: truncated to the first 60,000 characters.') : null, ta),
        h('div', {}, h('h3', {}, 'Fields to fill'),
          h('p', { class: 'muted small' }, 'Empty fields are pre-selected. You will review every value before anything is saved.'),
          h('div', { class: 'check-list tall' }, fillable.map(d => h('label', { class: 'check-row' },
            h('input', { type: 'checkbox', checked: chosen.has(d.key), onchange: e => { e.target.checked ? chosen.add(d.key) : chosen.delete(d.key); } }),
            ` ${d.label} `, h('span', { class: 'muted tiny' }, d.type), !isEmptyValue(rec[d.key]) ? h('span', { class: 'muted tiny' }, ' · has value') : null))),
          instr)),
      h('div', { class: 'row-gap' },
        h('button', { class: 'btn', onclick: step1 }, '← Back'),
        h('span', { class: 'spacer' }),
        h('button', { class: 'btn btn-primary', onclick: () => run(ta.value, fillable.filter(d => chosen.has(d.key)), instr.value) }, '✨ Extract with AI')));
    if (paste) setTimeout(() => ta.focus(), 0);
  };

  const run = async (text, defs, extra) => {
    if (!text.trim()) return toast('No text to analyse');
    if (!defs.length) return toast('Choose at least one field');
    body.replaceChildren(h('p', {}, '✨ Asking your local AI… this can take a while for long documents.'), h('div', { class: 'spinner' }));
    const schema = defs.map(d => `- "${d.key}" (${d.label}): ${typeHint(d)}`).join('\n');
    const messages = [
      { role: 'system', content: 'You extract structured data from documents for a CRM. Answer ONLY with one JSON object, no commentary. Use "" or [] when the document does not contain the information. Never invent facts.' },
      { role: 'user', content: `Record: ${type.singular} "${recordTitle(type, rec)}".\nExtract these fields:\n${schema}\n${extra ? `\nExtra instruction: ${extra}\n` : ''}\nDocument:\n"""\n${text}\n"""` },
    ];
    let answer;
    try {
      const res = await window.crm.ai.chat({ messages, stream: false, json: true, temperature: 0.1, maxTokens: Math.max(1500, store.config.ai.maxTokens || 0) });
      answer = res.text;
    } catch (e) {
      body.replaceChildren(h('div', { class: 'error-box' }, e.message), h('button', { class: 'btn', onclick: () => step2() }, '← Back'));
      return;
    }
    const json = extractJson(answer);
    if (!json) {
      body.replaceChildren(h('div', { class: 'error-box' }, 'The AI did not return valid JSON. Try again or use a larger model.'), h('pre', { class: 'pre-wrap small' }, answer.slice(0, 2000)), h('button', { class: 'btn', onclick: () => step2() }, '← Back'));
      return;
    }
    review(defs, json);
  };

  const review = (defs, json) => {
    const rows = defs.map(d => {
      const { value, warn } = coerce(d, json[d.key]);
      return { def: d, value, warn, accept: !isEmptyValue(value) && (isEmptyValue(rec[d.key]) || d.type === 'tags') };
    }).filter(r => !isEmptyValue(r.value) || r.def.type === 'checkbox');
    if (!rows.length) {
      body.replaceChildren(h('p', {}, 'The AI found nothing for the selected fields.'), h('button', { class: 'btn', onclick: () => step2() }, '← Back'));
      return;
    }
    const tbl = h('table', { class: 'grid-table diff-table' },
      h('thead', {}, h('tr', {}, h('th', {}, 'Apply'), h('th', {}, 'Field'), h('th', {}, 'Current'), h('th', {}, 'Proposed (editable)'))),
      h('tbody', {}, rows.map(r => {
        const cb = h('input', { type: 'checkbox', checked: r.accept, onchange: e => { r.accept = e.target.checked; } });
        const asText = Array.isArray(r.value) ? r.value.join(', ') : String(r.value ?? '');
        const editor = (r.def.type === 'markdown' || r.def.type === 'longtext' || asText.length > 80)
          ? h('textarea', { class: 'input', rows: r.def.type === 'markdown' ? 8 : 3, value: asText })
          : h('input', { class: 'input', value: asText });
        editor.addEventListener('change', () => { r.value = coerce(r.def, (r.def.type === 'tags' || r.def.type === 'multiselect') ? editor.value.split(',') : editor.value).value; });
        return h('tr', {}, h('td', { class: 'center' }, cb), h('td', {}, h('b', {}, r.def.label), r.warn ? h('div', { class: 'warn tiny' }, `⚠ ${r.warn}`) : null),
          h('td', { class: 'muted small cur-val' }, valueToText(r.def, rec[r.def.key], relCtx).slice(0, 300) || '—'), h('td', {}, editor));
      })));
    body.replaceChildren(tbl, h('div', { class: 'row-gap' },
      h('button', { class: 'btn', onclick: () => step2() }, '← Back'),
      h('span', { class: 'spacer' }),
      h('button', { class: 'btn btn-primary', onclick: () => {
        const apply = rows.filter(r => r.accept);
        if (!apply.length) return modal.close();
        mutate(`Fill ${apply.length} field(s) from ${doc.name}`, (d) => {
          const t = d.meta.recordTypes.find(x => x.key === typeKey);
          const x = findRecord(typeKey, id);
          for (const r of apply) {
            const def = t.fieldDefs.find(f => f.key === r.def.key);
            if (def.type === 'select' && r.value && !def.options.some(o => o.value === r.value)) def.options.push({ value: r.value, color: COLOR_PALETTE[def.options.length % COLOR_PALETTE.length] });
            if (def.type === 'multiselect') for (const v of r.value) if (!def.options.some(o => o.value === v)) def.options.push({ value: v, color: COLOR_PALETTE[def.options.length % COLOR_PALETTE.length] });
            x[def.key] = def.type === 'tags' ? normalizeTags([...(x[def.key] || []), ...r.value]) : r.value;
          }
          touch(x);
        });
        toast(`Updated ${apply.length} field(s)`);
        modal.close();
      } }, 'Apply selected')));
  };

  if (fileRef) load({ rel: fileRef.rel }); else step1();
}
