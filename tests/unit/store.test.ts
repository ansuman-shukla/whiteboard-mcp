import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { CanvasStore, NotFoundError, ValidationError, type CanvasStoreOptions } from '../../src/canvas/store.js';
import type { ExElement } from '../../src/shared/protocol.js';

const DAY = 24 * 60 * 60 * 1000;

function el(id: string, over: Partial<ExElement> = {}): ExElement {
  return { id, type: 'rectangle', x: 0, y: 0, width: 10, height: 10, version: 1, versionNonce: 100, isDeleted: false, updated: 1000, ...over };
}

const png = (id: string, size = 10) => ({ id, mimeType: 'image/png', dataURL: `data:image/png;base64,${'A'.repeat(size)}`, created: 1 });

let dir: string;
let clock: number;
const stores: CanvasStore[] = [];

function makeStore(opts: Partial<CanvasStoreOptions> = {}): CanvasStore {
  const store = new CanvasStore({ dir, flushMs: 10_000, now: () => clock, ...opts });
  stores.push(store);
  return store;
}

const readCanvasFile = (id: string) => JSON.parse(readFileSync(join(dir, `${id}.json`), 'utf8'));

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'exl-store-'));
  clock = 1_000_000;
});

afterEach(() => {
  for (const s of stores.splice(0)) s.close();
  rmSync(dir, { recursive: true, force: true });
});

describe('merge rule', () => {
  it('keeps the higher version, breaks ties with the lower nonce, rejects stale', () => {
    const s = makeStore();
    s.ensure('c1');
    s.apply('c1', [el('a', { version: 2, versionNonce: 50, x: 1 })], 'agent');

    expect(s.apply('c1', [el('a', { version: 1, x: 99 })], 'human')).toEqual({ rev: 1, applied: [], stale: ['a'] });
    expect(s.apply('c1', [el('a', { version: 2, versionNonce: 60, x: 98 })], 'human').stale).toEqual(['a']);
    expect(s.snapshot('c1').elements[0]!.x).toBe(1);

    expect(s.apply('c1', [el('a', { version: 2, versionNonce: 40, x: 2 })], 'human')).toEqual({ rev: 2, applied: ['a'], stale: [] });
    expect(s.snapshot('c1').elements[0]!.x).toBe(2);
    expect(s.apply('c1', [el('a', { version: 3, versionNonce: 999, x: 3 })], 'human').applied).toEqual(['a']);
    expect(s.snapshot('c1').elements[0]!.x).toBe(3);
  });
});

