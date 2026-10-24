import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { removeTempDir } from '../helpers/cleanup.js';

/**
 * Opt-in (WHITEBOARD_TEST_VSCODE=1): opens two real, isolated VS Code windows with the extension under
 * development, both showing folder W, runs a real daemon, and has agents in the first window show boards.
 * The agents work on folder X, which only the second window shows, so a board that lost its window id
 * would deterministically land in the second window.
 * WHITEBOARD_TEST_VSCODE_BIN overrides the VS Code executable; WHITEBOARD_TEST_VSCODE_KEEP=1 keeps the temp
 * folder (results, terminal output) for inspection.
 */
const enabled = process.env.WHITEBOARD_TEST_VSCODE === '1';
const repo = fileURLToPath(new URL('../..', import.meta.url));
const cli = join(repo, 'dist', 'cli.js');
const code = process.env.WHITEBOARD_TEST_VSCODE_BIN ?? (process.platform === 'darwin' ? '/Applications/Visual Studio Code.app/Contents/MacOS/Code' : 'code');
const AGENT_BOARDS = ['Terminal agent board', 'Extension agent board', 'Editor agent board'];

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

async function waitFor<T>(what: string, check: () => T | undefined | false, timeoutMs: number): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = check();
    if (value) return value;
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error(`timed out waiting for ${what}`);
}

const exited = (child: ChildProcess, timeoutMs: number): Promise<number | null> =>
  child.exitCode !== null ? Promise.resolve(child.exitCode) : new Promise((resolve) => {
    const timer = setTimeout(() => resolve(null), timeoutMs);
    child.once('exit', (status) => {
      clearTimeout(timer);
      resolve(status);
    });
  });

/** The launching shell's editor and whiteboard variables must not leak into the test windows. */
function cleanEnv(): NodeJS.ProcessEnv {
  return Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^(VSCODE_|ELECTRON_|WINDSURF_|CURSOR_|TERM_PROGRAM|WHITEBOARD_)/.test(key)));
}

