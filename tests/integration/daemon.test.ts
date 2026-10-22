import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { request as httpRequest } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { removeTempDir } from '../helpers/cleanup.js';
import WebSocket from 'ws';
import { startDaemon, type Daemon, type DaemonOptions } from '../../src/canvas/daemon.js';
import type { ExElement, ServerMessage } from '../../src/shared/protocol.js';

let root: string;
let frontendDir: string;
const daemons: Daemon[] = [];
const sockets: WebSocket[] = [];

function el(id: string, over: Partial<ExElement> = {}): ExElement {
  return { id, type: 'rectangle', x: 0, y: 0, width: 10, height: 10, version: 1, versionNonce: 1, isDeleted: false, updated: 1, ...over };
}

async function start(opts: Partial<DaemonOptions> = {}): Promise<Daemon> {
  // Hinted shows answer at once unless a test is about a fresh daemon's grace period for hosts.
  const d = await startDaemon({ port: 0, dir: join(root, 'state'), frontendDir, hostGraceMs: 0, ...opts });
  daemons.push(d);
  return d;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function until(check: () => boolean, timeoutMs = 3000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!check()) {
    if (Date.now() > deadline) throw new Error('condition not met in time');
    await sleep(10);
  }
}

function api(d: Daemon, path: string, init: { method?: string; body?: unknown; token?: string | null } = {}) {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  const token = init.token === undefined ? d.token : init.token;
  if (token !== null) headers.Authorization = `Bearer ${token}`;
  return fetch(`${d.url}${path}`, {
    method: init.method ?? (init.body === undefined ? 'GET' : 'POST'),
    headers,
    body: init.body === undefined ? undefined : typeof init.body === 'string' ? init.body : JSON.stringify(init.body),
  });
}

async function apiJson<T = any>(d: Daemon, path: string, init: Parameters<typeof api>[2] = {}): Promise<{ status: number; body: T }> {
  const res = await api(d, path, init);
  return { status: res.status, body: (await res.json()) as T };
}

/** Raw request so we control Host and an un-normalized path. */
function raw(d: Daemon, path: string, headers: Record<string, string> = {}): Promise<{ status: number; headers: Record<string, unknown>; body: string }> {
  return new Promise((resolve, reject) => {
    const req = httpRequest({ host: '127.0.0.1', port: d.port, path, headers }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (c) => (body += c));
      res.on('end', () => resolve({ status: res.statusCode!, headers: res.headers, body }));
    });
    req.on('error', reject);
    req.end();
  });
}

interface Viewer {
  ws: WebSocket;
  take<T extends ServerMessage['t']>(t: T, match?: (m: Extract<ServerMessage, { t: T }>) => boolean, timeoutMs?: number): Promise<Extract<ServerMessage, { t: T }>>;
  send(msg: unknown): void;
}

async function viewer(d: Daemon, canvas: string, opts: WebSocket.ClientOptions = {}): Promise<Viewer> {
  const ws = new WebSocket(`ws://127.0.0.1:${d.port}/ws?canvas=${canvas}&token=${d.token}`, opts);
  sockets.push(ws);
  const inbox: ServerMessage[] = [];
  const waiters = new Set<() => void>();
  ws.on('message', (data) => {
    inbox.push(JSON.parse(String(data)) as ServerMessage);
    for (const w of [...waiters]) w();
  });
  await new Promise((resolve, reject) => {
    ws.once('open', resolve);
    ws.once('error', reject);
  });
  return {
    ws,
    send: (msg) => ws.send(JSON.stringify(msg)),
    take: (t, match = () => true, timeoutMs = 2000) =>
      new Promise((resolve, reject) => {
        const check = () => {
          const i = inbox.findIndex((m) => m.t === t && match(m as never));
          if (i < 0) return;
          waiters.delete(check);
          clearTimeout(timer);
          resolve(inbox.splice(i, 1)[0] as never);
        };
        const timer = setTimeout(() => {
          waiters.delete(check);
          reject(new Error(`no ${t} message; inbox: ${JSON.stringify(inbox).slice(0, 500)}`));
        }, timeoutMs);
        waiters.add(check);
        check();
      }),
  };
}

function wsStatus(d: Daemon, query: string, opts: WebSocket.ClientOptions = {}): Promise<string> {
  return new Promise((resolve) => {
    const ws = new WebSocket(`ws://127.0.0.1:${d.port}/ws?${query}`, opts);
    sockets.push(ws);
    ws.once('open', () => resolve('open'));
    ws.once('error', (err) => resolve(err.message));
  });
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'exl-daemon-'));
  frontendDir = join(root, 'frontend');
  mkdirSync(join(frontendDir, 'assets'), { recursive: true });
  mkdirSync(join(frontendDir, 'fonts'), { recursive: true });
  writeFileSync(join(frontendDir, 'index.html'), '<!doctype html><div id="root"></div>');
  writeFileSync(join(frontendDir, 'assets', 'app.js'), 'console.log(1)');
  writeFileSync(join(frontendDir, 'fonts', 'f.woff2'), 'woff');
  writeFileSync(join(root, 'secret.txt'), 'top secret');
});

