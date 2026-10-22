import type { ExElement } from './protocol.js';

export type ShapeType = 'rectangle' | 'ellipse' | 'diamond' | 'text' | 'arrow' | 'line' | 'frame' | 'freedraw';

export interface ElementSpec {
  id?: string;
  type?: ShapeType;
  x?: number;
  y?: number;
  width?: number;
  height?: number;
  label?: string;
  text?: string;
  from?: string;
  to?: string;
  points?: number[][];
  strokeColor?: string;
  backgroundColor?: string;
  fillStyle?: 'solid' | 'hachure' | 'cross-hatch' | 'zigzag';
  strokeStyle?: 'solid' | 'dashed' | 'dotted';
  strokeWidth?: number;
  roughness?: number;
  opacity?: number;
  fontSize?: number;
  fontFamily?: 'hand' | 'normal' | 'code' | number;
  textAlign?: 'left' | 'center' | 'right';
  rounded?: boolean;
  startArrowhead?: string;
  endArrowhead?: string;
  frame?: string;
  groupIds?: string[];
  locked?: boolean;
  link?: string;
}

export interface BuildOptions {
  now?: number;
  random?: () => number;
}

export interface BuildResult {
  elements: ExElement[];
  ids: string[];
  warnings: string[];
}

export type Point = [number, number];
export interface BoundRef {
  id: string;
  type: 'arrow' | 'text';
}
export interface PointBinding {
  elementId: string;
  focus: number;
  gap: number;
}

/** Excalidraw 0.18 element fields beyond the wire-level ExElement core. */
export interface ElementProps {
  angle: number;
  strokeColor: string;
  backgroundColor: string;
  fillStyle: string;
  strokeWidth: number;
  strokeStyle: string;
  roughness: number;
  opacity: number;
  groupIds: string[];
  frameId: string | null;
  roundness: { type: number; value?: number } | null;
  seed: number;
  boundElements: BoundRef[] | null;
  link: string | null;
  locked: boolean;
  index: string | null;
  text: string;
  originalText: string;
  fontSize: number;
  fontFamily: number;
  textAlign: string;
  verticalAlign: string;
  containerId: string | null;
  autoResize: boolean;
  lineHeight: number;
  points: Point[];
  lastCommittedPoint: Point | null;
  startBinding: PointBinding | null;
  endBinding: PointBinding | null;
  startArrowhead: string | null;
  endArrowhead: string | null;
  elbowed: boolean;
  pressures: number[];
  simulatePressure: boolean;
  name: string | null;
  fileId: string | null;
}

export type Elem = ExElement & Partial<ElementProps>;

/** Open Color shades used by Excalidraw's picker: stroke = shade 8, fill = shade 2. */
export const PALETTE: Record<string, { stroke: string; fill: string }> = {
  black: { stroke: '#1e1e1e', fill: '#1e1e1e' },
  white: { stroke: '#ffffff', fill: '#ffffff' },
  gray: { stroke: '#343a40', fill: '#e9ecef' },
  red: { stroke: '#e03131', fill: '#ffc9c9' },
  pink: { stroke: '#c2255c', fill: '#fcc2d7' },
  grape: { stroke: '#9c36b5', fill: '#eebefa' },
  violet: { stroke: '#6741d9', fill: '#d0bfff' },
  indigo: { stroke: '#3b5bdb', fill: '#bac8ff' },
  blue: { stroke: '#1971c2', fill: '#a5d8ff' },
  cyan: { stroke: '#0c8599', fill: '#99e9f2' },
  teal: { stroke: '#099268', fill: '#96f2d7' },
  green: { stroke: '#2f9e44', fill: '#b2f2bb' },
  lime: { stroke: '#66a80f', fill: '#d8f5a2' },
  yellow: { stroke: '#f08c00', fill: '#ffec99' },
  orange: { stroke: '#e8590c', fill: '#ffd8a8' },
};

