import { describe, expect, it } from 'vitest';
import { ELEMENT_SPEC_FIELDS, PALETTE, buildElements, deleteElements, estimateTextSize, type ElementSpec } from '../../src/shared/elements.js';
import { incomingWins, type ExElement } from '../../src/shared/protocol.js';

type El = ExElement & Record<string, any>;

function seeded(seed = 1): () => number {
  let s = seed;
  return () => (s = (s * 16807) % 2147483647) / 2147483647;
}
const opts = (now = 1000, seed = 1) => ({ now, random: seeded(seed) });

function build(specs: ElementSpec[], scene: ExElement[] = [], now = 1000) {
  const r = buildElements(specs, scene, opts(now));
  return { ...r, get: (id: string) => r.elements.find((e) => e.id === id) as El | undefined };
}

/** Applies a result to a scene the way the store would (by id). */
function merge(scene: ExElement[], els: ExElement[]): ExElement[] {
  const m = new Map(scene.map((e) => [e.id, e]));
  for (const e of els) m.set(e.id, e);
  return [...m.values()];
}

const center = (e: El) => [e.x + e.width / 2, e.y + e.height / 2] as const;
const start = (a: El) => [a.x + a.points[0][0], a.y + a.points[0][1]] as const;
const end = (a: El) => {
  const p = a.points[a.points.length - 1];
  return [a.x + p[0], a.y + p[1]] as const;
};
/** Pulls a point `gap` px back toward the element centre. */
function pullIn(p: readonly [number, number], el: El, gap = 8): [number, number] {
  const [cx, cy] = center(el);
  const d = Math.hypot(p[0] - cx, p[1] - cy);
  return [p[0] - ((p[0] - cx) / d) * gap, p[1] - ((p[1] - cy) / d) * gap];
}

const BASE: Record<string, string> = {
  id: 'string', type: 'string', x: 'number', y: 'number', width: 'number', height: 'number', angle: 'number',
  strokeColor: 'string', backgroundColor: 'string', fillStyle: 'string', strokeWidth: 'number', strokeStyle: 'string',
  roughness: 'number', opacity: 'number', seed: 'number', version: 'number', versionNonce: 'number', isDeleted: 'boolean',
  updated: 'number', locked: 'boolean',
};