afterEach(async () => {
  for (const ws of sockets.splice(0)) ws.terminate();
  await Promise.all(daemons.splice(0).map((d) => d.close()));
  removeTempDir(root);
});

describe('http security', () => {
  it('leaves /health open but requires the token on /api', async () => {
    const d = await start();
    const health = await apiJson(d, '/health', { token: null });
    expect(health).toEqual({ status: 200, body: { ok: true, app: 'whiteboard-mcp', version: expect.any(String), pid: process.pid } });
    expect((await api(d, '/api/canvases', { token: null })).status).toBe(401);
    expect((await api(d, '/api/canvases', { token: 'x'.repeat(64) })).status).toBe(401);
    expect((await api(d, '/api/canvases', { token: d.token.slice(1) })).status).toBe(401);
    expect((await api(d, '/api/canvases')).status).toBe(200);
    expect((await fetch(`${d.url}/api/canvases?token=${d.token}`)).status).toBe(200);
    expect((await fetch(`${d.url}/api/canvases?token=nope`)).status).toBe(401);
  });

  it('rejects foreign Host headers (DNS rebinding) and sends no CORS headers', async () => {
    const d = await start();
    expect((await raw(d, '/health', { Host: `evil.example:${d.port}` })).status).toBe(403);
    expect((await raw(d, `/api/canvases?token=${d.token}`, { Host: 'evil.example' })).status).toBe(403);
    expect((await raw(d, '/c/x', { Host: `127.0.0.1:${d.port + 1}` })).status).toBe(403);
    const ok = await raw(d, '/health', { Host: `localhost:${d.port}`, Origin: 'http://evil.example' });
    expect(ok.status).toBe(200);
    expect(Object.keys(ok.headers).filter((h) => h.startsWith('access-control'))).toEqual([]);
  });

  it('checks token, Host and Origin on WebSocket upgrades', async () => {
    const d = await start();
    expect(await wsStatus(d, `canvas=c1&token=${d.token}`, { origin: 'http://evil.example' })).toMatch(/403/);
    expect(await wsStatus(d, `canvas=c1&token=${d.token}`, { origin: `http://127.0.0.1:${d.port + 1}` })).toMatch(/403/);
    expect(await wsStatus(d, `canvas=c1&token=${d.token}`, { headers: { Host: `evil.example:${d.port}` } })).toMatch(/403/);
    expect(await wsStatus(d, 'canvas=c1&token=wrong')).toMatch(/401/);
    expect(await wsStatus(d, `canvas=Bad..Id&token=${d.token}`)).toMatch(/400/);
    expect(await wsStatus(d, `canvas=c1&token=${d.token}`, { origin: `http://localhost:${d.port}` })).toBe('open');
    expect(await wsStatus(d, `canvas=c1&token=${d.token}`)).toBe('open');
  });
});

