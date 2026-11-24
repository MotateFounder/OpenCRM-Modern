// Attachments live next to the database: <db-folder>/<db-name>.files/<type>/<id>/<file>
// Removed files are moved to <db-name>.files/.trash instead of being deleted.

import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { filesDirFor } from './db-service.js';

const MIME = {
  '.pdf': 'application/pdf', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif',
  '.webp': 'image/webp', '.svg': 'image/svg+xml', '.txt': 'text/plain', '.md': 'text/markdown', '.csv': 'text/csv',
  '.doc': 'application/msword', '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', '.json': 'application/json',
};

export function mimeOf(p) { return MIME[path.extname(p).toLowerCase()] || 'application/octet-stream'; }

export function resolveRel(dbPath, rel) {
  const root = filesDirFor(dbPath);
  const abs = path.resolve(root, rel);
  if (!abs.startsWith(root + path.sep)) throw new Error('Invalid attachment path');
  return abs;
}

function safeName(name) {
  return String(name).replace(/[<>:"/\\|?*\x00-\x1f]/g, '_').slice(0, 150) || 'file';
}

async function uniqueTarget(dir, name) {
  const ext = path.extname(name);
  const stem = name.slice(0, name.length - ext.length);
  let candidate = name;
  for (let i = 2; fs.existsSync(path.join(dir, candidate)); i++) candidate = `${stem} (${i})${ext}`;
  return candidate;
}

export async function addFiles(dbPath, typeKey, recId, srcPaths) {
  const relDir = path.join(String(typeKey), String(recId));
  const dir = path.join(filesDirFor(dbPath), relDir);
  await fsp.mkdir(dir, { recursive: true });
  const refs = [];
  for (const src of srcPaths) {
    const st = await fsp.stat(src);
    if (!st.isFile()) continue;
    const name = await uniqueTarget(dir, safeName(path.basename(src)));
    await fsp.copyFile(src, path.join(dir, name));
    refs.push({
      id: 'f_' + Math.random().toString(36).slice(2, 10),
      name,
      rel: path.join(relDir, name).split(path.sep).join('/'),
      size: st.size,
      mime: mimeOf(name),
      addedAt: new Date().toISOString(),
    });
  }
  return refs;
}

export async function setPicture(dbPath, typeKey, recId, src) {
  const relDir = path.join(String(typeKey), String(recId));
  const dir = path.join(filesDirFor(dbPath), relDir);
  await fsp.mkdir(dir, { recursive: true });
  const name = `_picture-${Date.now().toString(36)}${path.extname(src).toLowerCase() || '.jpg'}`;
  await fsp.copyFile(src, path.join(dir, name));
  return 'file:' + path.join(relDir, name).split(path.sep).join('/');
}

export async function trashFile(dbPath, rel) {
  const abs = resolveRel(dbPath, rel);
  if (!fs.existsSync(abs)) return false;
  const trash = path.join(filesDirFor(dbPath), '.trash', path.dirname(rel));
  await fsp.mkdir(trash, { recursive: true });
  const name = await uniqueTarget(trash, path.basename(abs));
  await fsp.rename(abs, path.join(trash, name));
  return true;
}
