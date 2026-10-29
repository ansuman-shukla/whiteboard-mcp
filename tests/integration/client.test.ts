import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, afterEach, describe, expect, it } from 'vitest';
import { removeTempDir } from '../helpers/cleanup.js';
import WebSocket from 'ws';
import { CanvasClient, CanvasError, type ConnectOptions } from '../../src/canvas/client.js';
import { VERSION, type DaemonInfo } from '../../src/shared/config.js';
import type { ExElement, ServerMessage } from '../../src/shared/protocol.js';

const fixture = fileURLToPath(new URL('../fixtures/serve.mjs', import.meta.url));
const epermFixture = fileURLToPath(new URL('../fixtures/serve-listen-eperm.mjs', import.meta.url));
const roots: string[] = [];
const pids = new Set<number>();
const servers: Server[] = [];
const sockets: WebSocket[] = [];

// Windows has no Unix permission bits or process groups, cannot deliver SIGTERM (it hard-kills),
// and frees a killed process's port lazily; these POSIX lifecycle checks run on macOS and Linux.
const posixIt = process.platform === 'win32' ? it.skip : it;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const el = (id: string, over: Partial<ExElement> = {}): ExElement => ({ id, type: 'rectangle', x: 0, y: 0, width: 10, height: 10, version: 1, versionNonce: 1, isDeleted: false, updated: Date.now(), ...over });

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function until(check: () => boolean, timeoutMs = 5000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!check()) {
    if (Date.now() > deadline) throw new Error('condition not met in time');
    await sleep(20);
  }
}

function listen(port = 0): Promise<Server> {
  const server = createServer((_req, res) => res.writeHead(404).end('not excalidraw'));
  servers.push(server);
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => resolve(server));
  });
}

async function freePort(): Promise<number> {
  const server = await listen();
  const { port } = server.address() as AddressInfo;
  await new Promise((r) => server.close(r));
  return port;
}

let home: string;
let port: number;

async function useHome(env: Record<string, string> = {}): Promise<void> {
  home = mkdtempSync(join(tmpdir(), 'exl-client-'));
  roots.push(home);
  port = await freePort();
  delete process.env.WHITEBOARD_IDLE_MS;
  Object.assign(process.env, { WHITEBOARD_HOME: home, WHITEBOARD_PORT: String(port), WHITEBOARD_ENTRY: fixture }, env);
}

const file = (name: string) => join(home, name);
const daemonInfo = () => JSON.parse(readFileSync(file('daemon.json'), 'utf8')) as DaemonInfo;
const logLines = (pattern: RegExp) => (existsSync(file('daemon.log')) ? readFileSync(file('daemon.log'), 'utf8').split('\n').filter((l) => pattern.test(l)).length : 0);

async function connect(opts?: ConnectOptions): Promise<CanvasClient> {
  const client = await CanvasClient.connect(opts);
  pids.add((await client.health()).pid);
  return client;
}

async function pidOf(client: CanvasClient): Promise<number> {
  const { pid } = await client.health();
  pids.add(pid);
  return pid;
}

afterEach(async () => {
  for (const ws of sockets.splice(0)) ws.terminate();
  await Promise.all(servers.splice(0).map((s) => new Promise((r) => s.close(r))));
  for (const pid of pids) if (alive(pid)) process.kill(pid, 'SIGKILL');
});

afterAll(async () => {
  for (const pid of pids) if (alive(pid)) process.kill(pid, 'SIGKILL');
  // Windows releases a killed process's open files a moment later (EBUSY), so wait and retry.
  await until(() => [...pids].every((pid) => !alive(pid))).catch(() => {});
  for (const dir of roots) removeTempDir(dir);
});

