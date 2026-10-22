/**
 * Pure sync logic between the local Excalidraw scene and the daemon. No DOM, no
 * Excalidraw imports, so it is unit-testable in Node.
 *
 * `known` is the last version of every element exchanged with the server (sent
 * or received). An element is sent only when its local version/nonce differs
 * from `known`, which is also what prevents echoing received versions back.
 */
import { incomingWins } from '../../src/shared/protocol';

export interface SyncElement {
  id: string;
  version: number;
  versionNonce: number;
  isDeleted: boolean;
  index?: string | null;
  updated?: number;
}

export interface VersionStamp {
  version: number;
  versionNonce: number;
}

export type Known = Map<string, VersionStamp>;

export interface SyncFile {
  id: string;
  mimeType: string;
  dataURL: string;
  created?: number;
}

export interface MergeResult<T> {
  /** Next scene, ordered by fractional index; still needs `adoptRestored`. */
  elements: T[];
  /** Ids whose element object in `elements` is not the local one (remote winners, removals). */
  replaced: Set<string>;
}

const stampOf = (el: VersionStamp): VersionStamp => ({ version: el.version, versionNonce: el.versionNonce });
const sameStamp = (a: VersionStamp, b: VersionStamp) => a.version === b.version && a.versionNonce === b.versionNonce;

/**
 * Excalidraw orders by fractional `index` (plain string comparison). Elements
 * without an index (agent-created ones) stay right after their predecessor.
 */
export function orderByIndex<T extends SyncElement>(elements: readonly T[]): T[] {
  const groups: { key: string; items: T[] }[] = [];
  for (const el of elements) {
    if (typeof el.index === 'string' && el.index) groups.push({ key: el.index, items: [el] });
    else if (groups.length) groups[groups.length - 1]!.items.push(el);
    else groups.push({ key: '', items: [el] });
  }
  // Array.prototype.sort is stable, so equal keys keep their relative order.
  groups.sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
  return groups.flatMap((g) => g.items);
}

/**
 * Merges an `elements` broadcast into the local scene (including tombstones).
 * Every incoming version becomes `known`, because that is what the server now stores.
 */
export function mergeRemote<T extends SyncElement>(local: readonly T[], incoming: readonly T[], known: Known): MergeResult<T> {
  const winners = new Map<string, T>();
  const localById = new Map(local.map((el) => [el.id, el]));
  for (const el of incoming) {
    known.set(el.id, stampOf(el));
    const current = winners.get(el.id) ?? localById.get(el.id);
    if (incomingWins(el, current)) winners.set(el.id, el);
  }
  if (!winners.size) return { elements: [...local], replaced: new Set() };
  const elements = local.map((el) => winners.get(el.id) ?? el);
  for (const [id, el] of winners) if (!localById.has(id)) elements.push(el);
  return { elements: orderByIndex(elements), replaced: new Set(winners.keys()) };
}

/**
 * Reconciles a (re)connect snapshot, which holds live elements only:
 * - snapshot elements merge with the local scene by the shared rule;
 * - local elements we had exchanged before but missing now were deleted on the
 *   server (or their tombstone pruned), so they become local tombstones;
 * - local elements newer than the snapshot or never exchanged stay, and the next
 *   `diffLocal` sends them because `known` is reset to the snapshot.
 */
export function reconcileSnapshot<T extends SyncElement>(local: readonly T[], snapshot: readonly T[], known: Known): MergeResult<T> {
  const previouslyKnown = new Set(known.keys());
  known.clear();
  const remote = new Map<string, T>();
  for (const el of snapshot) {
    known.set(el.id, stampOf(el));
    remote.set(el.id, el);
  }
  const replaced = new Set<string>();
  const elements: T[] = [];
  for (const el of local) {
    const fromServer = remote.get(el.id);
    if (fromServer) {
      remote.delete(el.id);
      if (incomingWins(fromServer, el)) {
        elements.push(fromServer);
        replaced.add(el.id);
      } else {
        elements.push(el);
      }
    } else if (previouslyKnown.has(el.id) && !el.isDeleted) {
      elements.push({ ...el, isDeleted: true });
      replaced.add(el.id);
    } else {
      elements.push(el);
    }
  }
  for (const [id, el] of remote) {
    elements.push(el);
    replaced.add(id);
  }
  return { elements: orderByIndex(elements), replaced };
}

