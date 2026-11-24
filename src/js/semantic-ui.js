// AI search ("search by meaning") in the search row: toggle, run, progress, results banner.
import { mail, mailInSearch } from './mail-state.js';
import { h } from './dom.js';
import { store, emit, currentType, records } from './store.js';
import { semanticDocs, newId } from './shared.js';
import { relCtx } from './editors.js';
import { toast } from './ui.js';
import { hooks } from './hooks.js';

// store.ui.semantic = { on, query, typeKey, status: idle|running|done|error, progress, results: Map, mode, ms, model, error, searchId }
export function semanticState() {
  if (!store.ui.semantic) store.ui.semantic = { on: false, status: 'idle', results: null };
  return store.ui.semantic;
}

export function semanticActive() {
  const s = store.ui.semantic;
  return !!(s?.on && s.status === 'done' && s.results && s.typeKey === store.ui.typeKey);
}

export function semanticScore(id) {
  return semanticActive() ? store.ui.semantic.results.get(id) || null : null;
}

let offProgress = null;

export async function runSemantic(query) {
  const s = semanticState();
  const q = String(query || '').trim();
  if (!q) { clearSemantic(false); return; }
  if (!store.config?.ai?.baseUrl) { toast('Set up your local AI first (Settings → AI).', { type: 'error' }); hooks.openSettings?.('ai'); return; }
  if (s.status === 'running' && s.searchId) window.crm.ai.abort(s.searchId);
  const type = currentType();
  const docs = semanticDocs(type, records(type.key), { ...relCtx, extraText: mailInSearch() ? (rec => mail.searchText[`${type.key}:${rec.id}`] || '') : null });
  const searchId = newId('q');
  Object.assign(s, { query: q, typeKey: type.key, status: 'running', progress: null, results: null, error: null, searchId });
  emit('semantic-changed');
  offProgress?.();
  offProgress = window.crm.ai.onSemanticProgress(p => {
    if (p.searchId !== s.searchId) return;
    s.progress = p;
    emit('semantic-progress');
  });
  try {
    const res = await window.crm.ai.semanticSearch({ searchId, typeKey: type.key, query: q, docs });
    if (s.searchId !== searchId) return; // superseded
    Object.assign(s, { status: 'done', results: new Map(res.results.map(r => [r.id, r])), mode: res.mode, ms: res.ms, model: res.model });
  } catch (e) {
    if (s.searchId !== searchId) return;
    Object.assign(s, { status: 'error', error: e.message });
  } finally {
    if (s.searchId === searchId) { offProgress?.(); offProgress = null; }
  }
  emit('semantic-changed');
}

export function clearSemantic(turnOff = true) {
  const s = semanticState();
  if (s.status === 'running' && s.searchId) window.crm.ai.abort(s.searchId);
  Object.assign(s, { status: 'idle', results: null, error: null, progress: null, searchId: null, query: '' });
  if (turnOff) s.on = false;
  emit('semantic-changed');
}

export function toggleSemantic() {
  const s = semanticState();
  if (s.on) { clearSemantic(true); return false; }
  s.on = true;
  emit('semantic-changed');
  return true;
}

function progressText(p) {
  if (!p) return 'Starting…';
  if (p.phase === 'indexing') return p.total ? `Indexing ${p.done}/${p.total} records (first time only)…` : 'Index up to date…';
  if (p.phase === 'ranking') return 'Ranking…';
  if (p.phase === 'reading') return `The model is reading records ${p.done}/${p.total}…`;
  return 'Working…';
}

export function renderSemanticBanner(el) {
  const s = store.ui.semantic;
  if (!s?.on || s.status === 'idle' || s.typeKey !== store.ui.typeKey) { el.classList.add('hidden'); el.replaceChildren(); return; }
  el.classList.remove('hidden');
  const clearBtn = h('button', { class: 'btn-link small', onclick: () => clearSemantic(false) }, 'Clear');
  if (s.status === 'running') {
    const pct = s.progress?.total ? Math.round((s.progress.done / s.progress.total) * 100) : null;
    el.replaceChildren(
      h('span', { class: 'spinner-sm' }), h('span', {}, `✨ “${s.query}” — ${progressText(s.progress)}`),
      pct != null ? h('span', { class: 'mini-progress' }, h('span', { style: { width: `${pct}%` } })) : null,
      h('button', { class: 'btn-link small', onclick: () => clearSemantic(false) }, 'Cancel'));
  } else if (s.status === 'error') {
    el.replaceChildren(h('span', { class: 'err' }, `✨ AI search failed: ${s.error}`), h('button', { class: 'btn-link small', onclick: () => hooks.openSettings?.('ai') }, 'AI settings'), clearBtn);
  } else {
    const n = s.results.size;
    el.replaceChildren(
      h('span', {}, `✨ ${n ? `${n} match${n === 1 ? '' : 'es'}` : 'No matches'} for “${s.query}”`),
      h('span', { class: 'muted small' }, ` · ${s.mode === 'embeddings' ? 'embeddings' : s.mode === 'hybrid' ? 'shortlist from embeddings + related terms, checked by the model' : 'read by the model'} · ${s.model} · ${(s.ms / 1000).toFixed(1)} s`),
      n ? h('span', { class: 'muted small' }, ' · sorted by relevance; hover the Match column for the reason') : null,
      clearBtn);
  }
}
