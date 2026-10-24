import type { ClientMessage, ServerMessage } from '../../src/shared/protocol';
import { backoffDelay } from './sync';

export type LinkStatus = 'connecting' | 'live' | 'offline';

/** Opens the viewer's link to the daemon: a WebSocket, or the MCP Apps relay when shown inline in a chat. */
export type OpenLink = (onMessage: (msg: ServerMessage) => void, onStatus: (status: LinkStatus) => void) => Connection;

export interface Connection {
  send(msg: ClientMessage): boolean;
  isOpen(): boolean;
  /** Reconnect immediately if currently waiting for a retry. */
  retryNow(): void;
  close(): void;
}

/** One WebSocket at a time, reconnecting with jittered backoff until closed. */
export function connect(url: string, onMessage: (msg: ServerMessage) => void, onStatus: (status: LinkStatus) => void): Connection {
  let ws: WebSocket | null = null;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let attempt = 0;
  let closed = false;

  const detach = (s: WebSocket) => {
    s.onopen = s.onmessage = s.onerror = s.onclose = null;
  };
  const open = () => {
    clearTimeout(timer);
    timer = undefined;
    if (closed || ws) return;
    const s = new WebSocket(url);
    ws = s;
    s.onopen = () => onStatus('live');
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
      onStatus('offline');
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