export const ELEMENT_SPEC_FIELDS: Record<keyof ElementSpec, string> = {
  id: 'Readable id (letters, digits, _ . : -). Reuse an existing id to update that element; omit to auto-generate.',
  type: 'rectangle | ellipse | diamond | text | arrow | line | frame | freedraw. Required to create; cannot be changed.',
  x: 'Left edge in canvas px (for arrow/line/freedraw: origin of points).',
  y: 'Top edge in canvas px.',
  width: 'Width in px. Shapes auto-size to their label when omitted.',
  height: 'Height in px.',
  label: 'Text centered inside a shape, on an arrow, or a frame name. "" removes it.',
  text: 'Content of a text element (use \\n for new lines).',
  from: 'Arrow/line start: id of the element to connect from (edge point computed automatically).',
  to: 'Arrow/line end: id of the element to connect to.',
  points: 'Arrow/line/freedraw points [[x,y],...] relative to x,y.',
  strokeColor: 'Outline/text colour: hex or palette name (black gray red pink grape violet indigo blue cyan teal green lime yellow orange).',
  backgroundColor: 'Fill colour: hex, palette name (light shade) or transparent.',
  fillStyle: 'solid | hachure | cross-hatch | zigzag (default solid).',
  strokeStyle: 'solid | dashed | dotted.',
  strokeWidth: 'Outline width (1 thin, 2 default, 4 bold).',
  roughness: '0 clean, 1 hand-drawn (default), 2 sketchy.',
  opacity: '0-100 (default 100).',
  fontSize: 'Font size in px (default 20, arrow labels 16).',
  fontFamily: 'hand (default) | normal | code.',
  textAlign: 'left | center | right (text elements).',
  rounded: 'Rounded corners (default true for rectangles, diamonds, arrows, lines).',
  startArrowhead: 'arrow | bar | dot | circle | circle_outline | triangle | triangle_outline | diamond | diamond_outline | crowfoot_one | crowfoot_many | crowfoot_one_or_many | none (default none).',
  endArrowhead: 'Same values as startArrowhead (default arrow for arrows, none for lines).',
  frame: 'Id of a frame to place this element in ("" to remove from its frame).',
  groupIds: 'Group ids; elements sharing a group id move together.',
  locked: 'Lock the element against editing in the canvas.',
  link: 'URL attached to the element.',
};

const ID_PATTERN = /^[A-Za-z0-9_.:-]{1,64}$/;
const SHAPES = new Set<string>(['rectangle', 'ellipse', 'diamond', 'text', 'arrow', 'line', 'frame', 'freedraw']);
const BINDABLE = new Set(['rectangle', 'ellipse', 'diamond', 'text', 'image', 'frame', 'magicframe', 'iframe', 'embeddable']);
const LABELLED = new Set(['rectangle', 'ellipse', 'diamond', 'arrow']);
const ARROWHEADS = new Set(['arrow', 'bar', 'dot', 'circle', 'circle_outline', 'triangle', 'triangle_outline', 'diamond', 'diamond_outline', 'crowfoot_one', 'crowfoot_many', 'crowfoot_one_or_many']);
const FILL_STYLES = new Set(['solid', 'hachure', 'cross-hatch', 'zigzag']);
const STROKE_STYLES = new Set(['solid', 'dashed', 'dotted']);
const TEXT_ALIGNS = new Set(['left', 'center', 'right']);
const FONTS: Record<string, number> = { hand: 5, normal: 6, code: 8 };
/** FONT_METADATA[family].metrics.lineHeight in Excalidraw 0.18. */
const LINE_HEIGHTS: Record<number, number> = { 1: 1.25, 2: 1.15, 3: 1.2, 5: 1.25, 6: 1.35, 7: 1.15, 8: 1.25, 9: 1.15 };
const HEX = /^#(?:[0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})$/i;
const WIDE = /[\u1100-\u115F\u2E80-\u303E\u3041-\u33FF\u3400-\u4DBF\u4E00-\u9FFF\uA000-\uA4CF\uAC00-\uD7A3\uF900-\uFAFF\uFE30-\uFE4F\uFF00-\uFF60\uFFE0-\uFFE6\u{1F300}-\u{1FAFF}\u{20000}-\u{3FFFD}]/u;
const STROKE = '#1e1e1e';
const GAP = 8;
const DEFAULT_POINTS: Point[] = [[0, 0], [150, 0]];

export const lineHeightOf = (fontFamily: number): number => LINE_HEIGHTS[fontFamily] ?? 1.25;

export function estimateTextSize(text: string, fontSize: number, fontFamily: number): { width: number; height: number } {
  const em = fontFamily === 6 ? 0.55 : fontFamily === 8 || fontFamily === 3 ? 0.6 : 0.58;
  const lines = text.split('\n');
  let widest = 0;
  for (const line of lines) {
    let w = 0;
    for (const ch of line) w += WIDE.test(ch) ? 1 : em;
    widest = Math.max(widest, w);
  }
  return { width: Math.ceil(widest * fontSize), height: lines.length * fontSize * lineHeightOf(fontFamily) };
}

export const isLinear = (el: { type: string }): boolean => el.type === 'arrow' || el.type === 'line';

/** Axis-aligned [x1, y1, x2, y2] ignoring rotation. */
export function bounds(el: Elem): [number, number, number, number] {
  if (Array.isArray(el.points) && el.points.length) {
    const xs = el.points.map((p) => el.x + p[0]);
    const ys = el.points.map((p) => el.y + p[1]);
    return [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)];
  }
  return [el.x, el.y, el.x + el.width, el.y + el.height];
}

const center = (el: Elem): Point => [el.x + el.width / 2, el.y + el.height / 2];