describe.skipIf(!enabled)('real VS Code', () => {
  it('shows boards of agents in a window in that window only, one tab per board', { timeout: 300_000 }, async () => {
    expect(existsSync(join(repo, 'dist', 'frontend', 'index.html')), 'run npm run build first').toBe(true);
    // Electron's IPC socket path must stay below 104 characters, so not under os.tmpdir() on macOS.
    const root = realpathSync(mkdtempSync('/tmp/wbv-'));
    const workspace = join(root, 'ws');
    const agentWorkspace = join(root, 'agent-ws');
    const home = join(root, 'home');
    mkdirSync(workspace);
    mkdirSync(agentWorkspace);
    const otherWorkspace = join(root, 'other.code-workspace');
    writeFileSync(otherWorkspace, JSON.stringify({ folders: [{ path: workspace }, { path: agentWorkspace }] }));
    const children: ChildProcess[] = [];
    try {
      const whiteboard = { WHITEBOARD_HOME: home, WHITEBOARD_PORT: String(await freePort()), WHITEBOARD_OPEN: 'none' };
      const daemon = spawn(process.execPath, [cli, 'serve'], { env: { ...cleanEnv(), ...whiteboard, WHITEBOARD_IDLE_MS: '0' }, stdio: 'ignore' });
      children.push(daemon);
      await waitFor('the daemon', () => existsSync(join(home, 'daemon.json')), 20_000);
      const { port } = JSON.parse(readFileSync(join(home, 'daemon.json'), 'utf8')) as { port: number };

      const launch = (role: 'main' | 'other') => {
        const userDir = join(root, `${role}-user`);
        // VS Code's own MCP client gets the whiteboard server, as a user would configure it for agent mode.
        // Its workspace is the window's folder (MCP roots win over WHITEBOARD_WORKSPACE), which both windows
        // show, so the wrapper records the window id the server was started with.
        mkdirSync(join(userDir, 'User'), { recursive: true });
        const record = `printf %s "$WHITEBOARD_HOST_ID" > "${join(root, `${role}-mcp-host-id.txt`)}"; exec "${process.execPath}" "${cli}"`;
        const server = { type: 'stdio', command: '/bin/sh', args: ['-c', record] };
        writeFileSync(join(userDir, 'User', 'mcp.json'), JSON.stringify({ servers: { whiteboard: server } }));
        const child = spawn(code, [
          `--extensionDevelopmentPath=${join(repo, 'vscode')}`,
          `--extensionTestsPath=${join(repo, 'tests', 'vscode', 'suite', 'index.js')}`,
          `--user-data-dir=${userDir}`,
          `--extensions-dir=${join(root, `${role}-extensions`)}`,
          '--disable-workspace-trust',
          '--skip-welcome',
          '--skip-release-notes',
          '--new-window',
          role === 'main' ? workspace : otherWorkspace,
        ], {
          env: {
            ...cleanEnv(),
            ...whiteboard,
            WB_ROLE: role,
            WB_TEST_DIR: root,
            WB_URL: `http://127.0.0.1:${port}`,
            WB_TOKEN: readFileSync(join(home, 'token'), 'utf8').trim(),
            WB_NODE: process.execPath,
            WB_CLI: cli,
            WB_AGENT_WORKSPACE: agentWorkspace,
          },
          stdio: 'ignore',
        });
        children.push(child);
        return child;
      };

      const main = launch('main');
      await waitFor('the main window', () => existsSync(join(root, 'main-ready')) || main.exitCode !== null, 90_000);
      const other = launch('other');
      expect(await exited(main, 200_000), 'the main window finished its run').not.toBeNull();
      await exited(other, 30_000);

      const result = JSON.parse(readFileSync(join(root, 'main.json'), 'utf8'));
      expect(result.error).toBeUndefined();
      const otherTabs: string[] = JSON.parse(readFileSync(join(root, 'other-tabs.json'), 'utf8'));
      expect(result.hostId).toMatch(/^\d+$/);
      expect(result.other.hostId).not.toBe(result.hostId);
      // Precondition: without its window id a board of the agents' workspace lands in the other window.
      expect(result.unhinted).toBe(200);
      expect(result.unhintedHere).toBe(false);
      expect(otherTabs).toContain('Unhinted');

      // Soft, so a broken run reports every path that misrouted.
      expect.soft(result.extensionHostEnv).toBe(result.hostId);
      expect.soft(result.terminalHostId).toBe(result.hostId);
      expect.soft(result.terminalExit).toBe('0');
      expect.soft(result.terminalCall).toContain('Shown to the human beside the chat.');
      expect.soft(result.spawned.stdout).toContain('Shown to the human beside the chat.');
      expect.soft(result.mcp.error).toBeUndefined();
      expect.soft(result.mcp.text).toContain('Shown to the human beside the chat.');
      expect.soft(readFileSync(join(root, 'main-mcp-host-id.txt'), 'utf8')).toBe(result.hostId);
      expect.soft([result.terminalTab, result.spawnedTab, result.mcpTab]).toEqual([true, true, true]);
      for (const title of AGENT_BOARDS) expect.soft(result.viewers[title], `${title} is live in its tab`).toBeGreaterThanOrEqual(1);

      expect.soft(result.reshown).toBe(200);
      expect.soft(result.active).toBe('Terminal agent board');
      expect.soft(result.staleWindowId).toBe(200);
      for (const title of AGENT_BOARDS) expect.soft(result.mainTabs.filter((label: string) => label === title)).toEqual([title]);
      for (const title of AGENT_BOARDS) expect.soft(otherTabs).not.toContain(title);
    } finally {
      for (const child of children) if (child.exitCode === null && child.signalCode === null) child.kill();
      await Promise.all(children.map((child) => exited(child, 15_000)));
      if (process.env.WHITEBOARD_TEST_VSCODE_KEEP === '1') console.log(`kept ${root}`);
      else removeTempDir(root);
    }
  });
});
