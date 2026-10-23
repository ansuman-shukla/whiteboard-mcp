import { spawn, type ChildProcess } from 'node:child_process';

const OPEN_WAIT_MS = 1500;

export interface OpenResult {
  opened: boolean;
  note: string;
}

/**
 * Splits a command template into argv without a shell, with '…' and "…" quoting. As in a POSIX shell, a
 * backslash inside "…" only escapes " and \, so Windows paths survive quoting; unquoted, it escapes any
 * character, except on Windows where it only escapes ".
 */
export function splitCommand(template: string, platform = process.platform): string[] {
  const args: string[] = [];
  let cur = '';
  let quote: '"' | "'" | null = null;
  let inArg = false;
  for (let i = 0; i < template.length; i++) {
    const c = template[i]!;
    const next = template[i + 1];
    if (quote) {
      if (c === quote) quote = null;
      else if (c === '\\' && quote === '"' && (next === '"' || next === '\\')) cur += template[++i];
      else cur += c;
    } else if (c === '"' || c === "'") {
      quote = c;
      inArg = true;
    } else if (c === '\\' && next !== undefined && (platform !== 'win32' || next === '"')) {
      cur += template[++i];
      inArg = true;
    } else if (/\s/.test(c)) {
      if (inArg) args.push(cur);
      cur = '';
      inArg = false;
    } else {
      cur += c;
      inArg = true;
    }
  }
  if (inArg) args.push(cur);
  return args;
}

export function openerArgv(url: string, setting = process.env.WHITEBOARD_OPEN, platform = process.platform): string[] | null {
  const mode = setting?.trim();
  if (mode === 'none') return null;
  if (!mode || mode === 'browser' || mode === 'auto') {
    if (platform === 'darwin') return ['open', url];
    // run verbatim (see openViewer) so cmd sees the quotes and doesn't split the URL at '&'
    if (platform === 'win32') return ['cmd', '/c', 'start', '""', `"${url}"`];
    return ['xdg-open', url];
  }
  const argv = splitCommand(mode, platform).map((a) => a.split('{url}').join(url));
  return mode.includes('{url}') ? argv : [...argv, url];
}

/**
 * Opens the viewer without ever throwing. Waits briefly for the opener's exit so a blocked one
 * (e.g. `open` inside a sandbox) is reported instead of claimed as opened.
 */
export function openViewer(url: string, setting = process.env.WHITEBOARD_OPEN, waitMs = OPEN_WAIT_MS): Promise<OpenResult> {
  const argv = openerArgv(url, setting);
  if (!argv) return Promise.resolve({ opened: false, note: 'not opened (WHITEBOARD_OPEN=none)' });
  const [cmd, ...args] = argv;
  if (!cmd) return Promise.resolve({ opened: false, note: 'not opened (empty WHITEBOARD_OPEN)' });
  return new Promise((resolve) => {
    let child: ChildProcess;
    try {
      child = spawn(cmd, args, { detached: true, stdio: 'ignore', windowsVerbatimArguments: cmd === 'cmd' });
    } catch (err) {
      return resolve({ opened: false, note: `could not open (${err instanceof Error ? err.message : String(err)})` });
    }
    const settle = (result: OpenResult) => {
      clearTimeout(timer);
      child.removeAllListeners();
      child.on('error', () => undefined);
      child.unref();
      resolve(result);
    };
    // Still running after the wait: a browser started directly, not a launcher that hands off and exits.
    const timer = setTimeout(() => settle({ opened: true, note: `opened with ${cmd}` }), waitMs);
    child.once('error', (err) => settle({ opened: false, note: `could not open (${err.message})` }));
    child.once('exit', (code, signal) =>
      settle(code === 0 ? { opened: true, note: `opened with ${cmd}` } : { opened: false, note: `could not open (${cmd} exited with ${code === null ? `signal ${signal}` : `code ${code}`})` }),
    );
  });
}
