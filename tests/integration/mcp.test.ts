import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { homedir, tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { ListRootsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { removeTempDir } from '../helpers/cleanup.js';
import WebSocket from 'ws';

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

async function connect(opts: { cwd?: string; roots?: string; env?: Record<string, string>; unset?: string[] } = {}): Promise<Client> {
  const client = new Client({ name: 'test', version: '1.0.0' }, { capabilities: opts.roots ? { roots: { listChanged: true } } : {} });
  if (opts.roots) client.setRequestHandler(ListRootsRequestSchema, async () => ({ roots: [{ uri: pathToFileURL(opts.roots!).href, name: 'root' }] }));
  const childEnv = { ...env, ...opts.env };
  for (const key of opts.unset ?? []) delete childEnv[key];
  await client.connect(new StdioClientTransport({ command: process.execPath, args: [cli], env: childEnv, cwd: opts.cwd ?? workspace, stderr: 'ignore' }));
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
  // Ignore the identity of the agent running these tests (its chat and its editor window).
  for (const key of ['WHITEBOARD_WORKSPACE', 'WHITEBOARD_CHAT_ID', 'WHITEBOARD_CHAT_COMMAND', 'WHITEBOARD_HOST_ID', 'WINDSURF_EXT_HOST_PID']) delete env[key];
  delete env.WHITEBOARD_EXPORT_DIR;
});

afterAll(async () => {
  await Promise.allSettled(clients.map((c) => c.close()));
  try {
    const { pid } = daemon();
    process.kill(pid, 'SIGTERM');
    // The daemon flushes boards on shutdown; removing its folder first races with that write.
    for (let i = 0; i < 50; i++) {
      process.kill(pid, 0);
      await new Promise((r) => setTimeout(r, 100));
    }
  } catch {
    // daemon never started or already gone
  }
  removeTempDir(root);
});

describe('MCP server over stdio (SDK client)', () => {
  let client: Client;
  let canvasId: string;

  beforeAll(async () => {
    client = await connect();
  });

  it('negotiates and lists the eleven tools', async () => {
    expect(client.getServerVersion()?.name).toBe('whiteboard-mcp');
    expect(client.getInstructions()?.length).toBeLessThanOrEqual(700);
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual(
      ['canvas_delete', 'canvas_draw', 'canvas_export', 'canvas_focus', 'canvas_guide', 'canvas_mermaid', 'canvas_open', 'canvas_read', 'canvas_save', 'canvas_screenshot', 'canvas_search'].sort(),
    );
  });

  it("opens this chat's own board in the workspace and names it after the topic", async () => {
    const { text, result } = await call(client, 'canvas_open', { title: 'How MCP works' });
    expect(result.isError).toBeFalsy();
    canvasId = /This chat's board: "How MCP works" \[([a-z0-9-]+)\]/.exec(text)![1]!;
    expect(canvasId).toMatch(/^main-workspace-[0-9a-f]{6}$/);
    expect(canvasId).not.toBe(`main-workspace-${sha6(workspace)}`);
    expect(text).toContain('Nobody is watching the board');
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
    expect(draw.text).toContain('Nobody is watching the board');
    const read = await call(client, 'canvas_read');
    expect(read.text).toContain('[Alpha]');
    expect(read.text).toContain('[Beta]');
    expect(read.text).toMatch(/arrow "ab" a → b \[calls\]/);
    expect(read.text).toContain('No human changes since your last read.');
    expect(read.text).toMatch(/^Board "How MCP works" rev \d+/);
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

  it('explains that a screenshot needs the board on screen when nobody can be shown it', async () => {
    const shot = await call(client, 'canvas_screenshot');
    expect(shot.result.isError).toBe(true);
    expect(shot.text).toContain('needs the board on screen');
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
    expect(text).toMatch(/\[roots-project-[0-9a-f]{6}\]/);
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

const boardId = (text: string): string => /board[^[]*\[([a-z0-9-]+)\]/i.exec(text)![1]!;

describe('chat scope', () => {
  it('gives each chat its own board, lists the workspace boards, and lets a chat read and draw on another one', async () => {
    const first = await connect();
    const firstId = boardId((await call(first, 'canvas_open', { title: 'Auth architecture' })).text);
    await call(first, 'canvas_draw', { elements: [{ id: 'login', type: 'rectangle', x: 0, y: 0, label: 'Login' }] });

    const second = await connect();
    const opened = await call(second, 'canvas_open');
    const secondId = boardId(opened.text);
    expect(secondId).not.toBe(firstId);
    expect(opened.text).toContain('The board is empty.');
    expect(opened.text).toMatch(new RegExp(`Other boards in this workspace.*Auth architecture \\[${firstId}`));

    const borrowed = await call(second, 'canvas_open', { board: 'auth architecture' });
    expect(borrowed.text).toContain(`Board from another chat: "Auth architecture" [${firstId}]`);
    expect(borrowed.text).toContain('[Login]');
    await call(second, 'canvas_draw', { elements: [{ id: 'token', type: 'rectangle', x: 300, y: 0, label: 'Token' }] });
    expect((await call(first, 'canvas_read')).text).toContain('[Token]');

    const back = await call(second, 'canvas_open', { board: 'own' });
    expect(boardId(back.text)).toBe(secondId);
    expect((await call(second, 'canvas_open', { board: 'nope' })).result.isError).toBe(true);
    const elsewhere = join(root, 'Other Space');
    mkdirSync(elsewhere, { recursive: true });
    const outsider = await connect({ cwd: elsewhere });
    expect((await call(outsider, 'canvas_open')).text).not.toContain('Auth architecture');
  });

  it('separates chats that share one process by the host chat id in _meta', async () => {
    const shared = await connect();
    const open = async (chat: string) => boardId(((await shared.callTool({ name: 'canvas_open', arguments: {}, _meta: { sessionId: chat } })) as Result).content[0]!.text!);
    const a = await open('chat-a');
    const b = await open('chat-b');
    expect(a).not.toBe(b);
    expect(await open('chat-a')).toBe(a);
  });

  it('keeps a chat on its board across processes via WHITEBOARD_CHAT_COMMAND (account handoffs)', async () => {
    const command = `${JSON.stringify(process.execPath)} -e "process.stdout.write('chat-42')"`;
    const before = await connect({ env: { WHITEBOARD_CHAT_COMMAND: command } });
    const id = boardId((await call(before, 'canvas_open', { title: 'Handoff' })).text);
    await before.close();
    const after = await connect({ env: { WHITEBOARD_CHAT_COMMAND: command } });
    expect(boardId((await call(after, 'canvas_open')).text)).toBe(id);
  });
});

describe('boards from other folders', () => {
  // Codex desktop starts every task in a new folder, e.g. ~/Documents/Codex/<date>/<task-slug>.
  const task = (slug: string) => {
    const dir = join(root, 'Codex', '2026-10-23', slug);
    mkdirSync(dir, { recursive: true });
    return connect({ cwd: dir });
  };

  it('a new task opens a board an earlier task made in its own folder, by title, and draws on it', async () => {
    const first = await task('ca');
    const firstBoard = boardId((await call(first, 'canvas_open', { title: 'How Codex turns a prompt into work' })).text);
    await call(first, 'canvas_draw', { elements: [{ id: 'loop', type: 'rectangle', x: 0, y: 0, label: 'Agent loop' }] });

    const later = await task('open-the-how-codex-turns-a');
    const opened = await call(later, 'canvas_open', { board: 'how codex turns a prompt into work' });
    expect(opened.result.isError).toBeFalsy();
    expect(opened.text).toContain(`Board from another chat (from ca): "How Codex turns a prompt into work" [${firstBoard}]`);
    expect(opened.text).toContain('[Agent loop]');
    expect(opened.text).not.toContain('Other boards in this workspace');
    await call(later, 'canvas_draw', { elements: [{ id: 'tools', type: 'rectangle', x: 300, y: 0, label: 'Tools' }] });
    expect((await call(first, 'canvas_read')).text).toContain('[Tools]');
    expect((await call(later, 'canvas_open', { board: firstBoard })).text).toContain(`[${firstBoard}]`);
  });

  it('for loose wording it opens nothing and lists the closest boards and saved copies to pick by id', async () => {
    const maker = await task('make-a-board');
    const madeBoard = boardId((await call(maker, 'canvas_open', { title: 'Rate limiter design' })).text);
    await call(maker, 'canvas_draw', { elements: [{ id: 'bucket', type: 'rectangle', x: 0, y: 0, label: 'Token bucket' }] });
    const savedCopy = /\[([a-z0-9-]+)\]/.exec((await call(maker, 'canvas_save', { name: 'Limiter v1' })).text)![1]!;

    const later = await task('rate-limiter-follow-up');
    await call(later, 'canvas_open');
    const miss = await call(later, 'canvas_open', { board: 'the rate limiter' });
    expect(miss.result.isError).toBe(true);
    expect(miss.text).toMatch(new RegExp(`^No board called "the rate limiter" in any folder\\. Closest, open one by id: "Rate limiter design" \\[${madeBoard}\\] from make-a-board;`));
    expect(miss.text).toContain(`saved copy "Limiter v1" (load with saved:"${savedCopy}")`);
    expect((await call(later, 'canvas_read')).text).toMatch(/^Board this chat's board \(untitled/);
  });

  it('refuses to guess between same-titled boards of other folders, but prefers its own folder', async () => {
    for (const slug of ['alpha', 'beta']) {
      const chat = await task(slug);
      await call(chat, 'canvas_open', { title: 'How login works' });
      await call(chat, 'canvas_draw', { elements: [{ id: 'x', type: 'rectangle', x: 0, y: 0, label: `${slug} login` }] });
    }
    const outsider = await task('gamma');
    const several = await call(outsider, 'canvas_open', { board: 'How login works' });
    expect(several.result.isError).toBe(true);
    expect(several.text).toMatch(/^Several boards in other folders are called "How login works"; pass one id: \[[a-z0-9-]+\] from (alpha|beta); \[[a-z0-9-]+\] from (alpha|beta)\./);
    const beta = await task('beta');
    expect((await call(beta, 'canvas_open', { board: 'How login works' })).text).toContain('[beta login]');
  });

  it('canvas_search finds live boards of other folders by their text, next to saved copies', async () => {
    const maker = await task('search-source');
    const made = boardId((await call(maker, 'canvas_open', { title: 'Queue workers' })).text);
    await call(maker, 'canvas_draw', { elements: [{ id: 'k', type: 'text', x: 0, y: 0, text: 'Kafka consumer group' }] });
    await call(maker, 'canvas_save', { name: 'Workers snapshot' });
    const later = await task('search-later');
    const found = await call(later, 'canvas_search', { query: 'kafka' });
    expect(found.text).toMatch(new RegExp(`^1 live board matching "kafka", this workspace first \\(canvas_open \\{board:"<id>"\\} opens one\\):\\n- "Queue workers" \\[${made}\\] 1 el, changed \\d{4}-\\d\\d-\\d\\d, from search-source: "Kafka consumer group"\\n`));
    expect(found.text).toMatch(/\n1 saved board matching "kafka" \(canvas_open \{saved:"<id>"\} loads a copy into this chat's board\):\n- "Workers snapshot" \[/);
    expect((await call(later, 'canvas_search', { query: 'zebra unicorn' })).text).toBe('No boards or saved copies match "zebra unicorn".');
  });
});

describe('saved boards', () => {
  const savedId = (text: string): string => /as "[^"]+" \[([a-z0-9-]+)\]/.exec(text)![1]!;

  it('a later chat in another workspace finds a saved board and loads a frozen copy into its own board', async () => {
    const first = await connect();
    const firstBoard = boardId((await call(first, 'canvas_open', { title: 'Payments flow' })).text);
    await call(first, 'canvas_draw', { elements: [{ id: 'hook', type: 'rectangle', x: 0, y: 0, label: 'Stripe webhook' }] });
    const save = await call(first, 'canvas_save');
    expect(save.result.isError).toBeFalsy();
    expect(save.text).toMatch(/^Saved 2 elements as "Payments flow" \[payments-flow-[0-9a-f]{6}\]/);
    const id = savedId(save.text);
    await call(first, 'canvas_delete', { all: true });
    await first.close();

    const elsewhere = join(root, 'Later Space');
    mkdirSync(elsewhere, { recursive: true });
    const later = await connect({ cwd: elsewhere });
    const found = await call(later, 'canvas_search', { query: 'stripe' });
    expect(found.text).toMatch(/^1 saved board matching "stripe"/);
    expect(found.text).toContain(`- "Payments flow" [${id}] 2 el, saved `);
    expect(found.text).toContain('from Main Workspace: "Stripe webhook"');
    expect((await call(later, 'canvas_search', { query: 'nothing here' })).text).toBe('No boards or saved copies match "nothing here".');

    await call(later, 'canvas_draw', { elements: [{ id: 'mine', type: 'rectangle', x: 0, y: 0, label: 'Mine' }] });
    const refused = await call(later, 'canvas_open', { saved: id });
    expect(refused.result.isError).toBe(true);
    expect(refused.text).toMatch(/has 2 elements; loading "Payments flow" replaces them\. Pass fresh:true/);
    expect((await call(later, 'canvas_read')).text).toMatch(/^Board this chat's board \(untitled/);

    // Not the exact name or id, but the only board whose text matches.
    const loaded = await call(later, 'canvas_open', { saved: 'webhook', fresh: true });
    expect(loaded.result.isError).toBeFalsy();
    expect(loaded.text).toMatch(/^This chat's board: "Payments flow" \[later-space-[0-9a-f]{6}\]/);
    expect(loaded.text).toContain(`Loaded a copy of saved board "Payments flow" [${id}]`);
    expect(loaded.text).toContain('[Stripe webhook]');
    const read = await call(later, 'canvas_read');
    expect(read.text).toContain('[Stripe webhook]');
    expect(read.text).not.toContain('[Mine]');
    expect(boardId(loaded.text)).not.toBe(firstBoard);

    await call(later, 'canvas_draw', { elements: [{ id: 'more', type: 'ellipse', x: 300, y: 0, label: 'Retry queue' }] });
    expect((await call(later, 'canvas_search', { query: id })).text).toContain(`[${id}] 2 el,`);
  });

  it('explains what is missing: a name, content, a unique match', async () => {
    const chat = await connect();
    expect((await call(chat, 'canvas_save')).text).toBe('This board has no title yet: pass name.');
    expect((await call(chat, 'canvas_save', { name: 'Empty' })).text).toBe('The board is empty; draw something before saving it.');
    await call(chat, 'canvas_draw', { elements: [{ id: 'x', type: 'rectangle', x: 0, y: 0, label: 'X' }] });
    await call(chat, 'canvas_save', { name: 'Queue one' });
    await call(chat, 'canvas_save', { name: 'Queue two' });
    const several = await call(chat, 'canvas_open', { saved: 'queue' });
    expect(several.result.isError).toBe(true);
    expect(several.text).toMatch(/^"queue" matches several saved boards; pass one id: "Queue (one|two)"/);
    expect((await call(chat, 'canvas_open', { saved: 'zzz-none' })).text).toBe('No saved board matches "zzz-none". canvas_search lists them.');
    expect((await call(chat, 'canvas_open', { saved: 'queue one', board: 'own' })).text).toBe('Pass board or saved, not both.');
    const latest = await call(chat, 'canvas_search');
    expect(latest.text).toMatch(/\n\d+ saved boards \(canvas_open \{saved:"<id>"\} loads a copy into this chat's board\):\n- "Queue two" \[[a-z0-9-]+\] 2 el, saved \d{4}-\d\d-\d\d, this workspace\n/);
  });

  it('loads into the chat\'s own board even while it is looking at another chat\'s board', async () => {
    const owner = await connect();
    const ownerBoard = boardId((await call(owner, 'canvas_open', { title: 'Borrowed board' })).text);
    await call(owner, 'canvas_draw', { elements: [{ id: 'kept', type: 'rectangle', x: 0, y: 0, label: 'Kept' }] });
    await call(owner, 'canvas_save', { name: 'Loadable' });
    const chat = await connect();
    const own = boardId((await call(chat, 'canvas_open')).text);
    await call(chat, 'canvas_open', { board: 'Borrowed board' });
    const loaded = await call(chat, 'canvas_open', { saved: 'Loadable' });
    expect(loaded.result.isError).toBeFalsy();
    expect(boardId(loaded.text)).toBe(own);
    expect((await call(owner, 'canvas_read')).text).toMatch(new RegExp(`^Board "Borrowed board"`));
    expect(ownerBoard).not.toBe(own);
  });
});

describe('showing boards', () => {
  it('asks the panel host of this workspace to show the board and never hands the agent a URL', async () => {
    const client = await connect();
    await call(client, 'canvas_open', { open: false });
    const { port, token } = daemon();
    const host = new WebSocket(`ws://127.0.0.1:${port}/ws/host?token=${token}`);
    const shows: Array<{ reqId: string; canvasId: string }> = [];
    host.on('message', (m) => {
      const msg = JSON.parse(String(m));
      shows.push(msg);
      host.send(JSON.stringify({ t: 'shown', reqId: msg.reqId, ok: true }));
    });
    await new Promise((r) => host.once('open', r));
    host.send(JSON.stringify({ t: 'hello', folders: [workspace], focused: false }));
    await new Promise((r) => setTimeout(r, 100));
    const drawn = await call(client, 'canvas_draw', { elements: [{ id: 'x', type: 'rectangle', x: 0, y: 0, label: 'Shown' }] });
    host.close();
    expect(drawn.text).toContain('Shown to the human beside the chat.');
    expect(drawn.text).not.toMatch(/https?:\/\//);
    expect(shows).toHaveLength(1);
    expect(shows[0]!.canvasId).toBe(boardId((await call(client, 'canvas_open', { open: false })).text));
  });

  /** A panel host (editor window) that shows every board it is asked to. */
  async function panelHost(hello: { folders: string[]; hostId?: string; focused?: boolean }) {
    const { port, token } = daemon();
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws/host?token=${token}`);
    const shows: string[] = [];
    ws.on('message', (m) => {
      const msg = JSON.parse(String(m)) as { reqId: string; canvasId: string };
      shows.push(msg.canvasId);
      ws.send(JSON.stringify({ t: 'shown', reqId: msg.reqId, ok: true }));
    });
    await new Promise((r) => ws.once('open', r));
    ws.send(JSON.stringify({ t: 'hello', focused: false, ...hello }));
    await new Promise((r) => setTimeout(r, 100));
    return { shows, close: () => ws.close() };
  }

  it("shows each chat's first drawing only in the window that chat runs in, even when both windows show the same folder", async () => {
    // Desktop starts every chat's MCP server with its window's extension-host pid; the window's panel host says hello with it.
    const chatA = await connect({ env: { WINDSURF_EXT_HOST_PID: '45824', WHITEBOARD_OPEN: '' } });
    const chatB = await connect({ env: { WINDSURF_EXT_HOST_PID: '64248', WHITEBOARD_OPEN: '' } });
    const windowA = await panelHost({ folders: [workspace], hostId: '45824' });
    const windowB = await panelHost({ folders: [workspace], hostId: '64248', focused: true });
    try {
      const drawnB = await call(chatB, 'canvas_draw', { elements: [{ id: 'b', type: 'rectangle', x: 0, y: 0, label: 'B' }] });
      const drawnA = await call(chatA, 'canvas_draw', { elements: [{ id: 'a', type: 'rectangle', x: 0, y: 0, label: 'A' }] });
      expect(drawnA.text).toContain('Shown to the human beside the chat.');
      expect(drawnB.text).toContain('Shown to the human beside the chat.');
      const boardA = boardId((await call(chatA, 'canvas_open', { open: false })).text);
      const boardB = boardId((await call(chatB, 'canvas_open', { open: false })).text);
      expect(boardA).not.toBe(boardB);
      expect(windowA.shows).toEqual([boardA]);
      expect(windowB.shows).toEqual([boardB]);
    } finally {
      windowA.close();
      windowB.close();
    }
  });

  it('WHITEBOARD_HOST_ID names the window explicitly and wins over the editor variable', async () => {
    const chat = await connect({ env: { WINDSURF_EXT_HOST_PID: '45824', WHITEBOARD_HOST_ID: 'my-window', WHITEBOARD_OPEN: '' } });
    const editorWindow = await panelHost({ folders: [workspace], hostId: '45824', focused: true });
    const named = await panelHost({ folders: [], hostId: 'my-window' });
    try {
      await call(chat, 'canvas_draw', { elements: [{ id: 'n', type: 'rectangle', x: 0, y: 0 }] });
      expect(named.shows).toEqual([boardId((await call(chat, 'canvas_open', { open: false })).text)]);
      expect(editorWindow.shows).toEqual([]);
    } finally {
      editorWindow.close();
      named.close();
    }
  });

  it('inside an editor, a window other than the chat\'s own never shows its board', async () => {
    const chat = await connect({ env: { WINDSURF_EXT_HOST_PID: '45824', WHITEBOARD_OPEN: '' } });
    const otherWindow = await panelHost({ folders: [workspace], hostId: '64248', focused: true });
    try {
      const { text } = await call(chat, 'canvas_draw', { elements: [{ id: 'o', type: 'rectangle', x: 0, y: 0 }] });
      expect(text).toContain('No whiteboard panel is connected');
      expect(otherWindow.shows).toEqual([]);
    } finally {
      otherWindow.close();
    }
  });

  it.skipIf(process.platform === 'win32')('outside an editor every new CLI session opens its own fresh board in the browser on its first drawing', async () => {
    // A stand-in for the platform opener (`open` / `xdg-open`) records what would be opened.
    const bin = join(root, 'bin');
    const opened = join(root, 'opened.log');
    mkdirSync(bin, { recursive: true });
    for (const name of ['open', 'xdg-open']) writeFileSync(join(bin, name), `#!/bin/sh\nprintf '%s\\n' "$1" >> ${JSON.stringify(opened)}\n`, { mode: 0o755 });
    const cliSession = () =>
      connect({ env: { PATH: `${bin}${delimiter}${env.PATH}`, WHITEBOARD_OPEN: '' }, unset: ['VSCODE_PID', 'VSCODE_IPC_HOOK_CLI', 'CURSOR_TRACE_ID', 'TERM_PROGRAM'] });
    const sessions = [await cliSession(), await cliSession()];
    const boards: string[] = [];
    for (const [i, session] of sessions.entries()) {
      const { text } = await call(session, 'canvas_draw', { elements: [{ id: `s${i}`, type: 'rectangle', x: 0, y: 0, label: `Session ${i}` }] });
      expect(text).toMatch(/opened with (xdg-)?open/);
      const own = await call(session, 'canvas_open', { open: false });
      expect(own.text).toContain(`[Session ${i}]`);
      expect(own.text).not.toContain(`[Session ${1 - i}]`);
      boards.push(boardId(own.text));
    }
    expect(boards[0]).not.toBe(boards[1]);
    // The opener runs detached; wait for both launches to land.
    const read = () => (existsSync(opened) ? readFileSync(opened, 'utf8').trim().split('\n') : []);
    for (let i = 0; i < 50 && read().length < 2; i++) await new Promise((r) => setTimeout(r, 100));
    const urls = read();
    expect(urls.map((u) => /\/c\/([a-z0-9-]+)\?token=/.exec(u)?.[1]).sort()).toEqual([...boards].sort());
  });

  it('inside an editor without a panel host it opens nothing and tells the agent not to use a browser', async () => {
    const client = await connect({ env: { WINDSURF_EXT_HOST_PID: '1', WHITEBOARD_OPEN: '' } });
    const { text } = await call(client, 'canvas_open');
    expect(text).toContain('No whiteboard panel is connected');
    expect(text).toContain('Do not open board links in a browser or preview tool');
  });
});
