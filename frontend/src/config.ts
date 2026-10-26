import { parseViewerPath } from '../../src/shared/protocol';

export type ThemePreference = 'light' | 'dark' | 'auto';

export interface ViewerConfig {
  canvasId: string;
  theme: ThemePreference;
  embed: boolean;
  wsUrl: string;
}

/**
 * The page is served at `/c/<id>/<token>/`, but a proxy may mount it at its own root, so the board comes
 * from the daemon's meta tag (the URL only in the dev server) and the socket from a URL relative to the page.
 */
export function readConfig(loc: Location = window.location, doc: Document = document): ViewerConfig {
  const canvasId = doc.querySelector<HTMLMetaElement>('meta[name="whiteboard-canvas"]')?.content || parseViewerPath(loc.pathname)?.canvasId || '';
  const params = new URLSearchParams(loc.search);
  const themeParam = params.get('theme');
  const theme: ThemePreference = themeParam === 'light' || themeParam === 'dark' ? themeParam : 'auto';
  const ws = new URL('ws', loc.href);
  ws.protocol = loc.protocol === 'https:' ? 'wss:' : 'ws:';
  ws.search = '';
  ws.hash = '';
  return { canvasId, theme, embed: params.get('embed') === '1', wsUrl: ws.href };
}

/** localStorage can throw (sandboxed iframes, disabled storage, WKWebView quirks). */
export const storage = {
  get(key: string): string | null {
    try {
      return window.localStorage.getItem(key);
    } catch {
      return null;
    }
  },
  set(key: string, value: string): void {
    try {
      window.localStorage.setItem(key, value);
    } catch {
      // storage unavailable; the setting just won't persist
    }
  },
};
