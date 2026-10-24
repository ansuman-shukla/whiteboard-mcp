import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';

/** Where the agent runs: the editor window's panel host id, and whether it runs inside an editor at all. */
export interface EditorWindow {
  host?: string;
  ide: boolean;
}

interface Proc {
  ppid: number;
  env: NodeJS.ProcessEnv;
}

const IDE_ENV = ['WINDSURF_EXT_HOST_PID', 'VSCODE_PID', 'VSCODE_IPC_HOOK_CLI', 'CURSOR_TRACE_ID'];
const HOST_ENV = ['WHITEBOARD_HOST_ID', 'WINDSURF_EXT_HOST_PID'];
const WANTED = new Set([...IDE_ENV, ...HOST_ENV, 'TERM_PROGRAM']);
const MAX_DEPTH = 12;
const PS_TIMEOUT_MS = 2000;

/**
 * The editor window this agent runs in, as the `hostId` its panel host announces, so the board opens
 * beside this chat and not in another window: `WHITEBOARD_HOST_ID` when a host sets it explicitly, else
 * Windsurf/Devin Desktop's `WINDSURF_EXT_HOST_PID` (the extension host that started the chat, which is
 * the process a panel extension runs in).
 */
export function hostHint(env: NodeJS.ProcessEnv = process.env): string | undefined {
  return env.WHITEBOARD_HOST_ID?.trim() || env.WINDSURF_EXT_HOST_PID?.trim() || undefined;
}

/** Agents running inside an editor should get the board in a panel, never a separate browser window. */
export function insideIde(env: NodeJS.ProcessEnv = process.env): boolean {
  return IDE_ENV.some((k) => env[k]) || env.TERM_PROGRAM === 'vscode';
}

/** `ps -E` output: the parent pid, the command line, then the environment as KEY=value words. */
export function parsePs(output: string): Proc | undefined {
  const words = output.trim().split(/\s+/);
  if (!/^\d+$/.test(words[0] ?? '')) return undefined;
  const ppid = Number(words[0]);
  const env: NodeJS.ProcessEnv = {};
  for (const word of words.slice(1)) {
    const eq = word.indexOf('=');
    const key = word.slice(0, eq);
    if (eq > 0 && WANTED.has(key)) env[key] = word.slice(eq + 1);
  }
  return { ppid, env };
}

/** A process's parent and the environment it started with; undefined where that can't be read (Windows, other users). */
export async function readProc(pid: number, platform = process.platform): Promise<Proc | undefined> {
  try {
    if (platform === 'linux') {
      const ppid = Number(/^PPid:\s*(\d+)/m.exec(await readFile(`/proc/${pid}/status`, 'utf8'))?.[1]);
      const env: NodeJS.ProcessEnv = {};
      for (const entry of (await readFile(`/proc/${pid}/environ`, 'utf8')).split('\0')) {
        const eq = entry.indexOf('=');
        if (eq > 0 && WANTED.has(entry.slice(0, eq))) env[entry.slice(0, eq)] = entry.slice(eq + 1);
      }
      return Number.isInteger(ppid) ? { ppid, env } : undefined;
    }
    if (platform !== 'darwin') return undefined;
    const output = await new Promise<string>((done, fail) =>
      execFile('ps', ['-E', '-ww', '-o', 'ppid=,command=', '-p', String(pid)], { timeout: PS_TIMEOUT_MS }, (err, stdout) => (err ? fail(err) : done(stdout))),
    );
    return parsePs(output);
  } catch {
    return undefined;
  }
}

/**
 * The agent's own environment, else its ancestors': some agents (Codex) start MCP servers with only a few
 * variables, so the window id their editor gave them, or the terminal they run in, is found up the
 * process tree. `WHITEBOARD_HOST_ID` set but empty means "no window": nothing is looked up.
 */
export async function editorWindow(env: NodeJS.ProcessEnv = process.env, start = process.ppid, read: (pid: number) => Promise<Proc | undefined> = readProc): Promise<EditorWindow> {
  const host = hostHint(env);
  let ide = insideIde(env);
  if (host || env.WHITEBOARD_HOST_ID !== undefined) return { ...(host ? { host } : {}), ide: ide || !!host };
  const seen = new Set<number>();
  for (let pid = start; pid > 1 && !seen.has(pid) && seen.size < MAX_DEPTH; ) {
    seen.add(pid);
    const proc = await read(pid);
    if (!proc) break;
    const found = hostHint(proc.env);
    if (found) return { host: found, ide: true };
    ide ||= insideIde(proc.env);
    pid = proc.ppid;
  }
  return { ide };
}
