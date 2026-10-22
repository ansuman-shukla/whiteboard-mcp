import { PassThrough } from 'node:stream';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { JsonRpcConnection, RpcError, type RpcHandlers } from '../../src/mcp/jsonrpc.js';

interface Peer {
  conn: JsonRpcConnection;
  input: PassThrough;
  write(s: string): void;
  frames(): Promise<any[]>;
  raw(): string;
}

const peers: Peer[] = [];
afterEach(() => {
  for (const p of peers.splice(0)) p.conn.close();
  vi.useRealTimers();
});

function peer(handlers: Partial<RpcHandlers> = {}): Peer {
  const input = new PassThrough();
  const output = new PassThrough();
  let out = '';
  output.setEncoding('utf8');
  output.on('data', (c: string) => (out += c));
  const conn = new JsonRpcConnection(input, output, { request: handlers.request ?? ((m) => ({ echo: m })), notification: handlers.notification });
  const p: Peer = {
    conn,
    input,
    write: (s) => input.write(s),
    async frames() {
      await new Promise((r) => setTimeout(r, 10));
      return out.split('\n').filter(Boolean).map((l) => JSON.parse(l));
    },
    raw: () => out,
  };
  peers.push(p);
  return p;
}

describe('framing', () => {
  it('reassembles partial chunks, accepts CRLF and skips blank lines', async () => {
    const p = peer();
    p.write('{"jsonrpc":"2.0","id":1,');
    p.write('"method":"a"}\r\n\n  \r\n{"jsonrpc":"2.0","id":"x","method":"b"}\n');
    expect(await p.frames()).toEqual([
      { jsonrpc: '2.0', id: 1, result: { echo: 'a' } },
      { jsonrpc: '2.0', id: 'x', result: { echo: 'b' } },
    ]);
    expect(p.raw().endsWith('\n')).toBe(true);
  });

  it('handles several messages in one chunk and a final line without newline on close', async () => {
    const p = peer();
    p.write('{"jsonrpc":"2.0","id":1,"method":"a"}\n{"jsonrpc":"2.0","id":2,"method":"b"}\n{"jsonrpc":"2.0","id":3,"method":"c"}');
    expect((await p.frames()).map((f) => f.id)).toEqual([1, 2]);
    p.input.end();
    expect((await p.frames()).map((f) => f.id)).toEqual([1, 2, 3]);
  });

  it('sends notifications to the notification handler without replying', async () => {
    const seen: string[] = [];
    const p = peer({ notification: (m) => void seen.push(m) });
    p.write('{"jsonrpc":"2.0","method":"notifications/initialized"}\n');
    expect(await p.frames()).toEqual([]);
    expect(seen).toEqual(['notifications/initialized']);
  });
});

describe('errors', () => {
  it('answers unparsable lines with -32700 and id null', async () => {
    const p = peer();
    p.write('{not json\n');
    expect(await p.frames()).toEqual([{ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } }]);
  });

  it('answers malformed messages with -32600', async () => {
    const p = peer();
    p.write('{"id":5,"method":"a"}\n[1,2]\n{"jsonrpc":"2.0","id":{},"method":"a"}\n{"jsonrpc":"2.0","id":7}\n');
    const frames = await p.frames();
    expect(frames.map((f) => [f.id, f.error?.code])).toEqual([
      [5, -32600],
      [null, -32600],
      [null, -32600],
      [7, -32600],
    ]);
  });

  it('maps RpcError codes and other throws to -32603', async () => {
    const p = peer({
      request(m) {
        if (m === 'rpc') throw new RpcError(-32601, 'nope', { m });
        if (m === 'async') return Promise.reject(new Error('boom'));
        throw new Error('sync boom');
      },
    });
    p.write('{"jsonrpc":"2.0","id":1,"method":"rpc"}\n{"jsonrpc":"2.0","id":2,"method":"async"}\n{"jsonrpc":"2.0","id":3,"method":"sync"}\n');
    const frames = await p.frames();
    expect(frames.find((f) => f.id === 1).error).toEqual({ code: -32601, message: 'nope', data: { m: 'rpc' } });
    expect(frames.find((f) => f.id === 2).error).toEqual({ code: -32603, message: 'boom' });
    expect(frames.find((f) => f.id === 3).error).toEqual({ code: -32603, message: 'sync boom' });
  });

  it('serializes an undefined result as an empty object', async () => {
    const p = peer({ request: () => undefined });
    p.write('{"jsonrpc":"2.0","id":1,"method":"x"}\n');
    expect((await p.frames())[0]).toEqual({ jsonrpc: '2.0', id: 1, result: {} });
  });
});

