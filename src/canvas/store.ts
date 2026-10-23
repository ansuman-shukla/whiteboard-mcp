import { randomInt, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  CANVAS_ID_PATTERN,
  incomingWins,
  type Actor,
  type ApplyResponse,
  type BinaryFile,
  type CanvasMeta,
  type CanvasNote,
  type CanvasSearchHit,
  type CanvasSnapshot,
  type CanvasSummary,
  type ChangeRecord,
  type ChangesResponse,
  type ExElement,
} from '../shared/protocol.js';
import { DEFAULT_SEARCH_LIMIT, MAX_SEARCH_LIMIT, matchTerms, searchTerms, textLines, type Match } from './search.js';

export class ValidationError extends Error {
  constructor(message: string, readonly status = 400) {
    super(message);
    this.name = 'ValidationError';
  }
}

export class NotFoundError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'NotFoundError';
  }
}

export interface CanvasStoreOptions {
  dir: string;
  flushMs?: number;
  tombstoneTtlMs?: number;
  changeLogLimit?: number;
  maxNotes?: number;
  maxFilesBytes?: number;
  now?: () => number;
  /** Receives background flush failures; dirty canvases are retried on the next change. */
  onError?: (err: unknown) => void;
}

interface CanvasFile {
  id: string;
  title: string;
  workspace?: string;
  chat?: string;
  rev: number;
  updatedAt: number;
  elements: ExElement[];
  files: Record<string, BinaryFile>;
  notes: CanvasNote[];
}

interface Canvas {
  id: string;
  title: string;
  workspace?: string;
  chat?: string;
  rev: number;
  updatedAt: number;
  elements: Map<string, ExElement>;
  files: Map<string, BinaryFile>;
  notes: CanvasNote[];
  log: ChangeRecord[];
  /** The log holds every record with rev > logBase. */
  logBase: number;
  dirty: boolean;
  lastAccess: number;
}

export const MAX_NOTE_LENGTH = 4000;
const MAX_META_LENGTH = 4096;

/** Only string workspace/chat fields, omitted when absent. */
function meta(source: { workspace?: unknown; chat?: unknown }): { workspace?: string; chat?: string } {
  return {
    ...(typeof source.workspace === 'string' && source.workspace ? { workspace: source.workspace } : {}),
    ...(typeof source.chat === 'string' && source.chat ? { chat: source.chat } : {}),
  };
}
const MAX_ID_LENGTH = 128;

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const isFiniteNumber = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const isId = (v: unknown): v is string => typeof v === 'string' && v.length > 0 && v.length <= MAX_ID_LENGTH;

function elementProblem(el: unknown): string | undefined {
  if (!isObject(el)) return 'element must be an object';
  if (!isId(el.id)) return `element id must be a string of 1-${MAX_ID_LENGTH} chars`;
  if (typeof el.type !== 'string') return `element ${el.id}: type must be a string`;
  for (const key of ['x', 'y', 'width', 'height', 'version', 'versionNonce', 'updated'] as const) {
    if (!isFiniteNumber(el[key])) return `element ${el.id}: ${key} must be a finite number`;
  }
  if (typeof el.isDeleted !== 'boolean') return `element ${el.id}: isDeleted must be a boolean`;
  return undefined;
}

function fileProblem(file: unknown): string | undefined {
  if (!isObject(file)) return 'file must be an object';
  if (!isId(file.id)) return `file id must be a string of 1-${MAX_ID_LENGTH} chars`;
  if (typeof file.mimeType !== 'string') return `file ${file.id}: mimeType must be a string`;
  if (typeof file.dataURL !== 'string' || !file.dataURL.startsWith('data:')) return `file ${file.id}: dataURL must be a data: URL string`;
  return undefined;
}

export function validateElements(elements: unknown): ExElement[] {
  if (!Array.isArray(elements)) throw new ValidationError('elements must be an array');
  for (const el of elements) {
    const problem = elementProblem(el);
    if (problem) throw new ValidationError(problem);
  }
  return elements as ExElement[];
}

