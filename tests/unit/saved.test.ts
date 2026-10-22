import { mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { SavedStore, savedId } from '../../src/canvas/saved.js';
import { NotFoundError, ValidationError } from '../../src/canvas/store.js';
import type { ExElement } from '../../src/shared/protocol.js';

function el(id: string, over: Partial<ExElement> = {}): ExElement {
  return { id, type: 'rectangle', x: 0, y: 0, width: 10, height: 10, version: 1, versionNonce: 100, isDeleted: false, updated: 1000, ...over };
}
const text = (id: string, value: string) => el(id, { type: 'text', text: value });
const png = (id: string) => ({ id, mimeType: 'image/png', dataURL: 'data:image/png;base64,AAAA', created: 1 });

const WS = '/work/alpha';
const OTHER = '/work/beta';

let dir: string;
let clock: number;
const make = () => new SavedStore({ dir, now: () => clock });

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'exl-saved-'));
  clock = 1_000_000;
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('save', () => {
  it('stores a frozen copy of live elements and referenced files only', () => {
    const s = make();
    const elements = [el('a'), el('gone', { isDeleted: true }), el('img', { type: 'image', fileId: 'f1' })];
    const saved = s.save({ name: '  Auth   flow ', source: 'alpha-123', workspace: WS, elements, files: { f1: png('f1'), f2: png('f2') } });
    expect(saved).toEqual({ id: savedId('Auth flow', WS), name: 'Auth flow', savedAt: clock, elementCount: 2, source: 'alpha-123', workspace: WS });
    elements[0]!.x = 999;
    const board = s.get(saved.id);
    expect(board.elements.map((e) => [e.id, e.x])).toEqual([['a', 0], ['img', 0]]);
    expect(Object.keys(board.files)).toEqual(['f1']);
  });

  it('overwrites the same name (any case) in one workspace; other workspaces keep their own', () => {
    const s = make();
    const first = s.save({ name: 'Auth flow', source: 'b1', workspace: WS, elements: [el('a')], files: {} });
    clock += 10;
    const again = s.save({ name: 'AUTH FLOW', source: 'b2', workspace: WS, elements: [el('a'), el('b')], files: {} });
    const elsewhere = s.save({ name: 'Auth flow', source: 'b3', workspace: OTHER, elements: [el('c')], files: {} });
    expect(again.id).toBe(first.id);
    expect(again).toMatchObject({ name: 'AUTH FLOW', elementCount: 2, savedAt: clock, source: 'b2' });
    expect(elsewhere.id).not.toBe(first.id);
    expect(s.search('').map((r) => r.id).sort()).toEqual([first.id, elsewhere.id].sort());
    expect(readdirSync(dir).sort()).toEqual([`${first.id}.json`, `${elsewhere.id}.json`].sort());
  });

  it('rejects empty, oversized or non-string names and invalid elements', () => {
    const s = make();
    for (const name of ['', '   ', 5, undefined, 'x'.repeat(201)]) {
      expect(() => s.save({ name, source: 'b', elements: [], files: {} })).toThrow(ValidationError);
    }
    expect(() => s.save({ name: 'ok', source: 'b', elements: [{ id: 'x' } as ExElement], files: {} })).toThrow(ValidationError);
    expect(readdirSync(dir)).toEqual([]);
  });
});

describe('search', () => {
  function seed(s: SavedStore) {
    s.save({ name: 'Auth flow', source: 'b', workspace: OTHER, elements: [text('t', 'Login service issues JWT')], files: {} });
    clock += 1;
    s.save({ name: 'Cache layer', source: 'b', workspace: WS, elements: [text('t', 'Redis in front of\nthe   auth DB')], files: {} });
    clock += 1;
    s.save({ name: 'Billing', source: 'b', workspace: WS, elements: [text('t', 'Stripe webhooks')], files: {} });
  }

  it('lists everything newest first within this workspace first when the query is empty', () => {
    const s = make();
    seed(s);
    expect(s.search('', WS).map((r) => r.name)).toEqual(['Billing', 'Cache layer', 'Auth flow']);
    expect(s.search('').map((r) => r.name)).toEqual(['Billing', 'Cache layer', 'Auth flow']);
  });

  it('matches every word across name, folder and text, ranking this workspace then name hits', () => {
    const s = make();
    seed(s);
    expect(s.search('auth', WS).map((r) => r.name)).toEqual(['Cache layer', 'Auth flow']);
    expect(s.search('auth', OTHER).map((r) => r.name)).toEqual(['Auth flow', 'Cache layer']);
    expect(s.search('auth').map((r) => r.name)).toEqual(['Auth flow', 'Cache layer']);
    expect(s.search('redis AUTH').map((r) => r.name)).toEqual(['Cache layer']);
    expect(s.search('beta jwt').map((r) => r.name)).toEqual(['Auth flow']);
    expect(s.search('redis stripe')).toEqual([]);
  });

  it('shows the matching text line as a one-line snippet, only when the name does not match', () => {
    const s = make();
    seed(s);
    s.save({ name: 'Long', source: 'b', elements: [text('t', `needle ${'x'.repeat(100)}`)], files: {} });
    s.save({ name: 'Auth notes', source: 'b', elements: [text('t', 'auth is also in the text')], files: {} });
    const byName = Object.fromEntries(s.search('auth').map((r) => [r.name, r.snippet]));
    expect(byName).toEqual({ 'Auth flow': undefined, 'Auth notes': undefined, 'Cache layer': 'Redis in front of the auth DB' });
    expect(s.search('needle')[0]!.snippet).toHaveLength(80);
    expect(s.search('needle')[0]!.snippet!.endsWith('…')).toBe(true);
    expect(s.search('')[0]).not.toHaveProperty('snippet');
  });

  it('caps results by limit', () => {
    const s = make();
    for (let i = 0; i < 60; i++) s.save({ name: `b${i}`, source: 'b', elements: [], files: {} });
    expect(s.search('', undefined, 3)).toHaveLength(3);
    expect(s.search('', undefined, 500)).toHaveLength(50);
    expect(s.search('')).toHaveLength(10);
  });
});

describe('persistence', () => {
  it('a new store finds boards saved by an earlier one and skips files that are not saved boards', () => {
    const first = make();
    const saved = first.save({ name: 'Auth flow', source: 'b', workspace: WS, elements: [text('t', 'JWT')], files: {} });
    writeFileSync(join(dir, 'broken.json'), '{not json');
    writeFileSync(join(dir, 'other-1.json'), JSON.stringify({ id: 'mismatch', name: 'x', savedAt: 1, elements: [] }));
    writeFileSync(join(dir, 'Bad Name.json'), '{}');
    const second = make();
    expect(second.search('jwt').map((r) => r.id)).toEqual([saved.id]);
    expect(second.get(saved.id)).toMatchObject({ name: 'Auth flow', workspace: WS, elements: [expect.objectContaining({ id: 't' })] });
  });

  it('get throws NotFoundError for unknown or invalid ids; remove deletes file and index entry', () => {
    const s = make();
    const saved = s.save({ name: 'Auth', source: 'b', elements: [], files: {} });
    expect(() => s.get('nope')).toThrow(NotFoundError);
    expect(() => s.get('../etc')).toThrow(NotFoundError);
    expect(s.remove('../etc')).toBe(false);
    expect(s.remove(saved.id)).toBe(true);
    expect(s.remove(saved.id)).toBe(false);
    expect(s.search('')).toEqual([]);
    expect(readdirSync(dir)).toEqual([]);
    expect(make().search('')).toEqual([]);
  });
});
