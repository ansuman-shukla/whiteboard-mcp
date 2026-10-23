import { spawn } from 'node:child_process';

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

/** Opens the viewer without ever throwing or blocking; returns a short status for tool output. */
export function openViewer(url: string): string {
  const argv = openerArgv(url);
  if (!argv) return 'not opened (WHITEBOARD_OPEN=none)';
  const [cmd, ...args] = argv;
  if (!cmd) return 'not opened (empty WHITEBOARD_OPEN)';
  try {
    const child = spawn(cmd, args, { detached: true, stdio: 'ignore', windowsVerbatimArguments: cmd === 'cmd' });
    child.on('error', () => undefined);
    child.unref();
    return `opened with ${cmd}`;
  } catch (err) {
    return `could not open (${err instanceof Error ? err.message : String(err)})`;
  }
}