describe('buildElements: element shape', () => {
  const r = build([
    { id: 'r', type: 'rectangle', x: 0, y: 0 },
    { id: 'e', type: 'ellipse', x: 300, y: 0 },
    { id: 'd', type: 'diamond', x: 600, y: 0 },
    { id: 't', type: 'text', x: 0, y: 200, text: 'hi' },
    { id: 'a', type: 'arrow', from: 'r', to: 'e' },
    { id: 'l', type: 'line', x: 0, y: 400, points: [[0, 0], [50, 50]] },
    { id: 'f', type: 'frame', x: -50, y: -50, width: 900, height: 600, label: 'Zone' },
    { id: 'p', type: 'freedraw', x: 10, y: 500, points: [[0, 0], [5, 3], [9, -2]] },
  ]);

  it('creates every type with all base fields of the right type', () => {
    expect(r.warnings).toEqual([]);
    expect(r.ids).toEqual(['r', 'e', 'd', 't', 'a', 'l', 'f', 'p']);
    for (const id of r.ids) {
      const el = r.get(id)!;
      for (const [k, t] of Object.entries(BASE)) expect(typeof el[k], `${id}.${k}`).toBe(t);
      expect(Array.isArray(el.groupIds)).toBe(true);
      expect(el.frameId).toBeNull();
      expect(el.link).toBeNull();
      expect(el.index).toBeNull();
      expect(Array.isArray(el.boundElements)).toBe(true);
      expect('roundness' in el).toBe(true);
      expect(Number.isInteger(el.seed) && Number.isInteger(el.versionNonce)).toBe(true);
      expect(el.roughness).toBe(id === 'f' ? 0 : 1);
      expect(el).toMatchObject({ version: 1, isDeleted: false, updated: 1000, angle: 0, opacity: 100, strokeWidth: 2, fillStyle: 'solid', strokeStyle: 'solid' });
    }
  });

  it('applies the per-type defaults', () => {
    expect(r.get('r')).toMatchObject({ width: 160, height: 80, roundness: { type: 3 }, strokeColor: '#1e1e1e', backgroundColor: 'transparent' });
    expect(r.get('e')!.roundness).toBeNull();
    expect(r.get('d')!.roundness).toEqual({ type: 2 });
    expect(r.get('t')).toMatchObject({ text: 'hi', originalText: 'hi', fontSize: 20, fontFamily: 5, textAlign: 'left', verticalAlign: 'top', containerId: null, autoResize: true, lineHeight: 1.25, roundness: null });
    expect(r.get('t')!.width).toBeGreaterThan(0);
    expect(r.get('t')!.height).toBe(25);
    for (const id of ['a', 'l']) {
      const el = r.get(id)!;
      expect(el).toMatchObject({ lastCommittedPoint: null, startArrowhead: null, roundness: { type: 2 } });
      expect(el.points[0]).toEqual([0, 0]);
    }
    expect(r.get('a')).toMatchObject({ endArrowhead: 'arrow', elbowed: false });
    expect(r.get('l')).toMatchObject({ endArrowhead: null, startBinding: null, endBinding: null, points: [[0, 0], [50, 50]], width: 50, height: 50 });
    expect(r.get('f')).toMatchObject({ name: 'Zone', width: 900, height: 600 });
    expect(r.get('p')).toMatchObject({ simulatePressure: true, pressures: [], lastCommittedPoint: null, x: 10, y: 500, width: 9, height: 5, points: [[0, 0], [5, 3], [9, -2]] });
  });

  it('uses the Excalidraw line height of each font', () => {
    const t = build([
      { id: 'n', type: 'text', text: 'a', fontFamily: 'normal' },
      { id: 'c', type: 'text', text: 'a', fontFamily: 'code', fontSize: 10 },
      { id: 'v', type: 'text', text: 'a', fontFamily: 1 },
    ]);
    expect(t.get('n')).toMatchObject({ fontFamily: 6, lineHeight: 1.35 });
    expect(t.get('c')).toMatchObject({ fontFamily: 8, lineHeight: 1.25, height: 12.5 });
    expect(t.get('v')).toMatchObject({ fontFamily: 1, lineHeight: 1.25 });
  });

  it('exposes a description for every spec field', () => {
    for (const k of ['id', 'type', 'label', 'from', 'to', 'points', 'strokeColor', 'fontFamily', 'endArrowhead', 'frame']) expect(ELEMENT_SPEC_FIELDS[k as keyof ElementSpec]).toMatch(/\w/);
  });

  it('does not mutate the input scene', () => {
    const scene = build([{ id: 'r', type: 'rectangle', x: 0, y: 0, label: 'A' }]).elements;
    const copy = structuredClone(scene);
    buildElements([{ id: 'r', x: 99, label: 'B' }, { id: 'a', type: 'arrow', from: 'r', to: 'r2' }], scene, opts());
    deleteElements(['r'], scene, opts());
    expect(scene).toEqual(copy);
  });
});