function validateFiles(files: unknown, now: number): BinaryFile[] {
  if (files === undefined) return [];
  if (!Array.isArray(files)) throw new ValidationError('files must be an array');
  return files.map((file: unknown) => {
    const problem = fileProblem(file);
    if (problem) throw new ValidationError(problem);
    const f = file as BinaryFile;
    return { id: f.id, mimeType: f.mimeType, dataURL: f.dataURL, created: isFiniteNumber(f.created) ? f.created : now };
  });
}

export function referencedFileIds(elements: Iterable<ExElement>): Set<string> {
  const ids = new Set<string>();
  for (const el of elements) if (!el.isDeleted && el.type === 'image' && typeof el.fileId === 'string') ids.add(el.fileId);
  return ids;
}

export class CanvasStore {
  private readonly dir: string;
  private readonly flushMs: number;
  private readonly tombstoneTtlMs: number;
  private readonly changeLogLimit: number;
  private readonly maxNotes: number;
  private readonly maxFilesBytes: number;
  private readonly now: () => number;
  private readonly onError: (err: unknown) => void;
  private readonly canvases = new Map<string, Canvas>();
  private flushTimer: NodeJS.Timeout | undefined;

  constructor(opts: CanvasStoreOptions) {
    this.dir = opts.dir;
    this.flushMs = opts.flushMs ?? 300;
    this.tombstoneTtlMs = opts.tombstoneTtlMs ?? 24 * 60 * 60 * 1000;
    this.changeLogLimit = opts.changeLogLimit ?? 5000;
    this.maxNotes = opts.maxNotes ?? 200;
    this.maxFilesBytes = opts.maxFilesBytes ?? 25 * 1024 * 1024;
    this.now = opts.now ?? Date.now;
    this.onError = opts.onError ?? (() => {});
    mkdirSync(this.dir, { recursive: true, mode: 0o700 });
  }

  get loadedCount(): number {
    return this.canvases.size;
  }

  list(): CanvasSummary[] {
    return [...this.everyCanvas()].map(({ summary }) => summary).sort((a, b) => b.updatedAt - a.updatedAt);
  }

  /**
   * Non-empty boards whose title, id, folder name or text contain every word of the query (all when empty):
   * those of `workspace` first, then by how many words the title matches, then the most recently changed.
   */
  search(query: string, workspace?: string, limit = DEFAULT_SEARCH_LIMIT): CanvasSearchHit[] {
    const terms = searchTerms(query);
    const hits: Array<Match & { summary: CanvasSummary; here: boolean }> = [];
    for (const { summary, elements } of this.everyCanvas()) {
      if (!summary.elementCount) continue;
      const match = matchTerms(terms, { id: summary.id, name: summary.title, workspace: summary.workspace, lines: textLines(elements) });
      if (match) hits.push({ ...match, summary, here: !!workspace && summary.workspace === workspace });
    }
    hits.sort((a, b) => Number(b.here) - Number(a.here) || b.nameHits - a.nameHits || b.summary.updatedAt - a.summary.updatedAt);
    return hits.slice(0, Math.max(1, Math.min(limit, MAX_SEARCH_LIMIT))).map((h) => ({ ...h.summary, ...(h.snippet ? { snippet: h.snippet } : {}) }));
  }

  /** Every board, loaded ones from memory and the rest from disk, without loading them. */
  private *everyCanvas(): Generator<{ summary: CanvasSummary; elements: Iterable<ExElement> }> {
    const seen = new Set<string>();
    for (const c of this.canvases.values()) {
      seen.add(c.id);
      yield { summary: this.summary(c), elements: c.elements.values() };
    }
    for (const name of readdirSync(this.dir)) {
      const id = name.endsWith('.json') ? name.slice(0, -5) : '';
      if (!CANVAS_ID_PATTERN.test(id) || seen.has(id)) continue;
      const data = this.readFile(id);
      if (!data) continue;
      const summary = { id, title: data.title, elementCount: data.elements.filter((el) => !el.isDeleted).length, updatedAt: data.updatedAt, viewers: 0, ...meta(data) };
      yield { summary, elements: data.elements };
    }
  }

  has(id: string): boolean {
    return CANVAS_ID_PATTERN.test(id) && (this.canvases.has(id) || existsSync(this.filePath(id)));
  }