describe('server-to-client requests', () => {
  it('matches responses by id regardless of order', async () => {
    const p = peer();
    const a = p.conn.request('roots/list');
    const b = p.conn.request('other', { q: 1 });
    const sent = await p.frames();
    expect(sent.map((f) => f.method)).toEqual(['roots/list', 'other']);
    expect(sent[1].params).toEqual({ q: 1 });
    expect('params' in sent[0]).toBe(false);
    p.write(`${JSON.stringify({ jsonrpc: '2.0', id: sent[1].id, error: { code: -1, message: 'bad' } })}\n`);
    p.write(`${JSON.stringify({ jsonrpc: '2.0', id: sent[0].id, result: { roots: [] } })}\n`);
    await expect(a).resolves.toEqual({ roots: [] });
    await expect(b).rejects.toMatchObject({ code: -1, message: 'bad' });
    expect(await p.frames()).toHaveLength(2);
  });

  it('times out and ignores the late response', async () => {
    const p = peer();
    const req = p.conn.request('roots/list', undefined, 30);
    await expect(req).rejects.toThrow(/timed out/);
    const [sent] = await p.frames();
    p.write(`${JSON.stringify({ jsonrpc: '2.0', id: sent.id, result: {} })}\n`);
    expect(await p.frames()).toHaveLength(1);
  });

  it('rejects pending requests on close and refuses new ones', async () => {
    const p = peer();
    const req = p.conn.request('roots/list', undefined, 5000);
    p.input.end();
    await expect(req).rejects.toThrow(/closed/);
    await expect(p.conn.request('x')).rejects.toThrow(/closed/);
  });
});

describe('close', () => {
  it('fires close listeners on stdin end, also when registered late', async () => {
    const p = peer();
    const first = vi.fn();
    p.conn.onClose(first);
    p.input.end();
    await new Promise((r) => setTimeout(r, 10));
    expect(first).toHaveBeenCalledOnce();
    expect(p.conn.isClosed).toBe(true);
    const late = vi.fn();
    p.conn.onClose(late);
    expect(late).toHaveBeenCalledOnce();
  });

  it('answers requests still running when stdin closes and drain waits for them', async () => {
    let finish!: (v: unknown) => void;
    const p = peer({ request: () => new Promise((r) => (finish = r)) });
    p.write('{"jsonrpc":"2.0","id":1,"method":"slow"}\n');
    await new Promise((r) => setTimeout(r, 5));
    p.input.end();
    await new Promise((r) => setTimeout(r, 5));
    let drained = false;
    const drain = p.conn.drain(2000).then(() => (drained = true));
    await new Promise((r) => setTimeout(r, 20));
    expect(drained).toBe(false);
    finish({ ok: 1 });
    await drain;
    expect(await p.frames()).toEqual([{ jsonrpc: '2.0', id: 1, result: { ok: 1 } }]);
  });

  it('drain gives up after its timeout', async () => {
    const p = peer({ request: () => new Promise(() => undefined) });
    p.write('{"jsonrpc":"2.0","id":1,"method":"hang"}\n');
    await new Promise((r) => setTimeout(r, 5));
    const t = Date.now();
    await p.conn.drain(50);
    expect(Date.now() - t).toBeGreaterThanOrEqual(40);
  });
});
