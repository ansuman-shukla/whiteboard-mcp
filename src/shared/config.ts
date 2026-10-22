import { mkdirSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

export const APP_NAME = 'whiteboard-mcp';
export const DEFAULT_PORT = 47428;

// src/shared/config.ts and dist/shared/config.js are both two levels below the package root.
export const VERSION: string = (JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8')) as { version: string }).version;

export interface DaemonInfo {
  pid: number;
  port: number;
  startedAt: number;
  version: string;
}

export function stateDir(): string {
  const dir = process.env.WHITEBOARD_HOME || join(homedir(), '.whiteboard-mcp');
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  return dir;
}

export function preferredPort(): number {
  const port = Number(process.env.WHITEBOARD_PORT);
  return Number.isInteger(port) && port > 0 && port < 65536 ? port : DEFAULT_PORT;
}

export type StateFile = 'daemon.json' | 'token' | 'daemon.lock' | 'canvases' | 'daemon.log';

export function statePath(name: StateFile, dir = stateDir()): string {
  return join(dir, name);
}
