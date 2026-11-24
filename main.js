// OpenCRM entry point.
//   OpenCRM.exe            -> the desktop app (app-main.js)
//   OpenCRM.exe --mcp      -> MCP server over stdio for AI agents: re-runs this executable in Node mode
//                             (electron/agent/bridge-node.mjs) with the same stdin/stdout; no window.
import { app } from 'electron';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { applyPaths } from './electron/paths.js';

if (process.argv.includes('--mcp')) {
  applyPaths(); // same settings folder as the app (portable: OpenCRM-data\settings), so the pipe name matches
  const here = path.dirname(fileURLToPath(import.meta.url));
  const launch = app.isPackaged
    ? { command: process.env.PORTABLE_EXECUTABLE_FILE || process.execPath, args: [] }
    : { command: process.execPath, args: [app.getAppPath()] };
  const child = spawn(process.execPath, [path.join(here, 'electron', 'agent', 'bridge-node.mjs')], {
    stdio: 'inherit',
    windowsHide: true,
    env: {
      ...process.env, ELECTRON_RUN_AS_NODE: '1',
      OPENCRM_BRIDGE_USERDATA: app.getPath('userData'), OPENCRM_BRIDGE_VERSION: app.getVersion(), OPENCRM_BRIDGE_LAUNCH: JSON.stringify(launch),
    },
  });
  child.on('exit', code => app.exit(code ?? 0));
  child.on('error', () => app.exit(1));
} else {
  await import('./app-main.js');
}