describe('colours', () => {
  it('maps Open Color names to Excalidraw picker shades', () => {
    expect(Object.keys(PALETTE)).toEqual(expect.arrayContaining(['black', 'gray', 'red', 'pink', 'grape', 'violet', 'indigo', 'blue', 'cyan', 'teal', 'green', 'lime', 'yellow', 'orange']));
    expect(PALETTE.blue).toEqual({ stroke: '#1971c2', fill: '#a5d8ff' });
    expect(PALETTE.red).toEqual({ stroke: '#e03131', fill: '#ffc9c9' });
    const r = build([{ id: 'r', type: 'rectangle', strokeColor: 'red', backgroundColor: 'Green' }, { id: 's', type: 'rectangle', strokeColor: '#ABCDEF', backgroundColor: 'transparent' }]);
    expect(r.get('r')).toMatchObject({ strokeColor: '#e03131', backgroundColor: '#b2f2bb', fillStyle: 'solid' });
    expect(r.get('s')).toMatchObject({ strokeColor: '#ABCDEF', backgroundColor: 'transparent' });
  });

  it('warns on invalid colours and keeps the defaults', () => {
    const r = build([{ id: 'r', type: 'rectangle', strokeColor: 'blurple', backgroundColor: '#12' }]);
    expect(r.get('r')).toMatchObject({ strokeColor: '#1e1e1e', backgroundColor: 'transparent' });
    expect(r.warnings).toHaveLength(2);
    expect(r.warnings.join()).toContain('blurple');
    expect(r.ids).toEqual(['r']);
  });
});

describe('labels and auto-size', () => {
  it('auto-sizes labelled shapes with room for the text', () => {
    const r = build([
      { id: 's', type: 'rectangle', label: 'Hi' },
      { id: 'w', type: 'rectangle', label: 'A considerably longer label text' },
      { id: 'e', type: 'ellipse', label: 'A considerably longer label text' },
      { id: 'd', type: 'diamond', label: 'A considerably longer label text' },
      { id: 'x', type: 'rectangle', label: 'A considerably longer label text', width: 90, height: 40 },
    ]);
    expect(r.get('s')).toMatchObject({ width: 120, height: 60 });
    const w = r.get('w')!;
    const text = r.get('w-label')!;
    expect(w.width).toBeGreaterThan(120);
    expect(w.width).toBeGreaterThan(text.width);
    expect(w.height).toBeGreaterThan(text.height);
    expect(r.get('e')!.width).toBeGreaterThan(w.width);
    expect(r.get('d')!.width).toBeGreaterThan(r.get('e')!.width);
    expect(r.get('x')).toMatchObject({ width: 90, height: 40 });
  });

  it('binds the label to its container both ways, centred', () => {
    const r = build([{ id: 'box', type: 'rectangle', x: 100, y: 50, width: 200, height: 100, label: 'Hello', strokeColor: 'blue' }]);
    const box = r.get('box')!;
    const label = r.get('box-label')!;
    expect(r.ids).toEqual(['box']);
    expect(box.boundElements).toEqual([{ type: 'text', id: 'box-label' }]);
    expect(label).toMatchObject({ type: 'text', containerId: 'box', text: 'Hello', originalText: 'Hello', textAlign: 'center', verticalAlign: 'middle', fontSize: 20, strokeColor: '#1971c2' });
    expect(label.x + label.width / 2).toBeCloseTo(200);
    expect(label.y + label.height / 2).toBeCloseTo(100);
  });

  it('updates label text in place and removes it with ""', () => {
    const scene = build([{ id: 'box', type: 'rectangle', x: 0, y: 0, label: 'Old' }]).elements;
    const up = build([{ id: 'box', label: 'New' }], scene, 2000);
    expect(up.get('box-label')).toMatchObject({ text: 'New', version: 2 });
    expect(up.get('box-label')!.x + up.get('box-label')!.width / 2).toBeCloseTo(up.get('box')!.x + up.get('box')!.width / 2);
    const gone = build([{ id: 'box', label: '' }], merge(scene, up.elements), 3000);
    expect(gone.get('box-label')).toMatchObject({ isDeleted: true, version: 3 });
    expect(gone.get('box')!.boundElements).toEqual([]);
  });

  it('puts arrow labels at the arrow midpoint with font size 16', () => {
    const r = build([{ id: 'a', type: 'arrow', x: 0, y: 0, points: [[0, 0], [200, 100]], label: 'go' }]);
    const l = r.get('a-label')!;
    expect(l).toMatchObject({ containerId: 'a', fontSize: 16 });
    expect(r.get('a')!.boundElements).toEqual([{ type: 'text', id: 'a-label' }]);
    expect(l.x + l.width / 2).toBeCloseTo(100);
    expect(l.y + l.height / 2).toBeCloseTo(50);
  });

  it('does not reuse a label id that another spec in the batch claims', () => {
    const r = build([{ id: 'b', type: 'rectangle', label: 'L' }, { id: 'b-label', type: 'text', text: 'mine', x: 500, y: 500 }]);
    expect(r.get('b-label')).toMatchObject({ text: 'mine', containerId: null });
    const bound = r.get('b')!.boundElements[0].id;
    expect(bound).not.toBe('b-label');
    expect(r.get(bound)).toMatchObject({ text: 'L', containerId: 'b' });
  });
});

