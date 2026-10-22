/**
 * Wire contract shared by the canvas daemon, its Node client (used by the MCP
 * layer and CLI) and the browser frontend. Keep this file dependency-free: the
 * frontend bundles it too.
 */

export type Actor = 'agent' | 'human';

/** A complete Excalidraw element as stored by Excalidraw itself (JSON). */
export interface ExElement {
  id: string;
  type: string;
  x: number;
  y: number;
  width: number;
  height: number;
  version: number;
  versionNonce: number;
  isDeleted: boolean;
  updated: number;
  [key: string]: unknown;
}

export interface BinaryFile {
  id: string;
  mimeType: string;
  dataURL: string;
  created: number;
}

export interface CanvasNote {
  id: string;
  text: string;
  at: number;
  rev: number;
}

export interface CanvasSummary {
  id: string;
  title: string;
  elementCount: number;
  updatedAt: number;
  viewers: number;
}

export interface CanvasSnapshot {
  id: string;
  title: string;
  rev: number;
  /** Live elements only (tombstones are omitted from snapshots). */
  elements: ExElement[];
  files: Record<string, BinaryFile>;
  notes: CanvasNote[];
  viewers: number;
}

export interface ChangeRecord {
  rev: number;
  actor: Actor;
  id: string;
  kind: 'created' | 'updated' | 'deleted';
}

export interface ChangesResponse {
  rev: number;
  /** True when `since` predates the retained change log; `changes` is then empty and `elements` is the full live scene. */
  full: boolean;
  changes: ChangeRecord[];
  /** Current state (including tombstones) of every element referenced by `changes`. */
  elements: ExElement[];
  notes: CanvasNote[];
}

export interface ApplyResponse {
  rev: number;
  /** Ids whose incoming version won the merge and were stored. */
  applied: string[];
  /** Ids rejected because the stored version was newer. */
  stale: string[];
}

export type ViewerRequestType = 'screenshot' | 'mermaid' | 'focus';

export interface ScreenshotPayload {
  ids?: string[];
  dark?: boolean;
  scale?: number;
}
export interface ScreenshotResult {
  mimeType: 'image/png';
  base64: string;
  width: number;
  height: number;
}

export interface MermaidPayload {
  definition: string;
  x?: number;
  y?: number;
}
/** The viewer converts, then applies the elements itself (sending them as an `elements` message with actor agent). */
export interface MermaidResult {
  ids: string[];
}

export interface FocusPayload {
  ids?: string[];
  /** Fit the whole scene when no ids are given. */
  zoom?: number;
  /** Briefly pulse a highlight around the target elements. */
  highlight?: boolean;
}
export interface FocusResult {
  ok: true;
}

/** Messages sent by the daemon to a browser viewer over WebSocket. */
export type ServerMessage =
  | { t: 'snapshot'; canvas: CanvasSnapshot }
  | { t: 'elements'; rev: number; actor: Actor; elements: ExElement[]; files?: BinaryFile[] }
  | { t: 'note'; note: CanvasNote }
  | { t: 'request'; reqId: string; type: ViewerRequestType; payload: unknown }
  | { t: 'viewers'; count: number }
  | { t: 'error'; message: string };

/** Messages sent by a browser viewer to the daemon over WebSocket. */
export type ClientMessage =
  | { t: 'elements'; elements: ExElement[]; files?: BinaryFile[]; actor?: Actor }
  | { t: 'response'; reqId: string; ok: boolean; result?: unknown; error?: string }
  | { t: 'note'; text: string }
  | { t: 'visible'; visible: boolean };

export const API = {
  health: '/health',
  canvases: '/api/canvases',
  canvas: (id: string) => `/api/canvases/${encodeURIComponent(id)}`,
  elements: (id: string) => `/api/canvases/${encodeURIComponent(id)}/elements`,
  clear: (id: string) => `/api/canvases/${encodeURIComponent(id)}/clear`,
  changes: (id: string, since: number) => `/api/canvases/${encodeURIComponent(id)}/changes?since=${since}`,
  notes: (id: string) => `/api/canvases/${encodeURIComponent(id)}/notes`,
  request: (id: string) => `/api/canvases/${encodeURIComponent(id)}/request`,
  viewer: (id: string) => `/c/${encodeURIComponent(id)}`,
  ws: '/ws',
} as const;

/** Canvas ids are URL- and filename-safe. */
export const CANVAS_ID_PATTERN = /^[a-z0-9][a-z0-9-]{0,63}$/;

/**
 * Excalidraw's own reconciliation rule: the higher version wins; on a version
 * tie the lower versionNonce wins, so every replica converges.
 */
export function incomingWins(incoming: Pick<ExElement, 'version' | 'versionNonce'>, stored: Pick<ExElement, 'version' | 'versionNonce'> | undefined): boolean {
  if (!stored) return true;
  if (incoming.version !== stored.version) return incoming.version > stored.version;
  return incoming.versionNonce < stored.versionNonce;
}
