// Semantic ("search by meaning") service.
//  - Embeddings mode: vectors from an OpenAI-compatible /embeddings endpoint, cached in a sidecar
//    "<db-name>.index.json" next to the database (never inside the database). Incremental by hash.
//  - LLM mode: no embeddings available -> the chat model reads compact record summaries in batches and
//    returns JSON matches. Plain prompting with JSON output: no tool calling needed (works with Gemma).

import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { atomicWrite } from './db-service.js';
import { embeddings, chat, listModels } from './ai-service.js';
import { extractJson } from '../src/shared/prompting.js';

const INDEX_VERSION = 1;
const EMBED_BATCH = 16;
const LLM_BATCH = 20;
const LLM_CONCURRENCY = 3;

const embedSupport = new Map(); // url -> boolean (probed)
const embedModelName = new Map(); // url -> model id reported by the server

// Model name matters for task prefixes (embeddinggemma, nomic, e5). Use the configured one,
// otherwise ask the embeddings server which model it serves.
async function detectEmbedModel(eo) {
  if (eo.model) return eo.model;
  if (embedModelName.has(eo.baseUrl)) return embedModelName.get(eo.baseUrl);
  let name = '';
  try { name = (await listModels({ ...eo, timeoutMs: 8000 }))[0] || ''; } catch { /* unknown */ }
  embedModelName.set(eo.baseUrl, name);
  return name;
}

export function indexPathFor(dbPath) {
  return path.join(path.dirname(dbPath), `${path.basename(dbPath).replace(/\.json$/i, '')}.index.json`);
}

export function cosine(a, b) {
  let dot = 0, na = 0, nb = 0;
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) { dot += a[i] * b[i]; na += a[i] * a[i]; nb += b[i] * b[i]; }
  return na && nb ? dot / Math.sqrt(na * nb) : 0;
}

// Some embedding models expect task prefixes.
export function withPrefix(model, text, kind) {
  const m = String(model || '').toLowerCase();
  if (m.includes('nomic')) return `${kind === 'query' ? 'search_query' : 'search_document'}: ${text}`;
  if (m.includes('embeddinggemma')) return kind === 'query' ? `task: search result | query: ${text}` : `title: none | text: ${text}`;
  if (/(^|[^a-z])e5([^a-z]|$)/.test(m)) return `${kind === 'query' ? 'query' : 'passage'}: ${text}`;
  return text;
}

const hashOf = (model, text) => crypto.createHash('sha1').update(`${model}\n${text}`).digest('hex').slice(0, 16);

class IndexStore {
  constructor() { this.cache = new Map(); }
  async load(file) {
    if (this.cache.has(file)) return this.cache.get(file);
    let idx = { version: INDEX_VERSION, items: {} };
    try {
      const j = JSON.parse(await fsp.readFile(file, 'utf8'));
      if (j.version === INDEX_VERSION && j.items) idx = j;
    } catch { /* missing or unreadable: rebuild */ }
    this.cache.set(file, idx);
    return idx;
  }
  async save(file, idx) { await atomicWrite(file, JSON.stringify(idx)); }
  forget(file) { this.cache.delete(file); }
}

const store = new IndexStore();

export function embedOptions(ai) {
  return { ...ai, baseUrl: ai.embedUrl?.trim() || ai.baseUrl, model: ai.embedModel?.trim() || '' };
}

// Decides which mode to use: 'embeddings' or 'llm'.
export async function resolveMode(ai) {
  const pref = ai.semanticMode || 'auto';
  if (pref === 'llm' || pref === 'embeddings') return pref;
  const eo = embedOptions(ai);
  if (!eo.baseUrl) return 'llm';
  if (embedSupport.has(eo.baseUrl)) return embedSupport.get(eo.baseUrl) ? 'embeddings' : 'llm';
  try {
    await embeddings({ ...eo, timeoutMs: 20000 }, ['probe']);
    embedSupport.set(eo.baseUrl, true);
    return 'embeddings';
  } catch (e) {
    // only remember "unsupported" for real 501/404 answers, not for a server that is down
    if (e.unsupported) embedSupport.set(eo.baseUrl, false);
    return 'llm';
  }
}

export function resetProbe() { embedSupport.clear(); embedModelName.clear(); }

// docs: [{ id, text, summary }]
// Modes: 'llm' = the chat model reads every record; 'embeddings' = vector similarity only;
// 'hybrid' (auto, when embeddings exist) = a shortlist from embeddings PLUS records containing terms
// from a model-written query expansion ("Asia" -> Singapore, Tokyo, ...), then the chat model
// re-reads only the shortlist and explains each match.
const SHORTLIST_EMB = 50;
const SHORTLIST_KW = 50;