/** Where Excalidraw puts a linear element's label: middle point, or middle of the middle segment. */
export function midpoint(el: Elem): Point {
  const pts = el.points ?? [];
  const n = pts.length;
  const a = pts[Math.floor((n - 1) / 2)] ?? [0, 0];
  const b = pts[Math.ceil((n - 1) / 2)] ?? a;
  return [el.x + (a[0] + b[0]) / 2, el.y + (a[1] + b[1]) / 2];
}

/** Point on el's outline along the ray from its center toward `toward`, pushed `gap` px further out. */
export function edgePoint(el: Elem, toward: Point, gap: number): Point {
  const [cx, cy] = center(el);
  const cos = Math.cos(el.angle ?? 0);
  const sin = Math.sin(el.angle ?? 0);
  let dx = (toward[0] - cx) * cos + (toward[1] - cy) * sin;
  let dy = -(toward[0] - cx) * sin + (toward[1] - cy) * cos;
  if (Math.hypot(dx, dy) < 1e-9) [dx, dy] = [0, 1];
  const hw = el.width / 2;
  const hh = el.height / 2;
  const ax = Math.abs(dx);
  const ay = Math.abs(dy);
  const t =
    hw <= 0 || hh <= 0 ? 0
    : el.type === 'ellipse' ? 1 / Math.hypot(dx / hw, dy / hh)
    : el.type === 'diamond' ? 1 / (ax / hw + ay / hh)
    : Math.min(ax ? hw / ax : Infinity, ay ? hh / ay : Infinity);
  const k = t + gap / Math.hypot(dx, dy);
  const px = dx * k;
  const py = dy * k;
  return [cx + px * cos - py * sin, cy + px * sin + py * cos];
}

function autoSize(type: string, label: string, fontSize: number, fontFamily: number): Point {
  const t = estimateTextSize(label, fontSize, fontFamily);
  if (type === 'ellipse') return [Math.max(120, Math.round((t.width + 20) * Math.SQRT2)), Math.max(60, Math.round((t.height + 20) * Math.SQRT2))];
  if (type === 'diamond') return [Math.max(120, 2 * t.width + 40), Math.max(60, 2 * t.height + 40)];
  return [Math.max(120, t.width + 40), Math.max(60, t.height + 30)];
}

function textProps(text: string, fontSize: number, fontFamily: number, textAlign: string, verticalAlign: string, containerId: string | null): Partial<Elem> {
  const { width, height } = estimateTextSize(text, fontSize, fontFamily);
  return { text, originalText: text, fontSize, fontFamily, textAlign, verticalAlign, containerId, autoResize: true, lineHeight: lineHeightOf(fontFamily), width, height };
}

const globalPoints = (el: Elem): Point[] => (el.points?.length ? el.points : DEFAULT_POINTS).map(([px, py]) => [el.x + px, el.y + py]);

class Session {
  readonly warnings: string[] = [];
  readonly work = new Map<string, Elem>();
  readonly reserved = new Set<string>();
  private readonly orig = new Map<string, Elem>();
  private readonly changed = new Set<string>();
  private readonly moved = new Set<string>();
  private readonly framed: string[] = [];
  private readonly autoFrames: { id: string; x?: number; y?: number }[] = [];
  private readonly now: number;
  private readonly rand: () => number;

  constructor(scene: ExElement[], opts: BuildOptions) {
    this.now = opts.now ?? Date.now();
    this.rand = opts.random ?? Math.random;
    for (const el of scene as Elem[]) {
      this.orig.set(el.id, el);
      this.work.set(el.id, el);
    }
  }

  int(): number {
    return Math.floor(this.rand() * 2 ** 31);
  }

  warn(msg: string): void {
    this.warnings.push(msg);
  }

  live(id: string | null | undefined): Elem | undefined {
    const el = id ? this.work.get(id) : undefined;
    return el && !el.isDeleted ? el : undefined;
  }

  edit(id: string): Elem {
    const cur = this.work.get(id);
    if (!cur) throw new Error(`unknown element ${id}`);
    if (this.changed.has(id)) return cur;
    const copy = structuredClone(cur);
    this.work.set(id, copy);
    this.changed.add(id);
    return copy;
  }

  put(el: Elem): Elem {
    this.work.set(el.id, el);
    this.changed.add(el.id);
    return el;
  }

  /** A label wider than its arrow hides the arrow; the model can only fix that by spacing the shapes. */
  warnCrampedLabels(): void {
    for (const id of this.changed) {
      const arrow = this.live(id);
      const label = arrow && isLinear(arrow) ? this.live(arrow.boundElements?.find((b) => b.type === 'text')?.id) : undefined;
      if (!arrow || !label) continue;
      const pts = arrow.points ?? [];
      const length = pts.slice(1).reduce((sum, p, i) => sum + Math.hypot(p[0] - pts[i]![0], p[1] - pts[i]![1]), 0);
      const needed = label.width + 40;
      if (length >= needed) continue;
      const ends = [arrow.startBinding?.elementId, arrow.endBinding?.elementId].filter(Boolean).map((e) => `"${e}"`);
      const fix = ends.length === 2 ? `move ${ends.join(' and ')} about ${Math.ceil(needed - length)}px further apart` : 'make the arrow longer';
      this.warn(`${id}: label "${label.text}" is longer than the arrow (${Math.round(length)}px visible, needs ~${Math.ceil(needed)}px); ${fix} or shorten the label`);
    }
  }

