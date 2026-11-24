// Optional local HTTP transport (Streamable HTTP, stateless) for MCP clients that only accept a URL.
// Only 127.0.0.1, Bearer token = the agent token, DNS-rebinding protection (Host/Origin checks).
import http from 'node:http';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { createMcpServer } from './mcp-server.js';

export function startHttp({ port, call, version, onError }) {
  const allowedHosts = [`127.0.0.1:${port}`, `localhost:${port}`];
  const server = http.createServer(async (req, res) => {
    const deny = (status, msg) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ jsonrpc: '2.0', error: { code: -32000, message: msg }, id: null })); };
    try {
      if (!allowedHosts.includes(String(req.headers.host || ''))) return deny(403, 'Forbidden host');
      if (req.headers.origin && !/^https?:\/\/(127\.0\.0\.1|localhost)(:\d+)?$/.test(req.headers.origin)) return deny(403, 'Forbidden origin');
      const url = new URL(req.url, `http://127.0.0.1:${port}`);
      if (url.pathname !== '/mcp') return deny(404, 'Not found');
      if (req.method !== 'POST') return deny(405, 'Only POST is supported (stateless server)');
      const token = String(req.headers.authorization || '').replace(/^Bearer\s+/i, '');
      if (!token) return deny(401, 'Missing Authorization: Bearer <agent token>');
      const chunks = [];
      let size = 0;
      for await (const c of req) { size += c.length; if (size > 4 * 1024 * 1024) return deny(413, 'Request too large'); chunks.push(c); }
      let body;
      try { body = JSON.parse(Buffer.concat(chunks).toString('utf8') || 'null'); } catch { return deny(400, 'Invalid JSON'); }
      const mcp = createMcpServer({ invoke: (tool, args) => call(token, tool, args), version });
      const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true, enableDnsRebindingProtection: true, allowedHosts });
      res.on('close', () => { transport.close().catch(() => {}); mcp.close().catch(() => {}); });
      await mcp.connect(transport);
      await transport.handleRequest(req, res, body);
    } catch (e) {
      onError?.(e);
      if (!res.headersSent) deny(500, 'Internal error');
    }
  });
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => resolve({ close: () => new Promise(r => server.close(() => r())) }));
  });
}