/**
 * Takes the output of Excalidraw's `restoreElements` over the merged scene and
 * keeps restored objects only for replaced elements, forcing their exchanged
 * version back (restore/index repair bumps versions, which would echo them).
 * Local elements keep their identity; only a repaired fractional index is copied.
 */
export function adoptRestored<T extends SyncElement>(merged: readonly T[], restored: readonly T[], replaced: ReadonlySet<string>): T[] {
  const byId = new Map(restored.map((el) => [el.id, el]));
  const out: T[] = [];
  for (const el of merged) {
    const r = byId.get(el.id);
    if (replaced.has(el.id)) {
      // Dropped by restore (e.g. invisibly small): leave it out of the scene.
      if (!r) continue;
      out.push({ ...r, version: el.version, versionNonce: el.versionNonce, ...(el.updated === undefined ? {} : { updated: el.updated }) });
    } else if (r && r.index !== el.index) {
      out.push({ ...el, index: r.index });
    } else {
      out.push(el);
    }
  }
  return out;
}

/** Elements mid-creation that are not worth sending yet (Excalidraw deletes them if they stay empty). */
export function isSendable(el: SyncElement & Record<string, unknown>): boolean {
  if (el.isDeleted) return true;
  if (el.type === 'text') return typeof el.text === 'string' && el.text.trim() !== '';
  if (Array.isArray(el.points)) return el.points.length >= 2;
  return el.width !== 0 || el.height !== 0;
}

/** Local elements whose version differs from what the server has seen, tombstones included. */
export function diffLocal<T extends SyncElement>(elements: readonly T[], known: Known, sendable: (el: T) => boolean = () => true): T[] {
  const out: T[] = [];
  for (const el of elements) {
    const k = known.get(el.id);
    if (k ? sameStamp(k, el) : el.isDeleted) continue;
    if (!sendable(el)) continue;
    out.push(el);
  }
  return out;
}

export function markKnown(elements: readonly (VersionStamp & { id: string })[], known: Known): void {
  for (const el of elements) known.set(el.id, stampOf(el));
}

/** Files the server has not received yet. */
export function diffFiles<F extends SyncFile>(files: Readonly<Record<string, F>>, sent: ReadonlySet<string>): F[] {
  return Object.values(files).filter((f) => !sent.has(f.id) && typeof f.dataURL === 'string' && f.dataURL.startsWith('data:'));
}

/** Leading + trailing throttle with an explicit flush, for local change batching. */
export function createThrottle(fn: () => void, ms: number, timers: Pick<typeof globalThis, 'setTimeout' | 'clearTimeout'> = globalThis) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let pending = false;
  const tick = () => {
    if (pending) {
      pending = false;
      fn();
      timer = timers.setTimeout(tick, ms);
    } else {
      timer = undefined;
    }
  };
  return {
    schedule() {
      if (timer !== undefined) {
        pending = true;
        return;
      }
      fn();
      timer = timers.setTimeout(tick, ms);
    },
    flush() {
      if (timer !== undefined) timers.clearTimeout(timer);
      timer = undefined;
      pending = false;
      fn();
    },
    cancel() {
      if (timer !== undefined) timers.clearTimeout(timer);
      timer = undefined;
      pending = false;
    },
  };
}

/** Exponential reconnect backoff with jitter: 500ms doubling up to 10s, each delay ±25% (never above 10s). */
export function backoffDelay(attempt: number, random: () => number = Math.random): number {
  const base = Math.min(10_000, 500 * 2 ** Math.max(0, attempt));
  return Math.min(10_000, Math.round(base * (0.75 + random() * 0.5)));
}
