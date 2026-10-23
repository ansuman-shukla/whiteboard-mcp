'use strict';
// Panel host: the whiteboard daemon asks this window to show a chat's board beside the chat.

const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');

const RECONNECT_MS = 3000;
const CONNECT_TIMEOUT_MS = 5000;
const HTTP_TIMEOUT_MS = 5000;
const OPEN = 1;

/** The daemon's state folder: the setting, else WHITEBOARD_HOME, else ~/.whiteboard-mcp. */
function whiteboardHome(configured, env = process.env) {
  const value = configured || env.WHITEBOARD_HOME || path.join(os.homedir(), '.whiteboard-mcp');
  return value.startsWith('~') ? path.join(os.homedir(), value.slice(1)) : value;
}

function insideFolder(folder, file) {
  const relative = path.relative(folder, file);
  return relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

class WhiteboardHost {
  /**
   * `hostId` names this window for the daemon, which shows a chat's board in the window whose id the
   * chat's agent sends (WHITEBOARD_HOST_ID), else in a window showing the board's folder.
   * @param {{ home: string, hostId: string, folders: () => string[], focused: () => boolean,
   *           onShow: (board: { canvasId: string, url: string, title: string }) => Promise<void> | void,
   *           WebSocketImpl?: typeof WebSocket, fetchImpl?: typeof fetch, readFile?: (file: string) => Promise<string>,
   *           reconnectMs?: number, connectTimeoutMs?: number }} options
   */
  constructor({ home, hostId, folders, focused, onShow, WebSocketImpl = globalThis.WebSocket, fetchImpl = globalThis.fetch, readFile = (file) => fs.readFile(file, 'utf8'), reconnectMs = RECONNECT_MS, connectTimeoutMs = CONNECT_TIMEOUT_MS }) {
    Object.assign(this, { home, hostId, folders, focused, onShow, WebSocketImpl, fetchImpl, readFile, reconnectMs, connectTimeoutMs });
    this.socket = null;
    this.daemon = null;
    this.retryTimer = null;
    this.connecting = false;
    this.disposed = false;
  }

  start() {
    void this.connect();
  }

  /** Where the daemon listens and its token, or null while it isn't running. */
  async locate() {
    try {
      const { port } = JSON.parse(await this.readFile(path.join(this.home, 'daemon.json')));
      const token = (await this.readFile(path.join(this.home, 'token'))).trim();
      return Number.isInteger(port) && token ? { base: `http://127.0.0.1:${port}`, token } : null;
    } catch {
      return null;
    }
  }

  async connect() {
    if (this.disposed || this.socket || this.connecting) return;
    this.connecting = true;
    const daemon = await this.locate().finally(() => (this.connecting = false));
    if (this.disposed || this.socket) return;
    if (!daemon) return this.retry();
    const socket = new this.WebSocketImpl(`${daemon.base.replace('http:', 'ws:')}/ws/host?token=${encodeURIComponent(daemon.token)}`);
    this.socket = socket;
    this.daemon = daemon;
    // A port that accepts but never answers must not leave the window without a host forever.
    const openTimer = setTimeout(() => socket.close(), this.connectTimeoutMs);
    socket.addEventListener('open', () => {
      clearTimeout(openTimer);
      this.send({ t: 'hello', hostId: this.hostId, folders: this.folders(), focused: this.focused() });
    });
    socket.addEventListener('message', (event) => void this.receive(socket, event.data));
    socket.addEventListener('close', () => {
      clearTimeout(openTimer);
      if (this.socket !== socket) return;
      this.socket = null;
      this.retry();
    });
    socket.addEventListener('error', () => {});
  }

  retry() {
    if (this.disposed || this.retryTimer) return;
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null;
      void this.connect();
    }, this.reconnectMs);
  }

  send(message) {
    if (this.socket?.readyState === OPEN) this.socket.send(JSON.stringify(message));
  }

  /** Call when the window's folders or focus change. */
  update() {
    this.send({ t: 'state', folders: this.folders(), focused: this.focused() });
  }

  async receive(socket, data) {
    if (socket !== this.socket) return;
    let message;
    try {
      message = JSON.parse(String(data));
    } catch {
      return;
    }
    if (message?.t !== 'show' || typeof message.reqId !== 'string' || typeof message.canvasId !== 'string') return;
    try {
      await this.onShow({ canvasId: message.canvasId, url: this.viewerUrl(message.canvasId), title: String(message.title ?? '') });
      this.send({ t: 'shown', reqId: message.reqId, ok: true });
    } catch (error) {
      this.send({ t: 'shown', reqId: message.reqId, ok: false, error: String(error?.message ?? error) });
    }
  }

  viewerUrl(canvasId) {
    return `${this.daemon.base}/c/${encodeURIComponent(canvasId)}?token=${encodeURIComponent(this.daemon.token)}`;
  }

  /** Boards of this window's folders, newest first; empty while the daemon isn't running. */
  async boards() {
    const daemon = this.daemon ?? (await this.locate());
    if (!daemon) return [];
    this.daemon = daemon;
    const response = await this.fetchImpl(`${daemon.base}/api/canvases`, {
      headers: { Authorization: `Bearer ${daemon.token}` },
      signal: AbortSignal.timeout(HTTP_TIMEOUT_MS),
    });
    if (!response.ok) return [];
    const folders = this.folders();
    const ours = (board) => typeof board.workspace === 'string' && folders.some((folder) => insideFolder(folder, board.workspace));
    return (await response.json()).filter(ours).sort((a, b) => b.updatedAt - a.updatedAt);
  }

  dispose() {
    this.disposed = true;
    clearTimeout(this.retryTimer);
    this.retryTimer = null;
    const socket = this.socket;
    this.socket = null;
    socket?.close();
  }
}

module.exports = { WhiteboardHost, whiteboardHome };
