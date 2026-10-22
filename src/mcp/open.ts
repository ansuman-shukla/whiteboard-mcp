import { spawn } from 'node:child_process';

/** Splits a command template into argv without a shell; supports '…' and "…" quoting and backslash escapes. */
export function splitCommand(template: string): string[] {
  const args: string[] = [];
  let cur = '';
  let quote: '"' | "'" | null = null;
  let inArg = false;
  for (let i = 0; i < template.length; i++) {
    const c = template[i]!;
    if (quote) {
      if (c === quote) quote = null;
      else if (c === '\\' && quote === '"' && i + 1 < template.length) cur += template[++i];
      else cur += c;
    } else if (c === '"' || c === "'") {
      quote = c;
      inArg = true;
    } else if (c === '\\' && i + 1 < template.length) {
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
  const argv = splitCommand(mode).map((a) => a.split('{url}').join(url));
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
