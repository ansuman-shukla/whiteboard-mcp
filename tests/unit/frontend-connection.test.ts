import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { STOPPED_AFTER_MS, connect, type LinkStatus } from '../../frontend/src/connection';

/** A socket that opens when the daemon is up and closes right away when it's down. */
class FakeSocket {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static daemonUp = true;
  /** Addresses that no longer answer, such as a closed preview proxy. */
  static gone = new Set<string>();
  static created = 0;
  readyState = FakeSocket.CONNECTING;
  onopen: (() => void) | null = null;
  onmessage: ((e: { data: unknown }) => void) | null = null;
  onerror: (() => void) | null = null;
  onclose: (() => void) | null = null;

  constructor(readonly url: string) {
    FakeSocket.created++;
    sockets.push(this);
    setTimeout(() => (FakeSocket.daemonUp && !FakeSocket.gone.has(url) ? this.accept() : this.drop()), 0);
  }
  accept(): void {
    this.readyState = FakeSocket.OPEN;
    this.onopen?.();
  }
  drop(): void {
    this.readyState = 3;
    this.onclose?.();
  }
  send(): void {}
  close(): void {
    this.drop();
  }
}

let sockets: FakeSocket[] = [];
let statuses: LinkStatus[] = [];
const realWebSocket = globalThis.WebSocket;
const last = () => statuses[statuses.length - 1];
const live = () => sockets[sockets.length - 1]!;

beforeEach(() => {
  vi.useFakeTimers();
  sockets = [];
  statuses = [];
  FakeSocket.daemonUp = true;
  FakeSocket.gone = new Set();
  FakeSocket.created = 0;
  globalThis.WebSocket = FakeSocket as unknown as typeof WebSocket;
});

afterEach(() => {
  vi.useRealTimers();
  globalThis.WebSocket = realWebSocket;
});

const start = (urls = ['ws://127.0.0.1/ws']) => connect(urls, () => {}, (s) => statuses.push(s));

describe('viewer connection status', () => {
  it('says reconnecting at first, says the server stopped once it has been gone 10 s, and keeps retrying', () => {
    start();
    vi.advanceTimersByTime(0);
    expect(last()).toBe('live');
    FakeSocket.daemonUp = false;
    live().drop();
    expect(last()).toBe('offline');
    vi.advanceTimersByTime(STOPPED_AFTER_MS - 1);
    expect(statuses).not.toContain('stopped');
    vi.advanceTimersByTime(1);
    expect(last()).toBe('stopped');
    const triedSoFar = FakeSocket.created;
    vi.advanceTimersByTime(60_000);
    expect(FakeSocket.created).toBeGreaterThan(triedSoFar);
    expect(last()).toBe('stopped');

    FakeSocket.daemonUp = true;
    vi.advanceTimersByTime(10_000);
    expect(last()).toBe('live');
  });

  it('never says stopped for a short outage, such as a daemon being swapped for a newer version', () => {
    start();
    vi.advanceTimersByTime(0);
    FakeSocket.daemonUp = false;
    live().drop();
    vi.advanceTimersByTime(3000);
    expect(FakeSocket.created).toBeGreaterThanOrEqual(3);
    FakeSocket.daemonUp = true;
    vi.advanceTimersByTime(STOPPED_AFTER_MS * 3);
    expect(last()).toBe('live');
    expect(statuses).not.toContain('stopped');
  });

  it('gives every new outage the full 10 s again', () => {
    start();
    vi.advanceTimersByTime(0);
    FakeSocket.daemonUp = false;
    live().drop();
    vi.advanceTimersByTime(STOPPED_AFTER_MS);
    expect(last()).toBe('stopped');
    FakeSocket.daemonUp = true;
    vi.advanceTimersByTime(10_000);
    expect(last()).toBe('live');

    statuses = [];
    FakeSocket.daemonUp = false;
    live().drop();
    vi.advanceTimersByTime(STOPPED_AFTER_MS - 1);
    expect(statuses).not.toContain('stopped');
    vi.advanceTimersByTime(1);
    expect(last()).toBe('stopped');
  });

  it('a board link whose daemon is not running at all ends up saying so', () => {
    FakeSocket.daemonUp = false;
    start();
    expect(statuses).toEqual(['connecting']);
    vi.advanceTimersByTime(STOPPED_AFTER_MS);
    expect(last()).toBe('stopped');
  });

  it('reports nothing more once the viewer closes the connection', () => {
    const conn = start();
    vi.advanceTimersByTime(0);
    FakeSocket.daemonUp = false;
    live().drop();
    conn.close();
    const seen = statuses.length;
    vi.advanceTimersByTime(STOPPED_AFTER_MS * 2);
    expect(statuses).toHaveLength(seen);
  });
});

describe('viewer connection behind a preview proxy', () => {
  const PROXY = 'ws://127.0.0.1:59068/ws';
  const DIRECT = 'ws://127.0.0.1:47428/c/b1/t/ws';
  const triedAt = (url: string) => sockets.filter((s) => s.url === url).length;

  it('when the proxy goes away, reconnects straight to the daemon and never says stopped', () => {
    const conn = start([PROXY, DIRECT]);
    expect(conn.address()).toBe(PROXY);
    vi.advanceTimersByTime(0);
    expect([last(), live().url]).toEqual(['live', PROXY]);
    FakeSocket.gone.add(PROXY);
    live().drop();
    vi.advanceTimersByTime(3000);
    expect([last(), live().url]).toEqual(['live', DIRECT]);
    expect(conn.address()).toBe(DIRECT);
    vi.advanceTimersByTime(STOPPED_AFTER_MS * 3);
    expect(statuses).not.toContain('stopped');
  });

  it('keeps using the address that works, and only moves on after a failed attempt', () => {
    start([PROXY, DIRECT]);
    vi.advanceTimersByTime(0);
    FakeSocket.gone.add(PROXY);
    live().drop();
    vi.advanceTimersByTime(3000);
    const proxyTries = triedAt(PROXY);
    live().drop();
    vi.advanceTimersByTime(3000);
    expect([last(), live().url]).toEqual(['live', DIRECT]);
    expect(triedAt(PROXY)).toBe(proxyTries);
  });

  it('says the server stopped only when every address fails, after trying them all', () => {
    FakeSocket.daemonUp = false;
    start([PROXY, DIRECT]);
    vi.advanceTimersByTime(STOPPED_AFTER_MS);
    expect(last()).toBe('stopped');
    expect([triedAt(PROXY) > 0, triedAt(DIRECT) > 0]).toEqual([true, true]);
  });
});
