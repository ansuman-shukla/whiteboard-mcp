import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { appendFileSync, chmodSync, closeSync, openSync, readFileSync, realpathSync, renameSync, statSync, unlinkSync, writeFileSync, writeSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { createServer, STATUS_CODES, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { Duplex } from 'node:stream';
import { extname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocketServer, WebSocket, type RawData } from 'ws';
import { APP_NAME, VERSION, preferredPort, stateDir, statePath, type DaemonInfo } from '../shared/config.js';
import {
  API,
  CANVAS_ID_PATTERN,
  parseViewerPath,
  type Actor,
  type ApplyResponse,
  type BinaryFile,
  type CanvasMeta,
  type SavedSummary,
  type ServerHostMessage,
  type ServerMessage,
  type ViewerRequestType,
} from '../shared/protocol.js';
import { SavedStore } from './saved.js';
import { MAX_SEARCH_LIMIT } from './search.js';
import { CanvasStore, NotFoundError, ValidationError, validateElements } from './store.js';

export interface DaemonOptions {
  port?: number;
  host?: string;
  dir?: string;
  token?: string;
  idleExitMs?: number;
  heartbeatMs?: number;
  /** How long a panel host may take to show a board. */
  showTimeoutMs?: number;
  /** How long after start a show hinting a window waits for that window's panel host to connect. */
  hostGraceMs?: number;
  frontendDir?: string;
  onIdle?: () => void;
  log?: (line: string) => void;
}

export interface DaemonStats {
  viewers: number;
  hosts: number;
  pending: number;
  loadedCanvases: number;
  sockets: number;
}

export interface Daemon {
  port: number;
  token: string;
  url: string;
  close(): Promise<void>;
  stats(): DaemonStats;
}

interface Viewer {
  ws: WebSocket;
  canvasId: string;
  visible: boolean;
  /** Activity sequence number; higher means more recently active. */
  lastActive: number;
  alive: boolean;
}

interface Pending {
  viewer: Viewer;
  finish: (status: number, body: unknown) => void;
}

/** An IDE extension that shows boards in a panel beside the chat. */
interface Host {
  ws: WebSocket;
  /** The window's identity from its hello; older hosts don't send one. */
  hostId?: string;
  folders: string[];
  focused: boolean;
  lastActive: number;
  alive: boolean;
}

interface PendingShow {
  host: Host;
  finish: (status: number, body: unknown) => void;
}

/** A show waiting for a panel host to connect to a daemon that just started. */
interface HostWait {
  retry: () => void;
  finish: (status: number, body: unknown) => void;
}

const DEFAULT_SHOW_TIMEOUT_MS = 5_000;
/** Panel hosts look for a new daemon every few seconds (daemon.json), so a fresh daemon gives them this long. */
const DEFAULT_HOST_GRACE_MS = 5_000;
const MAX_HOST_FOLDERS = 64;
const MAX_HOST_ID = 256;

function contains(folder: string, target: string): boolean {
  const rel = relative(folder, target);
  return rel === '' || (!!rel && !rel.startsWith('..') && !isAbsolute(rel));
}

/**
 * A page served from this machine on any port, so viewers behind a local preview proxy (an editor's
 * in-app browser) can connect. The token still guards every socket; this only keeps remote sites out.
 */
function isLoopbackOrigin(origin: string): boolean {
  try {
    const url = new URL(origin);
    return url.protocol === 'http:' && (url.hostname === '127.0.0.1' || url.hostname === 'localhost') && url.origin === origin;
  } catch {
    return false;
  }
}

const MAX_BODY_BYTES = 30 * 1024 * 1024;
const MAX_SOCKET_BUFFER = 64 * 1024 * 1024;
const DEFAULT_REQUEST_TIMEOUT_MS = 15_000;
const MAX_REQUEST_TIMEOUT_MS = 60_000;
const UNLOAD_INTERVAL_MS = 60_000;
const UNLOAD_IDLE_MS = 10 * 60_000;
const DEFAULT_IDLE_EXIT_MS = 30 * 60_000;
const REQUEST_TYPES: ReadonlySet<string> = new Set<ViewerRequestType>(['screenshot', 'mermaid', 'focus']);
const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.woff': 'font/woff',
  '.ttf': 'font/ttf',
  '.wasm': 'application/wasm',
};

class HttpError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
  }
}

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const digest = (s: string) => createHash('sha256').update(s).digest();

function parseActor(value: unknown, fallback: Actor): Actor {
  if (value === undefined) return fallback;
  if (value === 'agent' || value === 'human') return value;
  throw new ValidationError('actor must be "agent" or "human"');
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  if (res.headersSent || res.destroyed) return;
  const data = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(data),
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
  });
  res.end(data);
}

function sendText(res: ServerResponse, status: number, text: string): void {
  if (res.headersSent || res.destroyed) return;
  res.writeHead(status, { 'Content-Type': 'text/plain; charset=utf-8', 'Content-Length': Buffer.byteLength(text), 'Cache-Control': 'no-store' });
  res.end(text);
}