describe('rest api', () => {
  it('creates, lists, snapshots, records changes and deletes canvases', async () => {
    const d = await start();
    expect(await apiJson(d, '/api/canvases/demo', { method: 'PUT', body: { title: 'Demo' } })).toMatchObject({ status: 200, body: { id: 'demo', title: 'Demo', elementCount: 0 } });
    expect(await apiJson(d, '/api/canvases/demo/elements', { body: { elements: [el('a'), el('b')] } })).toEqual({ status: 200, body: { rev: 1, applied: ['a', 'b'], stale: [] } });
    expect((await apiJson(d, '/api/canvases/demo/elements', { body: { elements: [el('a')] } })).body).toEqual({ rev: 1, applied: [], stale: ['a'] });
    expect((await apiJson(d, '/api/canvases/demo/notes', { body: { text: 'hi' } })).body).toMatchObject({ text: 'hi', rev: 2 });
    expect((await apiJson(d, '/api/canvases/demo/changes?since=0')).body).toMatchObject({ rev: 2, full: false, changes: [{ id: 'a', kind: 'created', actor: 'agent' }, { id: 'b' }], notes: [{ text: 'hi' }] });
    expect((await apiJson(d, '/api/canvases')).body).toEqual([{ id: 'demo', title: 'Demo', elementCount: 2, updatedAt: expect.any(Number), viewers: 0 }]);
    expect((await apiJson(d, '/api/canvases/demo/clear', { body: {} })).body).toEqual({ rev: 3, applied: ['a', 'b'], stale: [] });
    expect((await apiJson(d, '/api/canvases/demo')).body).toMatchObject({ id: 'demo', rev: 3, elements: [], viewers: 0 });
    expect((await api(d, '/api/canvases/demo', { method: 'DELETE' })).status).toBe(200);
    expect((await api(d, '/api/canvases/demo')).status).toBe(404);
    expect((await api(d, '/api/canvases/demo', { method: 'DELETE' })).status).toBe(404);
  });

  it('maps bad input to 400/404/405 with an error body', async () => {
    const d = await start();
    expect(await apiJson(d, '/api/canvases/c1/elements', { body: '{nope' })).toEqual({ status: 400, body: { error: 'invalid_json' } });
    expect((await apiJson(d, '/api/canvases/c1/elements', { body: { elements: [{ id: 'a' }] } })).status).toBe(400);
    expect((await apiJson(d, '/api/canvases/c1/elements', { body: { elements: [el('a')], actor: 'robot' } })).status).toBe(400);
    expect((await apiJson(d, '/api/canvases/Bad_Id/elements', { body: { elements: [] } })).status).toBe(400);
    expect((await apiJson(d, '/api/canvases/missing')).status).toBe(404);
    expect((await apiJson(d, '/api/canvases/missing/changes?since=0')).status).toBe(404);
    expect((await apiJson(d, '/api/canvases/missing/notes', { body: { text: 'x' } })).status).toBe(404);
    await api(d, '/api/canvases/c1', { method: 'PUT', body: {} });
    expect((await apiJson(d, '/api/canvases/c1/changes?since=abc')).status).toBe(400);
    expect((await apiJson(d, '/api/canvases/c1/notes', { body: { text: '  ' } })).status).toBe(400);
    expect((await apiJson(d, '/api/canvases/c1/elements')).status).toBe(405);
    expect((await apiJson(d, '/api/canvases', { method: 'POST', body: {} })).status).toBe(405);
    expect((await apiJson(d, '/api/canvases/c1/request', { body: { type: 'hack' } })).status).toBe(400);
    expect((await apiJson(d, '/api/canvases/c1/nope')).status).toBe(404);
  });

  it('does not create a canvas for a rejected apply', async () => {
    const d = await start();
    expect((await apiJson(d, '/api/canvases/ghost/elements', { body: { elements: [{ id: 'a' }] } })).status).toBe(400);
    expect((await api(d, '/api/canvases/ghost')).status).toBe(404);
    expect((await apiJson(d, '/api/canvases')).body).toEqual([]);
  });

  it('answers 413 for bodies over 30MB, with or without Content-Length', async () => {
    const d = await start();
    const big = 'x'.repeat(31 * 1024 * 1024);
    expect((await api(d, '/api/canvases/c1/elements', { body: big })).status).toBe(413);
    const status = await new Promise<number>((resolve, reject) => {
      const req = httpRequest({ host: '127.0.0.1', port: d.port, path: '/api/canvases/c1/elements', method: 'POST', headers: { Authorization: `Bearer ${d.token}`, 'Transfer-Encoding': 'chunked' } }, (res) => {
        res.resume();
        resolve(res.statusCode!);
      });
      req.on('error', reject);
      const chunk = Buffer.alloc(1024 * 1024, 120);
      let sent = 0;
      const pump = () => {
        while (sent < 40 && req.write(chunk)) sent++;
        if (sent < 40) req.once('drain', () => (sent++, pump()));
        else req.end();
      };
      pump();
    }).catch(() => -1);
    expect(status).toBe(413);
    expect((await api(d, '/api/canvases/c1')).status).toBe(404);
  });
});