describe('daemon discovery and autostart', () => {
  posixIt('autostarts one detached daemon and reuses it on the next connect', async () => {
    await useHome();
    expect(existsSync(file('daemon.json'))).toBe(false);
    const a = await connect();
    const pid = await pidOf(a);
    expect(pid).not.toBe(process.pid);
    expect(daemonInfo()).toMatchObject({ pid, port });
    expect(a.baseUrl).toBe(`http://127.0.0.1:${port}`);
    expect(a.token).toMatch(/^[0-9a-f]{64}$/);
    expect(a.token).toBe(readFileSync(file('token'), 'utf8'));
    expect(statSync(file('token')).mode & 0o777).toBe(0o600);
    expect(statSync(file('daemon.json')).mode & 0o777).toBe(0o600);
    expect(statSync(home).mode & 0o777).toBe(0o700);
    // detached: the daemon leads its own process group, so it outlives the MCP server's terminal
    const pgid = (p: number) => spawnSync('ps', ['-o', 'pgid=', '-p', String(p)], { encoding: 'utf8' }).stdout.trim();
    expect(pgid(pid)).toBe(String(pid));

    const b = await connect();
    expect(await pidOf(b)).toBe(pid);
    expect(logLines(/listening on/)).toBe(1);
  });

  it('starts exactly one daemon for concurrent connects', async () => {
    await useHome();
    const clients = await Promise.all([connect(), connect(), connect()]);
    const found = await Promise.all(clients.map(pidOf));
    expect(new Set(found).size).toBe(1);
    // every connect spawned a daemon; the lock made the other two bow out
    await until(() => logLines(/already running/) === 2);
    expect(logLines(/listening on/)).toBe(1);
  });

  it('does not start a daemon when autoStart is false', async () => {
    await useHome();
    const err = await CanvasClient.connect({ autoStart: false }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(CanvasError);
    expect(err).toMatchObject({ code: 'daemon_not_running' });
    await sleep(200);
    expect(existsSync(file('daemon.json'))).toBe(false);
  });

  posixIt('ignores a daemon.json whose pid does not match the process on the port', async () => {
    await useHome();
    const first = await connect();
    const pid = await pidOf(first);
    process.kill(pid, 'SIGKILL');
    await until(() => !alive(pid));
    // a foreign program now owns the advertised port
    await listen(port);
    const client = await connect();
    expect(client.baseUrl).not.toBe(`http://127.0.0.1:${port}`);
    expect(await pidOf(client)).not.toBe(pid);
    expect(daemonInfo().port).not.toBe(port);
  });

  it('times out with a clear error when the daemon never becomes ready', async () => {
    await useHome();
    const hang = join(home, 'hang.mjs');
    writeFileSync(hang, 'setTimeout(() => {}, 3000);\n');
    process.env.WHITEBOARD_ENTRY = hang;
    const err = await CanvasClient.connect({ startTimeoutMs: 500 }).catch((e: unknown) => e);
    expect(err).toMatchObject({ name: 'CanvasError', code: 'daemon_start_timeout' });
  });

  it('fails fast, without waiting for the timeout, when the daemon exits before it is ready', async () => {
    await useHome({ WHITEBOARD_ENTRY: join(home, 'missing.mjs') });
    writeFileSync(file('daemon.log'), '2026-01-01T00:00:00.000Z [1] shutting down (idle)\n');
    const started = Date.now();
    const err = await CanvasClient.connect({ startTimeoutMs: 8000 }).catch((e: unknown) => e);
    expect(err).toMatchObject({ name: 'CanvasError', code: 'daemon_start_failed' });
    expect((err as Error).message).toContain('exited with code 1');
    expect((err as Error).message).not.toContain('shutting down');
    expect(Date.now() - started).toBeLessThan(4000);
  });

  it('keeps waiting when the started daemon exits cleanly because another one is coming up', async () => {
    await useHome();
    const yields = join(home, 'yield.mjs');
    writeFileSync(yields, 'process.exit(0);\n');
    process.env.WHITEBOARD_ENTRY = yields;
    const connecting = connect({ startTimeoutMs: 8000 });
    await sleep(400);
    const other = spawn(process.execPath, [fixture], { detached: true, stdio: 'ignore', env: process.env });
    other.unref();
    pids.add(other.pid!);
    const client = await connecting;
    expect(await pidOf(client)).toBe(other.pid);
  });

  it('names the reason and the likely sandbox when the daemon may not listen on 127.0.0.1', async () => {
    await useHome({ WHITEBOARD_ENTRY: epermFixture });
    const started = Date.now();
    const err = await CanvasClient.connect({ startTimeoutMs: 8000 }).catch((e: unknown) => e);
    expect(err).toMatchObject({ name: 'CanvasError', code: 'daemon_start_failed' });
    expect((err as Error).message).toContain('listen failed: Error: listen EPERM');
    expect((err as Error).message).toMatch(/not permitted here, probably a sandbox/);
    expect(Date.now() - started).toBeLessThan(4000);
  });
});

describe('daemon restarts', () => {
  it('restarts a killed daemon on the next call (stale lock takeover) and keeps the token and data', async () => {
    await useHome();
    const client = await connect();
    const pid = await pidOf(client);
    const token = client.token;
    await client.ensureCanvas('demo');
    await client.apply('demo', [el('a')]);
    await sleep(600); // let the debounced write land before the hard kill
    process.kill(pid, 'SIGKILL');
    await until(() => !alive(pid));
    expect(existsSync(file('daemon.lock'))).toBe(true);

    const snap = await client.snapshot('demo');
    expect(snap.elements.map((e) => e.id)).toEqual(['a']);
    const next = await pidOf(client);
    expect(next).not.toBe(pid);
    expect(client.token).toBe(token);
    expect(daemonInfo().pid).toBe(next);
    expect(readFileSync(file('daemon.lock'), 'utf8')).toBe(String(next));
  });

  posixIt('shuts down gracefully on SIGTERM, flushing data and removing daemon.json and the lock', async () => {
    await useHome();
    const client = await connect();
    const pid = await pidOf(client);
    await client.ensureCanvas('demo');
    await client.apply('demo', [el('a')]);
    process.kill(pid, 'SIGTERM');
    await until(() => !alive(pid));
    expect(existsSync(file('daemon.json'))).toBe(false);
    expect(existsSync(file('daemon.lock'))).toBe(false);
    expect(JSON.parse(readFileSync(join(home, 'canvases', 'demo.json'), 'utf8')).elements).toHaveLength(1);
    await expect(CanvasClient.connect({ autoStart: false })).rejects.toMatchObject({ code: 'daemon_not_running' });
  });

  it('exits after WHITEBOARD_IDLE_MS without activity, and the next call starts it again', async () => {
    await useHome({ WHITEBOARD_IDLE_MS: '300' });
    const client = await connect();
    const pid = await pidOf(client);
    await until(() => !existsSync(file('daemon.json')) && !alive(pid));
    expect(existsSync(file('daemon.lock'))).toBe(false);
    expect(await client.list()).toEqual([]);
    expect(await pidOf(client)).not.toBe(pid);
  });

  posixIt('a client with autoStart false surfaces the dead daemon instead of starting one', async () => {
    await useHome();
    await connect();
    const client = await connect({ autoStart: false });
    const pid = await pidOf(client);
    process.kill(pid, 'SIGTERM');
    await until(() => !alive(pid));
    await expect(client.list()).rejects.toMatchObject({ code: 'daemon_not_running' });
    expect(existsSync(file('daemon.json'))).toBe(false);
  });
});

describe('daemon version', () => {
  const versionFixture = fileURLToPath(new URL('../fixtures/serve-version.mjs', import.meta.url));

  async function runInstalled(version: string): Promise<number> {
    const child = spawn(process.execPath, [versionFixture], { detached: true, stdio: 'ignore', env: { ...process.env, FAKE_VERSION: version } });
    child.unref();
    pids.add(child.pid!);
    await until(() => existsSync(file('daemon.json')) && daemonInfo().pid === child.pid);
    return child.pid!;
  }

  posixIt('replaces an older running daemon with this version on the same port and token', async () => {
    await useHome();
    const old = await runInstalled('0.0.1');
    const token = readFileSync(file('token'), 'utf8');
    // two sessions of the new version at once still end up with a single new daemon
    const [a, b] = await Promise.all([connect(), connect()]);
    const pid = await pidOf(a);
    expect(await pidOf(b)).toBe(pid);
    expect(pid).not.toBe(old);
    expect(alive(old)).toBe(false);
    expect((await a.health()).version).toBe(VERSION);
    expect(daemonInfo()).toMatchObject({ pid, port, version: VERSION });
    expect(a.baseUrl).toBe(`http://127.0.0.1:${port}`);
    expect(a.token).toBe(token);
    expect(logLines(new RegExp(`replacing daemon ${old} \\(v0\\.0\\.1\\) with v${VERSION.replace(/\./g, '\\.')}`))).toBeGreaterThanOrEqual(1);
    expect(logLines(/listening on/)).toBe(1);
  });

  posixIt('keeps using a newer running daemon instead of downgrading it', async () => {
    await useHome();
    const newer = await runInstalled('999.0.0');
    const client = await connect();
    expect(await pidOf(client)).toBe(newer);
    expect((await client.health()).version).toBe('999.0.0');
    expect(alive(newer)).toBe(true);
    expect(logLines(/listening on|replacing/)).toBe(0);
  });

  posixIt('a daemon started next to a newer one bows out and leaves it running', async () => {
    await useHome();
    const newer = await runInstalled('999.0.0');
    const child = spawn(process.execPath, [fixture], { stdio: 'ignore', env: process.env });
    const code = await new Promise<number | null>((r) => child.once('exit', r));
    expect(code).toBe(0);
    expect(alive(newer)).toBe(true);
    expect(daemonInfo().pid).toBe(newer);
    expect(logLines(new RegExp(`daemon ${newer} already running`))).toBe(1);
  });

  posixIt('without autoStart, still reports an older daemon rather than replacing it', async () => {
    await useHome();
    const old = await runInstalled('0.0.1');
    const client = await connect({ autoStart: false });
    expect(await pidOf(client)).toBe(old);
    expect(alive(old)).toBe(true);
  });
});

describe('api', () => {
  it('covers canvases, elements, changes, notes and errors', async () => {
    await useHome();
    const c = await connect();
    expect(await c.ensureCanvas('demo', { title: 'Demo', workspace: '/w', chat: 'c1' })).toMatchObject({ id: 'demo', title: 'Demo', elementCount: 0, workspace: '/w', chat: 'c1' });
    expect(await c.show('demo', '/w')).toBe(false);
    expect(await c.apply('demo', [el('a'), el('b')], { actor: 'human' })).toEqual({ rev: 1, applied: ['a', 'b'], stale: [] });
    expect((await c.apply('demo', [el('a')])).stale).toEqual(['a']);
    const note = await c.addNote('demo', 'hello');
    expect(note).toMatchObject({ text: 'hello', rev: 2 });
    const ch = await c.changes('demo', 0);
    expect(ch).toMatchObject({ rev: 2, full: false, notes: [{ text: 'hello' }] });
    expect(ch.changes).toEqual([
      { rev: 1, actor: 'human', id: 'a', kind: 'created' },
      { rev: 1, actor: 'human', id: 'b', kind: 'created' },
    ]);
    expect(await c.list()).toEqual([{ id: 'demo', title: 'Demo', elementCount: 2, updatedAt: expect.any(Number), viewers: 0, workspace: '/w', chat: 'c1' }]);
    expect(await c.clear('demo')).toEqual({ rev: 3, applied: ['a', 'b'], stale: [] });
    expect(await c.snapshot('demo')).toMatchObject({ id: 'demo', rev: 3, elements: [], notes: [note] });
    expect(c.viewerUrl('demo')).toBe(`http://127.0.0.1:${port}/c/demo/${c.token}/`);
    expect(await c.health()).toEqual({ ok: true, version: expect.any(String), pid: expect.any(Number) });

    await expect(c.snapshot('missing')).rejects.toMatchObject({ name: 'CanvasError', status: 404, code: 'canvas_not_found' });
    await expect(c.apply('demo', [{ id: 'x' } as ExElement])).rejects.toMatchObject({ status: 400 });
    await expect(c.ensureCanvas('Bad Id')).rejects.toMatchObject({ status: 400 });
    await c.deleteCanvas('demo');
    await expect(c.snapshot('demo')).rejects.toMatchObject({ status: 404 });
    await expect(c.deleteCanvas('demo')).rejects.toMatchObject({ status: 404, code: 'canvas_not_found' });
  });

  it('relays viewer requests and maps failures to no_viewer, viewer_error and timeout', async () => {
    await useHome();
    const c = await connect();
    await c.ensureCanvas('demo');
    await expect(c.request('demo', 'focus', {})).rejects.toMatchObject({ name: 'CanvasError', status: 409, code: 'no_viewer' });

    let mode: 'ok' | 'fail' | 'silent' = 'ok';
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws?canvas=demo&token=${c.token}`);
    sockets.push(ws);
    ws.on('message', (data) => {
      const msg = JSON.parse(String(data)) as ServerMessage;
      if (msg.t !== 'request' || mode === 'silent') return;
      ws.send(JSON.stringify(mode === 'ok' ? { t: 'response', reqId: msg.reqId, ok: true, result: { echo: msg.payload, type: msg.type } } : { t: 'response', reqId: msg.reqId, ok: false, error: 'bad mermaid' }));
    });
    await new Promise((r) => ws.once('open', r));

    expect(await c.request('demo', 'screenshot', { dark: true })).toEqual({ echo: { dark: true }, type: 'screenshot' });
    mode = 'fail';
    const failed = await c.request('demo', 'mermaid', { definition: 'x' }).catch((e: unknown) => e);
    expect(failed).toMatchObject({ status: 502, code: 'viewer_error' });
    expect((failed as Error).message).toContain('bad mermaid');
    mode = 'silent';
    const t0 = Date.now();
    await expect(c.request('demo', 'focus', {}, 200)).rejects.toMatchObject({ status: 504, code: 'timeout' });
    expect(Date.now() - t0).toBeLessThan(2000);
  });
});
