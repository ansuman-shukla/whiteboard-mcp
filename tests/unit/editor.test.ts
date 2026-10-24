import { spawn } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import { editorWindow, parsePs, readProc } from '../../src/mcp/editor.js';

/** A fake process tree: pid -> parent and starting environment. */
const tree = (procs: Record<number, { ppid: number; env?: NodeJS.ProcessEnv }>) => async (pid: number) => {
  const p = procs[pid];
  return p && { ppid: p.ppid, env: p.env ?? {} };
};

describe('editorWindow', () => {
  it("uses the agent's own environment first", async () => {
    expect(await editorWindow({ WHITEBOARD_HOST_ID: '4242' }, 10, tree({}))).toEqual({ host: '4242', ide: true });
    expect(await editorWindow({ WINDSURF_EXT_HOST_PID: '77' }, 10, tree({}))).toEqual({ host: '77', ide: true });
  });

  it('finds the window id and the editor up the process tree when the agent strips the environment (Codex)', async () => {
    // mcp server <- codex <- zsh (integrated terminal, has the window id) <- pty host
    const read = tree({ 10: { ppid: 20 }, 20: { ppid: 30, env: { TERM_PROGRAM: 'vscode' } }, 30: { ppid: 1, env: { WHITEBOARD_HOST_ID: '4242' } } });
    expect(await editorWindow({}, 10, read)).toEqual({ host: '4242', ide: true });
  });

  it('reports an editor without a window id, and nothing outside editors', async () => {
    expect(await editorWindow({}, 10, tree({ 10: { ppid: 20, env: { VSCODE_PID: '9' } }, 20: { ppid: 1 } }))).toEqual({ ide: true });
    expect(await editorWindow({}, 10, tree({ 10: { ppid: 20 }, 20: { ppid: 1 } }))).toEqual({ ide: false });
    expect(await editorWindow({}, 10, tree({}))).toEqual({ ide: false });
  });

  it('WHITEBOARD_HOST_ID set but empty means no window: nothing is looked up', async () => {
    let reads = 0;
    const read = async () => {
      reads++;
      return { ppid: 1, env: { WHITEBOARD_HOST_ID: '4242' } };
    };
    expect(await editorWindow({ WHITEBOARD_HOST_ID: '' }, 10, read)).toEqual({ ide: false });
    expect(reads).toBe(0);
  });

  it('stops on cycles and after a bounded depth', async () => {
    const loop = tree({ 10: { ppid: 20 }, 20: { ppid: 10 } });
    expect(await editorWindow({}, 10, loop)).toEqual({ ide: false });
    let reads = 0;
    const deep = async (pid: number) => (reads++, { ppid: pid + 1, env: {} });
    await editorWindow({}, 10, deep);
    expect(reads).toBeLessThanOrEqual(12);
  });
});

describe('parsePs', () => {
  it('reads the parent pid and the wanted variables from ps -E output', () => {
    expect(parsePs('  812 /usr/bin/codex app-server PATH=/bin WHITEBOARD_HOST_ID=4242 TERM_PROGRAM=vscode SECRET=x\n')).toEqual({ ppid: 812, env: { WHITEBOARD_HOST_ID: '4242', TERM_PROGRAM: 'vscode' } });
    expect(parsePs('')).toBeUndefined();
  });
});

describe.skipIf(process.platform !== 'darwin' && process.platform !== 'linux')('readProc on a real process', () => {
  it("reads another process's parent and starting environment", async () => {
    const child = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 5000)'], { env: { PATH: process.env.PATH, WHITEBOARD_HOST_ID: '4242', VSCODE_PID: '99' }, stdio: 'ignore' });
    try {
      await new Promise((r) => setTimeout(r, 200));
      const proc = await readProc(child.pid!);
      expect(proc).toEqual({ ppid: process.pid, env: { WHITEBOARD_HOST_ID: '4242', VSCODE_PID: '99' } });
      expect(await editorWindow({}, child.pid!)).toEqual({ host: '4242', ide: true });
    } finally {
      child.kill();
    }
  });
});