function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolveBody, reject) => {
    if (Number(req.headers['content-length']) > MAX_BODY_BYTES) return reject(new HttpError(413, 'payload_too_large'));
    const chunks: Buffer[] = [];
    let size = 0;
    const cleanup = () => {
      req.off('data', onData);
      req.off('end', onEnd);
      req.off('error', onError);
    };
    const onData = (chunk: Buffer) => {
      size += chunk.length;
      if (size <= MAX_BODY_BYTES) return void chunks.push(chunk);
      cleanup();
      // Discard the rest instead of resetting the connection, so the client can read the 413.
      req.resume();
      reject(new HttpError(413, 'payload_too_large'));
    };
    const onEnd = () => {
      cleanup();
      resolveBody(Buffer.concat(chunks));
    };
    const onError = (err: Error) => {
      cleanup();
      reject(err);
    };
    req.on('data', onData);
    req.on('end', onEnd);
    req.on('error', onError);
  });
}

async function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
  const raw = await readBody(req);
  if (!raw.length) return {};
  let body: unknown;
  try {
    body = JSON.parse(raw.toString('utf8'));
  } catch {
    throw new HttpError(400, 'invalid_json');
  }
  if (!isObject(body)) throw new HttpError(400, 'body must be a JSON object');
  return body;
}

const LEGACY_VIEWER = /^\/c\/([^/]+)(\/?)$/;

