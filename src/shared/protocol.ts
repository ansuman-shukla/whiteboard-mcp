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

/** Who a board belongs to: the workspace folder ("space") and the chat that created it. */
export interface CanvasMeta {
  title?: string;
  workspace?: string;
  chat?: string;
}

export interface CanvasSummary {
  id: string;
  title: string;
  elementCount: number;
  updatedAt: number;
  viewers: number;
  workspace?: string;
  chat?: string;
}

export interface CanvasSearchHit extends CanvasSummary {
  /** A line of the board's text that matches the search query. */
  snippet?: string;
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

/** A frozen copy of a board kept in the user's library, so any later chat can find and load it. */
export interface SavedSummary {
  id: string;
  name: string;
  savedAt: number;
  elementCount: number;
  /** The board it was saved from. */
  source: string;
  workspace?: string;
  /** A line of the board's text that matches the search query. */
  snippet?: string;
}

export interface SavedBoard extends Omit<SavedSummary, 'snippet'> {
  elements: ExElement[];
  files: Record<string, BinaryFile>;
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
  /** Answers this viewer's own `save`. */
  | { t: 'saved'; ok: true; saved: SavedSummary }
  | { t: 'saved'; ok: false; error: string }
  | { t: 'error'; message: string };

/** Messages sent by a browser viewer to the daemon over WebSocket. */
export type ClientMessage =
  | { t: 'elements'; elements: ExElement[]; files?: BinaryFile[]; actor?: Actor }
  | { t: 'response'; reqId: string; ok: boolean; result?: unknown; error?: string }
  | { t: 'note'; text: string }
  /** Saves the board to the library; the name defaults to the board's title. */
  | { t: 'save'; name?: string }
  | { t: 'visible'; visible: boolean };

/**
 * Panel hosts (IDE extensions that show boards beside the chat) connect to `API.hostWs`.
 * A show request goes to the host whose `hostId` equals the request's `host` hint (the chat's own
 * window), else to a host whose folders contain the board's workspace, never to an unrelated window.
 */
export type HostMessage =
  /** `hostId` identifies the editor window, e.g. its extension-host pid; agents in it pass the same id as `host`. */
  | { t: 'hello'; folders: string[]; focused: boolean; hostId?: string }
  | { t: 'state'; folders?: string[]; focused?: boolean }
  | { t: 'shown'; reqId: string; ok: boolean; error?: string };

export type ServerHostMessage = { t: 'show'; reqId: string; canvasId: string; title: string };

export interface ShowRequest {
  workspace?: string;
  /** The `hostId` of the window the agent runs in, when known. A daemon that just started waits a few seconds for that window's host to connect. */
  host?: string;
}

export const API = {
  health: '/health',
  canvases: '/api/canvases',
  canvas: (id: string) => `/api/canvases/${encodeURIComponent(id)}`,
  elements: (id: string) => `/api/canvases/${encodeURIComponent(id)}/elements`,
  clear: (id: string) => `/api/canvases/${encodeURIComponent(id)}/clear`,
  changes: (id: string, since: number) => `/api/canvases/${encodeURIComponent(id)}/changes?since=${since}`,
  notes: (id: string) => `/api/canvases/${encodeURIComponent(id)}/notes`,
  request: (id: string) => `/api/canvases/${encodeURIComponent(id)}/request`,
  show: (id: string) => `/api/canvases/${encodeURIComponent(id)}/show`,
  /** Saves the canvas to the library: `{ name? }`. */
  save: (id: string) => `/api/canvases/${encodeURIComponent(id)}/save`,
  /** Replaces the canvas's scene with a saved board: `{ saved }`. */
  load: (id: string) => `/api/canvases/${encodeURIComponent(id)}/load`,
  /** Saved boards matching every word of `q` (all when empty), boards of `workspace` first. */
  saved: (q = '', workspace = '', limit?: number) => `/api/saved?${new URLSearchParams({ q, workspace, ...(limit ? { limit: String(limit) } : {}) })}`,
  savedBoard: (id: string) => `/api/saved/${encodeURIComponent(id)}`,
  /** Live boards of every folder matching every word of `q` (all non-empty when empty), boards of `workspace` first. */
  search: (q = '', workspace = '', limit?: number) => `/api/search?${new URLSearchParams({ q, workspace, ...(limit ? { limit: String(limit) } : {}) })}`,
  hostWs: '/ws/host',
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