describe('change records', () => {
  it('classifies created/updated/deleted and bumps rev once per apply', () => {
    const s = makeStore();
    s.ensure('c1');
    expect(s.apply('c1', [el('a'), el('b')], 'agent').rev).toBe(1);
    expect(s.apply('c1', [el('a', { version: 2 }), el('b', { version: 2, isDeleted: true })], 'human').rev).toBe(2);
    // deleted -> deleted is stored (rev bump) but not recorded
    expect(s.apply('c1', [el('b', { version: 3, isDeleted: true })], 'agent').rev).toBe(3);
    // revive a tombstone -> created
    expect(s.apply('c1', [el('b', { version: 4 })], 'agent').rev).toBe(4);
    // nothing stored -> no rev bump
    expect(s.apply('c1', [el('a', { version: 1 })], 'agent').rev).toBe(4);

    const ch = s.changes('c1', 0);
    expect(ch.full).toBe(false);
    expect(ch.rev).toBe(4);
    expect(ch.changes).toEqual([
      { rev: 1, actor: 'agent', id: 'a', kind: 'created' },
      { rev: 1, actor: 'agent', id: 'b', kind: 'created' },
      { rev: 2, actor: 'human', id: 'a', kind: 'updated' },
      { rev: 2, actor: 'human', id: 'b', kind: 'deleted' },
      { rev: 4, actor: 'agent', id: 'b', kind: 'created' },
    ]);
    expect(ch.elements.map((e) => [e.id, e.version])).toEqual([['a', 2], ['b', 4]]);

    const later = s.changes('c1', 2);
    expect(later.changes).toEqual([{ rev: 4, actor: 'agent', id: 'b', kind: 'created' }]);
    expect(s.changes('c1', 4)).toEqual({ rev: 4, full: false, changes: [], elements: [], notes: [] });
  });

  it('includes tombstones in changes elements but not in snapshots', () => {
    const s = makeStore();
    s.ensure('c1');
    s.apply('c1', [el('a'), el('b')], 'agent');
    s.apply('c1', [el('a', { version: 2, isDeleted: true })], 'human');
    expect(s.snapshot('c1').elements.map((e) => e.id)).toEqual(['b']);
    expect(s.changes('c1', 1).elements).toEqual([el('a', { version: 2, isDeleted: true })]);
  });

  it('switches to a full resync once the bounded log no longer covers `since`', () => {
    const s = makeStore({ changeLogLimit: 3 });
    s.ensure('c1');
    s.apply('c1', [el('a'), el('b')], 'agent'); // rev 1
    s.apply('c1', [el('c'), el('d')], 'agent'); // rev 2 -> drops rev 1 records
    expect(s.changes('c1', 0)).toMatchObject({ full: true, changes: [], rev: 2 });
    expect(s.changes('c1', 0).elements.map((e) => e.id).sort()).toEqual(['a', 'b', 'c', 'd']);
    expect(s.changes('c1', 1)).toMatchObject({ full: false, changes: [{ id: 'c' }, { id: 'd' }] });
  });

  it('resyncs fully when `since` is ahead of rev (canvas recreated or writes lost)', () => {
    const s = makeStore();
    s.ensure('c1');
    s.apply('c1', [el('a')], 'agent');
    s.addNote('c1', 'n');
    const ch = s.changes('c1', 9);
    expect(ch).toMatchObject({ rev: 2, full: true, changes: [], notes: [{ text: 'n' }] });
    expect(ch.elements.map((e) => e.id)).toEqual(['a']);
  });
});

describe('clear', () => {
  it('tombstones every live element with a bumped version and records deletions', () => {
    const s = makeStore();
    s.ensure('c1');
    s.apply('c1', [el('a', { version: 5 }), el('b'), el('gone', { isDeleted: true })], 'agent');
    clock += 5;
    const res = s.clear('c1', 'agent');
    expect(res).toEqual({ rev: 2, applied: ['a', 'b'], stale: [] });
    expect(s.snapshot('c1').elements).toEqual([]);
    const ch = s.changes('c1', 1);
    expect(ch.changes.map((r) => [r.id, r.kind])).toEqual([['a', 'deleted'], ['b', 'deleted']]);
    const a = ch.elements.find((e) => e.id === 'a')!;
    expect(a).toMatchObject({ version: 6, isDeleted: true, updated: clock });
    // an old replica's version of the element cannot resurrect it
    expect(s.apply('c1', [el('a', { version: 5, versionNonce: 0 })], 'human').stale).toEqual(['a']);
    expect(s.clear('c1', 'agent')).toEqual({ rev: 2, applied: [], stale: [] });
  });
});

describe('notes', () => {
  it('trims, rejects empty/oversized text, assigns revs and caps the list', () => {
    const s = makeStore({ maxNotes: 3 });
    s.ensure('c1');
    expect(() => s.addNote('c1', '   ')).toThrow(ValidationError);
    expect(() => s.addNote('c1', 'x'.repeat(4001))).toThrow(ValidationError);
    expect(s.addNote('c1', 'x'.repeat(4000)).rev).toBe(1);
    const n = s.addNote('c1', '  hello  ');
    expect(n).toMatchObject({ text: 'hello', rev: 2, at: clock });
    s.addNote('c1', 'three');
    s.addNote('c1', 'four');
    expect(s.snapshot('c1').notes.map((x) => x.text)).toEqual(['hello', 'three', 'four']);
    expect(s.changes('c1', 2).notes.map((x) => x.text)).toEqual(['three', 'four']);
  });
});

