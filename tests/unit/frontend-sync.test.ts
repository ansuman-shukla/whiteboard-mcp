import { describe, expect, it, vi } from 'vitest';
import {
  adoptRestored,
  backoffDelay,
  createThrottle,
  diffFiles,
  diffLocal,
  isSendable,
  markKnown,
  mergeRemote,
  orderByIndex,
  reconcileSnapshot,
  type Known,
  type SyncElement,
} from '../../frontend/src/sync';

type El = SyncElement & { type: string; width: number; height: number; x: number; text?: string; points?: unknown[] };

const el = (id: string, version = 1, versionNonce = 100, extra: Partial<El> = {}): El => ({
  id,
  type: 'rectangle',
  x: 0,
  width: 10,
  height: 10,
  version,
  versionNonce,
  isDeleted: false,
  index: null,
  ...extra,
});

const knownOf = (...els: El[]): Known => {
  const k: Known = new Map();
  markKnown(els, k);
  return k;
};
const ids = (els: readonly { id: string }[]) => els.map((e) => e.id);

describe('mergeRemote', () => {
  it('higher version wins, lower version loses', () => {
    const local = [el('a', 2), el('b', 5)];
    const { elements, replaced } = mergeRemote(local, [el('a', 3, 1, { x: 30 }), el('b', 4, 1, { x: 40 })], new Map());
    expect(elements.find((e) => e.id === 'a')!.x).toBe(30);
    expect(elements.find((e) => e.id === 'b')).toBe(local[1]);
    expect([...replaced]).toEqual(['a']);
  });

  it('breaks version ties with the lower versionNonce', () => {
    const local = [el('a', 3, 50), el('b', 3, 50)];
    const { elements, replaced } = mergeRemote(local, [el('a', 3, 10, { x: 1 }), el('b', 3, 90, { x: 2 })], new Map());
    expect(elements.find((e) => e.id === 'a')!.x).toBe(1);
    expect(elements.find((e) => e.id === 'b')).toBe(local[1]);
    expect([...replaced]).toEqual(['a']);
  });

  it('appends unknown elements and applies remote tombstones', () => {
    const local = [el('a', 1)];
    const { elements } = mergeRemote(local, [el('a', 2, 1, { isDeleted: true }), el('new', 1)], new Map());
    expect(ids(elements)).toEqual(['a', 'new']);
    expect(elements[0]!.isDeleted).toBe(true);
  });

  it('records every incoming version as known, winners and losers alike', () => {
    const known: Known = new Map();
    mergeRemote([el('a', 9)], [el('a', 2, 7), el('b', 1, 8)], known);
    expect(known.get('a')).toEqual({ version: 2, versionNonce: 7 });
    expect(known.get('b')).toEqual({ version: 1, versionNonce: 8 });
  });

  it('never echoes received elements back, but a newer local element is still sent', () => {
    const known: Known = new Map();
    const local = [el('mine', 9, 1), el('theirs', 1, 1)];
    const { elements } = mergeRemote(local, [el('theirs', 2, 5), el('mine', 3, 5), el('added', 1, 5)], known);
    expect(ids(diffLocal(elements, known))).toEqual(['mine']);
  });

  it('returns the local scene untouched when nothing wins', () => {
    const local = [el('a', 5)];
    const { elements, replaced } = mergeRemote(local, [el('a', 1)], new Map());
    expect(elements).toEqual(local);
    expect(replaced.size).toBe(0);
  });
});

describe('diffLocal', () => {
  it('sends new, changed (version or nonce) and deleted elements only', () => {
    const known = knownOf(el('same', 2, 1), el('bumped', 1, 1), el('renonced', 4, 1), el('gone', 1, 1));
    const scene = [el('same', 2, 1), el('bumped', 2, 1), el('renonced', 4, 2), el('gone', 2, 3, { isDeleted: true }), el('fresh', 1, 1)];
    expect(ids(diffLocal(scene, known))).toEqual(['bumped', 'renonced', 'gone', 'fresh']);
  });

  it('skips tombstones the server never saw', () => {
    expect(diffLocal([el('ghost', 2, 1, { isDeleted: true })], new Map())).toEqual([]);
  });

  it('nothing is resent after markKnown', () => {
    const known: Known = new Map();
    const scene = [el('a'), el('b', 3, 3, { isDeleted: true })];
    known.set('b', { version: 2, versionNonce: 2 });
    const first = diffLocal(scene, known);
    expect(ids(first)).toEqual(['a', 'b']);
    markKnown(first, known);
    expect(diffLocal(scene, known)).toEqual([]);
  });

  it('applies the sendable filter and retries filtered elements later', () => {
    const known: Known = new Map();
    const draft = el('t', 1, 1, { type: 'text', text: '' });
    expect(diffLocal([draft], known, isSendable)).toEqual([]);
    const typed = { ...draft, version: 2, text: 'hi' };
    expect(ids(diffLocal([typed], known, isSendable))).toEqual(['t']);
  });
});

describe('isSendable', () => {
  it('holds back empty drafts but sends real content and tombstones', () => {
    expect(isSendable(el('r', 1, 1, { width: 0, height: 0 }))).toBe(false);
    expect(isSendable(el('r', 1, 1, { width: 0, height: 5 }))).toBe(true);
    expect(isSendable(el('t', 1, 1, { type: 'text', text: '  ' }))).toBe(false);
    expect(isSendable(el('t', 1, 1, { type: 'text', text: 'x' }))).toBe(true);
    expect(isSendable(el('l', 1, 1, { type: 'arrow', points: [[0, 0]] }))).toBe(false);
    expect(isSendable(el('l', 1, 1, { type: 'arrow', points: [[0, 0], [5, 5]] }))).toBe(true);
    expect(isSendable(el('r', 1, 1, { width: 0, height: 0, isDeleted: true }))).toBe(true);
  });
});