describe('arrows', () => {
  const shapes: ElementSpec[] = [
    { id: 'src', type: 'rectangle', x: 0, y: 0, width: 100, height: 60 },
    { id: 'dst', type: 'rectangle', x: 300, y: 0, width: 100, height: 60 },
  ];

  it('starts on the source right edge and ends on the target left edge with an 8px gap', () => {
    const r = build([...shapes, { id: 'a', type: 'arrow', from: 'src', to: 'dst' }]);
    const a = r.get('a')!;
    expect(start(a)[0]).toBeCloseTo(108);
    expect(start(a)[1]).toBeCloseTo(30);
    expect(end(a)[0]).toBeCloseTo(292);
    expect(end(a)[1]).toBeCloseTo(30);
    expect(a.startBinding).toEqual({ elementId: 'src', focus: 0, gap: 8 });
    expect(a.endBinding).toEqual({ elementId: 'dst', focus: 0, gap: 8 });
    expect(a.width).toBeCloseTo(184);
    expect(r.get('src')!.boundElements).toEqual([{ id: 'a', type: 'arrow' }]);
    expect(r.get('dst')!.boundElements).toEqual([{ id: 'a', type: 'arrow' }]);
  });

  it('lands on ellipse and diamond outlines', () => {
    const r = build([
      { id: 'o', type: 'ellipse', x: 0, y: 0, width: 200, height: 100 },
      { id: 'dia', type: 'diamond', x: 400, y: 300, width: 160, height: 120 },
      { id: 'a', type: 'arrow', from: 'o', to: 'dia' },
    ]);
    const a = r.get('a')!;
    const o = r.get('o')!;
    const d = r.get('dia')!;
    const [sx, sy] = pullIn(start(a), o);
    expect(((sx - 100) / 100) ** 2 + ((sy - 50) / 50) ** 2).toBeCloseTo(1, 3);
    const [ex, ey] = pullIn(end(a), d);
    expect(Math.abs(ex - 480) / 80 + Math.abs(ey - 360) / 60).toBeCloseTo(1, 3);
    expect(Math.hypot(start(a)[0] - sx, start(a)[1] - sy)).toBeCloseTo(8);
  });

  it('resolves forward references within the same batch', () => {
    const r = build([{ id: 'a', type: 'arrow', from: 'src', to: 'dst', label: 'x' }, ...shapes]);
    expect(r.warnings).toEqual([]);
    expect(r.ids).toEqual(['a', 'src', 'dst']);
    expect(r.get('a')!.startBinding.elementId).toBe('src');
    expect(start(r.get('a')!)[0]).toBeCloseTo(108);
    expect(r.get('dst')!.boundElements).toEqual([{ id: 'a', type: 'arrow' }]);
  });

  it('warns about a missing binding target and leaves that end free', () => {
    const r = build([shapes[0]!, { id: 'a', type: 'arrow', from: 'src', to: 'nope' }]);
    expect(r.warnings.join()).toContain('nope');
    expect(r.get('a')).toMatchObject({ endBinding: null, startBinding: { elementId: 'src' } });
  });

  it('binds to the container when given a label id, and lines never bind', () => {
    const r = build([{ id: 'b', type: 'rectangle', x: 0, y: 0, label: 'B' }, { id: 'c', type: 'rectangle', x: 400, y: 0 }, { id: 'a', type: 'arrow', from: 'b-label', to: 'c' }, { id: 'l', type: 'line', from: 'b', to: 'c' }]);
    expect(r.get('a')!.startBinding.elementId).toBe('b');
    expect(r.get('l')).toMatchObject({ startBinding: null, endBinding: null });
    expect(r.get('c')!.boundElements).toEqual([{ id: 'a', type: 'arrow' }]);
  });

  it('handles arrowheads: none → null, invalid → warning and default', () => {
    const r = build([
      { id: 'a', type: 'arrow', endArrowhead: 'none', startArrowhead: 'dot' },
      { id: 'b', type: 'arrow', endArrowhead: 'spear' },
      { id: 'l', type: 'line', endArrowhead: 'triangle' },
    ]);
    expect(r.get('a')).toMatchObject({ endArrowhead: null, startArrowhead: 'dot' });
    expect(r.get('b')!.endArrowhead).toBe('arrow');
    expect(r.warnings.join()).toContain('spear');
    expect(r.get('l')!.endArrowhead).toBe('triangle');
  });

  it('does not duplicate boundElements when an arrow is updated', () => {
    const scene = build([...shapes, { id: 'a', type: 'arrow', from: 'src', to: 'dst' }]).elements;
    const up = build([{ id: 'a', from: 'src', strokeStyle: 'dashed' }], scene, 2000);
    const src = up.get('src') ?? (scene.find((e) => e.id === 'src') as El);
    expect(src.boundElements).toEqual([{ id: 'a', type: 'arrow' }]);
    expect(up.get('a')!.strokeStyle).toBe('dashed');
  });
});

