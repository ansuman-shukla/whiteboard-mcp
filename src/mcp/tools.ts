import { mkdirSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, extname, isAbsolute, relative, resolve, sep } from 'node:path';
import { CanvasClient, CanvasError } from '../canvas/client.js';
import { describeChanges, describeScene } from '../shared/describe.js';
import { ELEMENT_SPEC_FIELDS, buildElements, deleteElements, type ElementSpec } from '../shared/elements.js';
import type { CanvasSummary, ChangesResponse, ExElement, MermaidResult, SavedSummary, ScreenshotResult } from '../shared/protocol.js';
import { editorWindow, type EditorWindow } from './editor.js';
import { closestBoards, findBoard, whereFrom } from './find.js';
import { GUIDE } from './guide.js';
import { openViewer } from './open.js';
import { stripNulls, validate, type Schema } from './schema.js';
import type { CanvasRef, Session } from './session.js';

export type Content = { type: 'text'; text: string } | { type: 'image'; data: string; mimeType: string };
export interface ToolResult {
  content: Content[];
  isError?: boolean;
}
type Args = Record<string, unknown>;

export interface Tool {
  name: string;
  description: string;
  inputSchema: Schema & { type: 'object' };
  run(args: Args, ctx: ChatContext): Promise<ToolResult | string>;
  /** canvas_read/canvas_guide don't get the "human changed things" footer. */
  quiet?: boolean;
}

export class ToolError extends Error {}

const debug = (msg: string): void => {
  if (process.env.WHITEBOARD_DEBUG === '1') process.stderr.write(`[whiteboard-mcp] ${msg}\n`);
};

/** Shared by the MCP server and CLI `call`: lazy daemon connection plus the session. */
export class ToolContext {
  private client?: Promise<CanvasClient>;
  /** Boards already created this process, with their current titles. */
  readonly titles = new Map<string, string>();
  /** The client is a chat app with its own window (not a terminal): boards go in its in-app browser. */
  app = false;

  private window?: Promise<EditorWindow>;

  constructor(readonly session: Session, private readonly connectOpts: Parameters<typeof CanvasClient.connect>[0] = {}) {}

  /** The editor window the agent runs in, looked up once (it may take a walk up the process tree). */
  editor(): Promise<EditorWindow> {
    return (this.window ??= editorWindow());
  }

  connect(): Promise<CanvasClient> {
    this.client ??= CanvasClient.connect({ autoStart: true, ...this.connectOpts }).catch((err: unknown) => {
      this.client = undefined;
      throw err;
    });
    return this.client;
  }

  get connected(): boolean {
    return this.client !== undefined;
  }

  /** Tool calls carry their chat, so one process can serve several chats. */
  async forChat(meta?: unknown): Promise<ChatContext> {
    await this.session.ready();
    return new ChatContext(this, await this.session.resolveChat(meta));
  }
}

/** Opening the board in the app's own browser keeps it beside the chat; an external browser takes the human away. */
const IN_APP_BROWSER = 'your in-app browser or preview tool (not an external browser)';

const SHOWN_BESIDE = 'Shown to the human beside the chat.';
const SHOW_WAIT_MS = 8000;
export class ChatContext {
  constructor(private readonly base: ToolContext, readonly chat: string) {}

  get session(): Session {
    return this.base.session;
  }

  get connected(): boolean {
    return this.base.connected;
  }

  connect(): Promise<CanvasClient> {
    return this.base.connect();
  }

  /** The board this chat is on (its own unless it opened another), created on first use. */
  async canvas(ref = this.session.board(this.chat)): Promise<{ client: CanvasClient; ref: CanvasRef }> {
    const client = await this.connect();
    const own = ref.id === this.session.ownBoard(this.chat).id;
    if (!this.base.titles.has(ref.id) || ref.title) {
      const summary = await client.ensureCanvas(ref.id, { ...(ref.title ? { title: ref.title } : {}), ...(own ? { workspace: this.session.workspace, chat: this.chat } : {}) });
      this.base.titles.set(ref.id, summary.title === ref.id ? '' : summary.title);
    }
    return { client, ref: { id: ref.id, title: this.base.titles.get(ref.id) ?? '' } };
  }

