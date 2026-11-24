// Built-in AI: what can be downloaded, from where, and how it is checked. Pure Node (no Electron), so the
// portable-folder build script (scripts/make-portable.mjs) uses the same code and the same pinned files.
//
// Everything is pinned to an exact file and SHA-256, so a download is either exactly the tested file or rejected.
//  - llama.cpp (MIT): the Windows Vulkan build. It runs on NVIDIA, AMD and Intel graphics and includes CPU
//    backends, so it also works on computers without a usable graphics card.
//  - Models: Google's Gemma 4 instruction models (Apache-2.0) in GGUF format, and EmbeddingGemma for AI search.
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';

export const RUNTIME = {
  id: 'llama.cpp',
  build: 'b12674',
  file: 'llama-b12674-bin-win-vulkan-x64.zip',
  url: 'https://github.com/ggml-org/llama.cpp/releases/download/b12674/llama-b12674-bin-win-vulkan-x64.zip',
  size: 39041988,
  sha256: '6873622ceeaed0b569665699b8d00e75916aa23be25c71cdea4eb591de337bc6',
  license: 'MIT',
};

const hf = (repo, file) => `https://huggingface.co/${repo}/resolve/main/${file}`;

export const MODELS = [
  {
    id: 'gemma-4-e2b', role: 'chat', label: 'Gemma 4 E2B (small)',
    file: 'gemma-4-E2B-it-Q4_K_M.gguf', url: hf('unsloth/gemma-4-E2B-it-GGUF', 'gemma-4-E2B-it-Q4_K_M.gguf'),
    size: 3106738272, sha256: '740185b21d22ceb83a11c3aa62ad5842ef32c70f6096d756bbee85a1e4ec34b8',
    minRamGb: 8, note: 'For laptops and older computers (8 GB RAM). Fast; good for short emails, summaries and AI search.',
    license: 'Apache-2.0',
  },
  {
    id: 'gemma-4-e4b', role: 'chat', label: 'Gemma 4 E4B (recommended)', recommended: true,
    file: 'gemma-4-E4B_q4_0-it.gguf', url: hf('google/gemma-4-E4B-it-qat-q4_0-gguf', 'gemma-4-E4B_q4_0-it.gguf'),
    size: 5154941280, sha256: '676c35070db6dbe52f93e9c864ee0fba4eddea94b9c875d9cb10daff453fbaee',
    minRamGb: 12, note: 'Good balance for most computers (12 GB RAM or a graphics card with 6 GB+). Google\'s QAT build.',
    license: 'Apache-2.0',
  },
  {
    id: 'gemma-4-12b', role: 'chat', label: 'Gemma 4 12B (best quality)',
    file: 'gemma-4-12b-it-qat-q4_0.gguf', url: hf('google/gemma-4-12B-it-qat-q4_0-gguf', 'gemma-4-12b-it-qat-q4_0.gguf'),
    size: 6975879296, sha256: '93567e57a8fe10b23569b9d9ec38cd005deedf71e29477c421a4b83f418a538b',
    minRamGb: 16, note: 'Best answers and document filling. Needs a graphics card with 10 GB+ (or 16 GB RAM, but slow without one).',
    license: 'Apache-2.0',
  },
  {
    id: 'embeddinggemma-300m', role: 'embed', label: 'EmbeddingGemma 300M (AI search)',
    file: 'embeddinggemma-300M-Q8_0.gguf', url: hf('ggml-org/embeddinggemma-300M-GGUF', 'embeddinggemma-300M-Q8_0.gguf'),
    size: 333590944, sha256: 'b5ce9d77a3fc4b3b39ccb5643c36777911cc4eb46a66962eadfa3f5f60490d63',
    minRamGb: 2, note: 'Small model that makes ✨ AI search fast. Runs on the CPU.',
    license: 'Gemma terms',
  },
];
export const modelById = id => MODELS.find(m => m.id === id) || null;
export const EMBED_MODEL = 'embeddinggemma-300m';

export function suggestChatModel(totalRamGb) {
  if (totalRamGb < 12) return 'gemma-4-e2b';
  return 'gemma-4-e4b';
}

// ---------------------------------------------------------------- layout inside the AI folder
export const runtimeDir = aiDir => path.join(aiDir, 'llama.cpp', RUNTIME.build);
export const serverExe = aiDir => path.join(runtimeDir(aiDir), 'llama-server.exe');
export const modelsDir = aiDir => path.join(aiDir, 'models');
export const modelPath = (aiDir, m) => path.join(modelsDir(aiDir), m.file);
export const runtimeInstalled = aiDir => fs.existsSync(serverExe(aiDir));
export function modelPresent(aiDir, m) {
  try { return fs.statSync(modelPath(aiDir, m)).size === m.size; } catch { return false; }
}

