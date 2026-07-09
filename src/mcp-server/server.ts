import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { createRelayTools, RELAY_TOOL_INFO, type RelayToolDeps } from './tools';

// The Relay MCP server factory (P1 — the MCP qualifying technology). Builds an McpServer
// with the three READ-ONLY tools registered and NOTHING that can mutate the ledger. The
// factory is TRANSPORT-AGNOSTIC: stdio.ts connects it to a StdioServerTransport for the
// Claude Desktop demo; the integrator can also mount it on the Bolt HTTP server behind a
// bearer token (see the note at the bottom of this file).

const SERVER_INSTRUCTIONS = [
  'Relay is a Slack-native agent for verified volunteer crisis response. This MCP server exposes',
  'the live relief-operations ledger so an external agent can observe, summarise and reason over',
  'the response. Three tools are READ-ONLY; one (pledge_support) is a WRITE tool that only files a',
  'PROPOSAL — it can never itself change state or commit a volunteer.',
  '',
  'Read tools:',
  '  • search_needs — list live needs (filter by status/type/severity/locality/only_open).',
  '  • get_need     — full detail for one need by public id (e.g. N-0007), incl. evidence + verification.',
  '  • get_sitrep   — the live situation report as structured counts.',
  '',
  'Write tool (opt-in; requires RELAY_MCP_WRITES_ENABLED):',
  '  • pledge_support — pledge that your agent/org will fulfil an OPEN need. This lands as a PROPOSAL',
  '    a human coordinator must CONFIRM; Relay never auto-assigns an agent pledge. Once confirmed, the',
  '    commitment is tracked with the same SLA, drift detection and evidence gating as a human promise.',
  '',
  'Every value is PII-free by construction: beneficiary contact never leaves the encrypted',
  'vault and is never returned here. Numbers are ledger-derived; cite the source_permalink',
  'when you reference a need.',
].join('\n');

/**
 * Build the Relay read-only MCP server over an injected read port (+ optional sitrep fn).
 * The three tools are registered with their Zod input schemas; the SDK validates arguments
 * at the boundary before invoking each handler. Auth is a transport concern — for an HTTP
 * mount the integrator wraps this behind a bearer check; the factory itself stays clean.
 */
export function createRelayMcpServer(deps: RelayToolDeps): McpServer {
  const server = new McpServer(
    { name: 'relay-crisis', version: '0.1.0' },
    { capabilities: { tools: {} }, instructions: SERVER_INSTRUCTIONS },
  );

  const tools = createRelayTools(deps);

  server.registerTool(
    RELAY_TOOL_INFO.search_needs.name,
    {
      title: RELAY_TOOL_INFO.search_needs.title,
      description: RELAY_TOOL_INFO.search_needs.description,
      inputSchema: RELAY_TOOL_INFO.search_needs.inputSchema,
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    (args) => tools.search_needs(args),
  );

  server.registerTool(
    RELAY_TOOL_INFO.get_need.name,
    {
      title: RELAY_TOOL_INFO.get_need.title,
      description: RELAY_TOOL_INFO.get_need.description,
      inputSchema: RELAY_TOOL_INFO.get_need.inputSchema,
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    (args) => tools.get_need(args),
  );

  server.registerTool(
    RELAY_TOOL_INFO.get_sitrep.name,
    {
      title: RELAY_TOOL_INFO.get_sitrep.title,
      description: RELAY_TOOL_INFO.get_sitrep.description,
      inputSchema: RELAY_TOOL_INFO.get_sitrep.inputSchema,
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    (args) => tools.get_sitrep(args),
  );

  // The ONE write tool (Moonshot #2). Always registered so the "writes disabled" path is itself
  // discoverable; it is inert unless deps.write is composed with enabled: true. It only files a
  // PROPOSAL (never commits), so it is NOT destructive — but it is not read-only either.
  server.registerTool(
    RELAY_TOOL_INFO.pledge_support.name,
    {
      title: RELAY_TOOL_INFO.pledge_support.title,
      description: RELAY_TOOL_INFO.pledge_support.description,
      inputSchema: RELAY_TOOL_INFO.pledge_support.inputSchema,
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
    },
    (args) => tools.pledge_support(args),
  );

  return server;
}

// INTEGRATOR NOTE (HTTP mount, hosted app): the stdio entrypoint is the Claude Desktop demo
// path. To also serve the hosted Bolt app to remote agents, mount a
// StreamableHTTPServerTransport ('@modelcontextprotocol/sdk/server/streamableHttp.js') on an
// Express route behind a bearer-token guard, e.g.:
//
//   const server = createRelayMcpServer({ service, sitrep });
//   const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
//   await server.connect(transport);
//   app.post('/mcp', requireBearer(RELAY_MCP_TOKEN), (req, res) => transport.handleRequest(req, res, req.body));
//
// The factory above is unchanged for that path — only the transport + auth wrapper differ.