const EXPAND_SYSTEM = `You help search a personal CRM. Turn the user's request into concrete words or short phrases that a matching record would literally contain: synonyms, related skills, job titles, technologies, specific places (e.g. cities and countries inside a region), company types.
Answer ONLY with JSON: {"terms":["...", "..."]} with at most 30 lowercase terms. Do not include generic words like "contact", "person", "people", "someone", "experience".`;

export async function expandQuery(query, ai, signal) {
  if (signal?.aborted) return [];
  const text = await chat({
    ...ai, stream: false, json: true, noThinking: true, temperature: 0, maxTokens: 400, timeoutMs: 45000,
    messages: [{ role: 'system', content: EXPAND_SYSTEM }, { role: 'user', content: query }],
  });
  const j = extractJson(text);
  const terms = Array.isArray(j?.terms) ? j.terms : [];
  return [...new Set(terms.map(t => String(t).toLowerCase().trim()).filter(t => t.length >= 2 && t.length <= 40))].slice(0, 30);
}

const escapeRe = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// Records whose text contains expansion terms, best first (number of distinct terms hit).
export function keywordHits(docs, terms) {
  if (!terms.length) return [];
  const res = terms.map(t => new RegExp(`(^|[^\\p{L}\\p{N}])${escapeRe(t)}($|[^\\p{L}\\p{N}])`, 'iu'));
  const squashed = terms.map(t => (t.length >= 5 ? t.replace(/[\s-]+/g, '') : null)); // "hong kong" ~ "HongKong"
  const out = [];
  for (const d of docs) {
    const flat = d.text.toLowerCase().replace(/[\s-]+/g, '');
    const n = res.reduce((k, re, i) => k + (re.test(d.text) || (squashed[i] && squashed[i] !== terms[i] && flat.includes(squashed[i])) ? 1 : 0), 0);
    if (n) out.push({ id: d.id, n });
  }
  return out.sort((a, b) => b.n - a.n);
}

export async function search({ dbPath, typeKey, query, docs, ai, signal, onProgress }) {
  const t0 = Date.now();
  let mode = await resolveMode(ai);
  let results;
  if (mode === 'llm') {
    results = await searchLLM({ query, docs, ai, signal, onProgress });
  } else {
    const rerank = (ai.semanticMode || 'auto') === 'auto' && ai.baseUrl;
    const [scored, terms] = await Promise.all([
      searchEmbeddings({ dbPath, typeKey, query, docs, ai, signal, onProgress }),
      rerank ? expandQuery(query, ai, signal).catch(() => []) : Promise.resolve([]),
    ]);
    if (rerank) {
      const byId = new Map(docs.map(d => [d.id, d]));
      const ids = new Set(scored.slice(0, SHORTLIST_EMB).map(s => s.id));
      for (const k of keywordHits(docs, terms).slice(0, SHORTLIST_KW)) ids.add(k.id);
      const shortlist = [...ids].map(id => byId.get(id)).filter(Boolean);
      try {
        results = await searchLLM({ query, docs: shortlist, ai, signal, onProgress });
        mode = 'hybrid';
      } catch (e) {
        if (signal?.aborted) throw e;
        results = topSimilar(scored); // chat model unavailable: fall back to pure similarity
      }
    } else results = topSimilar(scored);
  }
  const model = mode === 'llm' ? (ai.model || 'default')
    : mode === 'hybrid' ? `${embedModelName.get(embedOptions(ai).baseUrl) || embedOptions(ai).model || 'embeddings'} + ${ai.model || 'chat model'}`
      : (embedModelName.get(embedOptions(ai).baseUrl) || embedOptions(ai).model || 'embeddings');
  return { mode, results, ms: Date.now() - t0, model };
}

// keep the clear leaders: everything close to the best match, max 30
export function topSimilar(scored) {
  if (!scored.length) return [];
  const top = scored[0].sim;
  const floor = Math.max(top - 0.12, top * 0.8);
  return scored.filter(s => s.sim >= floor).slice(0, 30).map(s => ({ id: s.id, score: Math.round(Math.max(0, s.sim) * 100), why: '' }));
}