describe('reconcileSnapshot', () => {
  it('turns known elements missing from the snapshot into local tombstones that are not resent', () => {
    const known = knownOf(el('kept'), el('pruned'));
    const local = [el('kept'), el('pruned')];
    const { elements, replaced } = reconcileSnapshot(local, [el('kept')], known);
    expect(elements.find((e) => e.id === 'pruned')!.isDeleted).toBe(true);
    expect(replaced.has('pruned')).toBe(true);
    expect(known.has('pruned')).toBe(false);
    expect(diffLocal(elements, known)).toEqual([]);
  });

  it('sends offline edits and offline creations back after reconnect', () => {
    const known = knownOf(el('edited', 1, 1));
    const local = [el('edited', 3, 1, { x: 99 }), el('offline', 1, 1)];
    const { elements } = reconcileSnapshot(local, [el('edited', 2, 1)], known);
    expect(elements.find((e) => e.id === 'edited')!.x).toBe(99);
    expect(ids(diffLocal(elements, known))).toEqual(['edited', 'offline']);
  });

  it('takes newer server versions and adds server-only elements', () => {
    const known = knownOf(el('a', 1));
    const { elements, replaced } = reconcileSnapshot([el('a', 1)], [el('a', 4, 1, { x: 7 }), el('b', 1)], known);
    expect(elements.find((e) => e.id === 'a')!.x).toBe(7);
    expect(ids(elements).sort()).toEqual(['a', 'b']);
    expect([...replaced].sort()).toEqual(['a', 'b']);
    expect(known.get('a')).toEqual({ version: 4, versionNonce: 1 });
    expect(diffLocal(elements, known)).toEqual([]);
  });

  it('resets known to the snapshot', () => {
    const known = knownOf(el('old', 1));
    reconcileSnapshot([], [el('x', 2, 2)], known);
    expect([...known.keys()]).toEqual(['x']);
  });
});

describe('orderByIndex and adoptRestored', () => {
  it('sorts by fractional index and keeps index-less elements after their predecessor', () => {
    const order = orderByIndex([el('c', 1, 1, { index: 'a2' }), el('n1'), el('a', 1, 1, { index: 'a0' }), el('n2'), el('b', 1, 1, { index: 'a1' })]);
    expect(ids(order)).toEqual(['a', 'n2', 'b', 'c', 'n1']);
  });

  it('keeps exchanged versions on replaced elements and local identity on others', () => {
    const local = el('local', 4, 4, { index: 'a0' });
    const remote = el('remote', 2, 9, { updated: 5 });
    const restored = [
      { ...local, index: 'a0', width: 999 },
      { ...remote, version: 3, versionNonce: 1, updated: 6, index: 'a1', width: 42 },
    ];
    const out = adoptRestored([local, remote], restored, new Set(['remote']));
    expect(out[0]).toBe(local);
    expect(out[1]).toMatchObject({ id: 'remote', version: 2, versionNonce: 9, updated: 5, index: 'a1', width: 42 });
  });

  it('copies a repaired index onto local elements and drops replaced elements restore discarded', () => {
    const local = el('local', 4, 4, { index: 'zz' });
    const out = adoptRestored([local, el('tiny', 1, 1)], [{ ...local, version: 5, index: 'a5' }], new Set(['tiny']));
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ id: 'local', version: 4, index: 'a5' });
  });
});

describe('diffFiles', () => {
  it('returns only files the server has not received', () => {
    const files = {
      a: { id: 'a', mimeType: 'image/png', dataURL: 'data:image/png;base64,AA' },
      b: { id: 'b', mimeType: 'image/png', dataURL: 'data:image/png;base64,BB' },
      c: { id: 'c', mimeType: 'image/png', dataURL: '' },
    };
    expect(ids(diffFiles(files, new Set(['a'])))).toEqual(['b']);
    expect(diffFiles(files, new Set(['a', 'b']))).toEqual([]);
  });
});

describe('createThrottle', () => {
  it('runs on the leading edge, coalesces into one trailing call, and flushes immediately', () => {
    vi.useFakeTimers();
    try {
      const fn = vi.fn();
      const t = createThrottle(fn, 100);
      t.schedule();
      expect(fn).toHaveBeenCalledTimes(1);
      t.schedule();
      t.schedule();
      expect(fn).toHaveBeenCalledTimes(1);
      vi.advanceTimersByTime(100);
      expect(fn).toHaveBeenCalledTimes(2);
      vi.advanceTimersByTime(100);
      expect(fn).toHaveBeenCalledTimes(2);
      t.schedule();
      expect(fn).toHaveBeenCalledTimes(3);
      t.schedule();
      t.flush();
      expect(fn).toHaveBeenCalledTimes(4);
      vi.advanceTimersByTime(500);
      expect(fn).toHaveBeenCalledTimes(4);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('backoffDelay', () => {
  it('grows from ~500ms and caps at 10s', () => {
    expect(backoffDelay(0, () => 0.5)).toBe(500);
    expect(backoffDelay(1, () => 0.5)).toBe(1000);
    expect(backoffDelay(3, () => 0.5)).toBe(4000);
    expect(backoffDelay(20, () => 1)).toBe(10_000);
    expect(backoffDelay(0, () => 0)).toBe(375);
  });
});
