import { VIEWER_META, parseViewerPath } from '../../src/shared/protocol';

export type ThemePreference = 'light' | 'dark' | 'auto';

export interface ViewerConfig {
  canvasId: string;
  theme: ThemePreference;
  embed: boolean;
  /** Socket addresses in the order to try: next to the page, then the daemon's own (a proxy in front of the page can go away). */
  wsUrls: string[];
  /** The daemon's own address for this page, when the page reached it through a proxy. */
  directPage?: string;
}

/**
 * The page is served at `/c/<id>/<token>/`, but a proxy may mount it at its own root, so the board comes
 * from the daemon's meta tag (the URL only in the dev server) and the socket from a URL relative to the page.
 */
export function readConfig(loc: Location = window.location, doc: Document = document): ViewerConfig {
  const meta = (name: string) => doc.querySelector<HTMLMetaElement>(`meta[name="${name}"]`)?.content;
  const canvasId = meta(VIEWER_META.canvas) || parseViewerPath(loc.pathname)?.canvasId || '';
  const params = new URLSearchParams(loc.search);
  const themeParam = params.get('theme');
  const theme: ThemePreference = themeParam === 'light' || themeParam === 'dark' ? themeParam : 'auto';
  const ws = new URL('ws', loc.href);
  ws.protocol = loc.protocol === 'https:' ? 'wss:' : 'ws:';
  ws.search = '';
  ws.hash = '';
  const direct = meta(VIEWER_META.direct);
  const proxied = !!direct && direct !== ws.href;
  return {
    canvasId,
    theme,
    embed: params.get('embed') === '1',
    wsUrls: proxied ? [ws.href, direct] : [ws.href],
    ...(proxied ? { directPage: `${direct.replace(/^ws:/, 'http:').replace(/ws$/, '')}${loc.search}` } : {}),
  };
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
