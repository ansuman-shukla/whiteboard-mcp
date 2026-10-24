import type { ClientMessage, ServerMessage } from '../../src/shared/protocol';
import type { Connection, LinkStatus, OpenLink } from './connection';
import { backoffDelay } from './sync';

/**
 * The view's side of MCP Apps: JSON-RPC over postMessage with the host that renders this page inline in
 * the chat. Only what the board needs: the handshake, theme changes, the canvas_open result and proxied
 * tool calls (spec: io.modelcontextprotocol/ui, protocol 2026-01-26).
 */
const PROTOCOL_VERSION = '2026-01-26';
const REQUEST_TIMEOUT_MS = 30_000;
/** How long a relay poll waits server-side for daemon messages; well below hosts' tool-call timeouts. */
const POLL_WAIT_MS = 15_000;
const VIEW_TOOL = 'canvas_view';

type Json = Record<string, unknown>;
interface Pending {
  resolve(value: unknown): void;
  reject(err: Error): void;
  timer: ReturnType<typeof setTimeout>;
}
export interface HostContext {
  theme?: 'light' | 'dark';
  displayMode?: string;
  availableDisplayModes?: string[];
  containerDimensions?: { height?: number; maxHeight?: number };
  [key: string]: unknown;
}
export interface ToolResult {
  content?: Array<{ type: string; text?: string }>;
  structuredContent?: Json;
  _meta?: Json;
  isError?: boolean;
}
export interface BridgeEvents {
  toolResult(result: ToolResult): void;
  hostContext(ctx: HostContext): void;
  teardown(): void;
}

const isObject = (v: unknown): v is Json => typeof v === 'object' && v !== null && !Array.isArray(v);

export class HostBridge {
  private nextId = 1;
  private readonly pending = new Map<number, Pending>();
  context: HostContext = {};

  constructor(private readonly ev: BridgeEvents, private readonly target: Window = window.parent) {
    window.addEventListener('message', this.onMessage);
  }

  async connect(appInfo: { name: string; version: string }): Promise<HostContext> {
    const result = await this.request('ui/initialize', {
      appInfo,
      appCapabilities: { availableDisplayModes: ['inline', 'fullscreen'] },
      protocolVersion: PROTOCOL_VERSION,
    });
    this.context = isObject(result) && isObject(result.hostContext) ? (result.hostContext as HostContext) : {};
    this.notify('ui/notifications/initialized', {});
    return this.context;
  }

  async callTool(name: string, args: Json): Promise<ToolResult> {
    const result = await this.request('tools/call', { name, arguments: args });
    return isObject(result) ? (result as ToolResult) : {};
  }

  requestDisplayMode(mode: 'inline' | 'fullscreen'): Promise<unknown> {
    return this.request('ui/request-display-mode', { mode });
  }

  sizeChanged(height: number): void {
    this.notify('ui/notifications/size-changed', { height });
  }

  dispose(): void {
    window.removeEventListener('message', this.onMessage);
    for (const p of this.pending.values()) {
      clearTimeout(p.timer);
      p.reject(new Error('view closed'));
    }
    this.pending.clear();
  }