/** Older links (`/c/<id>?token=`) move to the self-contained viewer path, relative so a proxy prefix survives. */
function redirectLegacyViewer(res: ServerResponse, url: URL, [, id, slash]: RegExpExecArray): void {
  const token = url.searchParams.get('token');
  if (!token) return sendText(res, 401, 'This board link has no token. Open the board from your agent.');
  url.searchParams.delete('token');
  res.writeHead(302, { Location: `${slash ? '' : `${id}/`}${encodeURIComponent(token)}/${url.search}`, 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer' });
  res.end();
}

function rejectUpgrade(socket: Duplex, status: number): void {
  // Destroying right after end() can drop the unflushed status line; wait for the write to finish.
  socket.once('finish', () => socket.destroy());
  socket.end(`HTTP/1.1 ${status} ${STATUS_CODES[status]}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
}

function idleExitFromEnv(): number {
  const raw = process.env.WHITEBOARD_IDLE_MS;
  const ms = raw === undefined || raw === '' ? NaN : Number(raw);
  return Number.isFinite(ms) && ms >= 0 ? ms : DEFAULT_IDLE_EXIT_MS;
}

export async function startDaemon(opts: DaemonOptions = {}): Promise<Daemon> {
  const host = opts.host ?? '127.0.0.1';
  const token = opts.token ?? randomBytes(32).toString('hex');
  const tokenDigest = digest(token);
  const heartbeatMs = opts.heartbeatMs ?? 30_000;
  const idleExitMs = opts.idleExitMs ?? idleExitFromEnv();
  const frontendDir = resolve(opts.frontendDir ?? fileURLToPath(new URL('../frontend', import.meta.url)));
  const log = opts.log ?? (() => {});
  const store = new CanvasStore({ dir: join(opts.dir ?? stateDir(), 'canvases'), onError: (err) => log(`flush failed: ${String(err)}`) });
  const saved = new SavedStore({ dir: join(opts.dir ?? stateDir(), 'saved') });

  const viewersByCanvas = new Map<string, Set<Viewer>>();
  const pending = new Map<string, Pending>();
  const hosts = new Set<Host>();
  const pendingShows = new Map<string, PendingShow>();
  const hostWaits = new Set<HostWait>();
  const startedAt = Date.now();
  const hostGraceMs = opts.hostGraceMs ?? DEFAULT_HOST_GRACE_MS;
  const timers: NodeJS.Timeout[] = [];
  let allowedHosts = new Set<string>();
  let lastActivityAt = Date.now();
  let activitySeq = 0;
  let closing: Promise<void> | undefined;

  const viewerCount = (canvasId: string) => viewersByCanvas.get(canvasId)?.size ?? 0;
  const tokenMatches = (given: string | null | undefined): boolean => typeof given === 'string' && timingSafeEqual(digest(given), tokenDigest);
  const authorized = (req: IncomingMessage, url: URL): boolean => {
    const header = req.headers.authorization;
    return tokenMatches(header?.startsWith('Bearer ') ? header.slice(7) : url.searchParams.get('token'));
  };

  function send(viewer: Viewer, msg: ServerMessage | string): void {
    if (viewer.ws.readyState !== WebSocket.OPEN) return;
    // A viewer that stops reading must not grow our memory without bound.
    if (viewer.ws.bufferedAmount > MAX_SOCKET_BUFFER) return void viewer.ws.terminate();
    viewer.ws.send(typeof msg === 'string' ? msg : JSON.stringify(msg));
  }

  function broadcast(canvasId: string, msg: ServerMessage, except?: Viewer): void {
    const viewers = viewersByCanvas.get(canvasId);
    if (!viewers) return;
    const data = JSON.stringify(msg);
    for (const v of viewers) if (v !== except) send(v, data);
  }

  function broadcastApplied(canvasId: string, result: ApplyResponse, actor: Actor, files: unknown, except?: Viewer): ApplyResponse {
    const sentFiles = Array.isArray(files) && files.length ? (files as BinaryFile[]) : undefined;
    if (result.applied.length || sentFiles) {
      broadcast(canvasId, { t: 'elements', rev: result.rev, actor, elements: store.pick(canvasId, result.applied), ...(sentFiles ? { files: sentFiles } : {}) }, except);
    }
    return result;
  }

  function applyAndBroadcast(canvasId: string, elements: unknown, actor: Actor, files: unknown, except?: Viewer) {
    // Validate before ensure() so a rejected request does not leave an empty canvas behind.
    validateElements(elements);
    store.ensure(canvasId);
    return broadcastApplied(canvasId, store.apply(canvasId, elements, actor, files), actor, files, except);
  }

  /** Saves a frozen copy of the board to the library, named after the board unless a name is given. */
  function saveBoard(canvasId: string, name: unknown): SavedSummary {
    const snap = store.snapshot(canvasId);
    return saved.save({ name: name ?? snap.title, source: canvasId, workspace: store.summaryOf(canvasId).workspace, elements: snap.elements, files: snap.files });
  }

  /** The `q`, `workspace` and `limit` parameters of a search request. */
  function searchParams(req: IncomingMessage, url: URL): [query: string, workspace: string | undefined, limit: number | undefined] {
    if ((req.method ?? 'GET') !== 'GET') throw new HttpError(405, 'method_not_allowed');
    const rawLimit = url.searchParams.get('limit');
    const limit = rawLimit ? Number(rawLimit) : undefined;
    if (limit !== undefined && !(Number.isInteger(limit) && limit > 0 && limit <= MAX_SEARCH_LIMIT)) throw new HttpError(400, `limit must be an integer from 1 to ${MAX_SEARCH_LIMIT}`);
    return [url.searchParams.get('q') ?? '', url.searchParams.get('workspace') || undefined, limit];
  }

  async function handleSaved(req: IncomingMessage, res: ServerResponse, url: URL): Promise<void> {
    const parts = url.pathname.split('/').slice(3);
    const method = req.method ?? 'GET';
    if (parts.length === 0) return sendJson(res, 200, saved.search(...searchParams(req, url)));
    if (parts.length !== 1 || !parts[0]) throw new HttpError(404, 'not_found');
    let id: string;
    try {
      id = decodeURIComponent(parts[0]);
    } catch {
      throw new HttpError(400, 'invalid saved board id');
    }
    if (method === 'GET') return sendJson(res, 200, saved.get(id));
    if (method !== 'DELETE') throw new HttpError(405, 'method_not_allowed');
    if (!saved.remove(id)) throw new HttpError(404, 'saved_not_found');
    return sendJson(res, 200, { ok: true });
  }

  function pickViewer(canvasId: string): Viewer | undefined {
    let best: Viewer | undefined;
    for (const v of viewersByCanvas.get(canvasId) ?? []) {
      if (v.ws.readyState !== WebSocket.OPEN) continue;
      if (!best || (v.visible && !best.visible) || (v.visible === best.visible && v.lastActive > best.lastActive)) best = v;
    }
    return best;
  }

  function relay(canvasId: string, type: ViewerRequestType, payload: unknown, timeoutMs: number, res: ServerResponse): Promise<void> {
    const viewer = pickViewer(canvasId);
    if (!viewer) return Promise.resolve(sendJson(res, 409, { error: 'no_viewer' }));
    const reqId = randomUUID();
    return new Promise((done) => {
      const finish = (status: number, body: unknown) => {
        if (!pending.delete(reqId)) return;
        clearTimeout(timer);
        res.off('close', onClientGone);
        sendJson(res, status, body);
        done();
      };
      const onClientGone = () => finish(499, { error: 'client_closed' });
      const timer = setTimeout(() => finish(504, { error: 'timeout' }), timeoutMs);
      res.once('close', onClientGone);
      pending.set(reqId, { viewer, finish });
      send(viewer, { t: 'request', reqId, type, payload });
    });
  }

  /**
   * The chat's own window (hostId equals the hint) wins. Otherwise a window whose folders contain the
   * board's workspace, focused first, then the most recent. While the hinted window may still connect
   * (`strict`), other identified windows are skipped; once it can't (a stale id after Reload Window),
   * the folder decides. No match means no host: a board never opens in a window of another folder.
   */
  function pickHost(workspace: string | undefined, hint: string | undefined, strict: boolean): Host | undefined {
    const rank = (h: Host): number => {
      if (hint !== undefined && h.hostId === hint) return 3;
      if (strict && hint !== undefined && h.hostId !== undefined) return 0;
      if (!workspace || !h.folders.some((f) => contains(f, workspace))) return 0;
      return h.focused ? 2 : 1;
    };
    let best: Host | undefined;
    let bestRank = 0;
    for (const h of hosts) {
      const r = h.ws.readyState === WebSocket.OPEN ? rank(h) : 0;
      if (r > bestRank || (r > 0 && r === bestRank && h.lastActive > best!.lastActive)) [best, bestRank] = [h, r];
    }
    return best;
  }

  /**
   * Right after the daemon starts (the agent's first call started it), the chat's window hasn't found it
   * yet: a show that names its window, or comes from an agent inside an editor (`wait`), waits briefly
   * for a host instead of answering no_host. A hinted show waits for its own window first.
   */
  function show(canvasId: string, workspace: string | undefined, hint: string | undefined, wait: boolean, res: ServerResponse): Promise<void> {
    const graceLeft = startedAt + hostGraceMs - Date.now();
    const waiting = graceLeft > 0 && (hint !== undefined || wait);
    const host = pickHost(workspace, hint, waiting);
    if (host) return showOn(host, canvasId, res);
    if (!waiting) return Promise.resolve(sendJson(res, 409, { error: 'no_host' }));
    return new Promise((done) => {
      const end = () => {
        hostWaits.delete(waiter);
        clearTimeout(timer);
        res.off('close', onClientGone);
      };
      const waiter: HostWait = {
        retry: () => {
          const found = pickHost(workspace, hint, true);
          if (!found) return;
          end();
          void showOn(found, canvasId, res).then(done);
        },
        finish: (status, body) => {
          end();
          sendJson(res, status, body);
          done();
        },
      };
      const onClientGone = () => {
        end();
        done();
      };
      const timer = setTimeout(() => {
        const fallback = pickHost(workspace, hint, false);
        if (!fallback) return waiter.finish(409, { error: 'no_host' });
        end();
        void showOn(fallback, canvasId, res).then(done);
      }, graceLeft);
      res.once('close', onClientGone);
      hostWaits.add(waiter);
    });
  }

  function showOn(host: Host, canvasId: string, res: ServerResponse): Promise<void> {
    const reqId = randomUUID();
    return new Promise((done) => {
      const finish = (status: number, body: unknown) => {
        if (!pendingShows.delete(reqId)) return;
        clearTimeout(timer);
        sendJson(res, status, body);
        done();
      };
      const timer = setTimeout(() => finish(504, { error: 'timeout' }), opts.showTimeoutMs ?? DEFAULT_SHOW_TIMEOUT_MS);
      pendingShows.set(reqId, { host, finish });
      const msg: ServerHostMessage = { t: 'show', reqId, canvasId, title: store.summaryOf(canvasId).title };
      host.ws.send(JSON.stringify(msg));
    });
  }

  async function handleApi(req: IncomingMessage, res: ServerResponse, url: URL): Promise<void> {
    const parts = url.pathname.split('/').slice(3);
    const method = req.method ?? 'GET';
    if (parts.length === 0 || (parts.length === 1 && parts[0] === '')) {
      if (method !== 'GET') throw new HttpError(405, 'method_not_allowed');
      return sendJson(res, 200, store.list().map((s) => ({ ...s, viewers: viewerCount(s.id) })));
    }
    let id: string;
    try {
      id = decodeURIComponent(parts[0]!);
    } catch {
      throw new HttpError(400, 'invalid canvas id');
    }
    const sub = parts.slice(1).join('/');
    const requireCanvas = () => {
      if (!store.has(id)) throw new HttpError(404, 'canvas_not_found');
    };
    const route = `${method} ${sub}`;
    switch (route) {
      case 'GET ':
        requireCanvas();
        return sendJson(res, 200, store.snapshot(id, viewerCount(id)));
      case 'PUT ': {
        const { title, workspace, chat } = await readJson(req);
        return sendJson(res, 200, { ...store.ensure(id, { title, workspace, chat } as CanvasMeta), viewers: viewerCount(id) });
      }
      case 'POST show': {
        const { workspace, host: hint, wait } = await readJson(req);
        if (workspace !== undefined && typeof workspace !== 'string') throw new HttpError(400, 'workspace must be a string');
        if (wait !== undefined && typeof wait !== 'boolean') throw new HttpError(400, 'wait must be a boolean');
        if (hint !== undefined && (typeof hint !== 'string' || !hint || hint.length > MAX_HOST_ID)) throw new HttpError(400, 'host must be a non-empty string');
        requireCanvas();
        return show(id, workspace as string | undefined, hint as string | undefined, wait === true, res);
      }
      case 'DELETE ':
        if (!store.remove(id)) throw new HttpError(404, 'canvas_not_found');
        return sendJson(res, 200, { ok: true });
      case 'POST elements': {
        const body = await readJson(req);
        return sendJson(res, 200, applyAndBroadcast(id, body.elements, parseActor(body.actor, 'agent'), body.files));
      }
      case 'POST clear': {
        const body = await readJson(req);
        requireCanvas();
        const actor = parseActor(body.actor, 'agent');
        return sendJson(res, 200, broadcastApplied(id, store.clear(id, actor), actor, undefined));
      }
      case 'POST save': {
        const { name } = await readJson(req);
        requireCanvas();
        return sendJson(res, 200, saveBoard(id, name));
      }
      case 'POST load': {
        const body = await readJson(req);
        if (typeof body.saved !== 'string' || !body.saved) throw new HttpError(400, 'saved must be a saved board id');
        requireCanvas();
        const board = saved.get(body.saved);
        const actor = parseActor(body.actor, 'agent');
        const files = Object.values(board.files);
        return sendJson(res, 200, broadcastApplied(id, store.replace(id, board.elements, actor, files), actor, files));
      }
      case 'GET changes': {
        const since = Number(url.searchParams.get('since') ?? 0);
        if (!Number.isInteger(since)) throw new HttpError(400, 'since must be an integer');
        requireCanvas();
        return sendJson(res, 200, store.changes(id, since));
      }
      case 'POST notes': {
        const { text } = await readJson(req);
        requireCanvas();
        const note = store.addNote(id, text);
        broadcast(id, { t: 'note', note });
        return sendJson(res, 200, note);
      }
      case 'POST request': {
        const body = await readJson(req);
        if (typeof body.type !== 'string' || !REQUEST_TYPES.has(body.type)) throw new HttpError(400, 'type must be one of screenshot, mermaid, focus');
        const timeoutMs = body.timeoutMs === undefined ? DEFAULT_REQUEST_TIMEOUT_MS : Number(body.timeoutMs);
        if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) throw new HttpError(400, 'timeoutMs must be a positive number');
        return relay(id, body.type as ViewerRequestType, body.payload, Math.min(timeoutMs, MAX_REQUEST_TIMEOUT_MS), res);
      }
    }
    if (['', 'elements', 'clear', 'changes', 'notes', 'request', 'show', 'save', 'load'].includes(sub)) throw new HttpError(405, 'method_not_allowed');
    throw new HttpError(404, 'not_found');
  }

  async function serveStatic(req: IncomingMessage, res: ServerResponse, url: URL): Promise<void> {
    if (req.method !== 'GET' && req.method !== 'HEAD') return sendText(res, 405, 'method not allowed');
    const legacy = LEGACY_VIEWER.exec(url.pathname);
    if (legacy) return redirectLegacyViewer(res, url, legacy);
    const viewer = parseViewerPath(url.pathname);
    if (viewer && !CANVAS_ID_PATTERN.test(viewer.canvasId)) return sendText(res, 404, 'not found');
    const path = viewer ? `/${viewer.rest}` : url.pathname;
    const isViewer = viewer?.rest === '';
    let file: string;
    if (isViewer) {
      file = join(frontendDir, 'index.html');
    } else {
      let rel: string;
      try {
        rel = decodeURIComponent(path);
      } catch {
        return sendText(res, 400, 'bad path');
      }
      file = resolve(frontendDir, `.${rel}`);
      if (rel.includes('\0') || !file.startsWith(frontendDir + sep)) return sendText(res, 404, 'not found');
    }
    let real: string;
    try {
      real = realpathSync(file);
      if (!statSync(real).isFile() || !real.startsWith(realpathSync(frontendDir) + sep)) throw new Error('outside');
    } catch {
      return isViewer ? sendText(res, 503, 'frontend not built') : sendText(res, 404, 'not found');
    }
    const content = await readFile(real);
    // The page can't always read its board from its own URL (a proxy may mount it at '/'), so it's told here.
    const data = viewer && isViewer ? Buffer.from(content.toString('utf8').replace('<head>', `<head><meta name="whiteboard-canvas" content="${viewer.canvasId}">`)) : content;
    if (res.destroyed) return;
    res.writeHead(200, {
      'Content-Type': MIME[extname(real).toLowerCase()] ?? 'application/octet-stream',
      'Content-Length': data.length,
      'Cache-Control': path.startsWith('/assets/') ? 'public, max-age=31536000, immutable' : 'no-store',
      'X-Content-Type-Options': 'nosniff',
      // The viewer URL carries the token in its query string.
      'Referrer-Policy': 'no-referrer',
    });
    res.end(req.method === 'HEAD' ? undefined : data);
  }

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    lastActivityAt = Date.now();
    if (!allowedHosts.has(req.headers.host ?? '')) return sendJson(res, 403, { error: 'forbidden_host' });
    const url = new URL(req.url ?? '/', 'http://localhost');
    if (url.pathname === '/health') {
      if (req.method !== 'GET') throw new HttpError(405, 'method_not_allowed');
      return sendJson(res, 200, { ok: true, app: APP_NAME, version: VERSION, pid: process.pid });
    }
    if (url.pathname === '/api' || url.pathname.startsWith('/api/')) {
      if (!authorized(req, url)) return sendJson(res, 401, { error: 'unauthorized' });
      if (url.pathname === '/api/saved' || url.pathname.startsWith('/api/saved/')) return handleSaved(req, res, url);
      if (url.pathname === '/api/search') return sendJson(res, 200, store.search(...searchParams(req, url)));
      if (url.pathname !== '/api/canvases' && !url.pathname.startsWith('/api/canvases/')) throw new HttpError(404, 'not_found');
      return handleApi(req, res, url);
    }
    if (url.pathname === '/ws' || url.pathname === API.hostWs) return sendText(res, 426, 'upgrade required');
    return serveStatic(req, res, url);
  }

  function onRequest(req: IncomingMessage, res: ServerResponse): void {
    handle(req, res).catch((err: unknown) => {
      if (err instanceof HttpError || err instanceof ValidationError) {
        sendJson(res, err.status, { error: err.message });
      } else if (err instanceof NotFoundError) {
        sendJson(res, 404, { error: err.message });
      } else {
        log(`request ${req.method} ${req.url?.split('?')[0]} failed: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}`);
        sendJson(res, 500, { error: 'internal_error' });
      }
    });
  }

  function onMessage(viewer: Viewer, data: RawData): void {
    viewer.lastActive = ++activitySeq;
    let msg: unknown;
    try {
      msg = JSON.parse(data.toString());
    } catch {
      return send(viewer, { t: 'error', message: 'invalid JSON' });
    }
    if (!isObject(msg)) return send(viewer, { t: 'error', message: 'message must be an object' });
    try {
      switch (msg.t) {
        case 'elements':
          applyAndBroadcast(viewer.canvasId, msg.elements, parseActor(msg.actor, 'human'), msg.files, viewer);
          return;
        case 'response': {
          const entry = typeof msg.reqId === 'string' ? pending.get(msg.reqId) : undefined;
          if (entry?.viewer !== viewer) return;
          if (msg.ok === true) entry.finish(200, { result: msg.result });
          else entry.finish(502, { error: typeof msg.error === 'string' && msg.error ? msg.error : 'viewer_error' });
          return;
        }
        case 'note': {
          store.ensure(viewer.canvasId);
          broadcast(viewer.canvasId, { t: 'note', note: store.addNote(viewer.canvasId, msg.text) });
          return;
        }
        case 'save': {
          // The viewer waits for this answer, so every failure gets one too.
          try {
            return send(viewer, { t: 'saved', ok: true, saved: saveBoard(viewer.canvasId, msg.name) });
          } catch (err) {
            const known = err instanceof ValidationError;
            if (!known) log(`save failed: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}`);
            return send(viewer, { t: 'saved', ok: false, error: known ? err.message : 'internal_error' });
          }
        }
        case 'visible':
          if (typeof msg.visible !== 'boolean') throw new ValidationError('visible must be a boolean');
          viewer.visible = msg.visible;
          return;
        default:
          throw new ValidationError(`unknown message type ${JSON.stringify(msg.t)}`);
      }
    } catch (err) {
      if (!(err instanceof ValidationError || err instanceof NotFoundError)) log(`ws message failed: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}`);
      send(viewer, { t: 'error', message: err instanceof ValidationError || err instanceof NotFoundError ? err.message : 'internal_error' });
    }
  }

  function onHostMessage(host: Host, data: RawData): void {
    host.lastActive = ++activitySeq;
    let msg: unknown;
    try {
      msg = JSON.parse(data.toString());
    } catch {
      return;
    }
    if (!isObject(msg)) return;
    if (msg.t === 'hello' || msg.t === 'state') {
      if (Array.isArray(msg.folders)) {
        host.folders = msg.folders.filter((f): f is string => typeof f === 'string' && isAbsolute(f) && f.length <= 4096).slice(0, MAX_HOST_FOLDERS);
      }
      if (typeof msg.focused === 'boolean') host.focused = msg.focused;
      if (msg.t === 'hello' && typeof msg.hostId === 'string' && msg.hostId && msg.hostId.length <= MAX_HOST_ID) host.hostId = msg.hostId;
      for (const wait of [...hostWaits]) wait.retry();
    } else if (msg.t === 'shown' && typeof msg.reqId === 'string') {
      const entry = pendingShows.get(msg.reqId);
      if (entry?.host !== host) return;
      if (msg.ok === true) entry.finish(200, { shown: true });
      else entry.finish(502, { error: typeof msg.error === 'string' && msg.error ? msg.error : 'host_error' });
    }
  }

  function onHost(ws: WebSocket): void {
    const host: Host = { ws, folders: [], focused: false, lastActive: ++activitySeq, alive: true };
    hosts.add(host);
    ws.on('pong', () => {
      host.alive = true;
    });
    ws.on('message', (data) => onHostMessage(host, data));
    ws.on('error', (err) => log(`host ws error: ${err.message}`));
    ws.on('close', () => {
      hosts.delete(host);
      for (const entry of [...pendingShows.values()]) if (entry.host === host) entry.finish(502, { error: 'host_disconnected' });
    });
  }

  function onConnection(ws: WebSocket, canvasId: string): void {
    const viewer: Viewer = { ws, canvasId, visible: false, lastActive: ++activitySeq, alive: true };
    let viewers = viewersByCanvas.get(canvasId);
    if (!viewers) viewersByCanvas.set(canvasId, (viewers = new Set()));
    viewers.add(viewer);
    ws.on('pong', () => {
      viewer.alive = true;
    });
    ws.on('message', (data) => onMessage(viewer, data));
    ws.on('error', (err) => log(`ws error: ${err.message}`));
    ws.on('close', () => {
      const set = viewersByCanvas.get(canvasId);
      set?.delete(viewer);
      if (set?.size === 0) viewersByCanvas.delete(canvasId);
      lastActivityAt = Date.now();
      for (const entry of [...pending.values()]) if (entry.viewer === viewer) entry.finish(502, { error: 'viewer_disconnected' });
      broadcast(canvasId, { t: 'viewers', count: viewerCount(canvasId) });
    });
    try {
      store.ensure(canvasId);
      send(viewer, { t: 'snapshot', canvas: store.snapshot(canvasId, viewers.size) });
    } catch (err) {
      log(`snapshot failed: ${String(err)}`);
      return void ws.close(1011, 'snapshot failed');
    }
    broadcast(canvasId, { t: 'viewers', count: viewers.size });
  }

  const wss = new WebSocketServer({ noServer: true, maxPayload: MAX_BODY_BYTES });
  const server = createServer(onRequest);
  server.on('upgrade', (req: IncomingMessage, socket: Duplex, head: Buffer) => {
    socket.on('error', () => socket.destroy());
    lastActivityAt = Date.now();
    const url = new URL(req.url ?? '/', 'http://localhost');
    if (closing) return rejectUpgrade(socket, 503);
    const viewerPath = parseViewerPath(url.pathname);
    const viewerWs = viewerPath?.rest === 'ws' ? viewerPath : undefined;
    if (url.pathname !== '/ws' && url.pathname !== API.hostWs && !viewerWs) return rejectUpgrade(socket, 404);
    if (!allowedHosts.has(req.headers.host ?? '')) return rejectUpgrade(socket, 403);
    if (req.headers.origin !== undefined && !isLoopbackOrigin(req.headers.origin)) return rejectUpgrade(socket, 403);
    if (!(viewerWs ? tokenMatches(viewerWs.token) : authorized(req, url))) return rejectUpgrade(socket, 401);
    if (url.pathname === API.hostWs) return wss.handleUpgrade(req, socket, head, onHost);
    const canvasId = viewerWs?.canvasId ?? url.searchParams.get('canvas') ?? '';
    if (!CANVAS_ID_PATTERN.test(canvasId)) return rejectUpgrade(socket, 400);
    wss.handleUpgrade(req, socket, head, (ws) => onConnection(ws, canvasId));
  });

  await new Promise<void>((resolveListen, reject) => {
    server.once('error', reject);
    server.listen(opts.port ?? 0, host, () => {
      server.off('error', reject);
      resolveListen();
    });
  }).catch((err: unknown) => {
    store.close();
    throw err;
  });
  server.on('error', (err) => log(`server error: ${err.message}`));
  const port = (server.address() as AddressInfo).port;
  allowedHosts = new Set([`127.0.0.1:${port}`, `localhost:${port}`]);

  const every = (ms: number, fn: () => void) => {
    const t = setInterval(fn, ms);
    t.unref();
    timers.push(t);
  };
  every(heartbeatMs, () => {
    const peers: Array<Viewer | Host> = [...hosts];
    for (const viewers of viewersByCanvas.values()) peers.push(...viewers);
    for (const peer of peers) {
      if (!peer.alive) {
        peer.ws.terminate();
        continue;
      }
      peer.alive = false;
      peer.ws.ping();
    }
  });
  every(UNLOAD_INTERVAL_MS, () => store.unloadIdle((id) => viewersByCanvas.has(id), UNLOAD_IDLE_MS));
  if (idleExitMs > 0 && opts.onIdle) {
    const onIdle = opts.onIdle;
    let fired = false;
    every(Math.min(Math.max(idleExitMs / 4, 25), 30_000), () => {
      // Panel hosts stay connected for the whole IDE session; only viewers and requests keep the daemon alive.
      if (fired || closing || viewersByCanvas.size > 0 || Date.now() - lastActivityAt < idleExitMs) return;
      fired = true;
      onIdle();
    });
  }

  function close(): Promise<void> {
    closing ??= (async () => {
      for (const t of timers) clearInterval(t);
      for (const entry of [...pending.values()]) entry.finish(503, { error: 'shutting_down' });
      for (const entry of [...pendingShows.values()]) entry.finish(503, { error: 'shutting_down' });
      for (const wait of [...hostWaits]) wait.finish(503, { error: 'shutting_down' });
      const closed = [new Promise<void>((r) => server.close(() => r()))];
      for (const ws of wss.clients) {
        closed.push(new Promise((r) => ws.once('close', r)));
        ws.terminate();
      }
      wss.close();
      server.closeAllConnections();
      await Promise.all(closed);
      store.close();
    })();
    return closing;
  }

  return {
    port,
    token,
    url: `http://127.0.0.1:${port}`,
    close,
    stats: () => {
      let viewers = 0;
      for (const set of viewersByCanvas.values()) viewers += set.size;
      return { viewers, hosts: hosts.size, pending: pending.size + pendingShows.size + hostWaits.size, loadedCanvases: store.loadedCount, sockets: wss.clients.size };
    },
  };
}

