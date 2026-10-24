import { CaptureUpdateAction, FONT_FAMILY, restoreElements } from '@excalidraw/excalidraw';
import type { ExcalidrawElement } from '@excalidraw/excalidraw/element/types';
import type { BinaryFileData, BinaryFiles, ExcalidrawImperativeAPI } from '@excalidraw/excalidraw/types';
import type { Actor, BinaryFile, CanvasSnapshot, ExElement, SavedSummary, ServerMessage, ViewerRequestType } from '../../src/shared/protocol';
import type { LinkStatus, OpenLink } from './connection';
import { pulseHighlight } from './highlight';
import { handleRequest, type RequestContext } from './requests';
import { adoptRestored, createThrottle, diffFiles, diffLocal, isSendable, markKnown, mergeRemote, reconcileSnapshot, type Known } from './sync';

export interface LiveEvents {
  status(status: LinkStatus): void;
  viewers(count: number): void;
  /** Ids of live elements the agent just drew or changed (remote, or converted mermaid). */
  agentDrew(ids: string[]): void;
  /** The board's title from the latest snapshot (its id when untitled). */
  title(title: string): void;
  dark(): boolean;
}

export interface Live {
  sendNote(text: string): boolean;
  /** Saves the board, including edits not sent yet, to the library. */
  save(name: string): Promise<SavedSummary>;
  stop(): void;
}

type El = ExcalidrawElement;

const SEND_INTERVAL_MS = 100;
const FONT_TIMEOUT_MS = 3000;
const SAVE_TIMEOUT_MS = 10_000;
const FAMILY_NAMES = new Map<number, string>(Object.entries(FONT_FAMILY).map(([name, id]) => [id, name]));

const asEls = (elements: readonly ExElement[]) => elements as unknown as El[];
const toWire = (f: BinaryFileData): BinaryFile => ({ id: f.id, mimeType: f.mimeType, dataURL: f.dataURL, created: f.created });
const sendable = (el: El) => isSendable(el as unknown as Parameters<typeof isSendable>[0]);

/** Loads the font subsets incoming text needs, so restoreElements measures labels with real metrics. */
async function loadFonts(elements: readonly ExElement[]): Promise<void> {
  const chars = new Map<string, Set<string>>();
  for (const el of elements) {
    const name = FAMILY_NAMES.get(el.fontFamily as number);
    if (el.type !== 'text' || el.isDeleted || typeof el.text !== 'string' || !name) continue;
    const set = chars.get(name) ?? new Set();
    for (const ch of el.text) set.add(ch);
    chars.set(name, set);
  }
  const loads = [...chars].map(([name, set]) => {
    const font = `20px "${name}"`;
    const text = [...set].join('');
    return document.fonts.check(font, text) ? undefined : document.fonts.load(font, text).catch(() => undefined);
  });
  if (!loads.some(Boolean)) return;
  let timer: ReturnType<typeof setTimeout> | undefined;
  await Promise.race([Promise.all(loads), new Promise((r) => (timer = setTimeout(r, FONT_TIMEOUT_MS)))]);
  clearTimeout(timer);
}

