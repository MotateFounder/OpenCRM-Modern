// "OpenCRM.exe --mcp": MCP server over stdio for the agent's client (Claude Desktop, Claude Code, Hermes…).
// It owns no data: every tool call goes through the local pipe to the running OpenCRM app, which is
// started in the tray if needed. Logs go to stderr (stdout is the MCP channel).
import { spawn } from 'node:child_process';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { connect, pipePath } from './protocol.js';
import { createMcpServer } from './mcp-server.js';

const log = (...a) => process.stderr.write(`[opencrm-mcp] ${a.join(' ')}\n`);
const sleep = ms => new Promise(r => setTimeout(r, ms));

export async function runBridge({ userData, version, launchCommand }) {
  const token = process.env.OPENCRM_AGENT_TOKEN || '';
  const pipe = pipePath(userData);
  let conn = null;
  let connecting = null;

  async function open() {
    try { return await connect(pipe); } catch { /* not running */ }
    log('OpenCRM is not running: starting it in the tray…');
    const { command, args } = launchCommand();
    const env = { ...process.env, OPENCRM_START_HIDDEN: '1' };
    delete env.OPENCRM_AGENT_TOKEN;
    delete env.ELECTRON_RUN_AS_NODE;
    spawn(command, args, { detached: true, stdio: 'ignore', env, windowsHide: false }).unref();
    for (let i = 0; i < 120; i++) {
      await sleep(500);
      try { return await connect(pipe); } catch { /* keep waiting */ }
    }
    throw new Error('Could not start or reach OpenCRM. Open OpenCRM and try again.');
  }

  async function ensure() {
    if (conn) return conn;
    if (!connecting) {
      connecting = (async () => {
        const c = await open();
        c.onClose(() => { conn = null; });
        const hello = await c.request('hello', {}, token);
        log(`connected as “${hello.client}” (${hello.profile}) to ${hello.db || 'no database'}`);
        conn = c;
        return c;
      })().finally(() => { connecting = null; });
    }
    return connecting;
  }

  const invoke = async (tool, args) => {
    for (let attempt = 0; attempt < 2; attempt++) {
      const c = await ensure();
      try { return await c.request('call', { tool, args }, token); } catch (e) {
        if (e.code === 'CLOSED' && attempt === 0) { conn = null; continue; }
        throw e;
      }
    }
    throw new Error('OpenCRM is not reachable.');
  };

  const server = createMcpServer({ invoke, version });
  const transport = new StdioServerTransport();
  await server.connect(transport);
  log(`ready (pipe ${pipe})`);
  if (!token) log('warning: OPENCRM_AGENT_TOKEN is not set; tool calls will be refused.');
  // connect early so the user sees the "allow this agent" question right away
  ensure().catch(e => log(e.message));
  process.stdin.on('close', () => process.exit(0));
}
