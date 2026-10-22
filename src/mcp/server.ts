import type { Readable, Writable } from 'node:stream';
import { APP_NAME, VERSION } from '../shared/config.js';
import { INSTRUCTIONS } from './guide.js';
import { INVALID_PARAMS, JsonRpcConnection, METHOD_NOT_FOUND, RpcError } from './jsonrpc.js';
import { Session, rootToPath } from './session.js';
import { ToolContext, callTool, getTool, toolList } from './tools.js';

export const SUPPORTED_PROTOCOL_VERSIONS = ['2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'];
const ROOTS_TIMEOUT_MS = 3000;

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

export interface McpServerOptions {
  input?: Readable;
  output?: Writable;
  session?: Session;
}

/** MCP over stdio. Never writes anything but JSON-RPC frames to `output`. */
export function startMcpServer(opts: McpServerOptions = {}): JsonRpcConnection {
  const session = opts.session ?? new Session();
  const ctx = new ToolContext(session);
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

  const conn: JsonRpcConnection = new JsonRpcConnection(opts.input ?? process.stdin, opts.output ?? process.stdout, {
    async request(method, params) {
      switch (method) {
        case 'initialize': {
          const p = isObject(params) ? params : {};
          clientWantsRoots = isObject(p.capabilities) && isObject(p.capabilities.roots);
          const requested = typeof p.protocolVersion === 'string' ? p.protocolVersion : '';
          return {
            protocolVersion: SUPPORTED_PROTOCOL_VERSIONS.includes(requested) ? requested : SUPPORTED_PROTOCOL_VERSIONS[0],
            capabilities: { tools: { listChanged: false } },
            serverInfo: { name: APP_NAME, version: VERSION },
            instructions: INSTRUCTIONS,
          };
        }
        case 'ping':
        case 'logging/setLevel':
          return {};
        case 'tools/list':
          return { tools: toolList() };
        case 'resources/list':
          return { resources: [] };
        case 'resources/templates/list':
          return { resourceTemplates: [] };
        case 'prompts/list':
          return { prompts: [] };
        case 'tools/call': {
          if (!isObject(params) || typeof params.name !== 'string') throw new RpcError(INVALID_PARAMS, 'tools/call needs a tool name');
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
  return conn;
}