  /**
   * Puts the board in front of the human when nobody is watching it: an IDE panel host first; in an
   * editor without one, or a chat app, the agent opens it in the app's in-app browser; else a browser.
   */
  async reveal(client: CanvasClient, ref: CanvasRef, viewers: number): Promise<string> {
    return viewers > 0 ? '' : (await this.show(client, ref)).note;
  }

  /** The IDE panel host of this chat's window, else of its folder, shows the board. */
  private async panel(client: CanvasClient, ref: CanvasRef): Promise<boolean> {
    const { host, ide } = await this.base.editor();
    return client.show(ref.id, this.session.workspace, host, ide).catch(() => false);
  }

  private async show(client: CanvasClient, ref: CanvasRef): Promise<{ launched: boolean; note: string }> {
    if (await this.panel(client, ref)) return { launched: true, note: SHOWN_BESIDE };
    const url = client.viewerUrl(ref.id);
    const mode = process.env.WHITEBOARD_OPEN?.trim();
    if (mode === 'none') return { launched: false, note: `Nobody is watching the board; the human can open ${url}.` };
    const explicit = !!mode && mode !== 'auto';
    // In an editor without a panel, or a chat app, the agent shows it in the app's own browser.
    if (!explicit && (this.base.app || (await this.base.editor()).ide)) {
      const where = this.base.app ? '' : 'No whiteboard panel is connected in this editor. ';
      return { launched: false, note: `${where}Open the board in ${IN_APP_BROWSER} with this full URL, path included, as its target, even if the tool asks for host and port only; without the path the board won't load and the human sees a blank "not found" page: ${url}` };
    }
    const { opened, note } = await openViewer(url);
    return opened ? { launched: true, note: `${note}.` } : { launched: false, note: `${note}, so the human can't see the board yet; ask them to open ${url}.` };
  }

  /** Shows the board and waits until a viewer is connected; false if none arrives. */
  async revealAndWait(client: CanvasClient, ref: CanvasRef): Promise<{ ok: boolean; note: string }> {
    const { launched, note } = await this.show(client, ref);
    if (!launched) return { ok: false, note };
    const deadline = Date.now() + SHOW_WAIT_MS;
    while (Date.now() < deadline) {
      if ((await client.snapshot(ref.id)).viewers > 0) return { ok: true, note };
      await new Promise((r) => setTimeout(r, 200));
    }
    return { ok: false, note };
  }
}

const str = (description: string): Schema => ({ type: 'string', description });
const num = (description: string): Schema => ({ type: 'number', description });
const bool = (description: string): Schema => ({ type: 'boolean', description });
const ids = (description = 'Element ids'): Schema => ({ type: 'array', items: { type: 'string' }, description });
const obj = (properties: Record<string, Schema>, required?: string[]): Schema & { type: 'object' } => ({ type: 'object', properties, ...(required ? { required } : {}) });

const SHAPE_TYPES = ['rectangle', 'ellipse', 'diamond', 'text', 'arrow', 'line', 'frame', 'freedraw'];
const FIELD_SCHEMA: Record<keyof ElementSpec, Omit<Schema, 'description'>> = {
  id: { type: 'string' },
  type: { type: 'string', enum: SHAPE_TYPES },
  x: { type: 'number' },
  y: { type: 'number' },
  width: { type: 'number' },
  height: { type: 'number' },
  label: { type: 'string' },
  text: { type: 'string' },
  from: { type: 'string' },
  to: { type: 'string' },
  points: { type: 'array', items: { type: 'array', items: { type: 'number' } } },
  strokeColor: { type: 'string' },
  backgroundColor: { type: 'string' },
  fillStyle: { type: 'string' },
  strokeStyle: { type: 'string' },
  strokeWidth: { type: 'number' },
  roughness: { type: 'number' },
  opacity: { type: 'number' },
  fontSize: { type: 'number' },
  fontFamily: { type: 'string' },
  textAlign: { type: 'string' },
  rounded: { type: 'boolean' },
  startArrowhead: { type: 'string' },
  endArrowhead: { type: 'string' },
  frame: { type: 'string' },
  groupIds: { type: 'array', items: { type: 'string' } },
  locked: { type: 'boolean' },
  link: { type: 'string' },
};