  finish(ids: string[]): BuildResult {
    const elements = [...this.changed].map((id) => {
      const el = this.work.get(id) as Elem;
      el.version = (this.orig.get(id)?.version ?? 0) + 1;
      el.versionNonce = this.int();
      el.updated = this.now;
      return el;
    });
    return { elements, ids, warnings: this.warnings };
  }

  newId(type: string): string {
    for (;;) {
      const id = `${type}-${this.int().toString(36).padStart(6, '0').slice(-6)}`;
      if (!this.work.has(id) && !this.reserved.has(id)) return id;
    }
  }

  base(id: string, type: string, props: Partial<Elem>): Elem {
    return {
      id, type, x: 0, y: 0, width: 0, height: 0, angle: 0,
      strokeColor: STROKE, backgroundColor: 'transparent', fillStyle: 'solid', strokeWidth: 2, strokeStyle: 'solid', roughness: 1, opacity: 100,
      groupIds: [], frameId: null, roundness: null, seed: this.int(), version: 1, versionNonce: 0, isDeleted: false,
      boundElements: [], updated: this.now, link: null, locked: false, index: null,
      ...props,
    };
  }

  num(v: unknown, field: string, id: string, positive = false): number | undefined {
    if (v === undefined) return undefined;
    if (typeof v === 'number' && Number.isFinite(v) && (!positive || v > 0)) return v;
    this.warn(`${id}: invalid ${field} ${JSON.stringify(v)} ignored`);
    return undefined;
  }

  oneOf(v: string | undefined, allowed: Set<string>, field: string, id: string): string | undefined {
    if (v === undefined || allowed.has(v)) return v;
    this.warn(`${id}: invalid ${field} "${v}" ignored`);
    return undefined;
  }

  color(v: string | undefined, kind: 'stroke' | 'fill', field: string, id: string): string | undefined {
    if (v === undefined) return undefined;
    const named = PALETTE[v.toLowerCase()];
    if (named) return named[kind];
    if (v === 'transparent' || HEX.test(v)) return v;
    this.warn(`${id}: invalid ${field} "${v}" ignored (use hex or a palette name)`);
    return undefined;
  }

  font(spec: ElementSpec, id: string): number | undefined {
    const f = spec.fontFamily;
    if (f === undefined) return undefined;
    if (typeof f === 'number' && Number.isInteger(f) && f > 0) return f;
    if (typeof f === 'string' && FONTS[f]) return FONTS[f];
    this.warn(`${id}: invalid fontFamily ${JSON.stringify(f)} ignored`);
    return undefined;
  }

  arrowhead(v: string | undefined, id: string): string | null | undefined {
    if (v === undefined) return undefined;
    if (v === 'none' || v === '') return null;
    return this.oneOf(v, ARROWHEADS, 'arrowhead', id);
  }

  points(v: number[][] | undefined, id: string): Point[] | undefined {
    if (v === undefined) return undefined;
    if (Array.isArray(v) && v.length >= 2 && v.every((p) => Array.isArray(p) && Number.isFinite(p[0]) && Number.isFinite(p[1]))) {
      return v.map((p) => [p[0] as number, p[1] as number]);
    }
    this.warn(`${id}: points must be at least two [x,y] pairs; ignored`);
    return undefined;
  }

  style(spec: ElementSpec, id: string): Partial<Elem> {
    const p: Partial<ElementProps> = {};
    const set = <K extends keyof ElementProps>(k: K, v: ElementProps[K] | undefined) => {
      if (v !== undefined) p[k] = v;
    };
    set('strokeColor', this.color(spec.strokeColor, 'stroke', 'strokeColor', id));
    set('backgroundColor', this.color(spec.backgroundColor, 'fill', 'backgroundColor', id));
    set('fillStyle', this.oneOf(spec.fillStyle, FILL_STYLES, 'fillStyle', id));
    set('strokeStyle', this.oneOf(spec.strokeStyle, STROKE_STYLES, 'strokeStyle', id));
    set('strokeWidth', this.num(spec.strokeWidth, 'strokeWidth', id, true));
    const roughness = this.num(spec.roughness, 'roughness', id);
    set('roughness', roughness === undefined ? undefined : Math.min(2, Math.max(0, roughness)));
    const opacity = this.num(spec.opacity, 'opacity', id);
    set('opacity', opacity === undefined ? undefined : Math.min(100, Math.max(0, opacity)));
    if (Array.isArray(spec.groupIds)) p.groupIds = spec.groupIds.filter((g) => typeof g === 'string');
    if (typeof spec.locked === 'boolean') p.locked = spec.locked;
    if (spec.link !== undefined) p.link = spec.link || null;
    return p as Partial<Elem>;
  }

