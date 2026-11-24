// Settings → AI (and the setup guide): "Built-in AI": download llama.cpp + a Gemma model and run them here.
import { h, replace } from './dom.js';
import { store, emit } from './store.js';
import { toast, confirmDialog } from './ui.js';

const gb = n => (n >= 1e9 ? `${(n / 1e9).toFixed(1)} GB` : `${Math.max(1, Math.round(n / 1e6))} MB`);
const pct = d => (d?.total ? Math.floor((d.done / d.total) * 100) : 0);

export function builtinAiPanel({ onChange } = {}) {
  const box = h('div', { class: 'builtin-ai' });
  let st = null;
  let pick = null;
  let busy = false;
  const live = {}; // id -> { done, total } from progress events

  const offs = [
    window.crm.aiRuntime.onState(s => { if (!box.isConnected) return cleanup(); st = s; paint(); }),
    window.crm.aiRuntime.onProgress(p => {
      if (!box.isConnected) return cleanup();
      live[p.id] = p;
      const bar = box.querySelector(`[data-progress="${p.id}"]`);
      if (bar) { bar.querySelector('i').style.width = `${pct(p)}%`; bar.querySelector('span').textContent = `${pct(p)}% · ${gb(p.done)} of ${gb(p.total)}`; }
    }),
  ];
  function cleanup() { offs.forEach(o => o()); }

  async function refresh() { st = await window.crm.aiRuntime.state(); paint(); }
  const applyConfig = res => { if (res?.config) { store.config = res.config; emit('config-changed'); } };

  async function downloadAll(chatId) {
    busy = true; paint();
    try {
      for (const id of ['runtime', chatId, 'embeddinggemma-300m']) {
        const present = id === 'runtime' ? st.runtime.installed : st.models.find(m => m.id === id)?.present;
        if (present) continue;
        const r = await window.crm.aiRuntime.download(id);
        if (!r.ok) { if (!r.canceled) toast(r.error, { type: 'error', timeout: 10000 }); return; }
        await refresh();
      }
      applyConfig(await window.crm.aiRuntime.use({ chatModel: chatId }));
      toast('The built-in AI is ready. It starts the first time you use ✨ AI.', { timeout: 6000 });
      onChange?.();
    } finally { busy = false; if (box.isConnected) refresh(); }
  }

  function progress(id, d) {
    const p = live[id] || d;
    return h('div', { class: 'dl-progress', dataset: { progress: id } },
      h('div', { class: 'bar' }, h('i', { style: `width:${pct(p)}%` })),
      h('span', { class: 'small muted' }, p?.total ? `${pct(p)}% · ${gb(p.done)} of ${gb(p.total)}` : 'Starting…'),
      h('button', { class: 'btn-link small', onclick: () => window.crm.aiRuntime.cancel(id) }, 'Cancel'));
  }

  function paint() {
    if (!st) { replace(box, h('p', { class: 'muted' }, 'Checking…')); return; }
    const b = st.builtin;
    const chats = st.models.filter(m => m.role === 'chat');
    const embed = st.models.find(m => m.role === 'embed');
    pick ||= b.chatModel || st.suggested;
    const sel = chats.find(m => m.id === pick);
    const using = b.enabled && store.config.ai?.baseUrl?.includes(`:${st.ports.chat}`);
    const run = st.running.chat;
    const runText = run ? (run.ready ? `running on the ${run.device === 'cpu' ? 'processor (CPU)' : 'graphics card'}` : 'starting…') : (b.startMode === 'manual' ? 'stopped' : 'stopped. It starts by itself when needed');
    const anyDownloading = st.runtime.downloading && !st.runtime.downloading.error || st.models.some(m => m.downloading && !m.downloading.error);

    replace(box,
      h('h3', {}, '✨ Built-in AI ', h('span', { class: 'muted small' }, '(easiest: OpenCRM downloads and runs it)')),
      h('p', { class: 'muted small' }, `A free AI model that runs on this computer. No account needed, and nothing you write leaves the computer. This computer has ${st.ramGb} GB RAM.`,
        st.portable ? h('span', {}, ' Portable: everything goes into ', h('code', {}, st.aiDir), ', so it travels with you.') : null),
      using ? h('div', { class: 'builtin-status ok-box' },
        h('b', {}, `✓ OpenCRM uses ${chats.find(m => m.id === b.chatModel)?.label || b.chatModel}`), ` · ${runText}`,
        h('div', { class: 'row-gap' },
          run ? h('button', { class: 'btn btn-sm', onclick: async () => { await window.crm.aiRuntime.stop(); refresh(); } }, '■ Stop (frees memory)')
            : h('button', { class: 'btn btn-sm', onclick: async () => { toast('Starting the AI… (loading the model can take a minute)'); try { await window.crm.aiRuntime.start(); toast('The AI is running'); } catch (e) { toast(e.message, { type: 'error', timeout: 10000 }); } refresh(); } }, '▶ Start now'),
          h('label', { class: 'small' }, 'Start: ', h('select', { class: 'input input-sm', onchange: async e => applyConfig(await window.crm.aiRuntime.setMode(e.target.value)) },
            [['auto', 'when needed, stop after 15 idle minutes'], ['startup', 'with OpenCRM'], ['manual', 'only with the Start button']].map(([v, l]) => h('option', { value: v, selected: (b.startMode || 'auto') === v }, l)))),
          h('button', { class: 'btn-link small', onclick: async () => { applyConfig(await window.crm.aiRuntime.disable()); onChange?.(); } }, 'Use my own AI server instead'))) : null,
      h('div', { class: 'model-cards' }, chats.map(m => h('label', { class: ['model-card', pick === m.id && 'on'], dataset: { model: m.id } },
        h('input', { type: 'radio', name: 'builtin-model', checked: pick === m.id, onchange: () => { pick = m.id; paint(); } }),
        h('div', {},
          h('b', {}, m.label), st.suggested === m.id ? h('span', { class: 'chip chip-sm' }, 'suggested for this computer') : null,
          h('div', { class: 'small muted' }, `${gb(m.size)} download · ${m.note}`),
          m.present ? h('div', { class: 'small ok' }, '✓ downloaded ', b.chatModel === m.id && using ? '· in use' : h('button', { class: 'btn-link small', onclick: async e => {
            e.preventDefault();
            if (!(await confirmDialog(`Delete ${m.label} (${gb(m.size)}) from this computer?`, { okLabel: 'Delete', danger: true }))) return;
            st = await window.crm.aiRuntime.remove(m.id); paint();
          } }, 'delete')) : null,
          m.downloading ? (m.downloading.error ? h('div', { class: 'small err' }, m.downloading.error) : progress(m.id, m.downloading)) : null)))),
      h('div', { class: 'small muted' },
        `AI engine: llama.cpp ${st.runtime.build} (${gb(st.runtime.size)}) `, st.runtime.installed ? h('span', { class: 'ok' }, '✓') : '',
        st.runtime.downloading ? (st.runtime.downloading.error ? h('span', { class: 'err' }, ` ${st.runtime.downloading.error}`) : progress('runtime', st.runtime.downloading)) : null,
        ` · AI search: ${embed.label} (${gb(embed.size)}) `, embed.present ? h('span', { class: 'ok' }, '✓') : '',
        embed.downloading ? (embed.downloading.error ? h('span', { class: 'err' }, ` ${embed.downloading.error}`) : progress(embed.id, embed.downloading)) : null),
      h('div', { class: 'row-gap' },
        !(using && b.chatModel === pick) ? h('button', { class: 'btn btn-primary', disabled: busy || anyDownloading, dataset: { action: 'builtin-use' }, onclick: () => downloadAll(pick) },
          sel.present && st.runtime.installed && embed.present ? `Use ${sel.label}` : `⤓ Download & use ${sel.label}`) : null,
        h('button', { class: 'btn btn-sm', onclick: () => window.crm.aiRuntime.openFolder() }, '📁 AI folder'),
        h('span', { class: 'muted small' }, 'Files are checked against their published SHA-256 checksums. Interrupted downloads resume.')));
  }

  refresh();
  paint();
  return box;
}