describe('updates', () => {
  it('patches only the given fields and bumps version and nonce', () => {
    const scene = build([{ id: 'r', type: 'rectangle', x: 10, y: 20, backgroundColor: 'yellow', strokeStyle: 'dotted' }]).elements;
    const old = scene[0] as El;
    const r = build([{ id: 'r', x: 50 }], scene, 5000);
    const el = r.get('r')!;
    expect(r.ids).toEqual(['r']);
    expect(el).toMatchObject({ x: 50, y: 20, width: 160, height: 80, backgroundColor: '#ffec99', strokeStyle: 'dotted', seed: old.seed, version: 2, updated: 5000 });
    expect(el.versionNonce).not.toBe(old.versionNonce);
    expect(Number.isInteger(el.versionNonce)).toBe(true);
    expect(r.elements).toHaveLength(1);
  });

  it('re-routes bound arrows (agent- and human-drawn) and recentres labels when a shape moves', () => {
    const base = build([
      { id: 'src', type: 'rectangle', x: 0, y: 0, width: 100, height: 60, label: 'S' },
      { id: 'dst', type: 'rectangle', x: 300, y: 0, width: 100, height: 60 },
      { id: 'a', type: 'arrow', from: 'src', to: 'dst', label: 'call' },
    ]).elements as El[];
    const human: El = {
      id: 'HUMANxyz', type: 'arrow', x: 50, y: 70, width: 300, height: 0, version: 5, versionNonce: 7, isDeleted: false, updated: 1,
      points: [[0, 0], [300, 0]], startBinding: { elementId: 'src', focus: 0.2, gap: 4 }, endBinding: null, startArrowhead: null, endArrowhead: 'arrow', elbowed: false,
      boundElements: null, angle: 0,
    };
    const scene = [...base.map((e) => (e.id === 'src' ? { ...e, boundElements: [...e.boundElements, { id: 'HUMANxyz', type: 'arrow' }] } : e)), human];
    const r = build([{ id: 'dst', y: 300 }, { id: 'src', x: -40 }], scene, 9000);
    expect(r.ids).toEqual(['dst', 'src']);
    const a = r.get('a')!;
    expect(a.version).toBe(2);
    const [ex, ey] = pullIn(end(a), r.get('dst')!);
    expect(ey).toBeCloseTo(300);
    expect(ex).toBeGreaterThan(300);
    expect(ex).toBeLessThan(400);
    const l = r.get('a-label')!;
    const mid = [a.x + (a.points[0][0] + a.points[1][0]) / 2, a.y + (a.points[0][1] + a.points[1][1]) / 2];
    expect(l.x + l.width / 2).toBeCloseTo(mid[0]!);
    expect(l.y + l.height / 2).toBeCloseTo(mid[1]!);
    const h = r.get('HUMANxyz')!;
    expect(h).toMatchObject({ version: 6, updated: 9000, endBinding: null, startBinding: { elementId: 'src', gap: 4 } });
    expect(end(h)[0]).toBeCloseTo(350);
    expect(start(h)[0]).toBeCloseTo(60 + (4 * 340) / Math.hypot(340, 40));
    const sl = r.get('src-label')!;
    expect(sl.x + sl.width / 2).toBeCloseTo(10);
  });

  it('grows a shape for a longer label and keeps explicit sizes', () => {
    const scene = build([{ id: 'r', type: 'rectangle', x: 0, y: 0, label: 'A' }]).elements;
    const r = build([{ id: 'r', label: 'A very very long label that needs more room' }], scene);
    expect(r.get('r')!.width).toBeGreaterThan(160);
    expect(r.get('r')!.width).toBeGreaterThan(r.get('r-label')!.width);
  });

  it('rejects type changes with a warning', () => {
    const scene = build([{ id: 'r', type: 'rectangle' }]).elements;
    const r = build([{ id: 'r', type: 'ellipse', x: 5 }], scene);
    expect(r.elements).toEqual([]);
    expect(r.ids).toEqual([]);
    expect(r.warnings.join()).toMatch(/type/);
  });

  it('requires a type to create', () => {
    const r = build([{ id: 'ghost', x: 1 }]);
    expect(r.elements).toEqual([]);
    expect(r.warnings.join()).toContain('ghost');
  });

  it('re-creates a tombstoned id with a version that beats the tombstone', () => {
    const tomb: El = { id: 'r', type: 'rectangle', x: 0, y: 0, width: 1, height: 1, version: 7, versionNonce: 3, isDeleted: true, updated: 1 };
    const r = build([{ id: 'r', type: 'ellipse', x: 10, y: 10 }], [tomb]);
    const el = r.get('r')!;
    expect(el).toMatchObject({ type: 'ellipse', version: 8, isDeleted: false });
    expect(incomingWins(el, tomb)).toBe(true);
  });

  it('validates ids and auto-generates missing ones', () => {
    const r = build([{ id: 'bad id!', type: 'rectangle' }, { type: 'rectangle' }, { id: 'x'.repeat(65), type: 'rectangle' }]);
    expect(r.warnings).toHaveLength(2);
    expect(r.ids).toHaveLength(1);
    expect(r.ids[0]).toMatch(/^[A-Za-z0-9_.:-]{1,64}$/);
    expect(r.elements.map((e) => e.id)).toEqual(r.ids);
  });

  it('is deterministic for the same options', () => {
    const specs: ElementSpec[] = [{ type: 'rectangle', label: 'a' }, { id: 'b', type: 'ellipse', x: 300, y: 0 }, { type: 'arrow', to: 'b' }];
    const a = buildElements(specs, [], opts(1, 42));
    const b = buildElements(specs, [], opts(1, 42));
    const c = buildElements(specs, [], opts(1, 43));
    expect(a).toEqual(b);
    expect(c.elements.map((e) => e.versionNonce)).not.toEqual(a.elements.map((e) => e.versionNonce));
  });
});