  freeY(): number {
    let bottom = -Infinity;
    for (const el of this.work.values()) if (!el.isDeleted) bottom = Math.max(bottom, bounds(el)[3]);
    return bottom === -Infinity ? 0 : Math.round(bottom + 40);
  }

  addBound(targetId: string, ref: BoundRef): void {
    if (this.work.get(targetId)?.boundElements?.some((b) => b.id === ref.id)) return;
    const t = this.edit(targetId);
    t.boundElements = [...(t.boundElements ?? []), ref];
  }

  removeBound(targetId: string | null | undefined, refId: string): void {
    const t = targetId ? this.work.get(targetId) : undefined;
    if (!t?.boundElements?.some((b) => b.id === refId)) return;
    const e = this.edit(t.id);
    e.boundElements = (e.boundElements ?? []).filter((b) => b.id !== refId);
  }

  target(binding: PointBinding | null | undefined): Elem | undefined {
    const t = this.live(binding?.elementId);
    return t && !isLinear(t) && t.type !== 'freedraw' ? t : undefined;
  }

  bindTarget(ref: string | undefined, id: string): Elem | undefined {
    if (!ref) return undefined;
    let t = this.live(ref);
    if (t?.type === 'text' && t.containerId) t = this.live(t.containerId) ?? t;
    if (!t) this.warn(`${id}: binding target "${ref}" not found; end left free`);
    else if (!BINDABLE.has(t.type)) this.warn(`${id}: cannot connect to ${t.type} "${ref}"; end left free`);
    else return t;
    return undefined;
  }

  setPoints(el: Elem, g: Point[]): void {
    const [ox, oy] = g[0] as Point;
    el.x = ox;
    el.y = oy;
    el.points = g.map(([px, py]) => [px - ox, py - oy]);
    const xs = el.points.map((p) => p[0]);
    const ys = el.points.map((p) => p[1]);
    el.width = Math.max(...xs) - Math.min(...xs);
    el.height = Math.max(...ys) - Math.min(...ys);
  }

  placeEnds(el: Elem, g: Point[], s: Elem | undefined, e: Elem | undefined, sGap: number, eGap: number): void {
    const n = g.length - 1;
    if (s) g[0] = edgePoint(s, n > 1 ? (g[1] as Point) : e ? center(e) : (g[n] as Point), sGap);
    if (e) g[n] = edgePoint(e, n > 1 ? (g[n - 1] as Point) : s ? center(s) : (g[0] as Point), eGap);
    this.setPoints(el, g);
    this.centerLabel(el.id);
  }

  route(id: string): void {
    const a = this.edit(id);
    this.placeEnds(a, globalPoints(a), this.target(a.startBinding), this.target(a.endBinding), a.startBinding?.gap ?? GAP, a.endBinding?.gap ?? GAP);
  }

  centerLabel(containerId: string): void {
    const c = this.live(containerId);
    const label = this.live(c?.boundElements?.find((b) => b.type === 'text')?.id);
    if (!c || !label) return;
    const [cx, cy] = isLinear(c) ? midpoint(c) : center(c);
    const x = cx - label.width / 2;
    const y = cy - label.height / 2;
    if (label.x !== x || label.y !== y) Object.assign(this.edit(label.id), { x, y });
  }

  setLabel(c: Elem, text: string | undefined, spec: ElementSpec): void {
    const old = this.live(c.boundElements?.find((b) => b.type === 'text')?.id);
    if (text === '') {
      if (old) {
        this.edit(old.id).isDeleted = true;
        this.removeBound(c.id, old.id);
      }
      return;
    }
    const content = text ?? old?.originalText ?? old?.text;
    if (content === undefined) return;
    const fontSize = this.num(spec.fontSize, 'fontSize', c.id, true) ?? old?.fontSize ?? (c.type === 'arrow' ? 16 : 20);
    const fontFamily = this.font(spec, c.id) ?? old?.fontFamily ?? 5;
    const props = textProps(content, fontSize, fontFamily, 'center', 'middle', c.id);
    if (old) {
      Object.assign(this.edit(old.id), props, spec.strokeColor === undefined ? {} : { strokeColor: c.strokeColor });
    } else {
      let id = `${c.id}-label`;
      while (this.live(id) || this.reserved.has(id)) id = `${c.id}-label-${this.int().toString(36).slice(-4)}`;
      this.put(this.base(id, 'text', { ...props, strokeColor: c.strokeColor, groupIds: [...(c.groupIds ?? [])], frameId: c.frameId ?? null }));
      this.addBound(c.id, { id, type: 'text' });
    }
    this.centerLabel(c.id);
  }

