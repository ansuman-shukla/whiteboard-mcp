import type { Readable, Writable } from 'node:stream';

export type Id = string | number;
export type Json = Record<string, unknown>;

export const PARSE_ERROR = -32700;
export const INVALID_REQUEST = -32600;
export const METHOD_NOT_FOUND = -32601;
export const INVALID_PARAMS = -32602;
export const INTERNAL_ERROR = -32603;

export class RpcError extends Error {
  constructor(readonly code: number, message: string, readonly data?: unknown) {
    super(message);
  }
}

export interface RpcHandlers {
  request(method: string, params: unknown): unknown;
  notification?(method: string, params: unknown): void;
}

interface Pending {
  resolve(value: unknown): void;
  reject(error: Error): void;
  timer: NodeJS.Timeout;
}

const isObject = (v: unknown): v is Json => typeof v === 'object' && v !== null && !Array.isArray(v);
const isId = (v: unknown): v is Id => typeof v === 'string' || (typeof v === 'number' && Number.isFinite(v));

/** Newline-delimited JSON-RPC 2.0 peer (MCP stdio transport). */
export class JsonRpcConnection {
  private buffer = '';
  private nextId = 1;
  private readonly pending = new Map<Id, Pending>();
  private readonly closeListeners: Array<() => void> = [];
  private closed = false;
  private inflight = 0;
  private drained?: () => void;

  constructor(private readonly input: Readable, private readonly output: Writable, private readonly handlers: RpcHandlers) {
    input.setEncoding('utf8');
    input.on('data', this.onData);
    input.once('end', this.close);
    input.once('close', this.close);
    output.on('error', this.close);
  }

  onClose(listener: () => void): void {
    if (this.closed) listener();
    else this.closeListeners.push(listener);
  }

  get isClosed(): boolean {
    return this.closed;
  }

  /** Resolves once requests received before close have been answered, or after `timeoutMs`. */
  drain(timeoutMs: number): Promise<void> {
    if (this.inflight === 0) return Promise.resolve();
    return new Promise((resolve) => {
      const timer = setTimeout(done, timeoutMs);
      function done(): void {
        clearTimeout(timer);
        resolve();
      }
      this.drained = done;
    });
  }

  request<T = unknown>(method: string, params?: unknown, timeoutMs = 10_000): Promise<T> {
    if (this.closed) return Promise.reject(new Error('connection closed'));
    const id = `srv-${this.nextId++}`;
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`${method} timed out after ${timeoutMs}ms`));
      }, timeoutMs);
      this.pending.set(id, { resolve: resolve as (v: unknown) => void, reject, timer });
      this.send({ jsonrpc: '2.0', id, method, ...(params === undefined ? {} : { params }) });
    });
  }

  notify(method: string, params?: unknown): void {
    this.send({ jsonrpc: '2.0', method, ...(params === undefined ? {} : { params }) });
  }

  readonly close = (): void => {
    if (this.closed) return;
    this.closed = true;
    this.input.off('data', this.onData);
    const rest = this.buffer.trim();
    this.buffer = '';
    if (rest) this.onLine(rest);
    for (const [id, p] of this.pending) {
      clearTimeout(p.timer);
      p.reject(new Error('connection closed'));
      this.pending.delete(id);
    }
    for (const listener of this.closeListeners.splice(0)) listener();
  };

  /** Still answers requests that arrived before stdin closed. */
  private send(message: Json): void {
    if (this.output.destroyed || !this.output.writable) return;
    this.output.write(`${JSON.stringify(message)}\n`);
  }

  private readonly onData = (chunk: string): void => {
    this.buffer += chunk;
    let nl: number;
    while ((nl = this.buffer.indexOf('\n')) >= 0) {
      const line = this.buffer.slice(0, nl).trim();
      this.buffer = this.buffer.slice(nl + 1);
      if (line) this.onLine(line);
    }
  };

  private onLine(line: string): void {
    let msg: unknown;
    try {
      msg = JSON.parse(line);
    } catch {
      this.sendError(null, PARSE_ERROR, 'Parse error');
      return;
    }
    if (!isObject(msg) || msg.jsonrpc !== '2.0') {
      this.sendError(isObject(msg) && isId(msg.id) ? msg.id : null, INVALID_REQUEST, 'Invalid Request');
      return;
    }
    if (typeof msg.method === 'string') {
      if (!('id' in msg)) {
        try {
          this.handlers.notification?.(msg.method, msg.params);
        } catch {
          // notifications never produce responses
        }
        return;
      }
      if (!isId(msg.id)) {
        this.sendError(null, INVALID_REQUEST, 'Invalid Request');
        return;
      }
      void this.dispatch(msg.id, msg.method, msg.params);
      return;
    }
    if (isId(msg.id) && ('result' in msg || 'error' in msg)) {
      const p = this.pending.get(msg.id);
      if (!p) return;
      this.pending.delete(msg.id);
      clearTimeout(p.timer);
      if (isObject(msg.error)) p.reject(new RpcError(Number(msg.error.code) || INTERNAL_ERROR, String(msg.error.message ?? 'error'), msg.error.data));
      else p.resolve(msg.result);
      return;
    }
    this.sendError(isId(msg.id) ? msg.id : null, INVALID_REQUEST, 'Invalid Request');
  }

  private async dispatch(id: Id, method: string, params: unknown): Promise<void> {
    this.inflight++;
    try {
      const result = await this.handlers.request(method, params);
      this.send({ jsonrpc: '2.0', id, result: result ?? {} });
    } catch (err) {
      if (err instanceof RpcError) this.sendError(id, err.code, err.message, err.data);
      else this.sendError(id, INTERNAL_ERROR, err instanceof Error ? err.message : String(err));
    } finally {
      if (--this.inflight === 0) this.drained?.();
    }
  }

  private sendError(id: Id | null, code: number, message: string, data?: unknown): void {
    this.send({ jsonrpc: '2.0', id, error: { code, message, ...(data === undefined ? {} : { data }) } });
  }
}