describe('deleteElements', () => {
  const scene = () =>
    build([
      { id: 'src', type: 'rectangle', x: 0, y: 0, label: 'S' },
      { id: 'dst', type: 'rectangle', x: 400, y: 0, label: 'D' },
      { id: 'a', type: 'arrow', from: 'src', to: 'dst', label: 'l' },
    ]).elements;

  it('tombstones a shape and its label, unbinds arrows but keeps them', () => {
    const r = deleteElements(['dst', 'zzz'], scene(), opts(7000));
    const get = (id: string) => r.elements.find((e) => e.id === id) as El;
    expect(r.ids).toEqual(['dst']);
    expect(r.warnings).toHaveLength(1);
    expect(r.warnings[0]).toContain('zzz');
    expect(get('dst')).toMatchObject({ isDeleted: true, version: 2, updated: 7000 });
    expect(get('dst-label').isDeleted).toBe(true);
    expect(get('a')).toMatchObject({ isDeleted: false, endBinding: null, startBinding: { elementId: 'src' } });
    expect(get('src')).toBeUndefined();
  });

  it('removes a deleted arrow from its targets and drops its label', () => {
    const r = deleteElements(['a'], scene(), opts());
    const get = (id: string) => r.elements.find((e) => e.id === id) as El;
    expect(get('a-label').isDeleted).toBe(true);
    expect(get('src').boundElements).toEqual([{ id: 'src-label', type: 'text' }]);
    expect(get('dst').boundElements).toEqual([{ id: 'dst-label', type: 'text' }]);
  });

  it('clears the container entry when a label is deleted', () => {
    const r = deleteElements(['src-label'], scene(), opts());
    const get = (id: string) => r.elements.find((e) => e.id === id) as El;
    expect(get('src-label').isDeleted).toBe(true);
    expect(get('src').boundElements).toEqual([{ id: 'a', type: 'arrow' }]);
    expect(get('src').isDeleted).toBe(false);
  });

  it('warns about already-deleted ids', () => {
    const s = scene();
    const once = deleteElements(['src'], s, opts());
    const twice = deleteElements(['src'], merge(s, once.elements), opts());
    expect(twice.elements).toEqual([]);
    expect(twice.warnings[0]).toContain('already deleted');
  });
});