  setFrame(el: Elem, frame: string | undefined): void {
    if (frame === undefined) return;
    if (el.type === 'frame') return this.warn(`${el.id}: frames cannot be nested; frame ignored`);
    el.frameId = frame || null;
    this.framed.push(el.id);
  }

  create(spec: ElementSpec, id: string, type: ShapeType): boolean {
    const style = this.style(spec, id);
    const sx = this.num(spec.x, 'x', id);
    const sy = this.num(spec.y, 'y', id);
    const w = this.num(spec.width, 'width', id, true);
    const h = this.num(spec.height, 'height', id, true);
    const x = sx ?? 0;
    const y = sy ?? (sx === undefined ? this.freeY() : 0);
    const fontSize = this.num(spec.fontSize, 'fontSize', id, true);
    const fontFamily = this.font(spec, id) ?? 5;
    let el: Elem;
    switch (type) {
      case 'rectangle':
      case 'ellipse':
      case 'diamond': {
        const [aw, ah] = spec.label ? autoSize(type, spec.label, fontSize ?? 20, fontFamily) : [160, 80];
        const roundness = type === 'ellipse' || spec.rounded === false ? null : { type: type === 'rectangle' ? 3 : 2 };
        el = this.put(this.base(id, type, { x, y, width: w ?? aw, height: h ?? ah, roundness, ...style }));
        this.setFrame(el, spec.frame);
        if (spec.label) this.setLabel(el, spec.label, spec);
        return true;
      }
      case 'text': {
        const content = spec.text ?? spec.label ?? '';
        if (!content) {
          this.warn(`${id}: text element needs non-empty text; skipped`);
          return false;
        }
        const align = this.oneOf(spec.textAlign, TEXT_ALIGNS, 'textAlign', id) ?? 'left';
        el = this.put(this.base(id, 'text', { x, y, ...textProps(content, fontSize ?? 20, fontFamily, align, 'top', null), ...style }));
        this.setFrame(el, spec.frame);
        return true;
      }
      case 'frame': {
        el = this.put(this.base(id, 'frame', { x, y, width: w ?? 400, height: h ?? 300, strokeColor: '#bbb', roughness: 0, name: spec.label || null, ...style }));
        if (w === undefined && h === undefined) this.autoFrames.push({ id, x: sx, y: sy });
        if (spec.frame !== undefined) this.setFrame(el, spec.frame);
        return true;
      }
      case 'freedraw': {
        const pts = this.points(spec.points, id);
        if (!pts) {
          this.warn(`${id}: freedraw needs points; skipped`);
          return false;
        }
        el = this.put(this.base(id, 'freedraw', { points: [], pressures: [], simulatePressure: true, lastCommittedPoint: null, ...style }));
        this.setPoints(el, pts.map(([px, py]) => [x + px, y + py]));
        this.setFrame(el, spec.frame);
        return true;
      }
      case 'arrow':
      case 'line': {
        const arrow = type === 'arrow';
        const endHead = this.arrowhead(spec.endArrowhead, id);
        const pts = this.points(spec.points, id) ?? DEFAULT_POINTS;
        const s = this.bindTarget(spec.from, id);
        let e = this.bindTarget(spec.to, id);
        if (s && e && s.id === e.id) {
          this.warn(`${id}: from and to are the same element; end left free`);
          e = undefined;
        }
        const last = pts[pts.length - 1] as Point;
        const [ox, oy]: Point =
          sx !== undefined || sy !== undefined ? [x, y]
          : s ? [s.x + s.width + GAP, s.y + s.height / 2]
          : e ? [e.x - GAP - last[0], e.y + e.height / 2 - last[1]]
          : [x, y];
        el = this.put(this.base(id, type, {
          points: [], lastCommittedPoint: null,
          startBinding: arrow && s ? { elementId: s.id, focus: 0, gap: GAP } : null,
          endBinding: arrow && e ? { elementId: e.id, focus: 0, gap: GAP } : null,
          startArrowhead: this.arrowhead(spec.startArrowhead, id) ?? null,
          endArrowhead: endHead !== undefined ? endHead : arrow ? 'arrow' : null,
          ...(arrow ? { elbowed: false } : {}),
          roundness: spec.rounded === false ? null : { type: 2 },
          ...style,
        }));
        this.placeEnds(el, pts.map(([px, py]) => [ox + px, oy + py]), s, e, GAP, GAP);
        if (arrow) for (const t of [s, e]) if (t) this.addBound(t.id, { id, type: 'arrow' });
        this.setFrame(el, spec.frame);
        if (spec.label) {
          if (arrow) this.setLabel(el, spec.label, spec);
          else this.warn(`${id}: lines cannot carry labels in Excalidraw; label ignored (use an arrow with endArrowhead "none")`);
        }
        return true;
      }
    }
  }

