// Where OpenCRM keeps its files.
//
// Installed / normal:  settings in %APPDATA%\OpenCRM, new databases in Documents\OpenCRM, built-in AI in %APPDATA%\OpenCRM\ai.
// Portable:            everything in an "OpenCRM-data" folder next to the program, so the whole folder (or the
//                      single portable exe plus its OpenCRM-data folder) can be carried to another computer:
//                        OpenCRM-data\settings   app settings (config.json), caches
//                        OpenCRM-data\Databases  default place for new databases
//                        OpenCRM-data\ai         built-in AI: llama.cpp and the downloaded models
// Portable mode is on when:
//   - the program is the single-file portable exe (electron-builder sets PORTABLE_EXECUTABLE_DIR), or
//   - a file named "portable.flag" sits next to OpenCRM.exe (the portable folder), or
//   - OPENCRM_PORTABLE_ROOT is set (tests).
// OPENCRM_USER_DATA (tests) always wins for the settings folder.
import fs from 'node:fs';
import path from 'node:path';
import { app } from 'electron';

function detectRoot() {
  if (process.env.OPENCRM_PORTABLE_ROOT) return path.resolve(process.env.OPENCRM_PORTABLE_ROOT);
  if (process.env.PORTABLE_EXECUTABLE_DIR) return process.env.PORTABLE_EXECUTABLE_DIR;
  const exeDir = path.dirname(process.execPath);
  if (app.isPackaged && fs.existsSync(path.join(exeDir, 'portable.flag'))) return exeDir;
  return null;
}

export const PORTABLE_ROOT = detectRoot();
export const isPortable = () => !!PORTABLE_ROOT;
export const dataRoot = () => (PORTABLE_ROOT ? path.join(PORTABLE_ROOT, 'OpenCRM-data') : null);

/** Call once, before anything reads app.getPath('userData'). */
export function applyPaths() {
  if (process.env.OPENCRM_USER_DATA) { app.setPath('userData', process.env.OPENCRM_USER_DATA); return; }
  if (!PORTABLE_ROOT) return;
  const settings = path.join(dataRoot(), 'settings');
  try { fs.mkdirSync(settings, { recursive: true }); } catch { /* read-only medium: Electron reports it */ }
  app.setPath('userData', settings);
}

export function databasesDir() {
  return PORTABLE_ROOT ? path.join(dataRoot(), 'Databases') : path.join(app.getPath('documents'), 'OpenCRM');
}

export function aiDir() {
  if (process.env.OPENCRM_AI_DIR) return path.resolve(process.env.OPENCRM_AI_DIR);
  return PORTABLE_ROOT ? path.join(dataRoot(), 'ai') : path.join(app.getPath('userData'), 'ai');
}

// Paths saved in config.json: inside the portable folder they are stored relative ("@portable\..."),
// so a database on the stick is found again when the drive letter changes on another computer.
const TAG = '@portable';
export function toStored(p) {
  if (!p || !PORTABLE_ROOT) return p;
  const rel = path.relative(PORTABLE_ROOT, p);
  if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) return p;
  return `${TAG}${path.sep}${rel}`;
}
export function fromStored(p) {
  if (!p || typeof p !== 'string' || !p.startsWith(TAG)) return p;
  return PORTABLE_ROOT ? path.join(PORTABLE_ROOT, p.slice(TAG.length + 1)) : p;
}
