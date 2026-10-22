import type { Actor, ChangeRecord, ExElement } from './protocol.js';

interface Binding {
  elementId?: string;
}
type El = ExElement & {
  text?: string;
  originalText?: string;
  containerId?: string | null;
  frameId?: string | null;
  name?: string | null;
  points?: number[][];
  startBinding?: Binding | null;
  endBinding?: Binding | null;
  startArrowhead?: string | null;
  endArrowhead?: string | null;
  strokeColor?: string;
  backgroundColor?: string;
  strokeStyle?: string;
  angle?: number;
  locked?: boolean;
  link?: string | null;
};

const MAX_TEXT = 200;
const ROW = 40;
const FRAMES = new Set(['frame', 'magicframe']);
const LINEAR = new Set(['arrow', 'line']);

const r = (n: number): number => Math.round(n);
const clip = (s: string): string => (s.length > MAX_TEXT ? `${s.slice(0, MAX_TEXT)}…` : s);
const quote = (s: string): string => JSON.stringify(clip(s));
const bracket = (s: string): string => `[${clip(s.replace(/\s*\n\s*/g, ' '))}]`;
const textOf = (el: El): string => el.originalText || el.text || '';

function box(el: El): [number, number, number, number] {
  if (Array.isArray(el.points) && el.points.length) {
    const xs = el.points.map((p) => el.x + (p[0] ?? 0));
    const ys = el.points.map((p) => el.y + (p[1] ?? 0));
    return [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)];
  }
  return [el.x, el.y, el.x + el.width, el.y + el.height];
}

/** Lookup of the elements being described: labels folded into their containers. */
class Scene {
  readonly byId = new Map<string, El>();
  readonly labels = new Map<string, El>();

  constructor(elements: ExElement[], withDeleted: boolean) {
    for (const el of elements as El[]) {
      if (!withDeleted && el.isDeleted) continue;
      const prev = this.byId.get(el.id);
      if (!prev || el.version >= prev.version) this.byId.set(el.id, el);
    }
    for (const el of this.byId.values()) {
      if (el.type !== 'text' || !el.containerId || !this.byId.has(el.containerId)) continue;
      const prev = this.labels.get(el.containerId);
      if (!prev || prev.isDeleted) this.labels.set(el.containerId, el);
    }
  }

  isLabel(el: El): boolean {
    return el.type === 'text' && !!el.containerId && this.labels.get(el.containerId) === el;
  }

  label(el: El): string {
    if (FRAMES.has(el.type)) return el.name ? ` ${bracket(el.name)}` : '';
    const t = this.labels.get(el.id);
    return t && (!t.isDeleted || el.isDeleted) && textOf(t) ? ` ${bracket(textOf(t))}` : '';
  }

  end(el: El, binding: Binding | null | undefined, which: 0 | 1): string {
    let target = binding?.elementId ? this.byId.get(binding.elementId) : undefined;
    if (target?.type === 'text' && target.containerId && this.byId.has(target.containerId)) target = this.byId.get(target.containerId);
    if (target && !target.isDeleted) return target.id;
    const pts = el.points?.length ? el.points : [[0, 0]];
    const p = (which === 0 ? pts[0] : pts[pts.length - 1]) ?? [0, 0];
    return `(${r(el.x + (p[0] ?? 0))},${r(el.y + (p[1] ?? 0))})`;
  }

  members(frame: El): string[] {
    return [...this.byId.values()].filter((m) => m.frameId === frame.id && !m.isDeleted && !this.isLabel(m)).map((m) => m.id);
  }

  line(el: El): string {
    const head = `${el.type} ${JSON.stringify(el.id)}`;
    const pos = `(${r(el.x)},${r(el.y)})`;
    const size = `${r(el.width)}×${r(el.height)}`;
    let body: string;
    if (LINEAR.has(el.type)) {
      const s = !!el.startArrowhead;
      const e = !!el.endArrowhead;
      const arrow = s && e ? '↔' : e ? '→' : s ? '←' : '—';
      const bends = (el.points?.length ?? 2) > 2 ? ` via ${(el.points?.length ?? 2) - 2} bends` : '';
      body = `${head} ${this.end(el, el.startBinding, 0)} ${arrow} ${this.end(el, el.endBinding, 1)}${this.label(el)}${bends}`;
    } else if (el.type === 'text') {
      body = `${head} ${quote(textOf(el))} ${pos}`;
    } else if (el.type === 'freedraw') {
      body = `${head} hand sketch ${pos} ${size}`;
    } else if (FRAMES.has(el.type)) {
      const kids = this.members(el);
      body = `${head}${this.label(el)} ${pos} ${size}${kids.length ? ` contains: ${kids.join(', ')}` : ' (empty)'}`;
    } else {
      body = `${head}${this.label(el)} ${pos} ${size}`;
    }
    return body + attrs(el);
  }
}

