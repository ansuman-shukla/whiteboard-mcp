import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { APP_NAME, stateDir, statePath, type DaemonInfo } from '../shared/config.js';
import {
  API,
  type Actor,
  type ApplyResponse,
  type BinaryFile,
  type CanvasMeta,
  type CanvasNote,
  type CanvasSnapshot,
  type CanvasSummary,
  type ChangesResponse,
  type ExElement,
  type SavedSummary,
  type ShowRequest,
  type ViewerRequestType,
} from '../shared/protocol.js';

export class CanvasError extends Error {
  constructor(message: string, readonly status: number, readonly code: string) {
    super(message);
    this.name = 'CanvasError';
  }
}

export interface ConnectOptions {
  /** Spawn the daemon when none is running (default true). */
  autoStart?: boolean;
  /** Script run as `node <entry> serve`; defaults to WHITEBOARD_ENTRY or the bundled cli.js. */
  entry?: string;
  startTimeoutMs?: number;
}

interface Endpoint {
  baseUrl: string;
  token: string;
}

const HTTP_TIMEOUT_MS = 10_000;
const HEALTH_TIMEOUT_MS = 1000;
const DEFAULT_REQUEST_TIMEOUT_MS = 15_000;
const POLL_MS = 50;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

/** fetch() rejects with a TypeError ("fetch failed") when the daemon is gone; timeouts are DOMExceptions. */
const isConnectionError = (err: unknown) => err instanceof TypeError;

function readJsonFile(file: string): unknown {
  try {
    return JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    return undefined;
  }
}

async function fetchHealth(baseUrl: string): Promise<{ ok: boolean; app?: unknown; version: string; pid: number } | undefined> {
  try {
    const res = await fetch(`${baseUrl}${API.health}`, { signal: AbortSignal.timeout(HEALTH_TIMEOUT_MS) });
    const body: unknown = await res.json();
    return res.ok && isObject(body) && typeof body.pid === 'number' ? (body as { ok: boolean; version: string; pid: number }) : undefined;
  } catch {
    return undefined;
  }
}

/** The daemon advertised in daemon.json, if it answers /health as whiteboard-mcp with the same pid. */
async function probe(): Promise<Endpoint | undefined> {
  const info = readJsonFile(statePath('daemon.json')) as Partial<DaemonInfo> | undefined;
  if (!isObject(info) || typeof info.port !== 'number' || typeof info.pid !== 'number') return undefined;
  let token: string;
  try {
    token = readFileSync(statePath('token'), 'utf8').trim();
  } catch {
    return undefined;
  }
  const baseUrl = `http://127.0.0.1:${info.port}`;
  const health = await fetchHealth(baseUrl);
  return token && health?.app === APP_NAME && health.pid === info.pid ? { baseUrl, token } : undefined;
}

async function discover(opts: ConnectOptions): Promise<Endpoint> {
  const found = await probe();
  if (found) return found;
  if (opts.autoStart === false) throw new CanvasError('canvas daemon is not running', 503, 'daemon_not_running');
  const entry = opts.entry ?? (process.env.WHITEBOARD_ENTRY || fileURLToPath(new URL('../cli.js', import.meta.url)));
  let spawnError: Error | undefined;
  // cwd = state dir so the daemon never pins the caller's project directory. Concurrent spawns are
  // safe: the daemon's lock lets exactly one of them run.
  const child = spawn(process.execPath, [entry, 'serve'], { detached: true, stdio: 'ignore', env: process.env, cwd: stateDir() });
  child.once('error', (err) => (spawnError = err));
  child.unref();
  const timeoutMs = opts.startTimeoutMs ?? 8000;
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (spawnError) throw new CanvasError(`could not start the canvas daemon: ${spawnError.message}`, 503, 'daemon_start_failed');
    await sleep(POLL_MS);
    const endpoint = await probe();
    if (endpoint) return endpoint;
  }
  throw new CanvasError(`canvas daemon did not start within ${timeoutMs}ms (see ${statePath('daemon.log')})`, 503, 'daemon_start_timeout');
}

export class CanvasClient {
  private endpoint: Endpoint;
  private rediscovering: Promise<void> | undefined;

  private constructor(endpoint: Endpoint, private readonly opts: ConnectOptions) {
    this.endpoint = endpoint;
  }

  static async connect(opts: ConnectOptions = {}): Promise<CanvasClient> {
    return new CanvasClient(await discover(opts), opts);
  }

  get baseUrl(): string {
    return this.endpoint.baseUrl;
  }

  get token(): string {
    return this.endpoint.token;
  }

  async health(): Promise<{ ok: boolean; version: string; pid: number }> {
    const { ok, version, pid } = await this.call<{ ok: boolean; version: string; pid: number }>('GET', API.health);
    return { ok, version, pid };
  }