  update(spec: ElementSpec, cur: Elem): boolean {
    const id = cur.id;
    const before = [cur.x, cur.y, cur.width, cur.height].join();
    const el = this.edit(id);
    Object.assign(el, this.style(spec, id));
    const x = this.num(spec.x, 'x', id);
    const y = this.num(spec.y, 'y', id);
    const w = this.num(spec.width, 'width', id, true);
    const h = this.num(spec.height, 'height', id, true);
    const fontSize = this.num(spec.fontSize, 'fontSize', id, true);
    const fontFamily = this.font(spec, id);
    if (spec.rounded !== undefined && el.type !== 'ellipse' && el.type !== 'text' && el.type !== 'freedraw' && el.type !== 'frame') {
      el.roundness = spec.rounded ? { type: el.type === 'rectangle' ? 3 : 2 } : null;
    }
    this.setFrame(el, spec.frame);
    const oldLabel = this.live(el.boundElements?.find((b) => b.type === 'text')?.id);
    if (oldLabel && Array.isArray(spec.groupIds)) this.edit(oldLabel.id).groupIds = [...(el.groupIds ?? [])];
    const labelStyle = fontSize !== undefined || fontFamily !== undefined || spec.strokeColor !== undefined;

    if (el.type === 'text') {
      const align = this.oneOf(spec.textAlign, TEXT_ALIGNS, 'textAlign', id);
      const content = spec.text ?? spec.label;
      if (content === '') this.warn(`${id}: empty text ignored; delete the element instead`);
      if (content || fontSize !== undefined || fontFamily !== undefined || align !== undefined) {
        Object.assign(el, textProps(content || (el.originalText ?? el.text ?? ''), fontSize ?? el.fontSize ?? 20, fontFamily ?? el.fontFamily ?? 5, align ?? el.textAlign ?? 'left', el.verticalAlign ?? 'top', el.containerId ?? null));
      }
      if (x !== undefined) el.x = x;
      if (y !== undefined) el.y = y;
      if (el.containerId) this.centerLabel(el.containerId);
    } else if (isLinear(el) || el.type === 'freedraw') {
      const pts = this.points(spec.points, id);
      const ox = x ?? el.x;
      const oy = y ?? el.y;
      const g: Point[] = pts ? pts.map(([px, py]) => [ox + px, oy + py]) : globalPoints(el).map(([px, py]) => [px + ox - el.x, py + oy - el.y]);
      if (el.type === 'freedraw') {
        this.setPoints(el, g);
        return true;
      }
      const arrow = el.type === 'arrow';
      let s = arrow ? this.target(el.startBinding) : undefined;
      let e = arrow ? this.target(el.endBinding) : undefined;
      if (spec.from !== undefined) {
        this.removeBound(el.startBinding?.elementId, id);
        s = this.bindTarget(spec.from, id);
        el.startBinding = arrow && s ? { elementId: s.id, focus: 0, gap: GAP } : null;
      }
      if (spec.to !== undefined) {
        this.removeBound(el.endBinding?.elementId, id);
        e = this.bindTarget(spec.to, id);
        el.endBinding = arrow && e ? { elementId: e.id, focus: 0, gap: GAP } : null;
      }
      if (arrow) for (const t of [s, e]) if (t) this.addBound(t.id, { id, type: 'arrow' });
      const sh = this.arrowhead(spec.startArrowhead, id);
      const eh = this.arrowhead(spec.endArrowhead, id);
      if (sh !== undefined) el.startArrowhead = sh;
      if (eh !== undefined) el.endArrowhead = eh;
      this.placeEnds(el, g, s, e, el.startBinding?.gap ?? GAP, el.endBinding?.gap ?? GAP);
      if (spec.label !== undefined || labelStyle) {
        if (arrow) this.setLabel(el, spec.label, spec);
        else if (spec.label) this.warn(`${id}: lines cannot carry labels in Excalidraw; label ignored`);
      }
      return true;
    } else {
      if (x !== undefined) el.x = x;
      if (y !== undefined) el.y = y;
      if (w !== undefined) el.width = w;
      if (h !== undefined) el.height = h;
      if (el.type === 'frame' || el.type === 'magicframe') {
        if (spec.label !== undefined) el.name = spec.label || null;
      } else if (LABELLED.has(el.type) && (spec.label !== undefined || labelStyle)) {
        if (spec.label && w === undefined && h === undefined) {
          const old = this.live(el.boundElements?.find((b) => b.type === 'text')?.id);
          const [aw, ah] = autoSize(el.type, spec.label, fontSize ?? old?.fontSize ?? 20, fontFamily ?? old?.fontFamily ?? 5);
          el.width = Math.max(el.width, aw);
          el.height = Math.max(el.height, ah);
        }
        this.setLabel(el, spec.label, spec);
      } else if (spec.label) {
        this.warn(`${id}: ${el.type} cannot carry a label; ignored`);
      }
      this.centerLabel(id);
    }
    if ([el.x, el.y, el.width, el.height].join() !== before) this.moved.add(id);
    return true;
  }