// ---------------------------------------------------------------- download with resume + SHA-256
async function hashFile(file, hash) {
  await new Promise((resolve, reject) => {
    fs.createReadStream(file).on('data', d => hash.update(d)).on('end', resolve).on('error', reject);
  });
}

/**
 * Download url → dest, resuming a previous ".part", verifying size and SHA-256.
 * onProgress({ done, total }) is called about 4× a second. signal: AbortSignal.
 */
export async function download({ url, size, sha256 }, dest, { onProgress, signal, userAgent = 'OpenCRM' } = {}) {
  await fsp.mkdir(path.dirname(dest), { recursive: true });
  const part = dest + '.part';
  const hash = crypto.createHash('sha256');
  let have = 0;
  try { have = fs.statSync(part).size; } catch { /* fresh */ }
  if (have > size) { await fsp.rm(part, { force: true }); have = 0; }
  if (have) await hashFile(part, hash);
  if (have < size) {
    const res = await fetch(url, { headers: { 'User-Agent': userAgent, ...(have ? { Range: `bytes=${have}-` } : {}) }, redirect: 'follow', signal });
    if (have && res.status === 200) { // server ignored the range: start over
      await fsp.rm(part, { force: true }); have = 0; hash.destroy?.();
      return download({ url, size, sha256 }, dest, { onProgress, signal, userAgent });
    }
    if (!res.ok && res.status !== 206) throw new Error(`Download failed: HTTP ${res.status} ${res.statusText} (${url})`);
    const out = fs.createWriteStream(part, { flags: have ? 'a' : 'w' });
    let done = have;
    let last = 0;
    try {
      for await (const chunk of res.body) {
        hash.update(chunk);
        done += chunk.length;
        if (!out.write(chunk)) await new Promise(r => out.once('drain', r));
        const now = Date.now();
        if (onProgress && now - last > 250) { last = now; onProgress({ done, total: size }); }
      }
    } finally {
      await new Promise(r => out.end(r));
    }
    onProgress?.({ done, total: size });
  }
  const got = fs.statSync(part).size;
  if (got !== size) throw new Error(`Download incomplete: ${got} of ${size} bytes. Try again to resume.`);
  const digest = hash.digest('hex');
  if (digest !== sha256) {
    await fsp.rm(part, { force: true });
    throw new Error(`The downloaded file did not match its published checksum and was deleted (expected ${sha256.slice(0, 12)}…, got ${digest.slice(0, 12)}…).`);
  }
  await fsp.rename(part, dest);
  return dest;
}

/** Extract a .zip with Windows' built-in tar.exe (bsdtar). */
export function extractZip(zip, dir) {
  fs.mkdirSync(dir, { recursive: true });
  const tar = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'tar.exe');
  return new Promise((resolve, reject) => {
    const p = spawn(tar, ['-xf', zip, '-C', dir], { windowsHide: true });
    let err = '';
    p.stderr.on('data', d => { err += d; });
    p.on('error', reject);
    p.on('exit', code => (code === 0 ? resolve() : reject(new Error(`Could not unpack ${path.basename(zip)}: ${err.trim() || `tar exit ${code}`}`))));
  });
}

/** Download + verify + unpack llama.cpp into <aiDir>/llama.cpp/<build>. cacheDir keeps the zip (build script). */
export async function installRuntime(aiDir, { onProgress, signal, cacheDir } = {}) {
  if (runtimeInstalled(aiDir)) return;
  const zip = path.join(cacheDir || path.join(aiDir, 'downloads'), RUNTIME.file);
  if (!fs.existsSync(zip)) await download(RUNTIME, zip, { onProgress, signal });
  const tmp = runtimeDir(aiDir) + '.unpacking';
  await fsp.rm(tmp, { recursive: true, force: true });
  await extractZip(zip, tmp);
  // some releases put the files in a sub-folder
  let src = tmp;
  if (!fs.existsSync(path.join(tmp, 'llama-server.exe'))) {
    const sub = (await fsp.readdir(tmp, { withFileTypes: true })).find(d => d.isDirectory() && fs.existsSync(path.join(tmp, d.name, 'llama-server.exe')));
    if (!sub) throw new Error('llama-server.exe was not found in the downloaded package.');
    src = path.join(tmp, sub.name);
  }
  await fsp.rm(runtimeDir(aiDir), { recursive: true, force: true });
  await fsp.mkdir(path.dirname(runtimeDir(aiDir)), { recursive: true });
  await fsp.rename(src, runtimeDir(aiDir));
  await fsp.rm(tmp, { recursive: true, force: true });
  if (!cacheDir) await fsp.rm(zip, { force: true });
}

export async function installModel(aiDir, m, { onProgress, signal } = {}) {
  if (modelPresent(aiDir, m)) return;
  await download(m, modelPath(aiDir, m), { onProgress, signal });
}
