import { readFileSync } from 'node:fs';
import WebSocket from 'ws';
import type { CanvasClient } from '../canvas/client.js';
import { API, type ClientMessage, type ServerMessage } from '../shared/protocol.js';
import type { Schema } from './schema.js';

/**
 * MCP Apps (the `io.modelcontextprotocol/ui` extension): hosts that support it render the board inline
 * in the chat, in a sandboxed iframe, from the `ui://` resource canvas_open points at. The iframe can't
 * reach the daemon on 127.0.0.1, so it talks to it through this server: it calls the app-only
 * `canvas_view` tool (proxied by the host), and each view gets a viewer WebSocket held here.
 */
export const APPS_EXTENSION = 'io.modelcontextprotocol/ui';
export const APP_MIME_TYPE = 'text/html;profile=mcp-app';
export const BOARD_URI = 'ui://whiteboard-mcp/board.html';
export const VIEW_TOOL = 'canvas_view';

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

/** True when the client's initialize capabilities say it renders MCP Apps HTML. */
export function clientSupportsApps(capabilities: unknown): boolean {
  if (!isObject(capabilities) || !isObject(capabilities.extensions)) return false;
  const ui = capabilities.extensions[APPS_EXTENSION];
  if (!isObject(ui)) return false;
  return !Array.isArray(ui.mimeTypes) || ui.mimeTypes.includes(APP_MIME_TYPE);
}

/** `_meta` for a tool whose result the host shows as the inline board (new and legacy keys). */
export const BOARD_TOOL_META = { ui: { resourceUri: BOARD_URI }, 'ui/resourceUri': BOARD_URI };

const RESOURCE_META = { ui: { prefersBorder: true, csp: { connectDomains: [], resourceDomains: [] } } };

export const BOARD_RESOURCE = {
  uri: BOARD_URI,
  name: 'whiteboard',
  title: 'Whiteboard',
  description: 'The live board, drawn inline in the chat',
  mimeType: APP_MIME_TYPE,
  _meta: RESOURCE_META,
};

let boardHtml: string | undefined;

/** The prebuilt single-file view (dist/app/board.html; this module is dist/mcp/apps.js). */
export function readBoardResource(): { contents: Array<Record<string, unknown>> } {
  boardHtml ??= readFileSync(new URL('../app/board.html', import.meta.url), 'utf8');
  return { contents: [{ uri: BOARD_URI, mimeType: APP_MIME_TYPE, text: boardHtml, _meta: RESOURCE_META }] };
}

export const VIEW_TOOL_DEF = {
  name: VIEW_TOOL,
  description: 'Internal to the inline whiteboard view: relays its live connection to the board. Not for the model.',
  inputSchema: {
    type: 'object',
    properties: {
      view: { type: 'string', description: 'Id the view picked for its connection' },
      board: { type: 'string', description: 'Board id' },
      send: { type: 'array', items: { type: 'object' }, maxItems: 500, description: 'Viewer messages for the daemon' },
      wait: { type: 'number', description: 'Wait up to this many ms for daemon messages and return them' },
      close: { type: 'boolean', description: 'Close the connection' },
    },
    required: ['view', 'board'],
  } satisfies Schema & { type: 'object' },
  _meta: { ui: { visibility: ['app'] } },
};

const OPEN_TIMEOUT_MS = 5000;
const MAX_WAIT_MS = 20_000;
/** A view that stops polling (closed tab, unloaded iframe) loses its connection after this. */
const IDLE_MS = 45_000;
const MAX_QUEUE = 2000;
const MAX_VIEWS = 32;

export class ViewError extends Error {}

/** One inline view's viewer connection to the daemon, buffering what the daemon sends until the view polls. */
class ViewLink {
  private queue: ServerMessage[] = [];
  private wake?: () => void;
  private idle?: ReturnType<typeof setTimeout>;
  dead?: string;

  private constructor(readonly board: string, private readonly ws: WebSocket, private readonly onGone: () => void) {
    ws.on('message', (data) => {
      let msg: ServerMessage;
      try {
        msg = JSON.parse(String(data)) as ServerMessage;
      } catch {
        return;
      }
      if (this.queue.length >= MAX_QUEUE) return this.end('the view fell behind');
      this.queue.push(msg);
      this.wake?.();
    });
    ws.on('close', () => this.end('disconnected from the canvas daemon'));
    ws.on('error', () => this.end('disconnected from the canvas daemon'));
    this.touch();
  }