describe('static frontend', () => {
  it('serves the viewer shell and assets with the right headers', async () => {
    const d = await start();
    const page = await fetch(`${d.url}/c/anything`);
    expect(page.status).toBe(200);
    expect(page.headers.get('content-type')).toMatch(/^text\/html/);
    expect(page.headers.get('cache-control')).toBe('no-store');
    expect(await page.text()).toContain('id="root"');
    const js = await fetch(`${d.url}/assets/app.js`);
    expect(js.headers.get('content-type')).toMatch(/^text\/javascript/);
    expect(js.headers.get('cache-control')).toBe('public, max-age=31536000, immutable');
    expect(page.headers.get('referrer-policy')).toBe('no-referrer');
    expect((await fetch(`${d.url}/fonts/f.woff2`)).headers.get('content-type')).toBe('font/woff2');
    expect((await fetch(`${d.url}/fonts/f.woff2`)).headers.get('cache-control')).toBe('no-store');
    expect((await fetch(`${d.url}/assets/missing.js`)).status).toBe(404);
    const types: Record<string, string> = { 'a.css': 'text/css', 'a.svg': 'image/svg+xml', 'a.png': 'image/png', 'a.json': 'application/json', 'a.wasm': 'application/wasm', 'a.ttf': 'font/ttf', 'a.html': 'text/html' };
    for (const name of Object.keys(types)) writeFileSync(join(frontendDir, 'assets', name), 'x');
    for (const [name, type] of Object.entries(types)) expect((await fetch(`${d.url}/assets/${name}`)).headers.get('content-type')?.startsWith(type), name).toBe(true);
    const head = await fetch(`${d.url}/assets/app.js`, { method: 'HEAD' });
    expect([head.status, await head.text()]).toEqual([200, '']);
    expect((await fetch(`${d.url}/assets/app.js`, { method: 'POST' })).status).toBe(405);
  });

  it('blocks path traversal', async () => {
    const d = await start();
    for (const path of ['/../secret.txt', '/assets/..%2f..%2fsecret.txt', '/%2e%2e/secret.txt', '/assets/%2e%2e%2f%2e%2e%2fsecret.txt', '/..%5csecret.txt', '/assets/%00.js']) {
      const res = await raw(d, path, { Host: `127.0.0.1:${d.port}` });
      expect(res.status, path).not.toBe(200);
      expect(res.body).not.toContain('top secret');
    }
  });

  it('answers 503 when the frontend is not built', async () => {
    const d = await start({ frontendDir: join(root, 'nowhere') });
    const res = await fetch(`${d.url}/c/x`);
    expect(res.status).toBe(503);
    expect(await res.text()).toBe('frontend not built');
  });
});

describe('websocket hub', () => {
  it('sends a snapshot on connect and broadcasts viewer counts', async () => {
    const d = await start();
    await api(d, '/api/canvases/c1/elements', { body: { elements: [el('a'), el('gone', { isDeleted: true })] } });
    const a = await viewer(d, 'c1');
    const snap = await a.take('snapshot');
    expect(snap.canvas).toMatchObject({ id: 'c1', rev: 1, viewers: 1 });
    expect(snap.canvas.elements.map((e) => e.id)).toEqual(['a']);
    await a.take('viewers', (m) => m.count === 1);
    const b = await viewer(d, 'c1');
    await a.take('viewers', (m) => m.count === 2);
    expect((await b.take('snapshot')).canvas.viewers).toBe(2);
    b.ws.close();
    await a.take('viewers', (m) => m.count === 1);
    // connecting creates the canvas
    await viewer(d, 'fresh');
    expect((await api(d, '/api/canvases/fresh')).status).toBe(200);
  });

  it('relays viewer edits to the other viewers of the same canvas only', async () => {
    const d = await start();
    const a = await viewer(d, 'c1');
    const b = await viewer(d, 'c1');
    const other = await viewer(d, 'c2');
    a.send({ t: 'elements', elements: [el('x', { x: 5 })] });
    const got = await b.take('elements');
    expect(got).toEqual({ t: 'elements', rev: 1, actor: 'human', elements: [el('x', { x: 5 })] });
    // A REST edit reaches everyone; the sender's first `elements` message must be this one, not an echo of its own edit.
    await api(d, '/api/canvases/c1/elements', { body: { elements: [el('y')] } });
    expect(await a.take('elements')).toMatchObject({ rev: 2, actor: 'agent', elements: [{ id: 'y' }] });
    expect(await b.take('elements')).toMatchObject({ rev: 2, actor: 'agent' });
    await api(d, '/api/canvases/c2/elements', { body: { elements: [el('z')] } });
    expect(await other.take('elements')).toMatchObject({ rev: 1, elements: [{ id: 'z' }] });
    expect((await apiJson(d, '/api/canvases/c1/changes?since=0')).body.changes.map((c: { actor: string }) => c.actor)).toEqual(['human', 'agent']);
  });

  it('honours an explicit viewer actor (mermaid output is the agent\'s) and rejects unknown actors', async () => {
    const d = await start();
    const a = await viewer(d, 'c1');
    const b = await viewer(d, 'c1');
    a.send({ t: 'elements', elements: [el('m')], actor: 'agent' });
    expect(await b.take('elements')).toMatchObject({ actor: 'agent', elements: [{ id: 'm' }] });
    a.send({ t: 'elements', elements: [el('r')], actor: 'robot' });
    expect((await a.take('error')).message).toMatch(/actor/);
    expect((await apiJson(d, '/api/canvases/c1/changes?since=0')).body.changes).toEqual([{ rev: 1, actor: 'agent', id: 'm', kind: 'created' }]);
  });

  it('broadcasts only applied elements, files and clears; drops stale edits', async () => {
    const d = await start();
    const a = await viewer(d, 'c1');
    const file = { id: 'f1', mimeType: 'image/png', dataURL: 'data:image/png;base64,AA', created: 1 };
    await api(d, '/api/canvases/c1/elements', { body: { elements: [el('img', { type: 'image', fileId: 'f1', version: 3 }), el('b')], files: [file] } });
    expect(await a.take('elements')).toMatchObject({ rev: 1, files: [file], elements: [{ id: 'img' }, { id: 'b' }] });
    await api(d, '/api/canvases/c1/elements', { body: { elements: [el('img', { version: 2 }), el('b', { version: 2 })] } });
    expect((await a.take('elements')).elements.map((e) => e.id)).toEqual(['b']);
    await api(d, '/api/canvases/c1/clear', { body: {} });
    const cleared = await a.take('elements');
    expect(cleared.rev).toBe(3);
    expect(cleared.elements.every((e) => e.isDeleted)).toBe(true);
    expect(cleared.elements).toHaveLength(2);
  });

  it('handles notes, visibility and invalid messages without dropping the socket', async () => {
    const d = await start();
    const a = await viewer(d, 'c1');
    const b = await viewer(d, 'c1');
    a.ws.send('not json');
    expect((await a.take('error')).message).toMatch(/JSON/);
    a.send({ t: 'warp' });
    await a.take('error');
    a.send({ t: 'elements', elements: [{ id: 'bad' }] });
    await a.take('error');
    a.send({ t: 'note', text: '  look here ' });
    expect((await a.take('note')).note).toMatchObject({ text: 'look here', rev: 1 });
    expect((await b.take('note')).note.text).toBe('look here');
    expect((await apiJson(d, '/api/canvases/c1/changes?since=0')).body.notes).toHaveLength(1);
    expect(a.ws.readyState).toBe(WebSocket.OPEN);
  });
});

