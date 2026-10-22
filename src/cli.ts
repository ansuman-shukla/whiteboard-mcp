#!/usr/bin/env node
import { readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CanvasClient } from './canvas/client.js';
import { runDaemon } from './canvas/daemon.js';
import { APP_NAME, VERSION, statePath, type DaemonInfo } from './shared/config.js';
import { startMcpServer } from './mcp/server.js';
import { Session } from './mcp/session.js';
import { TOOLS, ToolContext, callTool, getTool, type ToolResult } from './mcp/tools.js';

const HELP = `${APP_NAME} ${VERSION} — live Excalidraw canvas for coding agents

Usage:
  ${APP_NAME} [mcp]              MCP stdio server (default)
  ${APP_NAME} call <tool> [json|-]  run a tool once (JSON args inline or on stdin)
  ${APP_NAME} tools [--json]       list tools and their input schemas
  ${APP_NAME} open                 show your board (panel or browser)
  ${APP_NAME} url [board]          print a board's viewer URL (yours, or a workspace board by id/title)
  ${APP_NAME} status               show the canvas daemon and its boards
  ${APP_NAME} stop                 stop the canvas daemon
  ${APP_NAME} serve                run the canvas daemon in the foreground
  ${APP_NAME} --version | --help
`;

const out = (s: string): void => void process.stdout.write(s.endsWith('\n') ? s : `${s}\n`);
const fail = (msg: string, code = 1): never => {
  process.stderr.write(`${APP_NAME}: ${msg}\n`);
  process.exit(code);
};

function readDaemonInfo(): DaemonInfo | undefined {
  try {
    return JSON.parse(readFileSync(statePath('daemon.json'), 'utf8')) as DaemonInfo;
  } catch {
    return undefined;
  }
}

async function health(port: number): Promise<{ pid?: number; version?: string } | undefined> {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(1500) });
    return res.ok ? ((await res.json()) as { pid?: number; version?: string }) : undefined;
  } catch {
    return undefined;
  }
}

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString('utf8');
}

function printResult(result: ToolResult): void {
  for (const item of result.content) {
    if (item.type === 'text') out(item.text);
    else {
      const file = join(tmpdir(), `${APP_NAME}-${Date.now()}.png`);
      writeFileSync(file, Buffer.from(item.data, 'base64'));
      out(`[image saved to ${file}]`);
    }
  }
}