  static open(client: CanvasClient, board: string, onGone: () => void): Promise<ViewLink> {
    const url = `${client.baseUrl.replace(/^http/, 'ws')}${API.ws}?canvas=${encodeURIComponent(board)}&token=${encodeURIComponent(client.token)}`;
    const ws = new WebSocket(url, { handshakeTimeout: OPEN_TIMEOUT_MS });
    return new Promise((resolve, reject) => {
      const fail = (err: Error) => {
        ws.removeAllListeners();
        ws.on('error', () => undefined);
        ws.terminate();
        reject(new ViewError(`could not connect the view to the board: ${err.message}`));
      };
      ws.once('error', fail);
      ws.once('unexpected-response', (_req, res) => fail(new Error(`daemon answered ${res.statusCode}`)));
      ws.once('open', () => {
        ws.removeAllListeners();
        resolve(new ViewLink(board, ws, onGone));
      });
    });
  }

  /** Keeps the link while the view keeps calling. */
  touch(): void {
    clearTimeout(this.idle);
    this.idle = setTimeout(() => this.end('idle'), IDLE_MS);
    this.idle.unref();
  }

  send(messages: ClientMessage[]): void {
    if (this.dead) throw new ViewError(this.dead);
    for (const msg of messages) this.ws.send(JSON.stringify(msg));
  }

  /** What the daemon sent since the last poll, waiting up to `waitMs` for something. Only the latest poll waits. */
  async poll(waitMs: number): Promise<ServerMessage[]> {
    this.wake?.();
    if (!this.queue.length && !this.dead && waitMs > 0) {
      await new Promise<void>((resolve) => {
        const timer = setTimeout(done, waitMs);
        const self = this;
        function done(): void {
          clearTimeout(timer);
          if (self.wake === done) self.wake = undefined;
          resolve();
        }
        this.wake = done;
      });
    }
    const out = this.queue;
    this.queue = [];
    if (!out.length && this.dead) throw new ViewError(this.dead);
    return out;
  }

  end(reason: string): void {
    if (this.dead) return;
    this.dead = reason;
    clearTimeout(this.idle);
    this.ws.removeAllListeners();
    this.ws.on('error', () => undefined);
    this.ws.close();
    this.wake?.();
    this.onGone();
  }
}

/** The views this server process relays, by the id each view picked. */
export class ViewRelays {
  private readonly links = new Map<string, Promise<ViewLink>>();

  constructor(private readonly connect: () => Promise<CanvasClient>) {}

  get size(): number {
    return this.links.size;
  }

  async handle(args: { view: string; board: string; send?: ClientMessage[]; wait?: number; close?: boolean }): Promise<ServerMessage[]> {
    const { view, board } = args;
    if (args.close) {
      const pending = this.links.get(view);
      this.links.delete(view);
      (await pending?.catch(() => undefined))?.end('closed');
      return [];
    }
    const link = await this.link(view, board);
    link.touch();
    if (args.send?.length) link.send(args.send);
    // Only polls drain the queue, and the view keeps one poll at a time, so messages arrive in order.
    if (args.wait === undefined) return [];
    const wait = Math.min(Math.max(Number(args.wait) || 0, 0), MAX_WAIT_MS);
    // A poll that finds the link dead ends it here, so the view's next call reconnects with a fresh snapshot.
    return link.poll(wait);
  }

  closeAll(): void {
    const pending = [...this.links.values()];
    this.links.clear();
    for (const p of pending) void p.then((l) => l.end('closed'), () => undefined);
  }

  private async link(view: string, board: string): Promise<ViewLink> {
    const existing = this.links.get(view);
    if (existing) {
      const link = await existing.catch(() => undefined);
      if (link && !link.dead && link.board === board) return link;
      if (this.links.get(view) === existing) this.links.delete(view);
      link?.end('switched board');
    }
    if (this.links.size >= MAX_VIEWS) throw new ViewError('too many inline views are open');
    const created = (async () => {
      const client = await this.connect();
      await client.health(); // finds the daemon again if it restarted on another port
      const link = await ViewLink.open(client, board, () => {
        if (this.links.get(view) === created) this.links.delete(view);
      });
      return link;
    })();
    this.links.set(view, created);
    created.catch(() => {
      if (this.links.get(view) === created) this.links.delete(view);
    });
    return created;
  }
}
