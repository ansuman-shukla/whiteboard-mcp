import type { Readable, Writable } from 'node:stream';
import { APP_NAME, VERSION } from '../shared/config.js';
import { BOARD_RESOURCE, BOARD_URI, VIEW_TOOL, VIEW_TOOL_DEF, ViewError, ViewRelays, clientSupportsApps, readBoardResource } from './apps.js';
import { INSTRUCTIONS } from './guide.js';
import { INVALID_PARAMS, JsonRpcConnection, METHOD_NOT_FOUND, RpcError } from './jsonrpc.js';
import { validate } from './schema.js';
import { Session, rootToPath } from './session.js';
import { ToolContext, callTool, getTool, toolList } from './tools.js';

export const SUPPORTED_PROTOCOL_VERSIONS = ['2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'];
const ROOTS_TIMEOUT_MS = 3000;

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const debug = (msg: string): void => {
  if (process.env.WHITEBOARD_DEBUG === '1') process.stderr.write(`[whiteboard-mcp] ${msg}\n`);
};

export interface McpServerOptions {
  input?: Readable;
  output?: Writable;
  session?: Session;
}

/** MCP over stdio. Never writes anything but JSON-RPC frames to `output`. */
export function startMcpServer(opts: McpServerOptions = {}): JsonRpcConnection {
  const session = opts.session ?? new Session();
  const ctx = new ToolContext(session);
  const views = new ViewRelays(() => ctx.connect());
  let clientWantsRoots = false;

  const queryRoots = (): void => {
    if (!clientWantsRoots) return;
    session.waitForWorkspace(
      conn.request<{ roots?: Array<{ uri?: unknown }> }>('roots/list', undefined, ROOTS_TIMEOUT_MS).then((res) => {
        for (const root of res.roots ?? []) {
          const path = typeof root.uri === 'string' ? rootToPath(root.uri) : undefined;
          if (path) return path;
        }
        return undefined;
      }),
    );
  };

  /** canvas_view: the inline board's link to the daemon (app-only, never shown to the model). */
  const relay = async (args: unknown) => {
    const a = isObject(args) ? args : {};
    const invalid = validate(VIEW_TOOL_DEF.inputSchema, a);
    if (invalid) return { content: [{ type: 'text', text: `Invalid arguments: ${invalid}.` }], isError: true };
    try {
      const messages = await views.handle(a as unknown as Parameters<ViewRelays['handle']>[0]);
      return { content: [{ type: 'text', text: `${messages.length} messages` }], structuredContent: { messages } };
    } catch (err) {
      const text = err instanceof ViewError ? err.message : `Canvas daemon unreachable (${err instanceof Error ? err.message : String(err)})`;
      return { content: [{ type: 'text', text }], isError: true };
    }
  };

  const conn: JsonRpcConnection = new JsonRpcConnection(opts.input ?? process.stdin, opts.output ?? process.stdout, {
    async request(method, params) {
      switch (method) {
        case 'initialize': {
          const p = isObject(params) ? params : {};
          clientWantsRoots = isObject(p.capabilities) && isObject(p.capabilities.roots);
          ctx.apps = clientSupportsApps(p.capabilities);
          debug(`initialize: ${isObject(p.clientInfo) ? String(p.clientInfo.name) : 'unknown client'}, MCP Apps ${ctx.apps ? 'on' : 'off'}`);
          const requested = typeof p.protocolVersion === 'string' ? p.protocolVersion : '';
          return {
            protocolVersion: SUPPORTED_PROTOCOL_VERSIONS.includes(requested) ? requested : SUPPORTED_PROTOCOL_VERSIONS[0],
            capabilities: { tools: { listChanged: false }, resources: { listChanged: false } },
            serverInfo: { name: APP_NAME, version: VERSION },
            instructions: INSTRUCTIONS,
          };
        }
        case 'ping':
        case 'logging/setLevel':
          return {};
        case 'tools/list':
          return { tools: ctx.apps ? [...toolList(true), VIEW_TOOL_DEF] : toolList() };
        case 'resources/list':
          return { resources: [BOARD_RESOURCE] };
        case 'resources/read': {
          if (!isObject(params) || params.uri !== BOARD_URI) throw new RpcError(INVALID_PARAMS, `Unknown resource: ${isObject(params) ? String(params.uri) : ''}`);
          debug(`resources/read ${BOARD_URI}`);
          return readBoardResource();
        }
        case 'resources/templates/list':
          return { resourceTemplates: [] };
        case 'prompts/list':
          return { prompts: [] };
        case 'tools/call': {
          if (!isObject(params) || typeof params.name !== 'string') throw new RpcError(INVALID_PARAMS, 'tools/call needs a tool name');
          if (params.name === VIEW_TOOL) return relay(params.arguments);
          const tool = getTool(params.name);
          if (!tool) throw new RpcError(INVALID_PARAMS, `Unknown tool: ${params.name}`);
          if (params.arguments !== undefined && !isObject(params.arguments)) throw new RpcError(INVALID_PARAMS, 'tools/call arguments must be an object');
          return callTool(tool, params.arguments ?? {}, ctx, params._meta);
        }
        default:
          throw new RpcError(METHOD_NOT_FOUND, `Method not found: ${method}`);
      }
    },
    notification(method) {
      if (method === 'notifications/initialized' || method === 'notifications/roots/list_changed') queryRoots();
    },
  });
  conn.onClose(() => views.closeAll());
  return conn;
}
