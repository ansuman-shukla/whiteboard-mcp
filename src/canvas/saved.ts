import { mkdirSync, readFileSync, readdirSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { sha6, slug } from '../shared/ids.js';
import { CANVAS_ID_PATTERN, type BinaryFile, type ExElement, type SavedBoard, type SavedSummary } from '../shared/protocol.js';
import { NotFoundError, ValidationError, referencedFileIds, validateElements } from './store.js';

export interface SavedStoreOptions {
  dir: string;
  now?: () => number;
}

export interface SaveInput {
  name: unknown;
  source: string;
  workspace?: string;
  elements: ExElement[];
  files: Record<string, BinaryFile>;
}

interface Entry extends SavedSummary {
  /** The text of the board's text elements, one line each, for search. */
  lines: string[];
}

export const MAX_SAVED_NAME_LENGTH = 200;
const DEFAULT_LIMIT = 10;
export const MAX_SEARCH_LIMIT = 50;
const SNIPPET_LENGTH = 80;

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const oneLine = (s: string): string => s.replace(/\s+/g, ' ').trim();

function textLines(elements: readonly ExElement[]): string[] {
  return elements.flatMap((el) => (el.type === 'text' && typeof el.text === 'string' && el.text.trim() ? [oneLine(el.text)] : []));
}

/** A name is saved once per workspace: saving the same name again (any case) overwrites it. */
export function savedId(name: string, workspace = ''): string {
  return `${slug(name)}-${sha6(`${workspace}\0${name.toLowerCase()}`)}`;
}

/**
 * The library of saved boards: frozen copies in `<dir>/<id>.json`, independent of the live board they
 * came from. A summary index (with each board's text, for search) is built from disk on first use and
 * kept in memory.
 */
export class SavedStore {
  private readonly dir: string;
  private readonly now: () => number;
  private index: Map<string, Entry> | undefined;

  constructor(opts: SavedStoreOptions) {
    this.dir = opts.dir;
    this.now = opts.now ?? Date.now;
    mkdirSync(this.dir, { recursive: true, mode: 0o700 });
  }

  save(input: SaveInput): SavedSummary {
    if (typeof input.name !== 'string' || !input.name.trim()) throw new ValidationError('name must be a non-empty string');
    const name = oneLine(input.name);
    if (name.length > MAX_SAVED_NAME_LENGTH) throw new ValidationError(`name exceeds ${MAX_SAVED_NAME_LENGTH} characters`);
    const elements = validateElements(input.elements).filter((el) => !el.isDeleted);
    const keep = referencedFileIds(elements);
    const board: SavedBoard = {
      id: savedId(name, input.workspace),
      name,
      savedAt: this.now(),
      elementCount: elements.length,
      source: input.source,
      ...(input.workspace ? { workspace: input.workspace } : {}),
      elements,
      files: Object.fromEntries(Object.entries(input.files).filter(([fileId]) => keep.has(fileId))),
    };
    const file = this.filePath(board.id);
    const tmp = `${file}.tmp-${process.pid}`;
    writeFileSync(tmp, JSON.stringify(board), { mode: 0o600 });
    renameSync(tmp, file);
    const entry = this.entry(board);
    this.entries().set(board.id, entry);
    return summary(entry);
  }

  get(id: string): SavedBoard {
    const board = CANVAS_ID_PATTERN.test(id) ? this.read(id) : undefined;
    if (!board) throw new NotFoundError(`saved board "${id}" not found`);
    return board;
  }

  /**
   * Boards whose name, folder name or text contain every word of the query (all boards when empty):
   * those of `workspace` first, then by how many words the name matches, then newest first.
   */
  search(query: string, workspace?: string, limit = DEFAULT_LIMIT): SavedSummary[] {
    const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
    const hits: Array<{ entry: Entry; here: boolean; nameHits: number; snippet?: string }> = [];
    for (const entry of this.entries().values()) {
      const name = entry.name.toLowerCase();
      const folder = entry.workspace ? basename(entry.workspace).toLowerCase() : '';
      const lines = entry.lines.map((l) => l.toLowerCase());
      if (!terms.every((t) => name.includes(t) || folder.includes(t) || lines.some((l) => l.includes(t)))) continue;
      const at = terms.length ? lines.findIndex((l) => terms.some((t) => !name.includes(t) && l.includes(t))) : -1;
      const line = entry.lines[at];
      hits.push({ entry, here: !!workspace && entry.workspace === workspace, nameHits: terms.filter((t) => name.includes(t)).length, ...(line ? { snippet: snippet(line) } : {}) });
    }
    hits.sort((a, b) => Number(b.here) - Number(a.here) || b.nameHits - a.nameHits || b.entry.savedAt - a.entry.savedAt);
    return hits.slice(0, Math.max(1, Math.min(limit, MAX_SEARCH_LIMIT))).map((h) => ({ ...summary(h.entry), ...(h.snippet ? { snippet: h.snippet } : {}) }));
  }

  remove(id: string): boolean {
    if (!CANVAS_ID_PATTERN.test(id)) return false;
    this.entries().delete(id);
    try {
      unlinkSync(this.filePath(id));
      return true;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
      return false;
    }
  }

  private entries(): Map<string, Entry> {
    if (this.index) return this.index;
    this.index = new Map();
    for (const name of readdirSync(this.dir)) {
      const id = name.endsWith('.json') ? name.slice(0, -5) : '';
      const board = CANVAS_ID_PATTERN.test(id) ? this.read(id) : undefined;
      if (board) this.index.set(id, this.entry(board));
    }
    return this.index;
  }

  private entry(board: SavedBoard): Entry {
    const { elements: _elements, files: _files, ...rest } = board;
    return { ...rest, lines: textLines(board.elements) };
  }

  private filePath(id: string): string {
    return join(this.dir, `${id}.json`);
  }

  /** Undefined when the file is missing, unreadable or not a saved board. */
  private read(id: string): SavedBoard | undefined {
    let raw: unknown;
    try {
      raw = JSON.parse(readFileSync(this.filePath(id), 'utf8'));
    } catch {
      return undefined;
    }
    if (!isObject(raw) || raw.id !== id || typeof raw.name !== 'string' || typeof raw.savedAt !== 'number' || !Array.isArray(raw.elements)) return undefined;
    let elements: ExElement[];
    try {
      elements = validateElements(raw.elements);
    } catch {
      return undefined;
    }
    return {
      id,
      name: raw.name,
      savedAt: raw.savedAt,
      elementCount: elements.length,
      source: typeof raw.source === 'string' ? raw.source : '',
      ...(typeof raw.workspace === 'string' && raw.workspace ? { workspace: raw.workspace } : {}),
      elements,
      files: isObject(raw.files) ? (raw.files as Record<string, BinaryFile>) : {},
    };
  }
}

function summary(entry: Entry): SavedSummary {
  const { lines: _lines, ...rest } = entry;
  return rest;
}

function snippet(line: string): string {
  return line.length <= SNIPPET_LENGTH ? line : `${line.slice(0, SNIPPET_LENGTH - 1)}…`;
}