async function searchEmbeddings({ dbPath, typeKey, query, docs, ai, signal, onProgress }) {
  const eo = embedOptions(ai);
  const file = indexPathFor(dbPath);
  const idx = await store.load(file);
  const modelKey = (await detectEmbedModel(eo)) || 'default';
  if (idx.model && idx.model !== `${eo.baseUrl}|${modelKey}`) { idx.items = {}; }
  idx.model = `${eo.baseUrl}|${modelKey}`;

  const keyOf = id => `${typeKey}:${id}`;
  const todo = docs.filter(d => idx.items[keyOf(d.id)]?.h !== hashOf(modelKey, d.text));
  // drop vectors of records that no longer exist
  const alive = new Set(docs.map(d => keyOf(d.id)));
  for (const k of Object.keys(idx.items)) if (k.startsWith(`${typeKey}:`) && !alive.has(k)) delete idx.items[k];

  let done = 0;
  onProgress?.({ phase: 'indexing', done, total: todo.length });
  for (let i = 0; i < todo.length; i += EMBED_BATCH) {
    if (signal?.aborted) throw new Error('Search cancelled.');
    const batch = todo.slice(i, i + EMBED_BATCH);
    const vecs = await embeddings({ ...eo, model: eo.model || undefined }, batch.map(d => withPrefix(modelKey, d.text, 'doc')));
    batch.forEach((d, j) => { idx.items[keyOf(d.id)] = { h: hashOf(modelKey, d.text), v: vecs[j].map(x => Math.round(x * 1e5) / 1e5) }; });
    done += batch.length;
    onProgress?.({ phase: 'indexing', done, total: todo.length });
  }
  if (todo.length || !fs.existsSync(file)) await store.save(file, idx);

  if (signal?.aborted) throw new Error('Search cancelled.');
  onProgress?.({ phase: 'ranking' });
  const [q] = await embeddings({ ...eo, model: eo.model || undefined }, [withPrefix(modelKey, query, 'query')]);
  return docs.map(d => ({ id: d.id, sim: cosine(q, idx.items[keyOf(d.id)]?.v || []) })).sort((a, b) => b.sim - a.sim);
}

const SYSTEM = `You are the search engine of a personal CRM. The user describes what they are looking for in plain words.
Decide which records match BY MEANING: synonyms, related skills or topics, and facts implied by notes all count; exact keywords are not required.
Answer ONLY with a JSON object, no other text:
{"matches":[{"id":<record id number>,"score":<0-100>,"why":"<at most 12 words>"}]}
Check EVERY record in the list against the request; do not stop after the first match. Use world knowledge (e.g. which cities are in which region, which skills belong to which field).
Include only records with score >= 50. If nothing matches, answer {"matches":[]}.`;

async function searchLLM({ query, docs, ai, signal, onProgress }) {
  const batches = [];
  for (let i = 0; i < docs.length; i += LLM_BATCH) batches.push(docs.slice(i, i + LLM_BATCH));
  const out = [];
  let done = 0;
  onProgress?.({ phase: 'reading', done, total: docs.length });
  let next = 0;
  const errors = [];
  const worker = async () => {
    while (next < batches.length) {
      if (signal?.aborted) return;
      const batch = batches[next++];
      const ids = new Set(batch.map(d => d.id));
      const list = batch.map(d => `[id ${d.id}] ${d.summary}`).join('\n');
      try {
        const text = await chat({
          ...ai, stream: false, json: true, noThinking: true, temperature: 0, maxTokens: 900, timeoutMs: Math.max(60000, ai.timeoutMs || 0),
          messages: [{ role: 'system', content: SYSTEM }, { role: 'user', content: `Query: ${query}\n\nRecords:\n${list}` }],
        });
        const j = extractJson(text);
        for (const m of (Array.isArray(j?.matches) ? j.matches : [])) {
          const id = Number(m.id);
          const score = Math.max(0, Math.min(100, Math.round(Number(m.score) || 0)));
          if (ids.has(id) && score >= 50) out.push({ id, score, why: String(m.why || '').slice(0, 140) });
        }
      } catch (e) { errors.push(e); }
      done += batch.length;
      onProgress?.({ phase: 'reading', done, total: docs.length });
    }
  };
  await Promise.all(Array.from({ length: Math.min(LLM_CONCURRENCY, batches.length) }, worker));
  if (signal?.aborted) throw new Error('Search cancelled.');
  if (errors.length === batches.length && batches.length) throw errors[0];
  const best = new Map();
  for (const r of out) if (!best.has(r.id) || best.get(r.id).score < r.score) best.set(r.id, r);
  return [...best.values()].sort((a, b) => b.score - a.score);
}