describe('viewer request relay', () => {
  it('returns the viewer result and ignores responses from other sockets', async () => {
    const d = await start();
    const a = await viewer(d, 'c1');
    const intruder = await viewer(d, 'c1');
    a.send({ t: 'visible', visible: true });
    await sleep(20);
    const pending = apiJson(d, '/api/canvases/c1/request', { body: { type: 'screenshot', payload: { dark: true } } });
    const req = await a.take('request');
    expect(req).toMatchObject({ type: 'screenshot', payload: { dark: true } });
    intruder.send({ t: 'response', reqId: req.reqId, ok: true, result: 'forged' });
    await sleep(30);
    a.send({ t: 'response', reqId: req.reqId, ok: true, result: { base64: 'AA' } });
    expect(await pending).toEqual({ status: 200, body: { result: { base64: 'AA' } } });
    expect(d.stats().pending).toBe(0);
  });

  it('returns 502 with the viewer error message', async () => {
    const d = await start();
    const a = await viewer(d, 'c1');
    const pending = apiJson(d, '/api/canvases/c1/request', { body: { type: 'mermaid', payload: { definition: 'graph' } } });
    const req = await a.take('request');
    a.send({ t: 'response', reqId: req.reqId, ok: false, error: 'parse error' });
    expect(await pending).toEqual({ status: 502, body: { error: 'parse error' } });
  });

  it('answers 409 without a viewer and 504 on timeout', async () => {
    const d = await start();
    expect(await apiJson(d, '/api/canvases/c1/request', { body: { type: 'focus' } })).toEqual({ status: 409, body: { error: 'no_viewer' } });
    const a = await viewer(d, 'c1');
    const t0 = Date.now();
    expect(await apiJson(d, '/api/canvases/c1/request', { body: { type: 'focus', timeoutMs: 150 } })).toEqual({ status: 504, body: { error: 'timeout' } });
    expect(Date.now() - t0).toBeLessThan(2000);
    expect(d.stats().pending).toBe(0);
    await a.take('request');
  });

  it('answers 502 immediately when the target viewer disconnects', async () => {
    const d = await start();
    const a = await viewer(d, 'c1');
    const t0 = Date.now();
    const pending = apiJson(d, '/api/canvases/c1/request', { body: { type: 'screenshot', timeoutMs: 10_000 } });
    await a.take('request');
    a.ws.terminate();
    expect(await pending).toEqual({ status: 502, body: { error: 'viewer_disconnected' } });
    expect(Date.now() - t0).toBeLessThan(3000);
    expect(d.stats().pending).toBe(0);
  });

  it('targets a visible viewer first, then the most recently active one', async () => {
    const d = await start();
    const first = await viewer(d, 'c1');
    const second = await viewer(d, 'c1');
    const respond = (v: Viewer, name: string) => v.take('request').then((r) => v.send({ t: 'response', reqId: r.reqId, ok: true, result: name }));
    second.send({ t: 'visible', visible: false });
    await sleep(20);
    let answer = respond(second, 'second');
    expect((await apiJson(d, '/api/canvases/c1/request', { body: { type: 'focus' } })).body.result).toBe('second');
    await answer;

    first.send({ t: 'visible', visible: true });
    await sleep(20);
    second.send({ t: 'visible', visible: false });
    await sleep(20);
    answer = respond(first, 'first');
    expect((await apiJson(d, '/api/canvases/c1/request', { body: { type: 'focus' } })).body.result).toBe('first');
    await answer;
  });
});