  list(): Promise<CanvasSummary[]> {
    return this.call('GET', API.canvases);
  }

  ensureCanvas(id: string, meta: CanvasMeta = {}): Promise<CanvasSummary> {
    return this.call('PUT', API.canvas(id), meta);
  }

  /** Asks the IDE panel host of the chat's window (`host`) or workspace to show the board. False when none qualifies. */
  async show(id: string, workspace: string, host?: string): Promise<boolean> {
    const request: ShowRequest = { workspace, ...(host ? { host } : {}) };
    try {
      await this.call('POST', API.show(id), request, 8000);
      return true;
    } catch (err) {
      if (err instanceof CanvasError && err.status === 409) return false;
      throw err;
    }
  }

  snapshot(id: string): Promise<CanvasSnapshot> {
    return this.call('GET', API.canvas(id));
  }

  apply(id: string, elements: ExElement[], opts: { files?: BinaryFile[]; actor?: Actor } = {}): Promise<ApplyResponse> {
    return this.call('POST', API.elements(id), { elements, ...opts });
  }

  clear(id: string): Promise<ApplyResponse> {
    return this.call('POST', API.clear(id), {});
  }

  changes(id: string, since: number): Promise<ChangesResponse> {
    return this.call('GET', API.changes(id, since));
  }

  addNote(id: string, text: string): Promise<CanvasNote> {
    return this.call('POST', API.notes(id), { text });
  }

  /** Relays a request to the canvas's browser viewer. Fails with code no_viewer, timeout or viewer_error. */
  async request<T>(id: string, type: ViewerRequestType, payload: unknown, timeoutMs = DEFAULT_REQUEST_TIMEOUT_MS): Promise<T> {
    try {
      const body = await this.call<{ result: T }>('POST', API.request(id), { type, payload, timeoutMs }, timeoutMs + 2000);
      return body.result;
    } catch (err) {
      if (!(err instanceof CanvasError)) throw err;
      if (err.status === 409) throw new CanvasError(`no browser viewer has canvas "${id}" open`, 409, 'no_viewer');
      if (err.status === 504) throw new CanvasError(`the viewer did not answer the ${type} request in time`, 504, 'timeout');
      if (err.status === 502) throw new CanvasError(`the viewer failed the ${type} request: ${err.code}`, 502, 'viewer_error');
      throw err;
    }
  }

  /** Saves a frozen copy of the canvas to the library, named after the board unless `name` is given. */
  save(id: string, name?: string): Promise<SavedSummary> {
    return this.call('POST', API.save(id), name === undefined ? {} : { name });
  }

  searchSaved(query = '', workspace = '', limit?: number): Promise<SavedSummary[]> {
    return this.call('GET', API.saved(query, workspace, limit));
  }

  /** Replaces the canvas's scene with a copy of a saved board. */
  loadSaved(id: string, savedId: string): Promise<ApplyResponse> {
    return this.call('POST', API.load(id), { saved: savedId });
  }

  async deleteSaved(savedId: string): Promise<void> {
    await this.call('DELETE', API.savedBoard(savedId));
  }

  async deleteCanvas(id: string): Promise<void> {
    await this.call('DELETE', API.canvas(id));
  }

  viewerUrl(id: string): string {
    return `${this.baseUrl}${API.viewer(id)}?token=${this.token}`;
  }

  private async call<T>(method: string, path: string, body?: unknown, timeoutMs = HTTP_TIMEOUT_MS, retry = true): Promise<T> {
    let res: Response;
    try {
      res = await fetch(`${this.baseUrl}${path}`, {
        method,
        headers: { Authorization: `Bearer ${this.token}`, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (err) {
      if (err instanceof DOMException && err.name === 'TimeoutError') throw new CanvasError(`${method} ${path.split('?')[0]} timed out after ${timeoutMs}ms`, 504, 'timeout');
      // The daemon idled out or restarted (maybe on another port): find or start it once, then retry once.
      if (!retry || !isConnectionError(err)) throw err;
      await this.rediscover();
      return this.call(method, path, body, timeoutMs, false);
    }
    const text = await res.text();
    let data: unknown;
    try {
      data = text ? JSON.parse(text) : undefined;
    } catch {
      data = undefined;
    }
    if (res.ok) return data as T;
    const code = isObject(data) && typeof data.error === 'string' ? data.error : `http_${res.status}`;
    throw new CanvasError(`${method} ${path.split('?')[0]} failed (${res.status}): ${code}`, res.status, code);
  }

  private rediscover(): Promise<void> {
    this.rediscovering ??= discover(this.opts)
      .then((endpoint) => {
        this.endpoint = endpoint;
      })
      .finally(() => {
        this.rediscovering = undefined;
      });
    return this.rediscovering;
  }
}
