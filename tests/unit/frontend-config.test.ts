import { describe, expect, it } from 'vitest';
import { readConfig } from '../../frontend/src/config';

const page = (href: string, meta: Record<string, string> = {}) => {
  const url = new URL(href);
  const loc = { href, pathname: url.pathname, search: url.search, protocol: url.protocol } as Location;
  const doc = { querySelector: (sel: string) => {
    const name = /meta\[name="([^"]+)"\]/.exec(sel)?.[1];
    return name && name in meta ? { content: meta[name] } : null;
  } } as unknown as Document;
  return readConfig(loc, doc);
};

describe('viewer socket addresses', () => {
  const direct = 'ws://127.0.0.1:47428/c/b1/tok/ws';

  it('behind a proxy: the page-relative socket first, then the daemon\'s own', () => {
    expect(page('http://127.0.0.1:59068/?theme=dark', { 'whiteboard-canvas': 'b1', 'whiteboard-direct': direct })).toMatchObject({
      canvasId: 'b1',
      wsUrls: ['ws://127.0.0.1:59068/ws', direct],
      directPage: 'http://127.0.0.1:47428/c/b1/tok/?theme=dark',
    });
  });

  it('served by the daemon itself: one address, not the same one twice', () => {
    const own = page('http://127.0.0.1:47428/c/b1/tok/', { 'whiteboard-canvas': 'b1', 'whiteboard-direct': direct });
    expect(own.wsUrls).toEqual([direct]);
    expect(own.directPage).toBeUndefined();
  });

  it('without a direct address (a link with a wrong token, or the dev server): only the page-relative socket', () => {
    expect(page('http://127.0.0.1:5173/c/b1/tok/?theme=dark').wsUrls).toEqual(['ws://127.0.0.1:5173/c/b1/tok/ws']);
  });
});