describe('lifecycle', () => {
  it('terminates sockets that stop answering pings and keeps healthy ones', async () => {
    const d = await start({ heartbeatMs: 40 });
    const silent = await viewer(d, 'c1', { autoPong: false });
    const healthy = await viewer(d, 'c1');
    const closed = new Promise((r) => silent.ws.once('close', r));
    await closed;
    await sleep(150);
    expect(healthy.ws.readyState).toBe(WebSocket.OPEN);
    await until(() => d.stats().viewers === 1 && d.stats().sockets === 1);
  });

  it('calls onIdle only after idleExitMs without sockets or requests', async () => {
    let idle = 0;
    const d = await start({ idleExitMs: 150, onIdle: () => idle++ });
    const v = await viewer(d, 'c1');
    await sleep(400);
    expect(idle).toBe(0);
    v.ws.close();
    await until(() => d.stats().sockets === 0);
    const closedAt = Date.now();
    await until(() => idle === 1);
    expect(Date.now() - closedAt).toBeGreaterThanOrEqual(100);
    await sleep(200);
    expect(idle).toBe(1);
  });

  it('close() resolves promptly with open sockets, keep-alive connections and pending requests', async () => {
    const d = await start();
    await viewer(d, 'c1');
    await api(d, '/health');
    const pending = apiJson(d, '/api/canvases/c1/request', { body: { type: 'focus', timeoutMs: 30_000 } }).catch(() => ({ status: -1 }));
    await until(() => d.stats().pending === 1);
    const t0 = Date.now();
    await d.close();
    expect(Date.now() - t0).toBeLessThan(1000);
    expect([503, -1]).toContain((await pending).status);
    expect(d.stats()).toMatchObject({ pending: 0, sockets: 0 });
  });

  it('returns to zero viewers, pending requests and sockets after churn', async () => {
    const d = await start();
    const viewers = await Promise.all(Array.from({ length: 200 }, () => viewer(d, 'churn')));
    viewers.forEach((v, i) => {
      v.ws.on('message', (data) => {
        const msg = JSON.parse(String(data)) as ServerMessage;
        if (msg.t !== 'request') return;
        if (i % 3 === 0) v.ws.terminate();
        else v.send({ t: 'response', reqId: msg.reqId, ok: true, result: i });
      });
      v.send({ t: 'visible', visible: i % 2 === 0 });
    });
    expect(d.stats().sockets).toBe(200);
    const results = await Promise.all(
      Array.from({ length: 200 }, () => apiJson(d, '/api/canvases/churn/request', { body: { type: 'focus', timeoutMs: 5000 } })),
    );
    for (const r of results) expect([200, 409, 502]).toContain(r.status);
    expect(results.some((r) => r.status === 200)).toBe(true);
    for (const v of viewers) v.ws.close();
    await until(() => {
      const s = d.stats();
      return s.viewers === 0 && s.pending === 0 && s.sockets === 0;
    }, 5000);
  });
});

