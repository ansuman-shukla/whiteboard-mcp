import { API } from '../../src/shared/protocol';

export type ThemePreference = 'light' | 'dark' | 'auto';

export interface ViewerConfig {
  canvasId: string;
  token: string;
  theme: ThemePreference;
  embed: boolean;
  wsUrl: string;
}

export function readConfig(loc: Location = window.location): ViewerConfig {
  const match = /^\/c\/([^/]+)\/?$/.exec(loc.pathname);
  const canvasId = match ? decodeURIComponent(match[1]!) : '';
  const params = new URLSearchParams(loc.search);
  const token = params.get('token') ?? '';
  const themeParam = params.get('theme');
  const theme: ThemePreference = themeParam === 'light' || themeParam === 'dark' ? themeParam : 'auto';
  const wsProto = loc.protocol === 'https:' ? 'wss:' : 'ws:';
  const wsUrl = `${wsProto}//${loc.host}${API.ws}?canvas=${encodeURIComponent(canvasId)}&token=${encodeURIComponent(token)}`;
  return { canvasId, token, theme, embed: params.get('embed') === '1', wsUrl };
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
