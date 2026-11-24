// Local channel between the MCP bridge (started by the agent's client) and the running OpenCRM app.
// Windows named pipe (or a Unix socket elsewhere); newline-delimited JSON requests carrying the client token.
import net from 'node:net';
import path from 'node:path';
import crypto from 'node:crypto';

export function pipePath(userDataDir) {
  const tag = crypto.createHash('sha1').update(path.resolve(userDataDir).toLowerCase()).digest('hex').slice(0, 12);
  return process.platform === 'win32' ? `\\\\.\\pipe\\opencrm-agent-${tag}` : path.join(userDataDir, `agent-${tag}.sock`);
}

export const hashToken = t => crypto.createHash('sha256').update(String(t)).digest('hex');
export const newToken = () => `ocrm_${crypto.randomBytes(24).toString('base64url')}`;

/** Line-delimited JSON over a socket. onMessage(msg, reply) for servers; request() for clients. */
export function framed(socket, onMessage) {
  let buf = '';
  socket.setEncoding('utf8');
  socket.on('data', chunk => {
    buf += chunk;
    if (buf.length > 32 * 1024 * 1024) { socket.destroy(); return; }
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i);
      buf = buf.slice(i + 1);
      if (!line.trim()) continue;
      let msg;
      try { msg = JSON.parse(line); } catch { continue; }
      onMessage(msg);
    }
  });
  return { send: obj => { if (!socket.destroyed) socket.write(`${JSON.stringify(obj)}\n`); } };
}

/** Client side: connects and returns { request(method, params), close() }. */
export function connect(pipe, { timeoutMs = 3000 } = {}) {
  return new Promise((resolve, reject) => {
    const socket = net.connect(pipe);
    const pending = new Map();
    let seq = 0;
    const t = setTimeout(() => { socket.destroy(); reject(new Error('timeout')); }, timeoutMs);
    const ch = framed(socket, msg => {
      const p = pending.get(msg.id);
      if (!p) return;
      pending.delete(msg.id);
      if (msg.error) { const e = new Error(msg.error.message || 'Error'); e.code = msg.error.code; p.reject(e); } else p.resolve(msg.result);
    });
    socket.once('connect', () => {
      clearTimeout(t);
      resolve({
        request: (method, params = {}, token) => new Promise((res, rej) => {
          const id = ++seq;
          pending.set(id, { resolve: res, reject: rej });
          ch.send({ id, method, params, token });
        }),
        close: () => socket.end(),
        onClose: fn => socket.once('close', fn),
      });
    });
    socket.once('error', err => { clearTimeout(t); reject(err); });
    socket.on('close', () => { for (const p of pending.values()) p.reject(Object.assign(new Error('OpenCRM closed the connection.'), { code: 'CLOSED' })); pending.clear(); });
  });
}
