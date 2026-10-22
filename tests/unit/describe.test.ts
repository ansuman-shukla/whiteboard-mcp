import { describe, expect, it } from 'vitest';
import { describeChanges, describeScene } from '../../src/shared/describe.js';
import { buildElements } from '../../src/shared/elements.js';
import type { ChangeRecord, ExElement } from '../../src/shared/protocol.js';

function seeded(seed = 1): () => number {
  let s = seed;
  return () => (s = (s * 16807) % 2147483647) / 2147483647;
}

function raw(id: string, type: string, over: Record<string, unknown> = {}): ExElement {
  return { id, type, x: 0, y: 0, width: 100, height: 50, version: 1, versionNonce: 1, isDeleted: false, updated: 1, strokeColor: '#1e1e1e', backgroundColor: 'transparent', strokeStyle: 'solid', ...over };
}

function boardScene(): ExElement[] {
  const { elements, warnings } = buildElements(
    [
      { id: 'backend', type: 'frame', x: 40, y: 60, width: 800, height: 400, label: 'Backend' },
      { id: 'api', type: 'rectangle', x: 100, y: 80, width: 160, height: 80, label: 'API Gateway', backgroundColor: 'blue', frame: 'backend' },
      { id: 'db', type: 'rectangle', x: 400, y: 80, width: 160, height: 80, label: 'DB', frame: 'backend' },
      { id: 'a1', type: 'arrow', from: 'api', to: 'db', label: 'SQL', strokeStyle: 'dashed' },
      { id: 't1', type: 'text', text: 'Remember to cache', x: 420, y: 300 },
      { id: 'Xk2', type: 'freedraw', x: 500, y: 320, points: [[0, 0], [30, 25], [90, 40]] },
    ],
    [],
    { now: 1, random: seeded() },
  );
  expect(warnings).toEqual([]);
  return elements;
}

describe('describeScene', () => {
  it('describes a board in reading order with folded labels, bindings, frames and sketches', () => {
    expect(describeScene(boardScene())).toBe(
      [
        'Canvas: 6 elements · bounds (40,60)–(840,460)',
        'frame "backend" [Backend] (40,60) 800×400 contains: api, db',
        'rectangle "api" [API Gateway] (100,80) 160×80 fill #a5d8ff',
        'rectangle "db" [DB] (400,80) 160×80',
        'arrow "a1" api → db [SQL] dashed',
        'text "t1" "Remember to cache" (420,300)',
        'freedraw "Xk2" hand sketch (500,320) 90×40',
      ].join('\n'),
    );
  });

  it('describes human-drawn arrows from their bindings and free ends as coordinates', () => {
    const scene = [
      raw('box', 'rectangle', { boundElements: [{ id: 'h1', type: 'arrow' }] }),
      raw('h1', 'arrow', { x: 110, y: 20, points: [[0, 0], [200, 80], [300, 100]], startBinding: { elementId: 'box', focus: 0, gap: 5 }, endBinding: null, startArrowhead: null, endArrowhead: 'arrow', strokeColor: '#e03131' }),
      raw('h2', 'line', { x: 0, y: 300, points: [[0, 0], [50, 0]], startArrowhead: null, endArrowhead: null }),
      raw('h3', 'arrow', { x: 0, y: 400, points: [[0, 0], [50, 0]], startBinding: { elementId: 'gone' }, startArrowhead: 'dot', endArrowhead: 'arrow' }),
    ];
    const lines = describeScene(scene).split('\n');
    expect(lines).toContain('arrow "h1" box → (410,120) via 1 bends stroke #e03131');
    expect(lines).toContain('line "h2" (0,300) — (50,300)');
    expect(lines).toContain('arrow "h3" (0,400) ↔ (50,400)');
  });

  it('orders by ~40px rows, then x', () => {
    const scene = [raw('A', 'rectangle', { x: 500, y: 100 }), raw('C', 'rectangle', { x: 0, y: 200 }), raw('B', 'rectangle', { x: 100, y: 110 })];
    expect(describeScene(scene).split('\n').slice(1).map((l) => l.split(' ')[1])).toEqual(['"B"', '"A"', '"C"']);
  });

  it('prints only non-default styling, rotation, links and locks', () => {
    const scene = [
      raw('plain', 'rectangle'),
      raw('fancy', 'ellipse', { y: 100, strokeColor: '#1971c2', backgroundColor: '#ffc9c9', strokeStyle: 'dotted', angle: Math.PI / 2, link: 'https://x.y', locked: true }),
      raw('img', 'image', { y: 200, fileId: 'f1' }),
    ];
    expect(describeScene(scene).split('\n').slice(1)).toEqual([
      'rectangle "plain" (0,0) 100×50',
      'ellipse "fancy" (0,100) 100×50 fill #ffc9c9 stroke #1971c2 dotted rotated 90° link https://x.y locked',
      'image "img" (0,200) 100×50',
    ]);
  });

  it('truncates long text at 200 characters and escapes newlines', () => {
    const long = 'a'.repeat(250);
    const out = describeScene([raw('t', 'text', { text: long, originalText: long }), raw('m', 'text', { y: 100, text: 'one\ntwo', originalText: 'one\ntwo' })]);
    expect(out).toContain(`text "t" "${'a'.repeat(200)}…" (0,0)`);
    expect(out).not.toContain('a'.repeat(201));
    expect(out).toContain('text "m" "one\\ntwo" (0,100)');
  });

  it('cuts off after maxElements', () => {
    const scene = Array.from({ length: 5 }, (_, i) => raw(`r${i}`, 'rectangle', { y: i * 100 }));
    const lines = describeScene(scene, { maxElements: 2 }).split('\n');
    expect(lines).toEqual(['Canvas: 5 elements · bounds (0,0)–(100,450)', 'rectangle "r0" (0,0) 100×50', 'rectangle "r1" (0,100) 100×50', '…and 3 more']);
  });

  it('filters by ids, maps label ids to their container and reports missing ids', () => {
    const out = describeScene(boardScene(), { ids: ['db-label', 't1', 'nope'] });
    expect(out.split('\n')).toEqual(['Canvas: 6 elements · bounds (40,60)–(840,460) · showing 2', 'rectangle "db" [DB] (400,80) 160×80', 'text "t1" "Remember to cache" (420,300)', 'Not found: nope']);
  });

  it('ignores tombstones and says when the canvas is empty', () => {
    expect(describeScene([])).toBe('Canvas is empty.');
    expect(describeScene([raw('x', 'rectangle', { isDeleted: true })])).toBe('Canvas is empty.');
    const out = describeScene([raw('x', 'rectangle', { isDeleted: true }), raw('t', 'text', { text: 'gone', containerId: 'x', isDeleted: true }), raw('y', 'diamond')]);
    expect(out).toBe('Canvas: 1 element · bounds (0,0)–(100,50)\ndiamond "y" (0,0) 100×50');
  });

  it('shows an empty frame and a text whose container is gone as plain text', () => {
    const out = describeScene([raw('f', 'frame', { name: 'Ideas', strokeColor: '#bbb' }), raw('t', 'text', { y: 100, text: 'orphan', containerId: 'missing' })]);
    expect(out.split('\n').slice(1)).toEqual(['frame "f" [Ideas] (0,0) 100×50 (empty)', 'text "t" "orphan" (0,100)']);
  });
});