/** Wires an Excalidraw instance to the daemon: snapshot/elements sync, local change upload and viewer requests. */
export function startLive(api: ExcalidrawImperativeAPI, openLink: OpenLink, ev: LiveEvents): Live {
  const known: Known = new Map();
  const sentFiles = new Set<string>();
  let synced = false;
  let firstSnapshot = true;
  let stopped = false;
  let queue: Promise<void> = Promise.resolve();
  let cancelHighlight: (() => void) | undefined;
  let pendingSave: { resolve(saved: SavedSummary): void; reject(err: Error): void; timer: ReturnType<typeof setTimeout> } | undefined;

  const settleSave = (outcome: { saved: SavedSummary } | { error: string }) => {
    const p = pendingSave;
    if (!p) return;
    pendingSave = undefined;
    clearTimeout(p.timer);
    if ('saved' in outcome) p.resolve(outcome.saved);
    else p.reject(new Error(outcome.error));
  };

  const scene = () => api.getSceneElementsIncludingDeleted();

  const flush = () => {
    if (!synced || !conn.isOpen()) return;
    const elements = diffLocal(scene(), known, sendable);
    const files = diffFiles(api.getFiles(), sentFiles);
    if (!elements.length && !files.length) return;
    const wire = elements as unknown as ExElement[];
    if (!conn.send({ t: 'elements', elements: wire, ...(files.length ? { files: files.map(toWire) } : {}) })) return;
    markKnown(elements, known);
    for (const f of files) sentFiles.add(f.id);
  };
  const throttle = createThrottle(flush, SEND_INTERVAL_MS);

  const commit = (merged: El[], replaced: ReadonlySet<string>) => {
    const restored = restoreElements(merged, null, { refreshDimensions: true, repairBindings: true });
    api.updateScene({ elements: adoptRestored(merged, restored, replaced), captureUpdate: CaptureUpdateAction.NEVER });
  };

  const addFiles = (files: readonly BinaryFile[]) => {
    for (const f of files) sentFiles.add(f.id);
    if (files.length) api.addFiles(files as unknown as BinaryFileData[]);
  };

  const applySnapshot = async (canvas: CanvasSnapshot) => {
    await loadFonts(canvas.elements);
    const { elements, replaced } = reconcileSnapshot(scene(), asEls(canvas.elements), known);
    sentFiles.clear();
    addFiles(Object.values(canvas.files));
    if (replaced.size) commit(elements, replaced);
    ev.viewers(canvas.viewers);
    ev.title(canvas.title);
    synced = true;
    sendVisible();
    throttle.flush();
    if (firstSnapshot && canvas.elements.length) api.scrollToContent(undefined, { fitToContent: true, maxZoom: 1 });
    firstSnapshot = false;
  };

  const applyRemote = async (incoming: ExElement[], files: BinaryFile[] | undefined, actor: Actor) => {
    await loadFonts(incoming);
    if (files) addFiles(files);
    const { elements, replaced } = mergeRemote(scene(), asEls(incoming), known);
    if (!replaced.size) return;
    commit(elements, replaced);
    if (actor !== 'agent') return;
    const drawn = incoming.filter((el) => !el.isDeleted && replaced.has(el.id)).map((el) => el.id);
    if (drawn.length) ev.agentDrew(drawn);
  };

  const ctx: RequestContext = {
    api,
    dark: ev.dark,
    appendAsAgent(elements, files: BinaryFiles) {
      if (!synced || !conn.isOpen()) throw new Error('viewer is not connected to the canvas daemon');
      const fresh = Object.values(files).filter((f) => !sentFiles.has(f.id));
      if (fresh.length) api.addFiles(fresh);
      const ids = new Set(elements.map((el) => el.id));
      commit([...scene(), ...elements], ids);
      const added = scene().filter((el) => ids.has(el.id));
      conn.send({ t: 'elements', actor: 'agent', elements: added as unknown as ExElement[], ...(fresh.length ? { files: fresh.map(toWire) } : {}) });
      markKnown(added, known);
      for (const f of fresh) sentFiles.add(f.id);
      ev.agentDrew(added.filter((el) => !el.isDeleted).map((el) => el.id));
    },
    highlight(elements) {
      cancelHighlight?.();
      cancelHighlight = pulseHighlight(api, elements);
    },
  };

  const respond = async (reqId: string, type: ViewerRequestType, payload: unknown) => {
    try {
      conn.send({ t: 'response', reqId, ok: true, result: await handleRequest(ctx, type, payload) });
    } catch (err) {
      conn.send({ t: 'response', reqId, ok: false, error: err instanceof Error ? err.message : String(err) });
    }
  };

  // Messages are applied strictly in arrival order, even when a step awaits fonts or a lazy chunk.
  const enqueue = (task: () => Promise<void>) => {
    queue = queue
      .then(() => (stopped ? undefined : task()))
      .catch((err: unknown) => console.error('[whiteboard-mcp]', err));
  };

  const onMessage = (msg: ServerMessage) => {
    switch (msg.t) {
      case 'snapshot':
        synced = false;
        return enqueue(() => applySnapshot(msg.canvas));
      case 'elements':
        return enqueue(() => applyRemote(msg.elements, msg.files, msg.actor));
      case 'request':
        return enqueue(() => respond(msg.reqId, msg.type, msg.payload));
      case 'viewers':
        return ev.viewers(msg.count);
      case 'saved':
        return settleSave(msg.ok ? { saved: msg.saved } : { error: msg.error });
      case 'error':
        return console.warn('[whiteboard-mcp] daemon:', msg.message);
    }
  };

  const conn = openLink(onMessage, (status) => {
    if (status !== 'live') {
      synced = false;
      settleSave({ error: 'connection lost' });
    }
    ev.status(status);
  });

  const sendVisible = () => conn.send({ t: 'visible', visible: document.visibilityState === 'visible' });
  const onVisibility = () => {
    if (document.visibilityState === 'hidden') throttle.flush();
    else conn.retryNow();
    sendVisible();
  };
  const onPageHide = () => throttle.flush();
  const onOnline = () => conn.retryNow();
  const offChange = api.onChange(() => throttle.schedule());
  document.addEventListener('visibilitychange', onVisibility);
  window.addEventListener('pagehide', onPageHide);
  window.addEventListener('online', onOnline);

  return {
    sendNote: (text) => conn.send({ t: 'note', text }),
    save(name) {
      if (pendingSave) return Promise.reject(new Error('already saving'));
      if (!synced || !conn.isOpen()) return Promise.reject(new Error('offline'));
      // Edits not sent yet go first; the socket keeps the order, so the daemon saves them too.
      throttle.flush();
      return new Promise((resolve, reject) => {
        pendingSave = { resolve, reject, timer: setTimeout(() => settleSave({ error: 'timed out' }), SAVE_TIMEOUT_MS) };
        if (!conn.send({ t: 'save', name })) settleSave({ error: 'offline' });
      });
    },
    stop() {
      throttle.flush();
      throttle.cancel();
      settleSave({ error: 'viewer closed' });
      stopped = true;
      offChange();
      document.removeEventListener('visibilitychange', onVisibility);
      window.removeEventListener('pagehide', onPageHide);
      window.removeEventListener('online', onOnline);
      cancelHighlight?.();
      conn.close();
    },
  };
}