  /** Creates the board if needed. A new title renames it; workspace and chat are set once. */
  ensure(id: string, info: CanvasMeta = {}): CanvasSummary {
    if (!CANVAS_ID_PATTERN.test(id)) throw new ValidationError(`invalid canvas id "${id}" (expected ${CANVAS_ID_PATTERN.source})`);
    for (const key of ['title', 'workspace', 'chat'] as const) {
      const value = info[key];
      if (value !== undefined && (typeof value !== 'string' || value.length > MAX_META_LENGTH)) throw new ValidationError(`${key} must be a string of at most ${MAX_META_LENGTH} characters`);
    }
    const title = info.title?.trim();
    let c = this.load(id);
    if (!c) {
      const now = this.now();
      c = { id, title: title || id, rev: 0, updatedAt: now, elements: new Map(), files: new Map(), notes: [], log: [], logBase: 0, dirty: false, lastAccess: now };
      this.canvases.set(id, c);
      this.markDirty(c);
    } else if (title && title !== c.title) {
      c.title = title;
      this.markDirty(c);
    }
    for (const key of ['workspace', 'chat'] as const) {
      if (info[key] && !c[key]) {
        c[key] = info[key];
        this.markDirty(c);
      }
    }
    return this.summary(c);
  }

  summaryOf(id: string): CanvasSummary {
    return this.summary(this.get(id));
  }

  snapshot(id: string, viewers = 0): CanvasSnapshot {
    const c = this.get(id);
    return {
      id: c.id,
      title: c.title,
      rev: c.rev,
      elements: [...c.elements.values()].filter((el) => !el.isDeleted),
      files: Object.fromEntries(c.files),
      notes: [...c.notes],
      viewers,
    };
  }

  /** Current stored state (including tombstones) of the given element ids. */
  pick(id: string, ids: readonly string[]): ExElement[] {
    const c = this.get(id);
    return ids.flatMap((elId) => c.elements.get(elId) ?? []);
  }

  apply(id: string, elements: unknown, actor: Actor, files?: unknown): ApplyResponse {
    const c = this.get(id);
    const incoming = validateElements(elements);
    const incomingFiles = validateFiles(files, this.now());

    const winners = new Map<string, ExElement>();
    const stale: string[] = [];
    for (const el of incoming) {
      if (incomingWins(el, winners.get(el.id) ?? c.elements.get(el.id))) winners.set(el.id, el);
      else if (!winners.has(el.id)) stale.push(el.id);
    }

    if (incomingFiles.length) {
      const projected = new Map(c.elements);
      for (const [elId, el] of winners) projected.set(elId, el);
      const keep = referencedFileIds(projected.values());
      const fresh = new Map(incomingFiles.map((f) => [f.id, f]));
      let total = 0;
      for (const [fileId, f] of new Map([...c.files, ...fresh])) if (keep.has(fileId) || fresh.has(fileId)) total += f.dataURL.length;
      if (total > this.maxFilesBytes) throw new ValidationError(`canvas files exceed ${this.maxFilesBytes} bytes`, 413);
      for (const f of incomingFiles) c.files.set(f.id, f);
      if (!winners.size) this.markDirty(c);
    }

    if (!winners.size) return { rev: c.rev, applied: [], stale };
    const rev = ++c.rev;
    const records: ChangeRecord[] = [];
    for (const [elId, el] of winners) {
      const prev = c.elements.get(elId);
      const wasLive = !!prev && !prev.isDeleted;
      if (!el.isDeleted) records.push({ rev, actor, id: elId, kind: wasLive ? 'updated' : 'created' });
      else if (wasLive) records.push({ rev, actor, id: elId, kind: 'deleted' });
      c.elements.set(elId, el);
    }
    this.record(c, records);
    return { rev, applied: [...winners.keys()], stale };
  }

  clear(id: string, actor: Actor): ApplyResponse {
    return this.replace(id, [], actor);
  }