  remove(id: string): void {
    const el = this.edit(id);
    el.isDeleted = true;
    for (const b of el.boundElements ?? []) if (b.type === 'text' && this.live(b.id)?.containerId === id) this.edit(b.id).isDeleted = true;
    this.removeBound(el.containerId, id);
    this.removeBound(el.startBinding?.elementId, id);
    this.removeBound(el.endBinding?.elementId, id);
    for (const other of [...this.work.values()]) {
      if (other.isDeleted) continue;
      if (other.startBinding?.elementId === id) this.edit(other.id).startBinding = null;
      if (other.endBinding?.elementId === id) this.edit(other.id).endBinding = null;
      if (other.frameId === id) this.edit(other.id).frameId = null;
    }
  }

  settle(): void {
    const rerouted = new Set<string>();
    for (const a of [...this.work.values()]) {
      if (a.isDeleted || a.type !== 'arrow' || a.elbowed) continue;
      const s = a.startBinding?.elementId;
      const e = a.endBinding?.elementId;
      if ((s && this.moved.has(s)) || (e && this.moved.has(e))) rerouted.add(a.id);
    }
    for (const id of rerouted) this.route(id);

    for (const id of this.framed) {
      const el = this.work.get(id) as Elem;
      if (el.frameId && this.live(el.frameId)?.type !== 'frame') {
        this.warn(`${id}: frame "${el.frameId}" not found; element left outside frames`);
        this.edit(id).frameId = null;
      }
      const label = this.live(el.boundElements?.find((b) => b.type === 'text')?.id);
      if (label && label.frameId !== el.frameId) this.edit(label.id).frameId = this.work.get(id)?.frameId ?? null;
    }

    for (const f of this.autoFrames) {
      const kids = [...this.work.values()].filter((k) => !k.isDeleted && k.frameId === f.id);
      if (!kids.length) continue;
      const b = kids.map(bounds);
      const pad = 40;
      const x = f.x ?? Math.min(...b.map((r) => r[0])) - pad;
      const y = f.y ?? Math.min(...b.map((r) => r[1])) - pad;
      Object.assign(this.edit(f.id), {
        x, y,
        width: Math.max(160, Math.max(...b.map((r) => r[2])) + pad - x),
        height: Math.max(80, Math.max(...b.map((r) => r[3])) + pad - y),
      });
    }
  }
}

export function buildElements(specs: ElementSpec[], scene: ExElement[], opts: BuildOptions = {}): BuildResult {
  const s = new Session(scene, opts);
  const planned = specs.map((spec, i) => {
    if (spec.id !== undefined && (typeof spec.id !== 'string' || !ID_PATTERN.test(spec.id))) {
      s.warn(`spec ${i}: invalid id ${JSON.stringify(spec.id)} (use 1-64 of A-Z a-z 0-9 _ . : -); skipped`);
      return undefined;
    }
    const id = spec.id ?? s.newId(spec.type && SHAPES.has(spec.type) ? spec.type : 'el');
    s.reserved.add(id);
    return id;
  });
  const ok: boolean[] = [];
  const run = (linearPass: boolean) =>
    specs.forEach((spec, i) => {
      const id = planned[i];
      if (id === undefined) return;
      const type = s.live(id)?.type ?? spec.type ?? '';
      if (isLinear({ type }) !== linearPass) return;
      const cur = s.live(id);
      if (cur) {
        if (spec.type !== undefined && spec.type !== cur.type) s.warn(`${id}: cannot change type from ${cur.type} to ${spec.type}; delete and recreate instead`);
        else ok[i] = s.update(spec, cur);
      } else if (!spec.type) s.warn(`${id}: no element with this id; "type" is required to create it`);
      else if (!SHAPES.has(spec.type)) s.warn(`${id}: unknown type "${spec.type}"`);
      else ok[i] = s.create(spec, id, spec.type);
    });
  run(false);
  run(true);
  s.settle();
  s.warnCrampedLabels();
  return s.finish(planned.filter((id, i): id is string => id !== undefined && ok[i] === true));
}

export function deleteElements(ids: string[], scene: ExElement[], opts: BuildOptions = {}): BuildResult {
  const s = new Session(scene, opts);
  const done: string[] = [];
  for (const id of ids) {
    if (s.live(id)) {
      s.remove(id);
      done.push(id);
    } else s.warn(`${id}: ${s.work.has(id) ? 'already deleted' : 'not found'}`);
  }
  return s.finish(done);
}