function attrs(el: El): string {
  const out: string[] = [];
  if (el.backgroundColor && el.backgroundColor !== 'transparent' && !LINEAR.has(el.type) && el.type !== 'text') out.push(`fill ${el.backgroundColor}`);
  if (el.strokeColor && el.strokeColor.toLowerCase() !== '#1e1e1e' && !FRAMES.has(el.type) && el.type !== 'image') out.push(`stroke ${el.strokeColor}`);
  if (el.strokeStyle && el.strokeStyle !== 'solid') out.push(el.strokeStyle);
  if (el.angle) out.push(`rotated ${r((el.angle * 180) / Math.PI)}°`);
  if (el.link) out.push(`link ${clip(el.link)}`);
  if (el.locked) out.push('locked');
  return out.length ? ` ${out.join(' ')}` : '';
}

function readingOrder(a: El, b: El): number {
  const [ax, ay] = box(a);
  const [bx, by] = box(b);
  return Math.floor(ay / ROW) - Math.floor(by / ROW) || ax - bx || ay - by;
}

export function describeScene(elements: ExElement[], opts: { ids?: string[]; maxElements?: number } = {}): string {
  const scene = new Scene(elements, false);
  const all = [...scene.byId.values()].filter((el) => !scene.isLabel(el)).sort(readingOrder);
  if (!all.length) return 'Canvas is empty.';
  const boxes = all.map(box);
  const header = `Canvas: ${all.length} element${all.length === 1 ? '' : 's'} · bounds (${r(Math.min(...boxes.map((b) => b[0])))},${r(Math.min(...boxes.map((b) => b[1])))})–(${r(Math.max(...boxes.map((b) => b[2])))},${r(Math.max(...boxes.map((b) => b[3])))})`;
  let shown = all;
  const missing: string[] = [];
  if (opts.ids) {
    const want = new Set<string>();
    for (const id of opts.ids) {
      const el = scene.byId.get(id);
      if (!el) missing.push(id);
      else want.add(el.type === 'text' && scene.isLabel(el) && el.containerId ? el.containerId : id);
    }
    shown = all.filter((el) => want.has(el.id));
  }
  const max = Math.max(1, opts.maxElements ?? 300);
  const lines = [opts.ids ? `${header} · showing ${shown.length}` : header, ...shown.slice(0, max).map((el) => scene.line(el))];
  if (shown.length > max) lines.push(`…and ${shown.length - max} more`);
  if (missing.length) lines.push(`Not found: ${missing.join(', ')}`);
  return lines.join('\n');
}

export function describeChanges(changes: ChangeRecord[], elements: ExElement[], opts: { actor?: Actor } = {}): string {
  const scene = new Scene(elements, true);
  const seen = new Map<string, { first: ChangeRecord['kind']; last: ChangeRecord['kind']; rev: number }>();
  for (const c of [...changes].sort((a, b) => a.rev - b.rev)) {
    if (opts.actor && c.actor !== opts.actor) continue;
    const s = seen.get(c.id);
    if (s) Object.assign(s, { last: c.kind, rev: c.rev });
    else seen.set(c.id, { first: c.kind, last: c.kind, rev: c.rev });
  }
  const added: string[] = [];
  const updated: string[] = [];
  const deleted: string[] = [];
  const containers = new Set<string>();
  const entries = [...seen].sort((a, b) => a[1].rev - b[1].rev);
  const kindOf = (id: string): ChangeRecord['kind'] | undefined => {
    const s = seen.get(id);
    if (!s) return undefined;
    const el = scene.byId.get(id);
    if (s.last === 'deleted' || el?.isDeleted) return s.first === 'created' ? undefined : 'deleted';
    return s.first === 'created' ? 'created' : s.last;
  };
  for (const [id] of entries) {
    const kind = kindOf(id);
    if (!kind) continue;
    const el = scene.byId.get(id);
    if (el?.type === 'text' && el.containerId) {
      const cid = el.containerId;
      const ck = kindOf(cid);
      if (ck === 'created' || ck === 'deleted' || containers.has(cid)) continue;
      containers.add(cid);
      const c = scene.byId.get(cid);
      const gone = kind === 'deleted';
      if (c && !c.isDeleted) updated.push(`${scene.line(c)}${gone && !scene.label(c) ? ' (label removed)' : ''}`);
      else updated.push(`label of ${JSON.stringify(cid)} ${gone ? 'removed' : `now ${bracket(textOf(el))}`}`);
      continue;
    }
    if (kind === 'deleted') {
      deleted.push(el ? `${el.type} ${JSON.stringify(id)}${el.type === 'text' ? ` ${quote(textOf(el))}` : scene.label(el)}` : JSON.stringify(id));
      continue;
    }
    if (containers.has(id)) continue;
    containers.add(id);
    const line = el ? scene.line(el) : `${JSON.stringify(id)} (details unavailable)`;
    (kind === 'created' ? added : updated).push(line);
  }
  const group = (title: string, lines: string[]): string[] => (lines.length ? [`${title} (${lines.length}):`, ...lines.map((l) => `  ${l}`)] : []);
  return [...group('Added', added), ...group('Updated', updated), ...group('Deleted', deleted)].join('\n');
}