describe('persistence', () => {
  it('flushes atomically and reloads with a full resync for older revisions', () => {
    const s = makeStore();
    s.ensure('c1', 'My canvas');
    s.apply('c1', [el('a'), el('b')], 'agent');
    s.apply('c1', [el('b', { version: 2, isDeleted: true, updated: clock })], 'human');
    s.addNote('c1', 'note');
    expect(existsSync(join(dir, 'c1.json'))).toBe(false);
    s.flush();
    expect(readdirSync(dir)).toEqual(['c1.json']);
    s.close();

    const s2 = makeStore();
    expect(s2.has('c1')).toBe(true);
    const snap = s2.snapshot('c1');
    expect(snap).toMatchObject({ title: 'My canvas', rev: 3, notes: [{ text: 'note', rev: 3 }] });
    expect(snap.elements.map((e) => e.id)).toEqual(['a']);
    expect(s2.changes('c1', 2)).toMatchObject({ full: true, changes: [] });
    expect(s2.changes('c1', 3)).toMatchObject({ full: false, changes: [] });
    // the tombstone survived the reload, so a stale replica stays rejected
    expect(s2.apply('c1', [el('b', { version: 1 })], 'human').stale).toEqual(['b']);
    expect(s2.list()).toEqual([{ id: 'c1', title: 'My canvas', elementCount: 1, updatedAt: clock, viewers: 0 }]);
  });

  it('writes on its own after flushMs (unref timer) and close() flushes pending writes', async () => {
    const s = makeStore({ flushMs: 20 });
    s.ensure('c1');
    s.apply('c1', [el('a')], 'agent');
    await new Promise((r) => setTimeout(r, 80));
    expect(readCanvasFile('c1').elements).toHaveLength(1);
    s.apply('c1', [el('b')], 'agent');
    s.close();
    expect(readCanvasFile('c1').elements).toHaveLength(2);
  });

  it('lists canvases that exist only on disk', () => {
    const s = makeStore();
    s.ensure('disk-only', 'On disk');
    s.apply('disk-only', [el('a'), el('b', { isDeleted: true })], 'agent');
    s.close();
    writeFileSync(join(dir, 'Bad.ID.json'), '{}');
    expect(makeStore().list()).toEqual([{ id: 'disk-only', title: 'On disk', elementCount: 1, updatedAt: clock, viewers: 0 }]);
  });

  it('moves a corrupt file aside and starts empty without throwing', () => {
    writeFileSync(join(dir, 'broken.json'), '{"rev": 3, "elements": [');
    const s = makeStore();
    expect(s.snapshot('broken')).toMatchObject({ rev: 0, elements: [] });
    expect(readdirSync(dir)).toEqual([`broken.corrupt-${clock}.json`]);
    s.apply('broken', [el('a')], 'agent');
    s.flush();
    expect(readCanvasFile('broken').elements).toHaveLength(1);
  });

  it('prunes tombstones older than the TTL at save and load', () => {
    const s = makeStore();
    s.ensure('c1');
    s.apply('c1', [el('old', { isDeleted: true, updated: clock - DAY - 1 }), el('young', { isDeleted: true, updated: clock - DAY + 1000 }), el('live', { updated: 0 })], 'agent');
    s.flush();
    expect(readCanvasFile('c1').elements.map((e: ExElement) => e.id).sort()).toEqual(['live', 'young']);
    s.close();
    clock += 2000;
    const s2 = makeStore();
    s2.snapshot('c1');
    expect(s2.changes('c1', -1).elements.map((e) => e.id)).toEqual(['live']);
    // the pruned tombstone no longer blocks an older version
    expect(s2.apply('c1', [el('young', { version: 1 })], 'human').applied).toEqual(['young']);
  });

  it('drops files not referenced by a live image element when saving', () => {
    const s = makeStore();
    s.ensure('c1');
    s.apply('c1', [el('img1', { type: 'image', fileId: 'f1' }), el('img2', { type: 'image', fileId: 'f2' })], 'agent', [png('f1'), png('f2'), png('orphan')]);
    expect(Object.keys(s.snapshot('c1').files).sort()).toEqual(['f1', 'f2', 'orphan']);
    s.apply('c1', [el('img2', { type: 'image', fileId: 'f2', version: 2, isDeleted: true })], 'agent');
    s.flush();
    expect(Object.keys(readCanvasFile('c1').files)).toEqual(['f1']);
    expect(Object.keys(s.snapshot('c1').files)).toEqual(['f1']);
  });

  it('rejects files beyond maxFilesBytes without mutating the canvas', () => {
    const s = makeStore({ maxFilesBytes: 100 });
    s.ensure('c1');
    s.apply('c1', [el('i1', { type: 'image', fileId: 'f1' })], 'agent', [png('f1', 50)]);
    let err: unknown;
    try {
      s.apply('c1', [el('i2', { type: 'image', fileId: 'f2' })], 'agent', [png('f2', 50)]);
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(ValidationError);
    expect((err as ValidationError).status).toBe(413);
    expect(s.snapshot('c1').elements.map((e) => e.id)).toEqual(['i1']);
    // an unreferenced file does not count against the budget
    s.apply('c1', [el('i1', { type: 'image', fileId: 'f1', version: 2, isDeleted: true }), el('i3', { type: 'image', fileId: 'f3' })], 'agent', [png('f3', 50)]);
    expect(Object.keys(s.snapshot('c1').files)).toContain('f3');
  });

  it('unloads only clean, idle canvases that are not in use', () => {
    const s = makeStore();
    s.ensure('a');
    s.ensure('b');
    s.ensure('c');
    s.flush();
    clock += 1000;
    s.snapshot('c'); // touched recently
    s.unloadIdle((id) => id === 'a', 500);
    expect(s.loadedCount).toBe(2);
    s.unloadIdle(() => false, 0);
    expect(s.loadedCount).toBe(0);
    expect(s.has('b')).toBe(true);
    s.addNote('b', 'dirty');
    s.unloadIdle(() => false, 0);
    expect(s.loadedCount).toBe(1);
  });

  it('remove deletes the file and memory state', () => {
    const s = makeStore();
    s.ensure('c1');
    s.flush();
    expect(s.remove('c1')).toBe(true);
    expect(s.has('c1')).toBe(false);
    expect(existsSync(join(dir, 'c1.json'))).toBe(false);
    expect(() => s.snapshot('c1')).toThrow(NotFoundError);
    expect(s.remove('c1')).toBe(false);
  });
});

describe('validation', () => {
  it('rejects bad canvas ids', () => {
    const s = makeStore();
    for (const id of ['', 'Upper', '../x', '-lead', 'a'.repeat(65), 'a/b']) expect(() => s.ensure(id)).toThrow(ValidationError);
    expect(() => s.snapshot('../etc')).toThrow(NotFoundError);
    expect(s.has('../etc')).toBe(false);
  });

  it.each([
    ['not an array', {}],
    ['non-object', [1]],
    ['missing id', [{ ...el('a'), id: undefined }]],
    ['long id', [el('x'.repeat(129))]],
    ['non-string type', [el('a', { type: 3 as unknown as string })]],
    ['NaN x', [el('a', { x: NaN })]],
    ['infinite width', [el('a', { width: Infinity })]],
    ['string version', [el('a', { version: '2' as unknown as number })]],
    ['missing versionNonce', [{ ...el('a'), versionNonce: undefined }]],
    ['missing updated', [{ ...el('a'), updated: undefined }]],
    ['non-boolean isDeleted', [el('a', { isDeleted: 0 as unknown as boolean })]],
  ])('rejects elements: %s', (_name, elements) => {
    const s = makeStore();
    s.ensure('c1');
    expect(() => s.apply('c1', elements, 'agent')).toThrow(ValidationError);
    expect(s.snapshot('c1').rev).toBe(0);
  });

  it.each([
    ['not an array', {}],
    ['missing mimeType', [{ id: 'f', dataURL: 'data:x' }]],
    ['non data url', [{ id: 'f', mimeType: 'image/png', dataURL: 'http://evil' }]],
    ['bad id', [{ id: 5, mimeType: 'image/png', dataURL: 'data:x' }]],
  ])('rejects files: %s', (_name, files) => {
    const s = makeStore();
    s.ensure('c1');
    expect(() => s.apply('c1', [el('a')], 'agent', files)).toThrow(ValidationError);
    expect(s.snapshot('c1').elements).toEqual([]);
  });

  it('applying to a missing canvas throws NotFoundError', () => {
    expect(() => makeStore().apply('nope', [el('a')], 'agent')).toThrow(NotFoundError);
  });
});
