import { readFileSync, renameSync, writeFileSync } from 'node:fs';
import { THEME_CHOICES, type ThemeChoice, type ViewerPrefs } from '../shared/protocol.js';
import { ValidationError } from './store.js';

export const DEFAULT_PREFS: ViewerPrefs = { theme: 'system' };

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

export function parsePrefs(input: unknown): ViewerPrefs {
  const theme = isObject(input) ? input.theme : undefined;
  if (!THEME_CHOICES.includes(theme as ThemeChoice)) throw new ValidationError(`prefs.theme must be one of ${THEME_CHOICES.join(', ')}`);
  return { theme: theme as ThemeChoice };
}

/** The saved prefs; the defaults when the file is missing or unreadable, since they're only display settings. */
export function loadPrefs(file: string): ViewerPrefs {
  try {
    return parsePrefs(JSON.parse(readFileSync(file, 'utf8')));
  } catch {
    return DEFAULT_PREFS;
  }
}

export function savePrefs(file: string, prefs: ViewerPrefs): void {
  const tmp = `${file}.tmp-${process.pid}`;
  writeFileSync(tmp, JSON.stringify(prefs), { mode: 0o600 });
  renameSync(tmp, file);
}
