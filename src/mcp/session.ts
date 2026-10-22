import { execFile } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { stateDir } from '../shared/config.js';
import { splitCommand } from './open.js';

export interface CanvasRef {
  id: string;
  title: string;
}

interface SessionFile {
  lastReadRev?: number;
  current?: CanvasRef;
  chat?: string;
}

const sha6 = (s: string): string => createHash('sha256').update(s).digest('hex').slice(0, 6);
const CHAT_COMMAND_TIMEOUT_MS = 3000;
/** Tool-call `_meta` keys hosts use for the conversation id. */
const META_CHAT_KEYS = ['chatId', 'conversationId', 'conversation_id', 'sessionId', 'session_id', 'threadId'];

export function slug(s: string): string {
  return s.toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40).replace(/-+$/, '') || 'canvas';
}

/** Each chat's own board, namespaced by its workspace folder (the "space"). */
export function chatBoard(workspace: string, chat: string): CanvasRef {
  const abs = resolve(workspace);
  return { id: `${slug(basename(abs) || abs)}-${sha6(`${abs}\0chat\0${chat}`)}`, title: '' };
}

export function rootToPath(uri: string): string | undefined {
  if (!uri.startsWith('file://')) return undefined;
  try {
    return fileURLToPath(uri);
  } catch {
    return undefined;
  }
}

const validChat = (value: unknown): value is string => typeof value === 'string' && value.trim().length > 0 && value.length <= 256;

export function chatFromMeta(meta: unknown): string | undefined {
  if (!meta || typeof meta !== 'object') return undefined;
  for (const [key, value] of Object.entries(meta)) {
    const name = key.split('/').pop() ?? key;
    if (META_CHAT_KEYS.includes(name) && validChat(value)) return value.trim();
  }
  return undefined;
}

function runChatCommand(template: string): Promise<string | undefined> {
  const [cmd, ...args] = splitCommand(template);
  if (!cmd) return Promise.resolve(undefined);
  return new Promise((done) => {
    execFile(cmd, args, { timeout: CHAT_COMMAND_TIMEOUT_MS, windowsHide: true }, (err, stdout) => {
      const value = String(stdout ?? '').trim();
      done(!err && validChat(value) ? value : undefined);
    });
  });
}

/**
 * Per-process state: workspace, which board each chat is looking at, and read cursors.
 * A chat draws on its own board unless it opened another board from the same workspace.
 * With `persist` (CLI `call`), state lives in `<stateDir>/sessions/` so separate calls act as one chat.
 */
export class Session {
  private readonly current = new Map<string, CanvasRef>();
  private readonly lastRead = new Map<string, number>();
  private pendingWorkspace: Promise<void> = Promise.resolve();
  private fallbackChat?: Promise<string>;

  constructor(public workspace = process.env.WHITEBOARD_WORKSPACE || process.cwd(), private readonly persist = false) {
    this.workspace = resolve(workspace);
  }

  /** Tool calls wait for an in-flight roots/list so they target the right workspace. */
  waitForWorkspace(update: Promise<string | undefined>): void {
    this.pendingWorkspace = update.then(
      (path) => {
        if (path && resolve(path) !== this.workspace) {
          this.workspace = resolve(path);
          this.current.clear();
        }
      },
      () => undefined,
    );
  }

  ready(): Promise<void> {
    return this.pendingWorkspace;
  }

  /** The chat a tool call belongs to: host metadata, then WHITEBOARD_CHAT_ID, WHITEBOARD_CHAT_COMMAND, else this process. */
  resolveChat(meta?: unknown): Promise<string> {
    const fromMeta = chatFromMeta(meta);
    if (fromMeta) return Promise.resolve(fromMeta);
    this.fallbackChat ??= (async () => {
      if (validChat(process.env.WHITEBOARD_CHAT_ID)) return process.env.WHITEBOARD_CHAT_ID.trim();
      const command = process.env.WHITEBOARD_CHAT_COMMAND;
      const fromCommand = command ? await runChatCommand(command) : undefined;
      if (fromCommand) return fromCommand;
      if (this.persist) return (this.load('cli').chat ??= this.saveChat());
      return `process-${randomUUID()}`;
    })();
    return this.fallbackChat;
  }

  ownBoard(chat: string): CanvasRef {
    return chatBoard(this.workspace, chat);
  }

  board(chat: string): CanvasRef {
    return this.current.get(chat) ?? (this.persist ? this.load(this.key(chat)).current : undefined) ?? this.ownBoard(chat);
  }

  /** Switches the chat to another board of this workspace, or back to its own with undefined. */
  setBoard(chat: string, ref: CanvasRef | undefined): void {
    const own = !ref || ref.id === this.ownBoard(chat).id;
    if (own) this.current.delete(chat);
    else this.current.set(chat, ref);
    if (this.persist) this.save(this.key(chat), { current: own ? undefined : ref });
  }

  lastReadRev(chat: string, boardId: string): number {
    const key = `${this.key(chat)}:${boardId}`;
    if (!this.lastRead.has(key) && this.persist) this.lastRead.set(key, this.load(key).lastReadRev ?? 0);
    return this.lastRead.get(key) ?? 0;
  }

  setLastReadRev(chat: string, boardId: string, rev: number): void {
    const key = `${this.key(chat)}:${boardId}`;
    this.lastRead.set(key, rev);
    if (this.persist) this.save(key, { lastReadRev: rev });
  }

  private key(chat: string): string {
    return sha6(`${this.workspace}\0${chat}`) + sha6(chat);
  }

  private saveChat(): string {
    const chat = `cli-${randomUUID()}`;
    this.save('cli', { chat });
    return chat;
  }

  private file(name: string): string {
    return join(stateDir(), 'sessions', `${sha6(this.workspace)}-${name.replace(/[^A-Za-z0-9_-]/g, '_')}.json`);
  }

  private load(name: string): SessionFile {
    try {
      return JSON.parse(readFileSync(this.file(name), 'utf8')) as SessionFile;
    } catch {
      return {};
    }
  }

  private save(name: string, patch: SessionFile): void {
    try {
      const file = this.file(name);
      mkdirSync(join(stateDir(), 'sessions'), { recursive: true, mode: 0o700 });
      const tmp = `${file}.${process.pid}.tmp`;
      writeFileSync(tmp, JSON.stringify({ ...this.load(name), ...patch }), { mode: 0o600 });
      renameSync(tmp, file);
    } catch {
      // session persistence is best effort
    }
  }
}