const trimDesc = (s: string, max = 110): string => (s.length <= max ? s : `${s.slice(0, max - 1).replace(/\s+\S*$/, '')}…`);

export const ELEMENT_SCHEMA: Schema = {
  type: 'object',
  properties: Object.fromEntries(
    (Object.keys(FIELD_SCHEMA) as Array<keyof ElementSpec>).map((k) => {
      const desc = ELEMENT_SPEC_FIELDS[k];
      return [k, { ...FIELD_SCHEMA[k], ...(desc && !FIELD_SCHEMA[k].enum ? { description: trimDesc(desc) } : {}) } as Schema];
    }),
  ),
};

const MAX_ELEMENTS = 200;

function text(...lines: Array<string | undefined | false>): string {
  return lines.filter((l): l is string => typeof l === 'string' && l.length > 0).join('\n');
}

const boardName = (ref: CanvasRef): string => (ref.title ? `"${ref.title}"` : 'this chat\'s board (untitled; name it with canvas_open {title})');

function withLabels(elements: ExElement[]): Map<string, string> {
  const labels = new Map<string, string>();
  for (const el of elements) {
    if (el.type === 'text' && typeof el.containerId === 'string' && typeof el.text === 'string') labels.set(el.containerId, el.text);
  }
  return labels;
}

const round = (n: unknown): number | undefined => (typeof n === 'number' ? Math.round(n) : undefined);

function trimmedJson(elements: ExElement[], only?: string[]): string {
  const labels = withLabels(elements);
  const want = only?.length ? new Set(only) : undefined;
  const out = elements
    .filter((el) => !(el.type === 'text' && typeof el.containerId === 'string') && (!want || want.has(el.id)))
    .map((el) => {
      const binding = (b: unknown): string | undefined => (b && typeof b === 'object' && 'elementId' in b ? String((b as { elementId: unknown }).elementId) : undefined);
      return Object.fromEntries(
        Object.entries({
          id: el.id,
          type: el.type,
          x: round(el.x),
          y: round(el.y),
          width: round(el.width),
          height: round(el.height),
          text: el.type === 'text' ? el.text : undefined,
          label: labels.get(el.id),
          strokeColor: el.strokeColor,
          backgroundColor: el.backgroundColor === 'transparent' ? undefined : el.backgroundColor,
          from: binding(el.startBinding),
          to: binding(el.endBinding),
          frame: el.frameId ?? undefined,
        }).filter(([, v]) => v !== undefined && v !== null),
      );
    });
  return JSON.stringify(out);
}

/** Element ids a change refers to, with bound label text folded into its container. */
function humanTouched(ch: ChangesResponse): Set<string> {
  const byId = new Map(ch.elements.map((el) => [el.id, el]));
  const touched = new Set<string>();
  for (const c of ch.changes) {
    if (c.actor !== 'human') continue;
    const container = byId.get(c.id)?.containerId;
    touched.add(typeof container === 'string' ? container : c.id);
  }
  return touched;
}

function unreadNotes(ch: ChangesResponse, since: number): ChangesResponse['notes'] {
  return ch.notes.filter((n) => n.rev > since);
}

const plural = (n: number, word: string): string => `${n} ${word}${n === 1 ? '' : 's'}`;

export async function humanActivityLine(ctx: ChatContext): Promise<string | undefined> {
  if (!ctx.connected) return undefined;
  const { client, ref } = await ctx.canvas();
  const since = ctx.session.lastReadRev(ctx.chat, ref.id);
  const ch = await client.changes(ref.id, since);
  if (ch.full && since > 0) return '⚑ The canvas changed a lot since your last canvas_read; call canvas_read to catch up.';
  const changed = humanTouched(ch).size;
  const notes = unreadNotes(ch, since).length;
  if (!changed && !notes) return undefined;
  const parts = [changed && `changed ${plural(changed, 'element')}`, notes && `left ${plural(notes, 'note')}`].filter(Boolean);
  return `⚑ The human ${parts.join(' and ')} since your last canvas_read.`;
}

