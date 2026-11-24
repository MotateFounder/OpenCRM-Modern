// Builds the portable folder you can carry to other computers (USB stick, cloud folder):
//
//   dist\OpenCRM-Portable\                 copy this whole folder
//     OpenCRM.exe                          double-click to start (plus the files it needs next to it)
//     portable.flag                        keeps all data inside this folder
//     README - Portable.txt
//     Docs\  Tracker\
//     OpenCRM-data\
//       Databases\                         your databases (default location for new ones)
//       settings\                          app settings (created on first start)
//       ai\llama.cpp\<build>\              built-in AI engine (bundled)
//       ai\models\                         EmbeddingGemma bundled; chat models bundled with --model or downloaded in the app
//   dist\OpenCRM-Portable-<version>.zip    the same folder as one zip
//
// Usage:
//   npm run portable                                  app + AI engine + AI-search model (~0.5 GB)
//   npm run portable -- --model gemma-4-e4b           also bundle a chat model (works fully offline)
//   npm run portable -- --skip-build --no-zip
// Downloads are cached in dist\.cache and verified by SHA-256 (see electron/ai-catalog.js).
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { spawnSync, spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { RUNTIME, MODELS, EMBED_MODEL, modelById, installRuntime, download, modelsDir } from '../electron/ai-catalog.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
const args = process.argv.slice(2);
const flag = f => args.includes(f);
const models = args.flatMap((a, i) => (a === '--model' ? [args[i + 1]] : a.startsWith('--model=') ? [a.slice(8)] : []));
for (const id of models) if (!modelById(id) || modelById(id).role !== 'chat') { console.error(`Unknown chat model: ${id}. Choose: ${MODELS.filter(m => m.role === 'chat').map(m => m.id).join(', ')}`); process.exit(1); }

const DIST = path.join(ROOT, 'dist');
const UNPACKED = path.join(DIST, 'win-unpacked');
const OUT = path.join(DIST, 'OpenCRM-Portable');
const CACHE = path.join(DIST, '.cache');
const DATA = path.join(OUT, 'OpenCRM-data');
const AI = path.join(DATA, 'ai');

const step = s => console.log(`\n▶ ${s}`);
const mb = n => `${(n / 1e6).toFixed(0)} MB`;
function progress(label) {
  let last = -1;
  return ({ done, total }) => {
    const p = Math.floor((done / total) * 100);
    if (p !== last && p % 5 === 0) { last = p; process.stdout.write(`\r  ${label}: ${p}% (${mb(done)} / ${mb(total)})   `); }
    if (done === total) process.stdout.write('\n');
  };
}
function dirSize(d) {
  let n = 0;
  for (const e of fs.readdirSync(d, { withFileTypes: true })) n += e.isDirectory() ? dirSize(path.join(d, e.name)) : fs.statSync(path.join(d, e.name)).size;
  return n;
}

if (!flag('--skip-build')) {
  step('Building the app (electron-builder --dir)');
  const r = spawnSync('npx', ['electron-builder', '--win', 'dir'], { cwd: ROOT, stdio: 'inherit', shell: true });
  if (r.status !== 0) process.exit(r.status || 1);
}
if (!fs.existsSync(path.join(UNPACKED, 'OpenCRM.exe'))) { console.error('dist\\win-unpacked\\OpenCRM.exe is missing. Run without --skip-build.'); process.exit(1); }

step(`Assembling ${path.relative(ROOT, OUT)}`);
// keep previously downloaded models if the folder already exists
const keepModels = path.join(CACHE, 'keep-models');
if (fs.existsSync(modelsDir(AI))) { await fsp.rm(keepModels, { recursive: true, force: true }); await fsp.mkdir(CACHE, { recursive: true }); await fsp.rename(modelsDir(AI), keepModels); }
await fsp.rm(OUT, { recursive: true, force: true });
fs.cpSync(UNPACKED, OUT, { recursive: true });
fs.writeFileSync(path.join(OUT, 'portable.flag'), 'This file tells OpenCRM to keep all its data in the OpenCRM-data folder next to it. Delete it to use the normal Windows locations instead.\r\n');
fs.mkdirSync(path.join(DATA, 'Databases'), { recursive: true });
fs.mkdirSync(path.join(OUT, 'Docs'), { recursive: true });
fs.copyFileSync(path.join(ROOT, 'README.md'), path.join(OUT, 'Docs', 'README.md'));
fs.copyFileSync(path.join(ROOT, 'docs', 'TUTORIAL.md'), path.join(OUT, 'Docs', 'TUTORIAL.md'));
fs.cpSync(path.join(ROOT, 'docs', 'screenshots'), path.join(OUT, 'Docs', 'screenshots'), { recursive: true });
fs.cpSync(path.join(ROOT, 'resources', 'tracker'), path.join(OUT, 'Tracker'), { recursive: true });
if (fs.existsSync(keepModels)) { await fsp.mkdir(AI, { recursive: true }); await fsp.rename(keepModels, modelsDir(AI)); }

step(`AI engine: llama.cpp ${RUNTIME.build} (Vulkan + CPU, ${mb(RUNTIME.size)})`);
await installRuntime(AI, { cacheDir: CACHE, onProgress: progress(RUNTIME.file) });
await fsp.rm(path.join(AI, 'downloads'), { recursive: true, force: true });
console.log('  ✓ verified and unpacked');

for (const id of [EMBED_MODEL, ...models]) {
  const m = modelById(id);
  step(`Model: ${m.label} (${mb(m.size)})`);
  const cached = path.join(CACHE, m.file);
  const dest = path.join(modelsDir(AI), m.file);
  if (fs.existsSync(dest) && fs.statSync(dest).size === m.size) { console.log('  ✓ already in the folder'); continue; }
  if (!fs.existsSync(cached)) await download(m, cached, { onProgress: progress(m.file) });
  await fsp.mkdir(modelsDir(AI), { recursive: true });
  await fsp.copyFile(cached, dest);
  console.log('  ✓ verified');
}

// With a bundled chat model, the built-in AI is switched on from the first start.
if (models.length) {
  const chat = models[0];
  fs.mkdirSync(path.join(DATA, 'settings'), { recursive: true });
  fs.writeFileSync(path.join(DATA, 'settings', 'config.json'), JSON.stringify({
    ai: { baseUrl: 'http://127.0.0.1:39281/v1', model: chat, embedUrl: 'http://127.0.0.1:39282/v1', embedModel: EMBED_MODEL, disableThinking: true, builtin: { enabled: true, chatModel: chat, startMode: 'auto' } },
  }, null, 2));
}

const bundled = [EMBED_MODEL, ...models].map(id => modelById(id).label).join(', ');
fs.writeFileSync(path.join(OUT, 'README - Portable.txt'), [
  `OpenCRM ${pkg.version} - portable`,
  '',
  'Start: double-click OpenCRM.exe. Nothing is installed; nothing is written outside this folder',
  '(except Windows itself remembering recent programs).',
  '',
  'Take it with you: copy the whole OpenCRM-Portable folder (USB stick, external drive, synced folder).',
  'Close OpenCRM before copying or unplugging, so the database is not in the middle of a save.',
  '',
  'Where things are:',
  '  OpenCRM-data\\Databases   your databases (and their .files, .mail and backups folders)',
  '  OpenCRM-data\\settings    settings, email accounts, AI agent connections',
  '  OpenCRM-data\\ai          built-in AI: engine and models',
  '  Docs\\                    README and the full tutorial (also inside the app: ? > Tutorial)',
  '  Tracker\\                 files for email open & click tracking (see tutorial chapter 23)',
  '',
  'Built-in AI: the AI engine and ' + bundled + ' are included.',
  models.length
    ? `  The chat model is included too, so all AI features work offline.`
    : '  Choose a chat model the first time (Settings > AI > Built-in AI, or the setup guide).\r\n  It is downloaded once into OpenCRM-data\\ai\\models and then travels with the folder.',
  '',
  'On another computer:',
  '  - Saved email passwords are encrypted by Windows for one computer and user. On a new computer,',
  '    OpenCRM asks you to enter them again (Settings > Email > Edit). They are never stored readable.',
  '  - AI agents (Claude Desktop, etc.) store the path to OpenCRM.exe. If the drive letter changes,',
  '    reconnect them in Settings > AI agents (MCP).',
  '  - "Start with Windows" is only available in the installed version.',
  '',
  'Windows SmartScreen may warn the first time on each computer (the app is not code-signed):',
  'click "More info" > "Run anyway".',
  '',
].join('\r\n'));

const total = dirSize(OUT);
console.log(`\n✓ ${path.relative(ROOT, OUT)}  (${mb(total)})`);

if (!flag('--no-zip')) {
  const zip = path.join(DIST, `OpenCRM-Portable-${pkg.version}.zip`);
  step(`Zipping → ${path.relative(ROOT, zip)}`);
  await fsp.rm(zip, { force: true });
  const tar = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'tar.exe');
  await new Promise((resolve, reject) => {
    const p = spawn(tar, ['-a', '-c', '-f', zip, '-C', DIST, 'OpenCRM-Portable'], { stdio: 'inherit', windowsHide: true });
    p.on('exit', c => (c === 0 ? resolve() : reject(new Error(`tar exit ${c}`))));
  });
  console.log(`✓ ${path.relative(ROOT, zip)}  (${mb(fs.statSync(zip).size)})`);
}
