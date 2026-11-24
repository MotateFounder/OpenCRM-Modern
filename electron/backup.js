// Rotating backups stored in a "backups" folder next to the database file.
//   <base>.hourly.YYYY-MM-DD_HHmm.json  (keep 48)
//   <base>.daily.YYYY-MM-DD.json        (keep 30)
//   <base>.manual.YYYY-MM-DD_HHmmss.json (pre-restore / pre-migration, keep 20)

import fs from 'node:fs';
import path from 'node:path';

const KEEP = { hourly: 48, daily: 30, manual: 20 };
const pad = n => String(n).padStart(2, '0');

export function backupDir(dbPath) { return path.join(path.dirname(dbPath), 'backups'); }
export function baseName(dbPath) { return path.basename(dbPath).replace(/\.json$/i, ''); }

function stamp(d, withSeconds = false) {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}_${pad(d.getHours())}${pad(d.getMinutes())}${withSeconds ? pad(d.getSeconds()) : ''}`;
}

function listKind(dbPath, kind) {
  const dir = backupDir(dbPath);
  const prefix = `${baseName(dbPath)}.${kind}.`;
  let files = [];
  try { files = fs.readdirSync(dir).filter(f => f.startsWith(prefix) && f.endsWith('.json')); } catch { return []; }
  return files.sort().map(f => path.join(dir, f));
}

function prune(dbPath, kind) {
  const files = listKind(dbPath, kind);
  const excess = files.length - KEEP[kind];
  for (let i = 0; i < excess; i++) { try { fs.unlinkSync(files[i]); } catch { /* ignore */ } }
}

function write(dbPath, kind, name, content) {
  const dir = backupDir(dbPath);
  fs.mkdirSync(dir, { recursive: true });
  const f = path.join(dir, `${baseName(dbPath)}.${kind}.${name}.json`);
  fs.writeFileSync(f, content);
  prune(dbPath, kind);
  return f;
}

// Called after every successful save with the content just written.
export function maybeBackup(dbPath, content, now = new Date()) {
  const made = [];
  const hourly = listKind(dbPath, 'hourly');
  const last = hourly.length ? fs.statSync(hourly[hourly.length - 1]).mtimeMs : 0;
  if (now.getTime() - last >= 60 * 60 * 1000) made.push(write(dbPath, 'hourly', stamp(now), content));
  const today = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
  const dailyFile = path.join(backupDir(dbPath), `${baseName(dbPath)}.daily.${today}.json`);
  if (!fs.existsSync(dailyFile)) made.push(write(dbPath, 'daily', today, content));
  return made;
}

export function manualBackup(dbPath, reason = 'manual') {
  if (!fs.existsSync(dbPath)) return null;
  const content = fs.readFileSync(dbPath);
  return write(dbPath, 'manual', `${stamp(new Date(), true)}-${reason.replace(/[^\w-]/g, '')}`, content);
}

export function listBackups(dbPath) {
  const out = [];
  for (const kind of ['manual', 'hourly', 'daily']) {
    for (const f of listKind(dbPath, kind)) {
      let counts = null;
      try {
        const d = JSON.parse(fs.readFileSync(f, 'utf8'));
        counts = {};
        const types = d.meta?.recordTypes?.map(t => t.key) || ['contacts'];
        for (const t of types) counts[t] = (d[t] || []).length;
      } catch { /* unreadable */ }
      const st = fs.statSync(f);
      out.push({ file: f, name: path.basename(f), kind, mtime: st.mtimeMs, size: st.size, counts });
    }
  }
  return out.sort((a, b) => b.mtime - a.mtime);
}

// Incremental mirror of the attachments folder (copies new/changed files, never deletes).
export function mirrorFiles(filesDir, dbPath) {
  if (!fs.existsSync(filesDir)) return 0;
  const target = path.join(backupDir(dbPath), `${baseName(dbPath)}.files-mirror`);
  let copied = 0;
  const walk = (src, dst) => {
    for (const ent of fs.readdirSync(src, { withFileTypes: true })) {
      const s = path.join(src, ent.name), d = path.join(dst, ent.name);
      if (ent.isDirectory()) { walk(s, d); continue; }
      try {
        const ss = fs.statSync(s);
        let need = true;
        try { const ds = fs.statSync(d); need = ds.size !== ss.size || ds.mtimeMs < ss.mtimeMs; } catch { /* missing */ }
        if (need) { fs.mkdirSync(dst, { recursive: true }); fs.copyFileSync(s, d); copied++; }
      } catch { /* skip */ }
    }
  };
  walk(filesDir, target);
  return copied;
}