function allowedExportRoots(workspace: string): string[] {
  const roots = [workspace, tmpdir(), process.env.WHITEBOARD_EXPORT_DIR].filter((r): r is string => !!r).map((r) => resolve(r));
  const real = roots.flatMap((r) => {
    try {
      return [realpathSync(r)];
    } catch {
      return [];
    }
  });
  return [...new Set([...roots, ...real])];
}

const inside = (root: string, target: string): boolean => {
  const rel = relative(root, target);
  return rel === '' || (!rel.startsWith(`..${sep}`) && rel !== '..' && !isAbsolute(rel));
};

export function resolveExportPath(path: string, workspace: string, ext: string): string {
  let target = resolve(workspace, path);
  if (!extname(target)) target += ext;
  const roots = allowedExportRoots(workspace);
  const refuse = (): never => {
    throw new ToolError(`Refusing to write ${target}: exports must stay inside the workspace (${workspace}), the temp dir, or WHITEBOARD_EXPORT_DIR.`);
  };
  if (!roots.some((r) => inside(r, target))) refuse();
  mkdirSync(dirname(target), { recursive: true });
  const real = resolve(realpathSync(dirname(target)), target.slice(dirname(target).length + 1));
  if (!roots.some((r) => inside(r, real))) refuse();
  return target;
}

async function viewerRequest<T>(ctx: ChatContext, type: 'screenshot' | 'mermaid' | 'focus', payload: unknown, timeoutMs?: number): Promise<{ result: T; ref: CanvasRef; client: CanvasClient }> {
  const { client, ref } = await ctx.canvas();
  const attempt = async () => ({ result: await client.request<T>(ref.id, type, payload, timeoutMs), ref, client });
  try {
    return await attempt();
  } catch (err) {
    if (err instanceof CanvasError && err.code === 'timeout') throw new ToolError(`The viewer did not answer the ${type} request in time. Is the whiteboard still open?`);
    if (!(err instanceof CanvasError && err.code === 'no_viewer')) throw err;
  }
  // Nobody is looking at the board: show it, then retry once.
  const { ok, note } = await ctx.revealAndWait(client, ref);
  if (!ok) throw new ToolError(`${type} needs the board on screen. ${note}`);
  return attempt();
}

/** A saved board by exact id or name (this workspace's first), or the only search hit. */
async function findSaved(client: CanvasClient, wanted: string, workspace: string): Promise<SavedSummary> {
  const hits = await client.searchSaved(wanted, workspace, 50);
  const lower = wanted.toLowerCase();
  const match = hits.find((s) => s.id === wanted) ?? hits.find((s) => s.name.toLowerCase() === lower) ?? (hits.length === 1 ? hits[0] : undefined);
  if (match) return match;
  if (!hits.length) throw new ToolError(`No saved board matches "${wanted}". canvas_search lists them.`);
  throw new ToolError(`"${wanted}" matches several saved boards; pass one id: ${hits.slice(0, 10).map((s) => `"${s.name}" [${s.id}]`).join('; ')}.`);
}

const savedLine = (s: SavedSummary, workspace: string): string =>
  `- "${s.name}" [${s.id}] ${s.elementCount} el, saved ${new Date(s.savedAt).toLocaleDateString('en-CA')}, ${whereFrom(s.workspace, workspace)}${s.snippet ? `: "${s.snippet}"` : ''}`;

/** A live board for canvas_open {board}: this workspace first, then any folder; otherwise the closest boards to pick from. */
async function findLiveBoard(client: CanvasClient, all: CanvasSummary[], wanted: string, workspace: string): Promise<CanvasSummary> {
  const lookup = findBoard(all, wanted, workspace);
  if ('found' in lookup) return lookup.found;
  if ('several' in lookup) throw new ToolError(`Several boards in other folders are called "${wanted}"; pass one id: ${lookup.several.map((b) => `[${b.id}] ${whereFrom(b.workspace, workspace)}`).join('; ')}.`);
  const closest = closestBoards(all, await client.searchSaved('', workspace, 50), wanted, workspace).map((s) =>
    s.kind === 'board' ? `"${s.board.title}" [${s.board.id}] ${whereFrom(s.board.workspace, workspace)}` : `saved copy "${s.saved.name}" (load with saved:"${s.saved.id}")`,
  );
  throw new ToolError(`No board called "${wanted}" in any folder.${closest.length ? ` Closest, open one by id: ${closest.join('; ')}.` : ''}`);
}