async function runCall(name: string | undefined, raw: string | undefined): Promise<number> {
  if (!name) return fail(`usage: ${APP_NAME} call <tool> [json|-]  (tools: ${TOOLS.map((t) => t.name).join(', ')})`);
  const tool = getTool(name);
  if (!tool) return fail(`unknown tool "${name}". Available: ${TOOLS.map((t) => t.name).join(', ')}`);
  const source = raw === '-' ? await readStdin() : (raw ?? '');
  let args: unknown = {};
  if (source.trim()) {
    try {
      args = JSON.parse(source);
    } catch (err) {
      return fail(`arguments are not valid JSON: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  if (typeof args !== 'object' || args === null || Array.isArray(args)) return fail('arguments must be a JSON object');
  const result = await callTool(tool, args, new ToolContext(new Session(undefined, true)));
  printResult(result);
  return result.isError ? 1 : 0;
}

function printTools(json: boolean): void {
  const list = TOOLS.map(({ name, description, inputSchema }) => ({ name, description, inputSchema }));
  if (json) return out(JSON.stringify(list, null, 2));
  for (const t of list) out(`${t.name}\n  ${t.description}\n  input: ${JSON.stringify(t.inputSchema)}\n`);
  out(`Run: ${APP_NAME} call <tool> '<json args>'`);
}

async function status(): Promise<number> {
  const info = readDaemonInfo();
  const h = info ? await health(info.port) : undefined;
  if (!info || !h) {
    out('Canvas daemon: not running (it starts automatically on first use).');
    return 0;
  }
  const client = await CanvasClient.connect({ autoStart: false });
  const boards = await client.list();
  out(`Canvas daemon: running, pid ${h.pid ?? info.pid}, version ${h.version ?? info.version}, ${client.baseUrl}`);
  out(boards.length ? 'Boards:' : 'No boards yet.');
  for (const b of boards) out(`  ${b.id}  "${b.title}"  ${b.elementCount} elements, ${b.viewers} viewers  ${client.viewerUrl(b.id)}`);
  return 0;
}

async function stop(): Promise<number> {
  const info = readDaemonInfo();
  const h = info ? await health(info.port) : undefined;
  if (!info || !h) {
    out('Canvas daemon is not running.');
    return 0;
  }
  if (h.pid !== info.pid) return fail(`daemon.json says pid ${info.pid} but port ${info.port} reports pid ${String(h.pid)}; not stopping anything.`);
  process.kill(info.pid, 'SIGTERM');
  for (let i = 0; i < 30; i++) {
    await new Promise((r) => setTimeout(r, 100));
    try {
      process.kill(info.pid, 0);
    } catch {
      out(`Stopped canvas daemon (pid ${info.pid}).`);
      return 0;
    }
  }
  return fail(`sent SIGTERM to pid ${info.pid} but it is still running.`);
}

async function open(name: string | undefined): Promise<number> {
  const result = await callTool(getTool('canvas_open')!, name ? { board: name } : {}, new ToolContext(new Session(undefined, true)));
  printResult(result);
  return result.isError ? 1 : 0;
}

/** Prints a board's viewer URL: the CLI chat's own board, or a workspace board by id or title. */
async function url(board: string | undefined): Promise<number> {
  const ctx = await new ToolContext(new Session(undefined, true)).forChat();
  const client = await ctx.connect();
  if (!board) {
    const { ref } = await ctx.canvas();
    out(client.viewerUrl(ref.id));
    return 0;
  }
  const match = (await client.list()).find((b) => b.workspace === ctx.session.workspace && (b.id === board || b.title.toLowerCase() === board.toLowerCase()));
  if (!match) return fail(`no board "${board}" in ${ctx.session.workspace}`);
  out(client.viewerUrl(match.id));
  return 0;
}

function serveMcp(): void {
  const conn = startMcpServer();
  process.on('unhandledRejection', (err) => {
    if (process.env.WHITEBOARD_DEBUG === '1') process.stderr.write(`[${APP_NAME}] unhandled: ${String(err)}\n`);
  });
  // The daemon is shared and detached; only this stdio process exits.
  conn.onClose(() => {
    setTimeout(() => process.exit(0), 1000).unref();
    void conn.drain(800).then(() => process.stdout.write('', () => process.exit(0)));
  });
}

async function main(argv: string[]): Promise<void> {
  const [cmd, ...rest] = argv;
  switch (cmd) {
    case undefined:
    case 'mcp':
      return serveMcp();
    case 'serve':
      return runDaemon();
    case 'call':
      process.exitCode = await runCall(rest[0], rest[1]);
      return;
    case 'tools':
      return printTools(rest.includes('--json'));
    case 'open':
      process.exitCode = await open(rest[0]);
      return;
    case 'url':
      process.exitCode = await url(rest[0]);
      return;
    case 'status':
      process.exitCode = await status();
      return;
    case 'stop':
      process.exitCode = await stop();
      return;
    case '--version':
    case '-v':
    case 'version':
      return out(VERSION);
    case '--help':
    case '-h':
    case 'help':
      return out(HELP);
    default:
      fail(`unknown command "${cmd}"\n\n${HELP}`, 2);
  }
}

const [command] = process.argv.slice(2);
const longRunning = command === undefined || command === 'mcp' || command === 'serve';
main(process.argv.slice(2)).then(
  // one-shot commands exit promptly even if a keep-alive socket lingers
  () => {
    if (!longRunning) process.stdout.write('', () => process.exit());
  },
  (err: unknown) => fail(err instanceof Error ? err.message : String(err)),
);