describe('panel hosts', () => {
  async function host(d: Daemon, hello?: { folders: string[]; focused: boolean; hostId?: string }, opts: WebSocket.ClientOptions = {}, token = d.token) {
    const ws = new WebSocket(`ws://127.0.0.1:${d.port}/ws/host?token=${token}`, opts);
    sockets.push(ws);
    await new Promise((resolve, reject) => {
      ws.once('open', resolve);
      ws.once('error', reject);
    });
    const shows: Array<{ t: string; reqId: string; canvasId: string; title: string }> = [];
    ws.on('message', (m) => shows.push(JSON.parse(String(m))));
    if (hello) ws.send(JSON.stringify({ t: 'hello', ...hello }));
    await until(() => d.stats().hosts > 0);
    await sleep(30);
    return { ws, shows, reply: (reqId: string, ok = true, error?: string) => ws.send(JSON.stringify({ t: 'shown', reqId, ok, error })) };
  }
  const board = (d: Daemon, id: string, workspace: string) => apiJson(d, `/api/canvases/${id}`, { method: 'PUT', body: { title: 'How MCP works', workspace, chat: 'chat-1' } });

  const showTo = (d: Daemon, body: { workspace?: string; host?: string }) => apiJson(d, '/api/canvases/mcp/show', { body });

  it('stores board metadata and shows it in the window of its workspace', async () => {
    const d = await start();
    expect((await board(d, 'mcp', '/work/a')).body).toMatchObject({ title: 'How MCP works', workspace: '/work/a', chat: 'chat-1' });
    const a = await host(d, { folders: ['/work/a'], focused: false });
    const b = await host(d, { folders: ['/work/b'], focused: true });

    const first = showTo(d, { workspace: '/work/a/sub' });
    await until(() => a.shows.length === 1);
    expect(a.shows[0]).toMatchObject({ t: 'show', canvasId: 'mcp', title: 'How MCP works' });
    b.reply(a.shows[0]!.reqId); // a reply from the wrong host is ignored
    await sleep(30);
    expect(d.stats().pending).toBe(1);
    a.reply(a.shows[0]!.reqId);
    expect(await first).toEqual({ status: 200, body: { shown: true } });
    expect(b.shows).toEqual([]);
  });

  it('never shows a board in an unrelated window: no hint and no folder match answers 409', async () => {
    // The incident: the chat's own window had no host, so the only connected window (another folder) took over.
    const d = await start();
    await board(d, 'mcp', '/Users/me/Documents/ishara');
    const unrelated = await host(d, { folders: ['/Users/me/work/devin-switch'], focused: true, hostId: '45824' });
    expect(await showTo(d, { workspace: '/Users/me/Documents/ishara' })).toEqual({ status: 409, body: { error: 'no_host' } });
    expect(await showTo(d, { workspace: '/Users/me/Documents/ishara', host: '64248' })).toEqual({ status: 409, body: { error: 'no_host' } });
    expect(await showTo(d, {})).toEqual({ status: 409, body: { error: 'no_host' } });
    expect(await showTo(d, { workspace: '/Users/me/work/devin-switch-sibling' })).toEqual({ status: 409, body: { error: 'no_host' } });
    await sleep(30);
    expect(unrelated.shows).toEqual([]);
    expect(d.stats().pending).toBe(0);
  });

  it('the host hint beats folder and focus, and tells two windows of one folder apart', async () => {
    const d = await start();
    await board(d, 'mcp', '/w');
    const a = await host(d, { folders: ['/w'], focused: true, hostId: '111' });
    const b = await host(d, { folders: ['/w'], focused: false, hostId: '222' });
    const c = await host(d, { folders: [], focused: false, hostId: '333' });
    const answer = async (target: typeof a, body: { workspace?: string; host?: string }) => {
      const before = [a, b, c].map((h) => h.shows.length);
      const pending = showTo(d, body);
      await until(() => target.shows.length > before[[a, b, c].indexOf(target)]!);
      target.reply(target.shows.at(-1)!.reqId);
      expect((await pending).status).toBe(200);
      return [a, b, c].map((h, i) => h.shows.length - before[i]!);
    };
    expect(await answer(b, { workspace: '/w', host: '222' })).toEqual([0, 1, 0]);
    expect(await answer(a, { workspace: '/w', host: '111' })).toEqual([1, 0, 0]);
    // The chat's window wins even when it shows another folder (or none).
    expect(await answer(c, { workspace: '/w', host: '333' })).toEqual([0, 0, 1]);
    expect(await answer(a, { workspace: '/w' })).toEqual([1, 0, 0]);
  });

  it('a hint for a window without a host never lands in another identified window, only in old hosts of the folder', async () => {
    const d = await start();
    await board(d, 'mcp', '/w');
    const other = await host(d, { folders: ['/w'], focused: true, hostId: '222' });
    expect(await showTo(d, { workspace: '/w', host: '999' })).toEqual({ status: 409, body: { error: 'no_host' } });
    const old = await host(d, { folders: ['/w'], focused: false });
    const pending = showTo(d, { workspace: '/w', host: '999' });
    await until(() => old.shows.length === 1);
    old.reply(old.shows[0]!.reqId);
    expect((await pending).status).toBe(200);
    expect(other.shows).toEqual([]);
  });

  it('among windows of the folder without a hint: focused first, then the most recently active', async () => {
    const d = await start();
    await board(d, 'mcp', '/w');
    const a = await host(d, { folders: ['/w'], focused: false });
    const b = await host(d, { folders: ['/w'], focused: false });
    const first = showTo(d, { workspace: '/w' });
    await until(() => b.shows.length === 1);
    b.reply(b.shows[0]!.reqId);
    await first;
    a.ws.send(JSON.stringify({ t: 'state', focused: false })); // a becomes the most recently active
    await sleep(30);
    const second = showTo(d, { workspace: '/w' });
    await until(() => a.shows.length === 1);
    a.reply(a.shows[0]!.reqId);
    await second;
    b.ws.send(JSON.stringify({ t: 'state', focused: true }));
    a.ws.send(JSON.stringify({ t: 'state', folders: ['/w'] }));
    await sleep(30);
    const third = showTo(d, { workspace: '/w' });
    await until(() => b.shows.length === 2);
    b.reply(b.shows[1]!.reqId);
    await third;
    expect(a.shows).toHaveLength(1);
    a.ws.close();
    b.ws.close();
    await until(() => d.stats().hosts === 0 && d.stats().pending === 0);
  });

  it('rejects a malformed host hint', async () => {
    const d = await start();
    await board(d, 'mcp', '/w');
    expect((await showTo(d, { workspace: '/w', host: 42 as unknown as string })).status).toBe(400);
  });

  it('answers 409 without a host, 502 on failure or disconnect, 504 on timeout, 404 for unknown boards', async () => {
    const d = await start({ showTimeoutMs: 150 });
    await board(d, 'mcp', '/w');
    expect(await apiJson(d, '/api/canvases/mcp/show', { body: {} })).toEqual({ status: 409, body: { error: 'no_host' } });
    expect((await apiJson(d, '/api/canvases/nope/show', { body: {} })).status).toBe(404);
    const h = await host(d, { folders: ['/w'], focused: true });
    const failing = apiJson(d, '/api/canvases/mcp/show', { body: { workspace: '/w' } });
    await until(() => h.shows.length === 1);
    h.reply(h.shows[0]!.reqId, false, 'panel failed');
    expect(await failing).toEqual({ status: 502, body: { error: 'panel failed' } });
    expect((await apiJson(d, '/api/canvases/mcp/show', { body: { workspace: '/w' } })).status).toBe(504);
    const dropped = apiJson(d, '/api/canvases/mcp/show', { body: { workspace: '/w' } });
    await until(() => h.shows.length === 3);
    h.ws.close();
    expect(await dropped).toEqual({ status: 502, body: { error: 'host_disconnected' } });
    await until(() => d.stats().hosts === 0 && d.stats().pending === 0);
  });

  it("a fresh daemon waits for the hinted window's host to connect, and shows the board only there", async () => {
    // The agent's first call started the daemon; windows find it by polling daemon.json every few seconds.
    const d = await start({ hostGraceMs: 3000 });
    await board(d, 'mcp', '/w');
    const pending = showTo(d, { workspace: '/w', host: '111' });
    await sleep(100);
    expect(d.stats().pending).toBe(1);
    const other = await host(d, { folders: ['/w'], focused: true, hostId: '222' });
    await sleep(50);
    expect(d.stats().pending).toBe(1);
    const own = await host(d, { folders: [], focused: false, hostId: '111' });
    await until(() => own.shows.length === 1);
    own.reply(own.shows[0]!.reqId);
    expect(await pending).toEqual({ status: 200, body: { shown: true } });
    expect(other.shows).toEqual([]);
    expect(d.stats().pending).toBe(0);
  });

  it('answers no_host once the grace period is over, and never waits for shows without a window hint', async () => {
    const d = await start({ hostGraceMs: 400 });
    await board(d, 'mcp', '/w');
    let started = Date.now();
    expect(await showTo(d, { workspace: '/w' })).toEqual({ status: 409, body: { error: 'no_host' } });
    expect(Date.now() - started).toBeLessThan(200);
    expect(await showTo(d, { workspace: '/w', host: '111' })).toEqual({ status: 409, body: { error: 'no_host' } });
    expect(Date.now() - started).toBeGreaterThanOrEqual(300);
    started = Date.now();
    expect(await showTo(d, { workspace: '/w', host: '111' })).toEqual({ status: 409, body: { error: 'no_host' } });
    expect(Date.now() - started).toBeLessThan(200);
    expect(d.stats().pending).toBe(0);
  });

  it('drops a waiting show when its caller leaves or the daemon shuts down', async () => {
    const d = await start({ hostGraceMs: 5000 });
    await board(d, 'mcp', '/w');
    const abort = new AbortController();
    const gone = fetch(`${d.url}/api/canvases/mcp/show`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${d.token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ workspace: '/w', host: '111' }),
      signal: abort.signal,
    }).catch(() => 'aborted');
    await until(() => d.stats().pending === 1);
    abort.abort();
    expect(await gone).toBe('aborted');
    await until(() => d.stats().pending === 0);
    const waiting = showTo(d, { workspace: '/w', host: '111' });
    await until(() => d.stats().pending === 1);
    await d.close();
    expect(await waiting).toEqual({ status: 503, body: { error: 'shutting_down' } });
  });

  it('requires the token and the daemon origin for hosts', async () => {
    const d = await start();
    await expect(host(d, undefined, {}, 'wrong')).rejects.toThrow(/401/);
    await expect(host(d, undefined, { origin: 'http://evil.test' })).rejects.toThrow(/403/);
  });

  it('a connected host does not keep an otherwise idle daemon alive', async () => {
    let idle = 0;
    const d = await start({ idleExitMs: 150, onIdle: () => idle++ });
    await host(d, { folders: ['/w'], focused: true });
    await until(() => idle === 1, 2000);
  });
});