  /**
   * Makes `elements` the board's whole scene: every other live element is deleted, and each incoming
   * one gets a version above anything stored for its id, so it wins over tombstones and old replicas.
   */
  replace(id: string, elements: unknown, actor: Actor, files?: unknown): ApplyResponse {
    const c = this.get(id);
    const incoming = validateElements(elements);
    const now = this.now();
    const bump = (el: ExElement, isDeleted: boolean): ExElement => ({
      ...el,
      version: Math.max(el.version, c.elements.get(el.id)?.version ?? 0) + 1,
      versionNonce: randomInt(2 ** 31 - 1),
      isDeleted,
      updated: now,
    });
    const live = incoming.filter((el) => !el.isDeleted);
    const keep = new Set(live.map((el) => el.id));
    const removed = [...c.elements.values()].filter((el) => !el.isDeleted && !keep.has(el.id)).map((el) => bump(el, true));
    return this.apply(id, [...removed, ...live.map((el) => bump(el, false))], actor, files);
  }

  changes(id: string, since: number): ChangesResponse {
    const c = this.get(id);
    if (since === c.rev) return { rev: c.rev, full: false, changes: [], elements: [], notes: [] };
    // A `since` ahead of rev comes from another timeline (canvas recreated, unflushed writes lost): resync.
    const ahead = since > c.rev;
    const notes = ahead ? [...c.notes] : c.notes.filter((n) => n.rev > since);
    if (since < c.logBase || ahead) {
      return { rev: c.rev, full: true, changes: [], elements: [...c.elements.values()].filter((el) => !el.isDeleted), notes };
    }
    const changes = c.log.filter((r) => r.rev > since);
    const elements: ExElement[] = [];
    for (const elId of new Set(changes.map((r) => r.id))) {
      const el = c.elements.get(elId);
      if (el) elements.push(el);
    }
    return { rev: c.rev, full: false, changes, elements, notes };
  }

  addNote(id: string, text: unknown): CanvasNote {
    const c = this.get(id);
    if (typeof text !== 'string' || !text.trim()) throw new ValidationError('note text must be a non-empty string');
    const trimmed = text.trim();
    if (trimmed.length > MAX_NOTE_LENGTH) throw new ValidationError(`note text exceeds ${MAX_NOTE_LENGTH} characters`);
    const note: CanvasNote = { id: randomUUID(), text: trimmed, at: this.now(), rev: ++c.rev };
    c.notes.push(note);
    if (c.notes.length > this.maxNotes) c.notes.splice(0, c.notes.length - this.maxNotes);
    this.markDirty(c);
    return note;
  }

  remove(id: string): boolean {
    if (!CANVAS_ID_PATTERN.test(id)) return false;
    const existed = this.canvases.delete(id);
    try {
      unlinkSync(this.filePath(id));
      return true;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
      return existed;
    }
  }

  flush(): void {
    if (this.flushTimer) clearTimeout(this.flushTimer);
    this.flushTimer = undefined;
    let failure: unknown;
    for (const c of this.canvases.values()) {
      if (!c.dirty) continue;
      try {
        this.save(c);
      } catch (err) {
        failure ??= err;
      }
    }
    if (failure) throw failure;
  }

  close(): void {
    this.flush();
  }

  unloadIdle(isInUse: (id: string) => boolean, idleMs: number): void {
    const cutoff = this.now() - idleMs;
    for (const c of [...this.canvases.values()]) {
      if (!c.dirty && c.lastAccess <= cutoff && !isInUse(c.id)) this.canvases.delete(c.id);
    }
  }

  private summary(c: Canvas): CanvasSummary {
    let elementCount = 0;
    for (const el of c.elements.values()) if (!el.isDeleted) elementCount++;
    return { id: c.id, title: c.title, elementCount, updatedAt: c.updatedAt, viewers: 0, ...meta(c) };
  }

  private get(id: string): Canvas {
    const c = CANVAS_ID_PATTERN.test(id) ? this.load(id) : undefined;
    if (!c) throw new NotFoundError(`canvas "${id}" not found`);
    return c;
  }

  private record(c: Canvas, records: ChangeRecord[]): void {
    c.log.push(...records);
    if (c.log.length > this.changeLogLimit) {
      const dropped = c.log.splice(0, c.log.length - this.changeLogLimit);
      c.logBase = dropped[dropped.length - 1]!.rev;
      // Records of one apply share a rev; never keep half of a rev group.
      while (c.log.length && c.log[0]!.rev <= c.logBase) c.log.shift();
    }
    this.markDirty(c);
  }