function createLogger(file: string): (line: string) => void {
  const limit = 1024 * 1024;
  let size = 0;
  try {
    size = statSync(file).size;
  } catch {
    // no log yet
  }
  return (line) => {
    try {
      if (size > limit) {
        writeFileSync(file, '', { mode: 0o600 });
        size = 0;
      }
      const entry = `${new Date().toISOString()} [${process.pid}] ${line}\n`;
      appendFileSync(file, entry, { mode: 0o600 });
      size += Buffer.byteLength(entry);
    } catch {
      // logging must never take the daemon down
    }
  };
}

function readPid(file: string): number | undefined {
  const raw = readFileSafe(file).trim();
  const parsed = safeJson(raw);
  const pid = Number(isObject(parsed) ? parsed.pid : raw);
  return raw && Number.isInteger(pid) && pid > 0 ? pid : undefined;
}

function ageMs(file: string): number {
  try {
    return Date.now() - statSync(file).mtimeMs;
  } catch {
    return Infinity;
  }
}

function safeJson(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    return undefined;
  }
}

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}

async function healthyAt(port: number): Promise<{ pid: number } | undefined> {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(1000) });
    const body = (await res.json()) as { app?: unknown; pid?: unknown };
    return res.ok && body.app === APP_NAME && typeof body.pid === 'number' ? { pid: body.pid } : undefined;
  } catch {
    return undefined;
  }
}