async function drawOnce(client: CanvasClient, ref: CanvasRef, specs: ElementSpec[]) {
  const snap = await client.snapshot(ref.id);
  const built = buildElements(specs, snap.elements);
  const res = await client.apply(ref.id, built.elements, { actor: 'agent' });
  return { snap, built, res };
}

export const TOOLS: Tool[] = [
  {
    name: 'canvas_open',
    description: "Show this chat's own whiteboard to the human beside the chat. Name it with title. To reuse another chat's drawing (any folder), pass board.",
    inputSchema: obj({
      title: str("Name this chat's board after the topic, e.g. \"How MCP works\""),
      board: str("Open another chat's board by id or title (this folder first, then any); \"own\" returns to this chat's"),
      saved: str("Load a copy of a saved board (id or name, see canvas_search) into this chat's board"),
      fresh: bool('Clear the board first (needed to load saved over a non-empty board)'),
      open: bool('Show it to the human if nobody is watching (default true)'),
    }),
    async run(args, ctx) {
      const client = await ctx.connect();
      const workspace = ctx.session.workspace;
      const own = ctx.session.ownBoard(ctx.chat);
      const all = await client.list();
      const boards = all.filter((b) => b.workspace === workspace || b.id === own.id);
      const wanted = (args.board as string | undefined)?.trim();
      const savedWanted = (args.saved as string | undefined)?.trim();
      if (wanted && savedWanted) throw new ToolError('Pass board or saved, not both.');
      let target: CanvasRef = ctx.session.board(ctx.chat);
      let elsewhere: string | undefined;
      if (wanted?.toLowerCase() === 'own') target = { id: own.id, title: '' };
      else if (wanted) {
        const match = await findLiveBoard(client, all, wanted, workspace);
        if (match.workspace !== workspace) elsewhere = whereFrom(match.workspace, workspace);
        target = { id: match.id, title: '' };
      }
      const loaded = savedWanted ? await findSaved(client, savedWanted, workspace) : undefined;
      if (loaded) {
        target = own;
        await ctx.canvas(own);
        const count = (await client.snapshot(own.id)).elements.length;
        if (count && !args.fresh) throw new ToolError(`This chat's board has ${plural(count, 'element')}; loading "${loaded.name}" replaces them. Pass fresh:true to replace them (canvas_save keeps a copy first).`);
      }
      const title = args.title !== undefined ? String(args.title).trim() : loaded?.name;
      const { ref } = await ctx.canvas(title !== undefined ? { ...target, title } : target);
      ctx.session.setBoard(ctx.chat, ref);
      if (loaded) await client.loadSaved(ref.id, loaded.id);
      else if (args.fresh) await client.clear(ref.id);
      const snap = await client.snapshot(ref.id);
      const shown = args.open === false ? '' : await ctx.reveal(client, ref, snap.viewers);
      const others = boards.filter((b) => b.id !== ref.id).sort((a, b) => b.updatedAt - a.updatedAt).slice(0, 10);
      const mine = ref.id === own.id;
      const summary = text(
        `${mine ? "This chat's board" : `Board from another chat${elsewhere ? ` (${elsewhere})` : ''}`}: ${boardName(ref)} [${ref.id}]. ${snap.viewers ? 'The human is watching it.' : shown}`,
        loaded && `Loaded a copy of saved board "${loaded.name}" [${loaded.id}]; the saved copy stays unchanged.`,
        snap.elements.length ? describeScene(snap.elements, { maxElements: 12 }) : 'The board is empty.',
        others.length > 0 && `Other boards in this workspace (open one with board): ${others.map((b) => `${b.title === b.id ? '(untitled)' : b.title} [${b.id}, ${b.elementCount} el]`).join('; ')}`,
        !mine && 'Drawing now changes that board; canvas_open {board:"own"} switches back to this chat\'s board.',
      );
      return summary;
    },
  },
  {
    name: 'canvas_read',
    description: 'Read the board: scene description (or JSON), then what the human changed and noted since your last read.',
    inputSchema: obj({
      ids: ids('Only describe these elements'),
      format: { type: 'string', enum: ['summary', 'json'], description: 'summary (default) or json' },
    }),
    quiet: true,
    async run(args, ctx) {
      const { client, ref } = await ctx.canvas();
      const only = args.ids as string[] | undefined;
      const snap = await client.snapshot(ref.id);
      const since = ctx.session.lastReadRev(ctx.chat, ref.id);
      const ch = await client.changes(ref.id, since);
      const scene = args.format === 'json' ? trimmedJson(snap.elements, only) : describeScene(snap.elements, only?.length ? { ids: only } : {});
      // A full (log-truncated) answer on the first read is just the scene above, not news.
      const human = ch.full ? (since > 0 ? 'too many to list; the scene above is current.' : '') : describeChanges(ch.changes, [...snap.elements, ...ch.elements], { actor: 'human' });
      const notes = unreadNotes(ch, since);
      ctx.session.setLastReadRev(ctx.chat, ref.id, ch.rev);
      return text(
        `Board ${boardName(ref)} rev ${ch.rev}, ${plural(snap.viewers, 'viewer')}.`,
        scene,
        human ? `Human changes since your last read:\n${human}` : 'No human changes since your last read.',
        notes.length > 0 && `Notes from the human:\n${notes.map((n) => `- ${n.text}`).join('\n')}`,
      );
    },
  },
  {
    name: 'canvas_draw',
    description: 'Create or update elements. Re-using an id updates only the given fields. Arrows bind with from/to element ids.',
    inputSchema: obj({ elements: { type: 'array', items: ELEMENT_SCHEMA, maxItems: MAX_ELEMENTS, description: 'Element specs' } }, ['elements']),
    async run(args, ctx) {
      const specs = args.elements as ElementSpec[];
      if (!specs.length) throw new ToolError('elements is empty: pass at least one element spec.');
      const { client, ref } = await ctx.canvas();
      let { snap, built, res } = await drawOnce(client, ref, specs);
      if (res.stale.length) ({ snap, built, res } = await drawOnce(client, ref, specs));
      const before = new Set(snap.elements.map((el) => el.id));
      const created = built.ids.filter((id) => !before.has(id));
      const updated = built.ids.filter((id) => before.has(id));
      const merged = new Map(snap.elements.map((el) => [el.id, el]));
      for (const el of built.elements) {
        if (el.isDeleted) merged.delete(el.id);
        else merged.set(el.id, el);
      }
      return text(
        created.length > 0 && `Created: ${created.join(', ')}`,
        updated.length > 0 && `Updated: ${updated.join(', ')}`,
        res.stale.length > 0 && `Not applied (the human edited them at the same moment, retry): ${res.stale.join(', ')}`,
        built.warnings.length > 0 && `Warnings:\n${built.warnings.map((w) => `- ${w}`).join('\n')}`,
        built.ids.length > 0 && describeScene([...merged.values()], { ids: built.ids }),
        await ctx.reveal(client, ref, snap.viewers),
      );
    },
  },
  {
    name: 'canvas_delete',
    description: 'Delete elements by id (arrows bound to them are detached), or everything with all:true.',
    inputSchema: obj({ ids: ids(), all: bool('Clear the whole board') }),
    async run(args, ctx) {
      const list = (args.ids as string[] | undefined) ?? [];
      if (!args.all && !list.length) throw new ToolError('Pass ids (element ids to delete) or all:true.');
      const { client, ref } = await ctx.canvas();
      if (args.all) {
        await client.clear(ref.id);
        return `Cleared ${boardName(ref)}.`;
      }
      const snap = await client.snapshot(ref.id);
      const del = deleteElements(list, snap.elements);
      if (del.elements.length) await client.apply(ref.id, del.elements, { actor: 'agent' });
      return text(del.ids.length ? `Deleted: ${del.ids.join(', ')}` : 'Nothing deleted.', del.warnings.length > 0 && `Warnings:\n${del.warnings.map((w) => `- ${w}`).join('\n')}`);
    },
  },
  {
    name: 'canvas_focus',
    description: "Scroll/zoom the human's view to elements (whole scene if no ids); highlight pulses them. Use it to point while explaining.",
    inputSchema: obj({ ids: ids(), highlight: bool('Pulse a highlight around them'), zoom: num('Zoom level, e.g. 1') }),
    async run(args, ctx) {
      await viewerRequest(ctx, 'focus', { ids: args.ids, highlight: args.highlight, zoom: args.zoom });
      const target = (args.ids as string[] | undefined)?.join(', ') || 'the whole scene';
      return `Focused on ${target}${args.highlight ? ' (highlighted)' : ''}.`;
    },
  },
  {
    name: 'canvas_screenshot',
    description: 'PNG of the board as the human sees it, to check your layout.',
    inputSchema: obj({ ids: ids('Only these elements'), dark: bool('Dark theme') }),
    async run(args, ctx) {
      const { result, ref } = await viewerRequest<ScreenshotResult>(ctx, 'screenshot', { ids: args.ids, dark: args.dark });
      return { content: [{ type: 'image', data: result.base64, mimeType: 'image/png' }, { type: 'text', text: `Screenshot of ${boardName(ref)}, ${result.width}×${result.height}px.` }] };
    },
  },
  {
    name: 'canvas_mermaid',
    description: 'Convert a Mermaid definition (flowchart, sequence, class…) into editable elements on the board.',
    inputSchema: obj({ definition: str('Mermaid source'), x: num('Left edge'), y: num('Top edge') }, ['definition']),
    async run(args, ctx) {
      const { result, ref, client } = await viewerRequest<MermaidResult>(ctx, 'mermaid', { definition: args.definition, x: args.x, y: args.y }, 30_000);
      const snap = await client.snapshot(ref.id);
      return text(`Created ${plural(result.ids.length, 'element')} from mermaid.`, result.ids.length > 0 && describeScene(snap.elements, { ids: result.ids }));
    },
  },
  {
    name: 'canvas_export',
    description: 'Save the board to a file: .excalidraw JSON (default) or PNG. Relative paths resolve against the workspace.',
    inputSchema: obj({ path: str('File path inside the workspace or temp dir'), format: { type: 'string', enum: ['excalidraw', 'png'], description: 'Default from extension, else excalidraw' } }, ['path']),
    async run(args, ctx) {
      await ctx.session.ready();
      const path = args.path as string;
      const format = (args.format as string | undefined) ?? (extname(path).toLowerCase() === '.png' ? 'png' : 'excalidraw');
      const target = resolveExportPath(path, ctx.session.workspace, format === 'png' ? '.png' : '.excalidraw');
      if (format === 'png') {
        const { result } = await viewerRequest<ScreenshotResult>(ctx, 'screenshot', {});
        writeFileSync(target, Buffer.from(result.base64, 'base64'));
        return `Wrote ${target} (${result.width}×${result.height}px PNG).`;
      }
      const { client, ref } = await ctx.canvas();
      const snap = await client.snapshot(ref.id);
      const doc = { type: 'excalidraw', version: 2, source: 'whiteboard-mcp', elements: snap.elements, appState: { viewBackgroundColor: '#ffffff' }, files: snap.files };
      writeFileSync(target, `${JSON.stringify(doc, null, 2)}\n`);
      return `Wrote ${target} (${plural(snap.elements.length, 'element')}).`;
    },
  },
  {
    name: 'canvas_save',
    description: "Save a frozen copy of this board to the user's library so any later chat can find it with canvas_search. The same name again overwrites it.",
    inputSchema: obj({ name: str('Name to save under (default: the board title)') }),
    async run(args, ctx) {
      const { client, ref } = await ctx.canvas();
      const name = (args.name as string | undefined)?.trim() || ref.title;
      if (!name) throw new ToolError('This board has no title yet: pass name.');
      if (!(await client.snapshot(ref.id)).elements.length) throw new ToolError('The board is empty; draw something before saving it.');
      const saved = await client.save(ref.id, name);
      return `Saved ${plural(saved.elementCount, 'element')} as "${saved.name}" [${saved.id}]. Later chats find it with canvas_search and load a copy with canvas_open {saved:"${saved.id}"}.`;
    },
  },
  {
    name: 'canvas_search',
    description: "Find boards of every folder (this one first) by name or text: other chats' live boards and saved copies. Open with canvas_open {board} or {saved}.",
    inputSchema: obj({ query: str('Words that must all match; omit to list the latest') }),
    quiet: true,
    async run(args, ctx) {
      const client = await ctx.connect();
      const workspace = ctx.session.workspace;
      const query = ((args.query as string | undefined) ?? '').trim();
      const [live, saved] = await Promise.all([client.searchBoards(query, workspace), client.searchSaved(query, workspace)]);
      if (!live.length && !saved.length) return query ? `No boards or saved copies match "${query}".` : 'No boards yet.';
      const matching = query ? ` matching "${query}"` : '';
      return text(
        live.length > 0 && `${plural(live.length, 'live board')}${matching}, this workspace first (canvas_open {board:"<id>"} opens one):`,
        ...live.map((b) => `- "${b.title === b.id ? '(untitled)' : b.title}" [${b.id}] ${b.elementCount} el, changed ${new Date(b.updatedAt).toLocaleDateString('en-CA')}, ${whereFrom(b.workspace, workspace)}${b.snippet ? `: "${b.snippet}"` : ''}`),
        saved.length > 0 && `${plural(saved.length, 'saved board')}${matching} (canvas_open {saved:"<id>"} loads a copy into this chat's board):`,
        ...saved.map((s) => savedLine(s, workspace)),
      );
    },
  },
  {
    name: 'canvas_guide',
    description: 'How to explain well on this canvas: layout, sizes, colours, the live explain loop. Read once before your first drawing.',
    inputSchema: obj({}),
    quiet: true,
    async run() {
      return GUIDE;
    },
  },
];

