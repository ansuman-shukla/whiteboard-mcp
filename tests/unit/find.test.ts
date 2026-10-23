import { describe, expect, it } from 'vitest';
import { closestBoards, findBoard, whereFrom } from '../../src/mcp/find.js';
import type { CanvasSummary, SavedSummary } from '../../src/shared/protocol.js';

const HERE = '/work/app';
const board = (id: string, title: string, workspace: string | undefined, updatedAt: number, elementCount = 3): CanvasSummary => ({
  id,
  title,
  elementCount,
  updatedAt,
  viewers: 0,
  ...(workspace ? { workspace } : {}),
});
const saved = (id: string, name: string, workspace: string | undefined, savedAt: number): SavedSummary => ({ id, name, savedAt, elementCount: 2, source: 'x', ...(workspace ? { workspace } : {}) });

describe('findBoard', () => {
  const boards = [
    board('codex-1', 'How Codex turns a prompt into work', '/Codex/2026-10-23/ca', 50),
    board('login-new', 'How login works', '/work/beta', 40),
    board('login-here', 'How login works', HERE, 10),
    board('login-alpha', 'How login works', '/work/alpha', 30),
    board('queue-a', 'Queue', '/work/alpha', 20),
    board('queue-b', 'Queue', '/work/beta', 25),
  ];

  it('finds a board by exact id in any folder', () => {
    expect(findBoard(boards, 'codex-1', HERE)).toEqual({ found: boards[0] });
  });

  it("finds a title made in another folder when it is the only one, ignoring case (Codex's per-task folders)", () => {
    expect(findBoard(boards, 'how CODEX turns a prompt into work', '/Codex/2026-10-24/new-task')).toEqual({ found: boards[0] });
  });

  it("prefers this workspace's board over newer ones with the same title elsewhere", () => {
    expect(findBoard(boards, 'How login works', HERE)).toEqual({ found: boards[2] });
  });

  it('returns every same-titled board elsewhere, newest first, instead of guessing', () => {
    expect(findBoard(boards, 'Queue', HERE)).toEqual({ several: [boards[5], boards[4]] });
    expect(findBoard(boards, 'How login works', '/work/gamma')).toEqual({ several: [boards[1], boards[3], boards[2]] });
  });

  it('finds nothing for a partial title', () => {
    expect(findBoard(boards, 'How Codex', HERE)).toEqual({ none: true });
  });
});

describe('closestBoards', () => {
  it('ranks by shared words, ignoring filler words, then this workspace, then newest', () => {
    const live = [
      board('ishara-arch', 'Ishara architecture', '/Documents/ishara', 90),
      board('codex-1', 'How Codex turns a prompt into work', '/Codex/2026-10-23/ca', 50),
      board('how-works', 'How the internet works', HERE, 95),
      board('here-arch', 'Payments architecture', HERE, 10),
    ];
    const picks = closestBoards(live, [], 'the Codex architecture one', HERE).map((s) => (s.kind === 'board' ? s.board.id : s.saved.id));
    expect(picks).toEqual(['here-arch', 'ishara-arch', 'codex-1', 'how-works']);
    expect(closestBoards(live, [], 'codex prompt', HERE)[0]).toEqual({ kind: 'board', board: live[1] });
  });

  it('includes saved copies and leaves out empty or untitled live boards', () => {
    const live = [board('empty', 'Battleship plan', HERE, 99, 0), board('untitled-1', 'untitled-1', HERE, 98), board('net', 'Network', HERE, 1)];
    const library = [saved('battleship-abc', 'Game Night: Battleship', '/Documents/ishara', 5)];
    expect(closestBoards(live, library, 'battleship', HERE)).toEqual([{ kind: 'saved', saved: library[0] }, { kind: 'board', board: live[2] }]);
  });

  it('caps the list', () => {
    const live = Array.from({ length: 10 }, (_, i) => board(`b${i}`, `Board ${i}`, HERE, i));
    expect(closestBoards(live, [], 'x', HERE, 3)).toHaveLength(3);
  });
});

describe('whereFrom', () => {
  it("names the board's folder relative to the asking chat", () => {
    expect(whereFrom(HERE, HERE)).toBe('this workspace');
    expect(whereFrom('/Codex/2026-10-23/ca', HERE)).toBe('from ca');
    expect(whereFrom(undefined, HERE)).toBe('no workspace');
  });
});