function tryLock(file: string): boolean {
  try {
    const fd = openSync(file, 'wx', 0o600);
    writeSync(fd, String(process.pid));
    closeSync(fd);
    return true;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
    return false;
  }
}

function removeIfOurs(file: string): void {
  if (readPid(file) !== process.pid) return;
  try {
    unlinkSync(file);
  } catch {
    // already gone
  }
}

function loadToken(file: string): string {
  try {
    const existing = readFileSync(file, 'utf8').trim();
    if (/^[0-9a-f]{64}$/.test(existing)) return existing;
  } catch {
    // create below
  }
  const token = randomBytes(32).toString('hex');
  writeFileSync(file, token, { mode: 0o600 });
  chmodSync(file, 0o600); // `mode` only applies when the file is created
  return token;
}

/** Entry point for `whiteboard-mcp serve`: one detached daemon per state dir. */
export async function runDaemon(): Promise<void> {
  const dir = stateDir();
  const log = createLogger(statePath('daemon.log', dir));
  const lockFile = statePath('daemon.lock', dir);
  const infoFile = statePath('daemon.json', dir);
  const knownPort = () => {
    const info = safeJson(readFileSafe(infoFile)) as Partial<DaemonInfo> | undefined;
    return typeof info?.port === 'number' ? info.port : preferredPort();
  };

  const lockDeadline = Date.now() + 5000;
  while (!tryLock(lockFile)) {
    const owner = readPid(lockFile);
    const ownerAlive = owner !== undefined && owner !== process.pid && pidAlive(owner);
    if (ownerAlive && (await healthyAt(knownPort()))?.pid === owner) {
      log(`daemon ${owner} already running`);
      process.exit(0);
    }
    // An empty lock is being written right now; a live but silent owner may still be starting
    // (after the deadline assume its pid was reused).
    const stale = owner === undefined ? ageMs(lockFile) > 2000 : !ownerAlive || Date.now() >= lockDeadline;
    if (!stale) {
      await new Promise((r) => setTimeout(r, 100));
      continue;
    }
    // Re-check right before removal to keep the takeover race window tiny.
    if (readPid(lockFile) === owner) {
      try {
        unlinkSync(lockFile);
      } catch {
        // someone else removed it
      }
    }
  }

  const token = loadToken(statePath('token', dir));
  let daemon: Daemon | undefined;
  let shuttingDown = false;
  const shutdown = async (reason: string, code = 0) => {
    if (shuttingDown) return;
    shuttingDown = true;
    log(`shutting down (${reason})`);
    setTimeout(() => process.exit(code), 5000).unref();
    try {
      await daemon?.close();
    } catch (err) {
      log(`close failed: ${String(err)}`);
    }
    removeIfOurs(infoFile);
    removeIfOurs(lockFile);
    process.exit(code);
  };
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGHUP', () => void shutdown('SIGHUP'));
  process.on('uncaughtException', (err) => {
    log(`uncaught: ${err.stack ?? err.message}`);
    void shutdown('uncaughtException', 1);
  });
  process.on('unhandledRejection', (err) => log(`unhandled rejection: ${String(err)}`));

  const options: DaemonOptions = { dir, token, log, onIdle: () => void shutdown('idle') };
  const port = preferredPort();
  const giveUp = (msg: string, code: number): never => {
    log(msg);
    removeIfOurs(lockFile);
    process.exit(code);
  };
  try {
    daemon = await startDaemon({ ...options, port });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'EADDRINUSE') giveUp(`listen failed: ${String(err)}`, 1);
    if (await healthyAt(port)) giveUp(`port ${port} already serves ${APP_NAME}`, 0);
    log(`port ${port} is taken by another program; using a random port`);
    daemon = await startDaemon({ ...options, port: 0 }).catch((e: unknown) => giveUp(`listen failed: ${String(e)}`, 1));
  }

  const info: DaemonInfo = { pid: process.pid, port: daemon.port, startedAt: Date.now(), version: VERSION };
  const tmp = `${infoFile}.tmp-${process.pid}`;
  writeFileSync(tmp, JSON.stringify(info), { mode: 0o600 });
  renameSync(tmp, infoFile);
  log(`listening on ${daemon.url} (v${VERSION})`);
}

function readFileSafe(file: string): string {
  try {
    return readFileSync(file, 'utf8');
  } catch {
    return '';
  }
}
