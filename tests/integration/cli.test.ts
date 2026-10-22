import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const cli = join(fileURLToPath(new URL('../..', import.meta.url)), 'dist', 'cli.js');
const root = realpathSync(mkdtempSync(join(tmpdir(), 'exl-cli-')));
const home = join(root, 'home');
const workspace = join(root, 'proj');
let env: NodeJS.ProcessEnv;

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

function run(args: string[], input?: string): { code: number | null; stdout: string; stderr: string } {
  const r = spawnSync(process.execPath, [cli, ...args], { cwd: workspace, env, input, encoding: 'utf8', timeout: 15000 });
  return { code: r.status, stdout: r.stdout, stderr: r.stderr };
}

async function humanEdit(canvasId: string): Promise<void> {
  const { port } = JSON.parse(readFileSync(join(home, 'daemon.json'), 'utf8')) as { port: number };
  const token = readFileSync(join(home, 'token'), 'utf8').trim();
  const element = { id: 'scribble', type: 'freedraw', x: 400, y: 300, width: 50, height: 20, version: 1, versionNonce: 7, isDeleted: false, updated: Date.now(), points: [[0, 0], [50, 20]] };
  const res = await fetch(`http://127.0.0.1:${port}/api/canvases/${canvasId}/elements`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ elements: [element], actor: 'human' }),
  });
  expect(res.status).toBe(200);
}

beforeAll(async () => {
  mkdirSync(workspace, { recursive: true });
  env = { ...process.env, WHITEBOARD_HOME: home, WHITEBOARD_PORT: String(await freePort()), WHITEBOARD_OPEN: 'none', WHITEBOARD_IDLE_MS: '60000' };
  delete env.WHITEBOARD_WORKSPACE;
});

afterAll(async () => {
  try {
    const { pid } = JSON.parse(readFileSync(join(home, 'daemon.json'), 'utf8')) as { pid: number };
    process.kill(pid, 'SIGTERM');
    // The daemon flushes boards on shutdown; removing its folder first races with that write.
    for (let i = 0; i < 50; i++) {
      process.kill(pid, 0);
      await new Promise((r) => setTimeout(r, 100));
    }
  } catch {
    // daemon gone
  }
  rmSync(root, { recursive: true, force: true });
});

describe('cli', () => {
  it('lists every tool for harnesses without MCP', () => {
    const r = run(['tools']);
    expect(r.code).toBe(0);
    for (const name of ['canvas_open', 'canvas_read', 'canvas_draw', 'canvas_delete', 'canvas_focus', 'canvas_screenshot', 'canvas_mermaid', 'canvas_export', 'canvas_guide']) expect(r.stdout).toContain(name);
  });

  it('shares the read cursor across separate call processes', async () => {
    const draw = run(['call', 'canvas_draw', JSON.stringify({ elements: [{ id: 'api', type: 'rectangle', x: 0, y: 0, label: 'API' }] })]);
    expect(draw.code, draw.stderr).toBe(0);
    expect(draw.stdout).toContain('api');

    const first = run(['call', 'canvas_read']);
    expect(first.code).toBe(0);
    expect(first.stdout).toContain('[API]');

    const canvasId = /proj-[0-9a-f]{6}/.exec(run(['status']).stdout)?.[0];
    expect(canvasId).toBeDefined();
    await humanEdit(canvasId!);

    const piggyback = run(['call', 'canvas_draw', JSON.stringify({ elements: [{ id: 'api', x: 40 }] })]);
    expect(piggyback.stdout).toMatch(/human changed 1 element/i);

    const second = run(['call', 'canvas_read']);
    const changeLine = /^.*scribble.*hand sketch.*$/m;
    expect(second.stdout.split('since your last read')[1]).toMatch(changeLine);
    const third = run(['call', 'canvas_read', '-'], '{}');
    expect(third.code).toBe(0);
    expect(third.stdout).toContain('[API]');
    expect(third.stdout).toContain('No human changes since your last read.');
  });

  it('rejects bad arguments with exit code 1 and nothing on stdout', () => {
    const bad = run(['call', 'canvas_draw', '{not json']);
    expect(bad.code).toBe(1);
    expect(bad.stdout).toBe('');
    expect(bad.stderr).toMatch(/not valid JSON/);
    expect(run(['call', 'no_such_tool', '{}']).code).toBe(1);
    expect(run(['call', 'canvas_delete', '{}']).code).toBe(1);
  });

  it("prints the CLI chat's board URL, the same across calls, and finds workspace boards by title", () => {
    const own = run(['url']);
    expect(own.code, own.stderr).toBe(0);
    expect(own.stdout).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/c\/proj-[0-9a-f]{6}\?token=[0-9a-f]{64}\n$/);
    expect(run(['url']).stdout).toBe(own.stdout);
    expect(run(['call', 'canvas_open', '{"title":"Auth flow","open":false}']).code).toBe(0);
    expect(run(['url', 'auth flow']).stdout).toBe(own.stdout);
    const missing = run(['url', 'nope']);
    expect(missing.code).toBe(1);
    expect(missing.stderr).toContain('no board "nope"');
  });

  it('prints its version', () => {
    const r = run(['--version']);
    expect(r.stdout.trim()).toMatch(/^\d+\.\d+\.\d+$/);
  });
});