describe('estimateTextSize', () => {
  it('scales with font size and lines', () => {
    const one = estimateTextSize('hello', 20, 5);
    const two = estimateTextSize('hello\nhello', 20, 5);
    expect(two.width).toBe(one.width);
    expect(two.height).toBe(2 * one.height);
    expect(estimateTextSize('hello', 40, 5).width).toBeGreaterThan(one.width * 1.9);
    expect(estimateTextSize('你好', 20, 5).width).toBeGreaterThan(estimateTextSize('ab', 20, 5).width);
  });
});

describe('arrow label fit', () => {
  const shapes = (gap: number): ElementSpec[] => [
    { id: 'a', type: 'rectangle', x: 0, y: 0, width: 160, height: 80 },
    { id: 'b', type: 'rectangle', x: 160 + gap, y: 0, width: 160, height: 80 },
  ];

  it('warns when the label is longer than the visible arrow, naming both ends', () => {
    const r = build([...shapes(60), { id: 'e', type: 'arrow', from: 'a', to: 'b', label: 'verify the JWT signature' }]);
    expect(r.warnings.find((w) => w.startsWith('e:'))).toMatch(/label .*longer than the arrow.*"a".*"b"/);
  });

  it('stays quiet when the shapes leave room for the label', () => {
    const r = build([...shapes(320), { id: 'e', type: 'arrow', from: 'a', to: 'b', label: 'verify the JWT signature' }]);
    expect(r.warnings).toEqual([]);
  });

  it('re-checks when a later update moves a shape closer', () => {
    const first = build([...shapes(320), { id: 'e', type: 'arrow', from: 'a', to: 'b', label: 'verify the JWT signature' }]);
    const moved = build([{ id: 'b', x: 200 }], first.elements);
    expect(moved.warnings.some((w) => w.startsWith('e:'))).toBe(true);
  });
});
