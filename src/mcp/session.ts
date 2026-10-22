import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { stateDir } from '../shared/config.js';
import { CANVAS_ID_PATTERN } from '../shared/protocol.js';

export interface CanvasRef {
  id: string;
  title: string;
}

interface SessionFile {
  lastReadRev?: number;
  current?: CanvasRef;
}

const sha6 = (s: string): string => createHash('sha256').update(s).digest('hex').slice(0, 6);

export function slug(s: string): string {
  return s.toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40).replace(/-+$/, '') || 'canvas';
}

export function defaultCanvas(workspace: string): CanvasRef {
  const abs = resolve(workspace);
  const title = basename(abs) || abs;
  return { id: `${slug(title)}-${sha6(abs)}`, title };
}

export function namedCanvas(workspace: string, name: string): CanvasRef {
  return { id: `${slug(name)}-${sha6(`${resolve(workspace)}\0${name}`)}`, title: name };
}

export function rootToPath(uri: string): string | undefined {
  if (!uri.startsWith('file://')) return undefined;
  try {
    return fileURLToPath(uri);
  } catch {
    return undefined;
  }
}

/**
 * Per-agent-session state: workspace, current board and the revision of the last canvas_read.
 * With `persist`, state lives in `<stateDir>/sessions/` so consecutive CLI calls act as one session.
 */
export class Session {
  private current?: CanvasRef;
  private readonly lastRead = new Map<string, number>();
  private pendingWorkspace: Promise<void> = Promise.resolve();

  constructor(public workspace = process.env.WHITEBOARD_WORKSPACE || process.cwd(), private readonly persist = false) {
    this.workspace = resolve(workspace);
    if (persist) this.current = this.load(defaultCanvas(this.workspace).id).current;
  }

  /** Tool calls wait for an in-flight roots/list so they target the right workspace. */
  waitForWorkspace(update: Promise<string | undefined>): void {
    this.pendingWorkspace = update.then(
      (path) => {
        if (path && resolve(path) !== this.workspace) {
          this.workspace = resolve(path);
          this.current = undefined;
        }
      },
      () => undefined,
    );
  }

  ready(): Promise<void> {
    return this.pendingWorkspace;
  }

  canvas(): CanvasRef {
    return this.current ?? defaultCanvas(this.workspace);
  }

  resolveCanvas(name: string | undefined, existingIds: string[] = []): CanvasRef {
    if (!name) return defaultCanvas(this.workspace);
    if (CANVAS_ID_PATTERN.test(name) && existingIds.includes(name)) return { id: name, title: name };
    return namedCanvas(this.workspace, name);
  }

  setCurrent(ref: CanvasRef): void {
    const isDefault = ref.id === defaultCanvas(this.workspace).id;
    this.current = isDefault ? undefined : ref;
    if (this.persist) this.save(defaultCanvas(this.workspace).id, { current: this.current });
  }

  lastReadRev(id: string): number {
    if (!this.lastRead.has(id) && this.persist) this.lastRead.set(id, this.load(id).lastReadRev ?? 0);
    return this.lastRead.get(id) ?? 0;
  }

  setLastReadRev(id: string, rev: number): void {
    this.lastRead.set(id, rev);
    if (this.persist) this.save(id, { lastReadRev: rev });
  }

  private file(id: string): string {
    return join(stateDir(), 'sessions', `${id}.json`);
  }

  private load(id: string): SessionFile {
    try {
      return JSON.parse(readFileSync(this.file(id), 'utf8')) as SessionFile;
    } catch {
      return {};
    }
  }

  private save(id: string, patch: SessionFile): void {
    try {
      const file = this.file(id);
      mkdirSync(join(stateDir(), 'sessions'), { recursive: true, mode: 0o700 });
      const tmp = `${file}.${process.pid}.tmp`;
      writeFileSync(tmp, JSON.stringify({ ...this.load(id), ...patch }), { mode: 0o600 });
      renameSync(tmp, file);
    } catch {
      // session persistence is best effort
    }
  }
}
