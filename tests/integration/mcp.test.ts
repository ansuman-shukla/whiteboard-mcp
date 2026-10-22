import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { createServer } from 'node:net';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { ListRootsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const repo = fileURLToPath(new URL('../..', import.meta.url));
const cli = join(repo, 'dist', 'cli.js');
const root = realpathSync(mkdtempSync(join(tmpdir(), 'exl-mcp-')));
const home = join(root, 'home');
const workspace = join(root, 'Main Workspace');
let env: Record<string, string>;
const clients: Client[] = [];

type Result = { content: Array<{ type: string; text?: string; data?: string; mimeType?: string }>; isError?: boolean };

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.once('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address() as { port: number };
      srv.close(() => resolve(port));
    });
  });
}

async function connect(opts: { cwd?: string; roots?: string } = {}): Promise<Client> {
  const client = new Client({ name: 'test', version: '1.0.0' }, { capabilities: opts.roots ? { roots: { listChanged: true } } : {} });
  if (opts.roots) client.setRequestHandler(ListRootsRequestSchema, async () => ({ roots: [{ uri: pathToFileURL(opts.roots!).href, name: 'root' }] }));
  await client.connect(new StdioClientTransport({ command: process.execPath, args: [cli], env, cwd: opts.cwd ?? workspace, stderr: 'ignore' }));
  clients.push(client);
  return client;
}

async function call(client: Client, name: string, args: Record<string, unknown> = {}): Promise<{ text: string; result: Result }> {
  const result = (await client.callTool({ name, arguments: args })) as Result;
  return { text: result.content.filter((c) => c.type === 'text').map((c) => c.text).join('\n'), result };
}

function daemon(): { port: number; pid: number; token: string } {
  const info = JSON.parse(readFileSync(join(home, 'daemon.json'), 'utf8')) as { port: number; pid: number };
  return { ...info, token: readFileSync(join(home, 'token'), 'utf8').trim() };
}

