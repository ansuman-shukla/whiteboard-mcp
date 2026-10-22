import { basename } from 'node:path';
import type { ExElement } from '../shared/protocol.js';

const SNIPPET_LENGTH = 80;

export const oneLine = (s: string): string => s.replace(/\s+/g, ' ').trim();

/** The text of a board's text elements, one line each, for search. */
export function textLines(elements: readonly ExElement[]): string[] {
  return elements.flatMap((el) => (el.type === 'text' && typeof el.text === 'string' && el.text.trim() && !el.isDeleted ? [oneLine(el.text)] : []));
}

export const searchTerms = (query: string): string[] => query.toLowerCase().split(/\s+/).filter(Boolean);

export interface Searchable {
  id: string;
  name: string;
  workspace?: string;
  lines: readonly string[];
}

export interface Match {
  /** How many terms the name contains, for ranking. */
  nameHits: number;
  /** A line of the board's text with a term the name lacks. */
  snippet?: string;
}

/** How a board matches when its name, id, folder name or text contain every term (every board matches no terms). */
export function matchTerms(terms: readonly string[], board: Searchable): Match | undefined {
  const name = board.name.toLowerCase();
  const folder = board.workspace ? basename(board.workspace).toLowerCase() : '';
  const lines = board.lines.map((l) => l.toLowerCase());
  if (!terms.every((t) => name.includes(t) || folder.includes(t) || board.id.includes(t) || lines.some((l) => l.includes(t)))) return undefined;
  const line = terms.length ? board.lines[lines.findIndex((l) => terms.some((t) => !name.includes(t) && l.includes(t)))] : undefined;
  return { nameHits: terms.filter((t) => name.includes(t)).length, ...(line ? { snippet: snippet(line) } : {}) };
}

function snippet(line: string): string {
  return line.length <= SNIPPET_LENGTH ? line : `${line.slice(0, SNIPPET_LENGTH - 1)}…`;
}
