// OpenAI-compatible client running in the main process (no CORS limitations).
// Works with LM Studio, Ollama (/v1), llama.cpp server, vLLM, Jan, LocalAI, OpenAI, ...

const active = new Map(); // streamId -> AbortController
// before(url): runs before each request; the built-in AI uses it to start llama-server on demand.
export const aiHooks = { before: null };

function baseUrl(url) {
  let u = String(url || '').trim().replace(/\/+$/, '');
  if (!u) throw new Error('AI base URL is not set (Settings → AI).');
  if (!/^https?:\/\//i.test(u)) u = 'http://' + u;
  return u;
}

function headers(apiKey) {
  const h = { 'Content-Type': 'application/json' };
  if (apiKey) h.Authorization = `Bearer ${apiKey}`;
  return h;
}

async function errorText(res) {
  let body = '';
  try { body = await res.text(); } catch { /* ignore */ }
  try { const j = JSON.parse(body); body = j.error?.message || j.error || j.message || body; } catch { /* not json */ }
  return `HTTP ${res.status} ${res.statusText}${body ? ': ' + String(body).slice(0, 400) : ''}`;
}

function friendly(e, url) {
  if (e.name === 'AbortError') return new Error('Request cancelled or timed out.');
  const code = e.cause?.code || e.code;
  if (code === 'ECONNREFUSED') return new Error(`Cannot reach ${url}. Is your local AI server (llama.cpp / LM Studio / Ollama) running?`);
  return e;
}

export async function listModels({ baseUrl: url, apiKey, timeoutMs = 15000 }) {
  const u = baseUrl(url);
  await aiHooks.before?.(u); // built-in AI: start llama-server if needed (before the timeout starts)
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(`${u}/models`, { headers: headers(apiKey), signal: ctrl.signal });
    if (!res.ok) throw new Error(await errorText(res));
    const j = await res.json();
    const list = Array.isArray(j.data) ? j.data : Array.isArray(j.models) ? j.models : [];
    return list.map(m => m.id || m.name || m.model).filter(Boolean).sort();
  } catch (e) { throw friendly(e, u); } finally { clearTimeout(t); }
}

// messages: [{role, content}]. onDelta(text, kind) is called while streaming, kind = 'content' | 'reasoning'.
// noThinking: asks reasoning models (Gemma 4, Qwen3, DeepSeek-R1 on llama.cpp/vLLM/LM Studio) to answer
// directly via chat_template_kwargs. Servers that reject the extra parameters get a plain retry.
export async function chat({ baseUrl: url, apiKey, model, temperature, maxTokens, timeoutMs = 120000, stream = true, messages, streamId, json = false, noThinking = false }, onDelta) {
  const u = baseUrl(url);
  await aiHooks.before?.(u); // built-in AI: start llama-server if needed (before the timeout starts)
  const ctrl = new AbortController();
  if (streamId) active.set(streamId, ctrl);
  let timer = setTimeout(() => ctrl.abort(), timeoutMs);
  const bump = () => { clearTimeout(timer); timer = setTimeout(() => ctrl.abort(), timeoutMs); };
  const body = { model: model || undefined, messages, temperature: Number(temperature ?? 0.7), stream: !!stream };
  if (maxTokens) body.max_tokens = Number(maxTokens);
  if (json) body.response_format = { type: 'json_object' };
  if (noThinking) body.chat_template_kwargs = { enable_thinking: false };
  const post = () => fetch(`${u}/chat/completions`, { method: 'POST', headers: headers(apiKey), body: JSON.stringify(body), signal: ctrl.signal });
  try {
    let res = await post();
    if (!res.ok && res.status === 400 && (body.response_format || body.chat_template_kwargs)) {
      // some servers reject response_format / chat_template_kwargs; retry without them
      delete body.response_format;
      delete body.chat_template_kwargs;
      res = await post();
    }
    if (!res.ok) throw new Error(await errorText(res));
    const ctype = res.headers.get('content-type') || '';
    let full = '', reasoning = '', finish = null;
    if (!stream || !ctype.includes('text/event-stream')) {
      const j = await res.json();
      const c = j.choices?.[0];
      full = c?.message?.content ?? c?.text ?? j.message?.content ?? '';
      reasoning = c?.message?.reasoning_content ?? c?.message?.reasoning ?? '';
      finish = c?.finish_reason || null;
      if (onDelta && full) onDelta(full, 'content');
    } else {
      const reader = res.body.getReader();
      const dec = new TextDecoder();
      let buf = '';
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        bump();
        buf += dec.decode(value, { stream: true });
        let idx;
        while ((idx = buf.indexOf('\n')) >= 0) {
          const line = buf.slice(0, idx).trim();
          buf = buf.slice(idx + 1);
          if (!line.startsWith('data:')) continue;
          const payload = line.slice(5).trim();
          if (payload === '[DONE]') continue;
          try {
            const j = JSON.parse(payload);
            const c = j.choices?.[0];
            const d = c?.delta || {};
            const r = d.reasoning_content ?? d.reasoning ?? '';
            if (r) { reasoning += r; onDelta?.(r, 'reasoning'); }
            const delta = d.content ?? c?.text ?? '';
            if (delta) { full += delta; onDelta?.(delta, 'content'); }
            if (c?.finish_reason) finish = c.finish_reason;
          } catch { /* partial line */ }
        }
      }
    }
    const text = stripThinking(full);
    if (!text && reasoning) {
      throw new Error(finish === 'length'
        ? 'The model spent its whole token budget thinking and gave no answer. Tick “Disable thinking” in Settings → AI, or raise Max tokens.'
        : 'The model only returned reasoning and no answer. Tick “Disable thinking” in Settings → AI.');
    }
    return text;
  } catch (e) { throw friendly(e, u); } finally {
    clearTimeout(timer);
    if (streamId) active.delete(streamId);
  }
}

// OpenAI-compatible /embeddings. Returns an array of vectors (same order as inputs).
export async function embeddings({ baseUrl: url, apiKey, model, timeoutMs = 120000 }, inputs) {
  const u = baseUrl(url);
  await aiHooks.before?.(u); // built-in AI: start llama-server if needed (before the timeout starts)
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(`${u}/embeddings`, { method: 'POST', headers: headers(apiKey), body: JSON.stringify({ model: model || undefined, input: inputs, encoding_format: 'float' }), signal: ctrl.signal });
    if (!res.ok) {
      const msg = await errorText(res);
      const err = new Error(msg);
      err.unsupported = res.status === 501 || res.status === 404 || /support embeddings|not found/i.test(msg);
      throw err;
    }
    const j = await res.json();
    const data = Array.isArray(j.data) ? j.data : [];
    data.sort((a, b) => (a.index ?? 0) - (b.index ?? 0));
    const vecs = data.map(d => d.embedding);
    if (vecs.length !== inputs.length || vecs.some(v => !Array.isArray(v))) throw new Error('Unexpected embeddings response');
    return vecs;
  } catch (e) { throw friendly(e, u); } finally { clearTimeout(t); }
}

// Reasoning models (e.g. qwen3, deepseek-r1) may prepend <think>...</think>.
export function stripThinking(text) {
  return String(text || '').replace(/<think>[\s\S]*?<\/think>\s*/gi, '').trim();
}

export function abort(streamId) {
  const c = active.get(streamId);
  if (c) { c.abort(); active.delete(streamId); return true; }
  return false;
}