async function rest(path: string, body: unknown): Promise<unknown> {
  const { port, token } = daemon();
  const res = await fetch(`http://127.0.0.1:${port}${path}`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  expect(res.status).toBe(200);
  return res.json();
}

const humanRect = (id: string) => ({ id, type: 'rectangle', x: 0, y: 400, width: 120, height: 60, version: 1, versionNonce: 7, isDeleted: false, updated: Date.now() });
const sha6 = (s: string) => createHash('sha256').update(s).digest('hex').slice(0, 6);
const PIGGYBACK = /⚑ The human/;

beforeAll(async () => {
  mkdirSync(workspace, { recursive: true });
  env = {
    ...(process.env as Record<string, string>),
    WHITEBOARD_HOME: home,
    WHITEBOARD_PORT: String(await freePort()),
    WHITEBOARD_OPEN: 'none',
    WHITEBOARD_IDLE_MS: '60000',
  };
  delete env.WHITEBOARD_WORKSPACE;
  delete env.WHITEBOARD_EXPORT_DIR;
});

afterAll(async () => {
  await Promise.allSettled(clients.map((c) => c.close()));
  try {
    process.kill(daemon().pid, 'SIGTERM');
  } catch {
    // daemon never started or already gone
  }
  rmSync(root, { recursive: true, force: true });
});

describe('MCP server over stdio (SDK client)', () => {
  let client: Client;
  let canvasId: string;

  beforeAll(async () => {
    client = await connect();
  });

  it('negotiates and lists the nine tools', async () => {
    expect(client.getServerVersion()?.name).toBe('whiteboard-mcp');
    expect(client.getInstructions()?.length).toBeLessThanOrEqual(700);
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual(
      ['canvas_delete', 'canvas_draw', 'canvas_export', 'canvas_focus', 'canvas_guide', 'canvas_mermaid', 'canvas_open', 'canvas_read', 'canvas_screenshot'].sort(),
    );
  });

  it('opens the workspace board named after the directory', async () => {
    const { text, result } = await call(client, 'canvas_open');
    expect(result.isError).toBeFalsy();
    canvasId = /\(([a-z0-9-]+)\):/.exec(text)![1]!;
    expect(canvasId).toBe(`main-workspace-${sha6(workspace)}`);
    expect(text).toContain(`/c/${canvasId}`);
    expect(text).toMatch(/Viewers: 0 \(not opened/);
  });

  it('draws two shapes and a labelled arrow, then reads them back', async () => {
    const draw = await call(client, 'canvas_draw', {
      elements: [
        { id: 'a', type: 'rectangle', x: 0, y: 0, label: 'Alpha' },
        { id: 'b', type: 'rectangle', x: 300, y: 0, label: 'Beta' },
        { id: 'ab', type: 'arrow', from: 'a', to: 'b', label: 'calls' },
      ],
    });
    expect(draw.result.isError).toBeFalsy();
    expect(draw.text).toContain('Created: a, b, ab');
    expect(draw.text).toMatch(/No viewer is open.*canvas_open/);
    const read = await call(client, 'canvas_read');
    expect(read.text).toContain('[Alpha]');
    expect(read.text).toContain('[Beta]');
    expect(read.text).toMatch(/arrow "ab" a → b \[calls\]/);
    expect(read.text).toContain('No human changes since your last read.');
  });

  it('moves an element when the same id is drawn again', async () => {
    const draw = await call(client, 'canvas_draw', { elements: [{ id: 'a', x: 0, y: 200 }] });
    expect(draw.text).toContain('Updated: a');
    expect(draw.text).not.toContain('Created');
    const read = await call(client, 'canvas_read', { format: 'json', ids: ['a'] });
    const json = JSON.parse(read.text.split('\n')[1]!) as Array<{ id: string; y: number; label: string }>;
    expect(json).toEqual([expect.objectContaining({ id: 'a', y: 200, label: 'Alpha' })]);
  });

  it('rejects bad arguments as tool errors', async () => {
    const empty = await call(client, 'canvas_delete');
    expect(empty.result.isError).toBe(true);
    expect(empty.text).toMatch(/ids.*all/);
    const invalid = await call(client, 'canvas_draw', { elements: 'nope' });
    expect(invalid.result.isError).toBe(true);
    expect(invalid.text).toContain('arguments.elements must be an array');
    await expect(client.callTool({ name: 'canvas_nope', arguments: {} })).rejects.toMatchObject({ code: -32602 });
  });

  it('deletes elements', async () => {
    const del = await call(client, 'canvas_delete', { ids: ['b'] });
    expect(del.text).toContain('Deleted: b');
    const read = await call(client, 'canvas_read');
    expect(read.text).not.toContain('[Beta]');
    expect(read.text).toContain('[Alpha]');
  });

  it('tells the model to call canvas_open when a viewer is needed', async () => {
    const shot = await call(client, 'canvas_screenshot');
    expect(shot.result.isError).toBe(true);
    expect(shot.text).toContain('canvas_open');
  });

  it('reports human changes once: piggyback on the next draw, details in canvas_read', async () => {
    await rest(`/api/canvases/${canvasId}/elements`, { elements: [humanRect('h1')], actor: 'human' });
    const draw = await call(client, 'canvas_draw', { elements: [{ id: 'c', type: 'ellipse', x: 600, y: 0, label: 'Gamma' }] });
    expect(draw.text).toMatch(/⚑ The human changed 1 element since your last canvas_read/);
    const read = await call(client, 'canvas_read');
    expect(read.text).toMatch(/Human changes since your last read:\nAdded \(1\):\n {2}rectangle "h1"/);
    expect(read.text).not.toContain('"c"  ');
    const again = await call(client, 'canvas_read');
    expect(again.text).toContain('No human changes since your last read.');
    const next = await call(client, 'canvas_draw', { elements: [{ id: 'c', x: 620 }] });
    expect(next.text).not.toMatch(PIGGYBACK);
  });

  it('shows human notes once', async () => {
    await rest(`/api/canvases/${canvasId}/notes`, { text: 'please add a cache' });
    const focus = await call(client, 'canvas_focus', { ids: ['a'] });
    expect(focus.result.isError).toBe(true);
    expect(focus.text).toMatch(/left 1 note/);
    const read = await call(client, 'canvas_read');
    expect(read.text).toContain('Notes from the human:\n- please add a cache');
    const again = await call(client, 'canvas_read');
    expect(again.text).not.toContain('please add a cache');
  });

  it('exports inside the workspace and refuses paths outside the allowed roots', async () => {
    const ok = await call(client, 'canvas_export', { path: 'out/board' });
    expect(ok.result.isError).toBeFalsy();
    const file = join(workspace, 'out', 'board.excalidraw');
    const doc = JSON.parse(readFileSync(file, 'utf8')) as { type: string; elements: Array<{ id: string }> };
    expect(doc.type).toBe('excalidraw');
    expect(doc.elements.map((e) => e.id)).toEqual(expect.arrayContaining(['a', 'c', 'h1']));
    const outside = join(homedir(), `.exl-should-not-exist-${process.pid}.excalidraw`);
    const refused = await call(client, 'canvas_export', { path: outside });
    expect(refused.result.isError).toBe(true);
    expect(refused.text).toContain('Refusing');
    expect(existsSync(outside)).toBe(false);
  });

  it('returns the guide', async () => {
    const guide = await call(client, 'canvas_guide');
    expect(guide.text.length).toBeGreaterThan(500);
    expect(guide.text.length).toBeLessThanOrEqual(2500);
  });
});

describe('MCP roots', () => {
  it('uses the first file root of a roots-capable client as the workspace', async () => {
    const rootDir = join(root, 'Roots Project');
    mkdirSync(rootDir, { recursive: true });
    const client = await connect({ roots: rootDir });
    const { text } = await call(client, 'canvas_open');
    expect(text).toContain(`(roots-project-${sha6(rootDir)})`);
  });
});

describe('raw stdio', () => {
  it('only writes JSON-RPC to stdout, answers unknown methods with -32601 and exits soon after stdin closes', async () => {
    const child = spawn(process.execPath, [cli], { env, cwd: workspace, stdio: ['pipe', 'pipe', 'ignore'] });
    let out = '';
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (c: string) => (out += c));
    const exited = new Promise<number | null>((resolve) => child.once('exit', (code) => resolve(code)));
    const send = (m: unknown) => child.stdin.write(`${typeof m === 'string' ? m : JSON.stringify(m)}\n`);
    send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'raw', version: '0' } } });
    send({ jsonrpc: '2.0', method: 'notifications/initialized' });
    send({ jsonrpc: '2.0', id: 2, method: 'initialize', params: { protocolVersion: '1999-01-01', capabilities: {} } });
    send({ jsonrpc: '2.0', id: 3, method: 'foo/bar' });
    send({ jsonrpc: '2.0', id: 4, method: 'ping' });
    send({ jsonrpc: '2.0', id: 5, method: 'prompts/list' });
    send('{oops');
    await new Promise((r) => setTimeout(r, 300));
    const started = Date.now();
    child.stdin.end();
    expect(await exited).toBe(0);
    expect(Date.now() - started).toBeLessThan(2000);
    const lines = out.split('\n').filter(Boolean);
    const frames = lines.map((l) => JSON.parse(l) as { jsonrpc: string; id: unknown; result?: any; error?: { code: number } });
    for (const f of frames) expect(f.jsonrpc).toBe('2.0');
    const byId = new Map(frames.map((f) => [f.id, f]));
    expect(byId.get(1)!.result.protocolVersion).toBe('2025-06-18');
    expect(byId.get(1)!.result.capabilities).toEqual({ tools: { listChanged: false } });
    expect(byId.get(2)!.result.protocolVersion).toBe('2025-11-25');
    expect(byId.get(3)!.error!.code).toBe(-32601);
    expect(byId.get(4)!.result).toEqual({});
    expect(byId.get(5)!.result).toEqual({ prompts: [] });
    expect(byId.get(null)!.error!.code).toBe(-32700);
    expect(frames).toHaveLength(6);
  });
});
