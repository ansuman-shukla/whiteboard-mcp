import { convertToExcalidrawElements, exportToBlob, getCommonBounds } from '@excalidraw/excalidraw';
import type { ExcalidrawElement, NonDeletedExcalidrawElement } from '@excalidraw/excalidraw/element/types';
import type { BinaryFiles, ExcalidrawImperativeAPI } from '@excalidraw/excalidraw/types';
import type { FocusPayload, FocusResult, MermaidPayload, MermaidResult, ScreenshotPayload, ScreenshotResult, ViewerRequestType } from '../../src/shared/protocol';
import { pulseHighlight } from './highlight';

export interface RequestContext {
  api: ExcalidrawImperativeAPI;
  dark(): boolean;
  /** Appends new elements to the scene and sends them to the daemon as the agent's. */
  appendAsAgent(elements: readonly ExcalidrawElement[], files: BinaryFiles): void;
  highlight(elements: readonly ExcalidrawElement[]): void;
}

const PADDING = 24;
const MAX_SIDE = 1600;
const MAX_SCALE = 4;
const MAX_CANVAS_SIDE = 8192;
const MERMAID_GAP = 80;

const obj = <T>(payload: unknown): Partial<T> => (payload && typeof payload === 'object' ? (payload as Partial<T>) : {});

/** Live elements matching ids, plus the labels bound to them; all live elements when no ids are given. */
function pick(api: ExcalidrawImperativeAPI, ids: unknown): NonDeletedExcalidrawElement[] {
  const all = api.getSceneElements();
  if (!Array.isArray(ids) || !ids.length) {
    if (!all.length) throw new Error('canvas is empty');
    return [...all];
  }
  const wanted = new Set(ids);
  const out = all.filter((el) => wanted.has(el.id) || (el.type === 'text' && el.containerId !== null && wanted.has(el.containerId)));
  if (!out.length) throw new Error('none of the requested elements exist');
  return out;
}

function blobToBase64(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result).slice(String(reader.result).indexOf(',') + 1));
    reader.onerror = () => reject(reader.error ?? new Error('could not read image'));
    reader.readAsDataURL(blob);
  });
}

async function screenshot(ctx: RequestContext, payload: unknown): Promise<ScreenshotResult> {
  const p = obj<ScreenshotPayload>(payload);
  const { api } = ctx;
  const elements = pick(api, p.ids);
  let size = { width: 0, height: 0 };
  const blob = await exportToBlob({
    elements,
    files: api.getFiles(),
    exportPadding: PADDING,
    appState: {
      exportBackground: true,
      exportWithDarkMode: typeof p.dark === 'boolean' ? p.dark : ctx.dark(),
      viewBackgroundColor: api.getAppState().viewBackgroundColor,
    },
    getDimensions: (w: number, h: number) => {
      const longest = Math.max(w, h, 1);
      const cap = MAX_CANVAS_SIDE / longest;
      const scale = typeof p.scale === 'number' && p.scale > 0 ? Math.min(p.scale, MAX_SCALE, cap) : Math.min(2, MAX_SIDE / longest);
      size = { width: Math.max(1, Math.round(w * scale)), height: Math.max(1, Math.round(h * scale)) };
      return { ...size, scale };
    },
  });
  return { mimeType: 'image/png', base64: await blobToBase64(blob), ...size };
}

async function mermaid(ctx: RequestContext, payload: unknown): Promise<MermaidResult> {
  const p = obj<MermaidPayload>(payload);
  if (typeof p.definition !== 'string' || !p.definition.trim()) throw new Error('definition must be a non-empty string');
  const { parseMermaidToExcalidraw } = await import('@excalidraw/mermaid-to-excalidraw');
  const { elements: skeletons, files } = await parseMermaidToExcalidraw(p.definition, { themeVariables: { fontSize: '20px' } });
  const converted = convertToExcalidrawElements(skeletons, { regenerateIds: true });
  if (!converted.length) throw new Error('the diagram produced no elements');
  const [x1, y1] = getCommonBounds(converted);
  const existing = ctx.api.getSceneElements();
  const [, ey1, ex2] = existing.length ? getCommonBounds(existing) : [0, 0, 0];
  const anchor = existing.length ? { x: ex2 + MERMAID_GAP, y: ey1 } : { x: x1, y: y1 };
  const dx = (typeof p.x === 'number' ? p.x : anchor.x) - x1;
  const dy = (typeof p.y === 'number' ? p.y : anchor.y) - y1;
  // Indices are reassigned after the existing scene so the diagram lands on top.
  const placed = converted.map((el) => ({ ...el, x: el.x + dx, y: el.y + dy, index: null }) as unknown as ExcalidrawElement);
  ctx.appendAsAgent(placed, files ?? {});
  return { ids: placed.map((el) => el.id) };
}

function focus(ctx: RequestContext, payload: unknown): FocusResult {
  const p = obj<FocusPayload>(payload);
  const targets = pick(ctx.api, p.ids);
  const zoom = typeof p.zoom === 'number' && p.zoom > 0 ? Math.min(Math.max(p.zoom, 0.1), 30) : undefined;
  ctx.api.scrollToContent(targets, { fitToContent: true, animate: true, ...(zoom ? { minZoom: zoom, maxZoom: zoom } : { maxZoom: 1.5 }) });
  if (p.highlight) {
    const ids = new Set(targets.map((el) => el.id));
    ctx.highlight(targets.filter((el) => !(el.type === 'text' && el.containerId && ids.has(el.containerId))));
  }
  return { ok: true };
}

export async function handleRequest(ctx: RequestContext, type: ViewerRequestType, payload: unknown): Promise<unknown> {
  switch (type) {
    case 'screenshot':
      return screenshot(ctx, payload);
    case 'mermaid':
      return mermaid(ctx, payload);
    case 'focus':
      return focus(ctx, payload);
    default:
      throw new Error(`unknown request type ${JSON.stringify(type)}`);
  }
}