  private markDirty(c: Canvas): void {
    c.dirty = true;
    c.updatedAt = c.lastAccess = this.now();
    if (!this.flushTimer) {
      this.flushTimer = setTimeout(() => {
        try {
          this.flush();
        } catch (err) {
          this.onError(err);
        }
      }, this.flushMs);
      this.flushTimer.unref();
    }
  }

  private filePath(id: string): string {
    return join(this.dir, `${id}.json`);
  }

  private load(id: string): Canvas | undefined {
    const cached = this.canvases.get(id);
    if (cached) {
      cached.lastAccess = this.now();
      return cached;
    }
    if (!existsSync(this.filePath(id))) return undefined;
    const data = this.readFile(id);
    const now = this.now();
    const c: Canvas = data
      ? {
          id,
          title: data.title,
          ...meta(data),
          rev: data.rev,
          updatedAt: data.updatedAt,
          elements: new Map(data.elements.map((el) => [el.id, el])),
          files: new Map(Object.entries(data.files)),
          notes: data.notes,
          log: [],
          logBase: data.rev,
          dirty: false,
          lastAccess: now,
        }
      : { id, title: id, rev: 0, updatedAt: now, elements: new Map(), files: new Map(), notes: [], log: [], logBase: 0, dirty: false, lastAccess: now };
    if (!data) renameSync(this.filePath(id), join(this.dir, `${id}.corrupt-${now}.json`));
    this.pruneTombstones(c);
    this.canvases.set(id, c);
    return c;
  }

  /** Returns undefined when the file is unreadable or not a canvas. */
  private readFile(id: string): CanvasFile | undefined {
    let raw: unknown;
    try {
      raw = JSON.parse(readFileSync(this.filePath(id), 'utf8'));
    } catch {
      return undefined;
    }
    if (!isObject(raw) || !isFiniteNumber(raw.rev) || !Array.isArray(raw.elements)) return undefined;
    const files: Record<string, BinaryFile> = {};
    if (isObject(raw.files)) for (const [k, f] of Object.entries(raw.files)) if (!fileProblem(f)) files[k] = f as BinaryFile;
    const notes = Array.isArray(raw.notes)
      ? (raw.notes as unknown[]).filter((n): n is CanvasNote => isObject(n) && typeof n.text === 'string' && typeof n.id === 'string' && isFiniteNumber(n.rev) && isFiniteNumber(n.at))
      : [];
    let updatedAt = isFiniteNumber(raw.updatedAt) ? raw.updatedAt : 0;
    if (!updatedAt) updatedAt = statSync(this.filePath(id)).mtimeMs;
    return {
      id,
      title: typeof raw.title === 'string' && raw.title ? raw.title : id,
      ...meta(raw as Partial<CanvasFile>),
      rev: raw.rev,
      updatedAt,
      elements: (raw.elements as unknown[]).filter((el): el is ExElement => !elementProblem(el)),
      files,
      notes,
    };
  }

  private pruneTombstones(c: Canvas): void {
    const cutoff = this.now() - this.tombstoneTtlMs;
    for (const [elId, el] of c.elements) if (el.isDeleted && el.updated < cutoff) c.elements.delete(elId);
  }

  private save(c: Canvas): void {
    this.pruneTombstones(c);
    const keep = referencedFileIds(c.elements.values());
    for (const fileId of c.files.keys()) if (!keep.has(fileId)) c.files.delete(fileId);
    const data: CanvasFile = {
      id: c.id,
      title: c.title,
      ...meta(c),
      rev: c.rev,
      updatedAt: c.updatedAt,
      elements: [...c.elements.values()],
      files: Object.fromEntries(c.files),
      notes: c.notes,
    };
    const file = this.filePath(c.id);
    const tmp = `${file}.tmp-${process.pid}`;
    writeFileSync(tmp, JSON.stringify(data), { mode: 0o600 });
    renameSync(tmp, file);
    c.dirty = false;
  }
}