  private request(method: string, params: Json): Promise<unknown> {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`${method} timed out`));
      }, REQUEST_TIMEOUT_MS);
      this.pending.set(id, { resolve, reject, timer });
      this.post({ jsonrpc: '2.0', id, method, params });
    });
  }

  private notify(method: string, params: Json): void {
    this.post({ jsonrpc: '2.0', method, params });
  }

  private post(msg: Json): void {
    this.target.postMessage(msg, '*');
  }

  private readonly onMessage = (e: MessageEvent): void => {
    if (e.source !== this.target) return;
    const msg: unknown = e.data;
    if (!isObject(msg) || msg.jsonrpc !== '2.0') return;
    if ('method' in msg && typeof msg.method === 'string') return this.onHostCall(msg.method, msg.params, msg.id as number | string | undefined);
    const p = typeof msg.id === 'number' ? this.pending.get(msg.id) : undefined;
    if (!p) return;
    this.pending.delete(msg.id as number);
    clearTimeout(p.timer);
    if (isObject(msg.error)) p.reject(new Error(String(msg.error.message ?? 'host error')));
    else p.resolve(msg.result);
  };

  private onHostCall(method: string, params: unknown, id: number | string | undefined): void {
    const reply = (result: Json): void => {
      if (id !== undefined) this.post({ jsonrpc: '2.0', id, result });
    };
    switch (method) {
      case 'ui/notifications/tool-result':
        if (isObject(params)) this.ev.toolResult(params as ToolResult);
        return;
      case 'ui/notifications/host-context-changed':
        if (isObject(params)) {
          this.context = { ...this.context, ...params };
          this.ev.hostContext(this.context);
        }
        return;
      case 'ui/resource-teardown':
        this.ev.teardown();
        return reply({});
      case 'ping':
        return reply({});
      default:
        if (id !== undefined) this.post({ jsonrpc: '2.0', id, error: { code: -32601, message: `Method not found: ${method}` } });
    }
  }
}

const randomId = (): string => (crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(36).slice(2)}`);

/**
 * The board's daemon link when shown inline: the iframe can't reach 127.0.0.1, so viewer messages go
 * through the MCP server's app-only canvas_view tool, which holds a real viewer WebSocket. One long poll
 * at a time brings daemon messages back in order; sends are queued and go out one call at a time.
 */
export function relayLink(bridge: HostBridge, board: string): OpenLink {
  return (onMessage: (msg: ServerMessage) => void, onStatus: (status: LinkStatus) => void): Connection => {
    const view = randomId();
    let closed = false;
    let live = false;
    let attempt = 0;
    let retry: ReturnType<typeof setTimeout> | undefined;
    let outbox: ClientMessage[] = [];
    let sending = false;

    const setLive = (on: boolean) => {
      if (on === live) return;
      live = on;
      onStatus(on ? 'live' : 'offline');
    };

    const call = async (args: Json): Promise<ServerMessage[]> => {
      const res = await bridge.callTool(VIEW_TOOL, { view, board, ...args });
      if (res.isError) throw new Error(res.content?.find((c) => c.type === 'text')?.text ?? 'relay failed');
      const messages = res.structuredContent?.messages;
      return Array.isArray(messages) ? (messages as ServerMessage[]) : [];
    };

    const poll = async (): Promise<void> => {
      retry = undefined;
      while (!closed) {
        try {
          const messages = await call({ wait: POLL_WAIT_MS });
          if (closed) return;
          attempt = 0;
          setLive(true);
          for (const msg of messages) onMessage(msg);
        } catch {
          if (closed) return;
          setLive(false);
          retry = setTimeout(() => void poll(), backoffDelay(attempt++));
          return;
        }
      }
    };

    const flush = async (): Promise<void> => {
      if (sending || closed || !outbox.length) return;
      sending = true;
      const batch = outbox;
      outbox = [];
      try {
        const messages = await call({ send: batch });
        for (const msg of messages) onMessage(msg);
      } catch {
        // The link is gone; the poll notices, reconnects and the fresh snapshot brings the view back in sync.
      } finally {
        sending = false;
      }
      void flush();
    };

    onStatus('connecting');
    void poll();
    return {
      send(msg) {
        if (!live || closed) return false;
        outbox.push(msg);
        queueMicrotask(() => void flush());
        return true;
      },
      isOpen: () => live && !closed,
      retryNow() {
        if (closed || !retry) return;
        clearTimeout(retry);
        attempt = 0;
        void poll();
      },
      close() {
        if (closed) return;
        closed = true;
        clearTimeout(retry);
        void call({ close: true }).catch(() => undefined);
      },
    };
  };
}
