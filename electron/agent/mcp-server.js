// Builds the MCP server (tools, resources, prompts). invoke(tool, args) runs a tool in the OpenCRM app
// (through the local pipe for stdio, directly for the in-app HTTP transport).
import { McpServer, ResourceTemplate } from '@modelcontextprotocol/sdk/server/mcp.js';
import { TOOLS, PROMPTS, SERVER_INSTRUCTIONS } from './tools.js';

const asText = obj => JSON.stringify(obj, null, 2);

export function createMcpServer({ invoke, version = '2.0.0' }) {
  const server = new McpServer({ name: 'opencrm', title: 'OpenCRM', version }, { instructions: SERVER_INSTRUCTIONS });

  for (const t of TOOLS) {
    server.registerTool(t.name, { title: t.title, description: t.description, inputSchema: t.input, annotations: { title: t.title, ...t.annotations } }, async (args) => {
      try {
        const result = await invoke(t.name, args || {});
        return { content: [{ type: 'text', text: asText(result) }], structuredContent: result && typeof result === 'object' && !Array.isArray(result) ? result : undefined };
      } catch (e) {
        return { isError: true, content: [{ type: 'text', text: e.message || String(e) }] };
      }
    });
  }

  const res = (name, uri, title, description, tool, argsOf) => {
    const isTemplate = uri.includes('{');
    const target = isTemplate ? new ResourceTemplate(uri, { list: undefined }) : uri;
    server.registerResource(name, target, { title, description, mimeType: 'application/json' }, async (u, vars = {}) => {
      const result = await invoke(tool, argsOf(vars));
      return { contents: [{ uri: u.href, mimeType: 'application/json', text: asText(result) }] };
    });
  };
  res('schema', 'crm://schema', 'CRM schema', 'Record types, fields, options, views and templates', 'crm_overview', () => ({}));
  res('record', 'crm://record/{type}/{id}', 'Record', 'One record with fields, documents and recent notes', 'get_record', v => ({ ref: `${v.type}:${v.id}` }));
  res('view', 'crm://view/{id}', 'Saved view', 'Records of a saved view', 'run_view', v => ({ view: decodeURIComponent(v.id) }));
  res('template', 'crm://template/{id}', 'Email template', 'An email template', 'get_email_template', v => ({ id: v.id }));
  res('thread', 'crm://thread/{id}', 'Email conversation', 'Messages of a conversation', 'get_thread', v => ({ threadId: v.id }));
  res('engagement', 'crm://engagement', 'Engagement', 'Hot leads, follow-ups, bounced/unsubscribed, template results', 'get_engagement', () => ({}));

  for (const p of PROMPTS) {
    server.registerPrompt(p.name, { title: p.title, description: p.description, argsSchema: p.args }, (args) => ({
      messages: [{ role: 'user', content: { type: 'text', text: p.text(args || {}) } }],
    }));
  }
  return server;
}
