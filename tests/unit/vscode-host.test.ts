import { createRequire } from 'node:module';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

const require = createRequire(import.meta.url);
const { WhiteboardHost, whiteboardHome } = require('../../vscode/host.js');

type Listener = (event: { data?: string }) => void;

/** A WebSocket stand-in the tests drive by hand. */
class FakeSocket {
  static all: FakeSocket[] = [];
  readyState = 0;
  sent: Array<Record<string, unknown>> = [];
  listeners: Record<string, Listener[]> = {};
  constructor(readonly url: string) {
    FakeSocket.all.push(this);
  }
  addEventListener(type: string, fn: Listener): void {
    (this.listeners[type] ??= []).push(fn);
  }
  emit(type: string, event: { data?: string } = {}): void {
    for (const fn of this.listeners[type] ?? []) fn(event);
  }
  open(): void {
    this.readyState = 1;
    this.emit('open');
  }
  message(value: unknown): void {
    this.emit('message', { data: typeof value === 'string' ? value : JSON.stringify(value) });
  }
  send(data: string): void {
    this.sent.push(JSON.parse(data));
  }
  close(): void {
    if (this.readyState === 3) return;
    this.readyState = 3;
    this.emit('close');
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const files = (map: Record<string, string>) => async (file: string) => {
  const name = path.basename(file);
  if (!(name in map)) throw new Error('ENOENT');
  return map[name]!;
};

const hosts: Array<{ dispose(): void }> = [];
afterEach(() => {
  for (const host of hosts.splice(0)) host.dispose();
});

function makeHost(overrides: Record<string, unknown> = {}) {
  FakeSocket.all = [];
  const shown: Array<{ canvasId: string; url: string; title: string }> = [];
  const state = { folders: ['/work/app'], focused: true };
  const host = new WhiteboardHost({
    home: '/home/u/.whiteboard-mcp',
    hostId: '45824',
    folders: () => state.folders,
    focused: () => state.focused,
    onShow: async (board: { canvasId: string; url: string; title: string }) => {
      if (board.title === 'boom') throw new Error('panel failed');
      shown.push(board);
    },
    WebSocketImpl: FakeSocket,
    readFile: files({ 'daemon.json': JSON.stringify({ port: 47428, pid: 1 }), token: 'tok/+\n' }),
    reconnectMs: 10,
    ...overrides,
  });
  hosts.push(host);
  return { host, shown, state };
}

describe('whiteboardHome', () => {
  it('honours the setting, then WHITEBOARD_HOME, then ~/.whiteboard-mcp', () => {
    expect(whiteboardHome('/custom', { WHITEBOARD_HOME: '/env' })).toBe('/custom');
    expect(whiteboardHome('', { WHITEBOARD_HOME: '/env/home' })).toBe('/env/home');
    expect(whiteboardHome('', {})).toMatch(/\.whiteboard-mcp$/);
    const tilde = whiteboardHome('~/wb', {});
    expect(tilde.startsWith('~')).toBe(false);
    expect(tilde.endsWith(`${path.sep}wb`)).toBe(true);
  });
});

describe('WhiteboardHost', () => {
  it('says hello with its window id, folders and focus, then reports state changes', async () => {
    const { host, state } = makeHost();
    host.start();
    await sleep(5);
    const socket = FakeSocket.all[0]!;
    expect(socket.url).toBe('ws://127.0.0.1:47428/ws/host?token=tok%2F%2B');
    host.update();
    expect(socket.sent).toEqual([]);
    socket.open();
    expect(socket.sent).toEqual([{ t: 'hello', hostId: '45824', folders: ['/work/app'], focused: true }]);
    state.focused = false;
    state.folders = ['/work/app', '/work/lib'];
    host.update();
    expect(socket.sent[1]).toEqual({ t: 'state', folders: ['/work/app', '/work/lib'], focused: false });
  });

  it('opens shown boards with a tokenised viewer URL and reports the outcome of each request', async () => {
    const { host, shown } = makeHost();
    host.start();
    await sleep(5);
    const socket = FakeSocket.all[0]!;
    socket.open();
    socket.message({ t: 'show', reqId: 'r1', canvasId: 'app-1a2b3c', title: 'How MCP works' });
    await sleep(5);
    expect(shown).toEqual([{ canvasId: 'app-1a2b3c', url: 'http://127.0.0.1:47428/c/app-1a2b3c?token=tok%2F%2B', title: 'How MCP works' }]);
    expect(socket.sent[1]).toEqual({ t: 'shown', reqId: 'r1', ok: true });

    socket.message({ t: 'show', reqId: 'r2', canvasId: 'x', title: 'boom' });
    await sleep(5);
    expect(socket.sent[2]).toEqual({ t: 'shown', reqId: 'r2', ok: false, error: 'panel failed' });

    socket.message('{not json');
    socket.message({ t: 'other', reqId: 'r3', canvasId: 'y' });
    socket.message({ t: 'show', canvasId: 'y' });
    socket.message({ t: 'show', reqId: 'r4' });
    socket.message('null');
    await sleep(5);
    expect(socket.sent).toHaveLength(3);
    expect(shown).toHaveLength(1);
  });

  it('waits for the daemon to appear, reconnects with a fresh hello after it restarts, and stops retrying once disposed', async () => {
    const disk: Record<string, string> = {};
    const { host } = makeHost({ readFile: files(disk) });
    host.start();
    await sleep(30);
    expect(FakeSocket.all).toHaveLength(0);

    Object.assign(disk, { 'daemon.json': JSON.stringify({ port: 5000 }), token: 't1' });
    await sleep(40);
    expect(FakeSocket.all).toHaveLength(1);
    FakeSocket.all[0]!.open();
    // The daemon idled out and came back on another port with a new token.
    Object.assign(disk, { 'daemon.json': JSON.stringify({ port: 6000 }), token: 't2' });
    FakeSocket.all[0]!.close();
    await sleep(40);
    expect(FakeSocket.all).toHaveLength(2);
    const second = FakeSocket.all[1]!;
    expect(second.url).toBe('ws://127.0.0.1:6000/ws/host?token=t2');
    second.open();
    expect(second.sent[0]).toMatchObject({ t: 'hello', hostId: '45824' });
    expect(host.viewerUrl('b')).toBe('http://127.0.0.1:6000/c/b?token=t2');

    host.dispose();
    second.close();
    await sleep(40);
    expect(FakeSocket.all).toHaveLength(2);
  });

  it('gives up on a connection that never opens and tries again', async () => {
    vi.useFakeTimers();
    try {
      const { host } = makeHost({ connectTimeoutMs: 1000, reconnectMs: 50 });
      host.start();
      await vi.advanceTimersByTimeAsync(0);
      expect(FakeSocket.all).toHaveLength(1);
      const first = FakeSocket.all[0]!;
      await vi.advanceTimersByTimeAsync(999);
      expect(first.readyState).toBe(0);
      await vi.advanceTimersByTimeAsync(1);
      expect(first.readyState).toBe(3);
      await vi.advanceTimersByTimeAsync(50);
      expect(FakeSocket.all).toHaveLength(2);
      const second = FakeSocket.all[1]!;
      second.open();
      await vi.advanceTimersByTimeAsync(5000);
      expect(second.readyState).toBe(1);
      expect(FakeSocket.all).toHaveLength(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it('ignores invalid daemon info and keeps waiting', async () => {
    const { host } = makeHost({ readFile: files({ 'daemon.json': JSON.stringify({ port: '47428' }), token: 'tok' }) });
    host.start();
    await sleep(40);
    expect(FakeSocket.all).toHaveLength(0);
    const { host: noToken } = makeHost({ readFile: files({ 'daemon.json': JSON.stringify({ port: 47428 }), token: '  \n' }) });
    noToken.start();
    await sleep(40);
    expect(FakeSocket.all).toHaveLength(0);
  });

  it('ignores requests arriving on a connection it already replaced', async () => {
    const { host, shown } = makeHost();
    host.start();
    await sleep(5);
    const first = FakeSocket.all[0]!;
    first.open();
    first.close();
    await sleep(40);
    FakeSocket.all[1]!.open();
    first.message({ t: 'show', reqId: 'late', canvasId: 'app-1', title: 'Late' });
    await sleep(5);
    expect(shown).toEqual([]);
  });

  it('lists only boards of its folders, newest first, with the token and a timeout', async () => {
    let request: { url: string; init: { headers: Record<string, string>; signal: AbortSignal } } | undefined;
    const fetchImpl = async (url: string, init: { headers: Record<string, string>; signal: AbortSignal }) => {
      request = { url, init };
      return {
        ok: true,
        json: async () => [
          { id: 'a', title: 'Old', workspace: '/work/app', updatedAt: 1 },
          { id: 'b', title: 'Other folder', workspace: '/work/other', updatedAt: 9 },
          { id: 'c', title: 'New', workspace: '/work/app/sub', updatedAt: 5 },
          { id: 'd', title: 'Sibling prefix', workspace: '/work/application', updatedAt: 8 },
          { id: 'e', title: 'Legacy', updatedAt: 7 },
          { id: 'f', title: 'Dot folder', workspace: '/work/app/..cache', updatedAt: 3 },
          { id: 'g', title: 'Parent', workspace: '/work', updatedAt: 6 },
        ],
      };
    };
    const { host } = makeHost({ fetchImpl });
    expect((await host.boards()).map((b: { id: string }) => b.id)).toEqual(['c', 'f', 'a']);
    expect(request!.url).toBe('http://127.0.0.1:47428/api/canvases');
    expect(request!.init.headers.Authorization).toBe('Bearer tok/+');
    expect(request!.init.signal).toBeInstanceOf(AbortSignal);

    const { host: offline } = makeHost({ readFile: files({}) });
    expect(await offline.boards()).toEqual([]);
    const { host: failing } = makeHost({ fetchImpl: async () => ({ ok: false }) });
    expect(await failing.boards()).toEqual([]);
  });
});

describe('finding a daemon that just started', () => {
  it('connects as soon as daemon.json appears, without waiting for the retry timer, and stops watching once connected', async () => {
    const present: Record<string, string> = {};
    let onChange: ((event: string, file: string) => void) | undefined;
    let closed = 0;
    const watchImpl = vi.fn((dir: string, fn: (event: string, file: string) => void) => {
      expect(dir).toBe('/home/u/.whiteboard-mcp');
      onChange = fn;
      return { close: () => closed++, on: () => undefined };
    });
    const { host } = makeHost({ readFile: files(present), watchImpl, reconnectMs: 60_000 });
    host.start();
    await sleep(10);
    expect(FakeSocket.all).toHaveLength(0);
    expect(watchImpl).toHaveBeenCalledTimes(1);
    onChange!('rename', 'token'); // other files don't matter
    await sleep(10);
    expect(FakeSocket.all).toHaveLength(0);
    Object.assign(present, { 'daemon.json': JSON.stringify({ port: 47428, pid: 1 }), token: 'tok\n' });
    onChange!('rename', 'daemon.json');
    await sleep(10);
    expect(FakeSocket.all).toHaveLength(1);
    FakeSocket.all[0]!.open();
    expect(closed).toBe(1);
  });

  it('keeps retrying on the timer when the state folder does not exist yet', async () => {
    const watchImpl = vi.fn(() => {
      throw new Error('ENOENT');
    });
    const present: Record<string, string> = {};
    const { host } = makeHost({ readFile: files(present), watchImpl, reconnectMs: 10 });
    host.start();
    await sleep(15);
    Object.assign(present, { 'daemon.json': JSON.stringify({ port: 47428, pid: 1 }), token: 'tok\n' });
    await vi.waitFor(() => expect(FakeSocket.all).toHaveLength(1));
  });
});