const BY_NAME = new Map(TOOLS.map((t) => [t.name, t]));

export function getTool(name: string): Tool | undefined {
  return BY_NAME.get(name);
}

export function toolList(): Array<Pick<Tool, 'name' | 'description' | 'inputSchema'>> {
  return TOOLS.map(({ name, description, inputSchema }) => ({ name, description, inputSchema }));
}

function errorText(err: unknown): string {
  if (err instanceof ToolError) return err.message;
  if (err instanceof CanvasError) return `Canvas error (${err.code}): ${err.message}`;
  const msg = err instanceof Error ? err.message : String(err);
  return err instanceof TypeError && /fetch failed/i.test(msg) ? `Canvas daemon unreachable (${msg}). Run \`whiteboard-mcp status\` to check it.` : `Failed: ${msg}`;
}

/** Validates and runs a tool; every failure becomes an `isError` result. */
export async function callTool(tool: Tool, rawArgs: unknown, base: ToolContext, meta?: unknown): Promise<ToolResult> {
  const args = stripNulls(rawArgs ?? {});
  const invalid = validate(tool.inputSchema, args);
  if (invalid) return { content: [{ type: 'text', text: `Invalid arguments: ${invalid}.` }], isError: true };
  let result: ToolResult;
  const ctx = await base.forChat(meta);
  try {
    const out = await tool.run(args as Args, ctx);
    result = typeof out === 'string' ? { content: [{ type: 'text', text: out }] } : out;
  } catch (err) {
    debug(`${tool.name} failed: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}`);
    result = { content: [{ type: 'text', text: errorText(err) }], isError: true };
  }
  if (!tool.quiet) {
    try {
      const line = await humanActivityLine(ctx);
      if (line) result.content.push({ type: 'text', text: line });
    } catch (err) {
      debug(`piggyback failed: ${String(err)}`);
    }
  }
  return result;
}