describe('describeChanges', () => {
  const ch = (rev: number, id: string, kind: ChangeRecord['kind'], actor: ChangeRecord['actor'] = 'human'): ChangeRecord => ({ rev, id, kind, actor });
  const elements = () => [
    ...boardScene().map((e) => (e.id === 'db-label' ? { ...e, text: 'Postgres', originalText: 'Postgres', version: 2 } : e)),
    raw('n1', 'rectangle', { x: 0, y: 600 }),
    raw('u1', 'ellipse', { x: 300, y: 600 }),
    raw('tmp', 'rectangle', { isDeleted: true }),
    raw('old', 'rectangle', { isDeleted: true, boundElements: [{ id: 'old-label', type: 'text' }] }),
    raw('old-label', 'text', { isDeleted: true, text: 'Legacy', originalText: 'Legacy', containerId: 'old' }),
  ];
  const changes = [
    ch(1, 'n1', 'created'),
    ch(2, 'n1', 'updated'),
    ch(3, 'tmp', 'created'),
    ch(4, 'tmp', 'deleted'),
    ch(5, 'db-label', 'updated'),
    ch(6, 'old', 'deleted'),
    ch(6, 'old-label', 'deleted'),
    ch(7, 'api', 'updated', 'agent'),
    ch(8, 'u1', 'updated'),
    ch(9, 'u1', 'updated'),
  ];

  it('groups, dedupes and filters by actor; label edits count as container updates', () => {
    expect(describeChanges(changes, elements(), { actor: 'human' })).toBe(
      [
        'Added (1):',
        '  rectangle "n1" (0,600) 100×50',
        'Updated (2):',
        '  rectangle "db" [Postgres] (400,80) 160×80',
        '  ellipse "u1" (300,600) 100×50',
        'Deleted (1):',
        '  rectangle "old" [Legacy]',
      ].join('\n'),
    );
  });

  it('includes every actor without a filter', () => {
    const out = describeChanges(changes, elements());
    expect(out).toContain('Updated (3):');
    expect(out).toContain('  rectangle "api" [API Gateway] (100,80) 160×80 fill #a5d8ff');
  });

  it('folds a new container label into the container being added', () => {
    const els = boardScene();
    const out = describeChanges([ch(1, 'db', 'created'), ch(1, 'db-label', 'created')], els);
    expect(out).toBe('Added (1):\n  rectangle "db" [DB] (400,80) 160×80');
  });

  it('reports label changes without the container in the element list', () => {
    const label = raw('db-label', 'text', { text: 'Postgres', originalText: 'Postgres', containerId: 'db' });
    expect(describeChanges([ch(1, 'db-label', 'updated')], [label])).toBe('Updated (1):\n  label of "db" now [Postgres]');
    const tomb = { ...label, isDeleted: true };
    expect(describeChanges([ch(1, 'db-label', 'deleted')], [tomb])).toBe('Updated (1):\n  label of "db" removed');
  });

  it('reports a removed label on a live container', () => {
    const els = boardScene().map((e) => (e.id === 'db-label' ? { ...e, isDeleted: true } : e.id === 'db' ? { ...e, boundElements: [] } : e));
    expect(describeChanges([ch(1, 'db-label', 'deleted')], els)).toBe('Updated (1):\n  rectangle "db" (400,80) 160×80 (label removed)');
  });

  it('prefers the newest copy when an element appears twice', () => {
    const out = describeChanges([ch(1, 'z', 'updated')], [raw('z', 'rectangle', { version: 1 }), raw('z', 'rectangle', { version: 3, x: 77 })]);
    expect(out).toBe('Updated (1):\n  rectangle "z" (77,0) 100×50');
  });

  it('returns an empty string when nothing relevant changed', () => {
    expect(describeChanges([], elements())).toBe('');
    expect(describeChanges([ch(1, 'api', 'updated', 'agent')], elements(), { actor: 'human' })).toBe('');
    expect(describeChanges([ch(1, 'tmp', 'created'), ch(2, 'tmp', 'deleted')], elements())).toBe('');
  });
});
