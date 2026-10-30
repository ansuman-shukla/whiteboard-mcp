import type { ClientMessage, ServerMessage } from '../../src/shared/protocol';
import { backoffDelay } from './sync';

export type LinkStatus = 'connecting' | 'live' | 'offline' | 'stopped';

/** Unreachable this long is no hiccup (a version swap takes well under a second): the daemon isn't running. */
export const STOPPED_AFTER_MS = 10_000;

export interface Connection {
  send(msg: ClientMessage): boolean;
  isOpen(): boolean;
  /** Reconnect immediately if currently waiting for a retry. */
  retryNow(): void;
  close(): void;
}

/**
 * One WebSocket at a time, reconnecting with jittered backoff until closed. An attempt that fails moves on to
 * the next address (the page's own proxy may be gone while the daemon runs on); one that connected is retried first.
 */
export function connect(urls: string[], onMessage: (msg: ServerMessage) => void, onStatus: (status: LinkStatus) => void): Connection {
  let ws: WebSocket | null = null;
  let current = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let attempt = 0;
  let closed = false;
  let stopped = false;
  let stoppedTimer: ReturnType<typeof setTimeout> | undefined;

  const detach = (s: WebSocket) => {
    s.onopen = s.onmessage = s.onerror = s.onclose = null;
  };
  const up = () => {
    clearTimeout(stoppedTimer);
    stoppedTimer = undefined;
    stopped = false;
    onStatus('live');
  };
  const down = () => {
    onStatus(stopped ? 'stopped' : 'offline');
    stoppedTimer ??= setTimeout(() => {
      stopped = true;
      onStatus('stopped');
    }, STOPPED_AFTER_MS);
  };
  const open = () => {
    clearTimeout(timer);
    timer = undefined;
    if (closed || ws) return;
    const s = new WebSocket(urls[current]!);
    ws = s;
    let opened = false;
    s.onopen = () => {
      opened = true;
      up();
    };
    s.onmessage = (e) => {
      if (typeof e.data !== 'string') return;
      let msg: ServerMessage;
      try {
        msg = JSON.parse(e.data) as ServerMessage;
      } catch {
        return;
      }
      // Reset only once the daemon really talks to us, so accept-then-close loops still back off.
      attempt = 0;
      onMessage(msg);
    };
    s.onclose = () => {
      detach(s);
      if (ws === s) ws = null;
      if (closed) return;
      if (!opened) current = (current + 1) % urls.length;
      down();
      timer = setTimeout(open, backoffDelay(attempt++));
    };
  };

  onStatus('connecting');
  open();
  return {
    send(msg) {
      if (ws?.readyState !== WebSocket.OPEN) return false;
      ws.send(JSON.stringify(msg));
      return true;
    },
    isOpen: () => ws?.readyState === WebSocket.OPEN,
    retryNow() {
      if (closed || ws) return;
      attempt = 0;
      open();
    },
    close() {
      closed = true;
      clearTimeout(timer);
      clearTimeout(stoppedTimer);
      const s = ws;
      if (!s) return;
      ws = null;
      detach(s);
      // Closing a CONNECTING socket logs a browser error; close it as soon as it opens instead.
      if (s.readyState === WebSocket.CONNECTING) s.onopen = () => s.close();
      else s.close();
    },
  };
}
