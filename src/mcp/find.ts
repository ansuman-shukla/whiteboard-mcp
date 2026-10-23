import { basename } from 'node:path';
import type { CanvasSummary, SavedSummary } from '../shared/protocol.js';

export type BoardLookup = { found: CanvasSummary } | { several: CanvasSummary[] } | { none: true };

/**
 * A live board by exact id (any folder) or title: this workspace's newest first, else the only one
 * with that title in another folder. Harnesses like Codex desktop start every task in a new folder,
 * so a board made in an earlier task must stay reachable by name.
 */
export function findBoard(boards: readonly CanvasSummary[], wanted: string, workspace: string): BoardLookup {
  const byId = boards.find((b) => b.id === wanted);
  if (byId) return { found: byId };
  const titled = boards.filter((b) => b.title.toLowerCase() === wanted.toLowerCase()).sort((a, b) => b.updatedAt - a.updatedAt);
  const here = titled.find((b) => b.workspace === workspace);
  if (here) return { found: here };
  if (titled.length === 1) return { found: titled[0]! };
  return titled.length ? { several: titled } : { none: true };
}

export type Suggestion = { kind: 'board'; board: CanvasSummary } | { kind: 'saved'; saved: SavedSummary };

const STOP_WORDS = new Set(['the', 'and', 'for', 'how', 'what', 'with', 'this', 'that', 'one', 'board', 'whiteboard', 'from', 'about', 'into', 'works']);
const words = (s: string): Set<string> => new Set(s.toLowerCase().split(/[^\p{L}\p{N}]+/u).filter((w) => w.length > 2 && !STOP_WORDS.has(w)));

/**
 * Titled, non-empty live boards and saved copies ranked by how many words of `wanted` their name
 * shares, this workspace first, then newest: so the agent can pick the board the human meant.
 */
export function closestBoards(boards: readonly CanvasSummary[], saved: readonly SavedSummary[], wanted: string, workspace: string, limit = 6): Suggestion[] {
  const asked = words(wanted);
  const shared = (name: string) => [...words(name)].filter((w) => asked.has(w)).length;
  const ranked = [
    ...boards.filter((b) => b.elementCount > 0 && b.title !== b.id).map((board) => ({ s: { kind: 'board', board } as Suggestion, name: board.title, workspace: board.workspace, at: board.updatedAt })),
    ...saved.map((s) => ({ s: { kind: 'saved', saved: s } as Suggestion, name: s.name, workspace: s.workspace, at: s.savedAt })),
  ].map((r) => ({ ...r, score: shared(r.name), here: r.workspace === workspace }));
  ranked.sort((a, b) => b.score - a.score || Number(b.here) - Number(a.here) || b.at - a.at);
  return ranked.slice(0, limit).map((r) => r.s);
}

/** Where a board lives, relative to the asking chat's workspace. */
export const whereFrom = (boardWorkspace: string | undefined, workspace: string): string =>
  boardWorkspace === workspace ? 'this workspace' : boardWorkspace ? `from ${basename(boardWorkspace)}` : 'no workspace';
