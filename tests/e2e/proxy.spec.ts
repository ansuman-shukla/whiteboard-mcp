import { createServer, request } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { Duplex } from 'node:stream';
import type { Page } from '@playwright/test';
import { api, drawRectangle, expect, sceneElements, shared, test, TOKEN, type Element } from './fixtures';

const DAEMON = { host: '127.0.0.1', port: 47500 };

/**
 * Like an editor's in-app browser preview (Devin's, for one): serves the board URL at its own root on
 * another port, prefixing every path with the board's, and passes the page's Origin through unchanged.
 */
async function mountingProxy(prefix: string): Promise<{ port: number; close: () => Promise<void>; dropSockets: () => void; refuseSockets: (on: boolean) => void }> {
  const headers = (raw: NodeJS.Dict<string | string[]>) => ({ ...raw, host: `${DAEMON.host}:${DAEMON.port}` });
  const upgraded = new Set<Duplex>();
  let refusing = false;
  const server = createServer((req, res) => {
    const up = request({ ...DAEMON, method: req.method, path: prefix + (req.url ?? '/').slice(1), headers: headers(req.headers) }, (r) => {
      res.writeHead(r.statusCode ?? 502, r.headers);
      r.pipe(res);
    });
    up.on('error', () => res.destroy());
    req.pipe(up);
  });
  server.on('upgrade', (req, socket, head) => {
    if (refusing) return void socket.end('HTTP/1.1 502 Bad Gateway\r\nContent-Length: 0\r\n\r\n');
    upgraded.add(socket);
    socket.on('close', () => upgraded.delete(socket));
    const up = request({ ...DAEMON, path: prefix + (req.url ?? '/').slice(1), headers: headers(req.headers) });
    up.on('upgrade', (r, upSocket, upHead) => {
      socket.write(`HTTP/1.1 101 Switching Protocols\r\n${Object.entries(r.headers).map(([k, v]) => `${k}: ${v}`).join('\r\n')}\r\n\r\n`);
      upSocket.write(head);
      socket.write(upHead);
      upSocket.pipe(socket).pipe(upSocket);
      socket.on('close', () => upSocket.destroy());
      upSocket.on('close', () => socket.destroy());
    });
    up.on('response', (r) => socket.end(`HTTP/1.1 ${r.statusCode} x\r\n\r\n`));
    up.on('error', () => socket.destroy());
    up.end();
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return {
    port: (server.address() as AddressInfo).port,
    dropSockets: () => {
      for (const socket of upgraded) socket.destroy();
    },
    refuseSockets: (on) => {
      refusing = on;
    },
    close: () => {
      for (const socket of upgraded) socket.destroy();
      server.closeAllConnections();
      return new Promise((resolve) => server.close(() => resolve()));
    },
  };
}

test('the viewer works behind a proxy that mounts the board URL at its own root', async ({ page, rest, canvasId }) => {
  const { buildElements } = await shared();
  await rest.post(api.elements(canvasId), { elements: buildElements([{ id: 'a', type: 'rectangle', x: 0, y: 0, width: 200, height: 80, label: 'Through the proxy' }], []).elements });
  const proxy = await mountingProxy(`/c/${canvasId}/${TOKEN}/`);
  try {
    await page.goto(`http://127.0.0.1:${proxy.port}/`);
    await expect(page.locator('.xl-status')).toHaveText('live');
    await expect.poll(async () => (await sceneElements(page)).map((e) => e.text).filter(Boolean)).toEqual(['Through the proxy']);
    await expect.poll(async () => (await rest.get(api.canvas(canvasId))).viewers).toBe(1);
  } finally {
    await proxy.close();
  }
});

/** Records every status the pill shows, across page loads (moving off a dead proxy is one). */
async function recordStatuses(page: Page): Promise<string[]> {
  const seen: string[] = [];
  await page.exposeBinding('reportStatus', (_source, status: string) => void seen.push(status));
  await page.addInitScript(() => {
    const report = (window as unknown as { reportStatus(s: string): void }).reportStatus;
    let last = '';
    new MutationObserver(() => {
      const now = document.querySelector('.xl-status')?.className ?? '';
      if (now && now !== last) report((last = now));
    }).observe(document, { subtree: true, childList: true, attributes: true });
  });
  return seen;
}

test.describe('a proxy that goes away', () => {
  // The browser reports the attempts made while offline or through the closed proxy, and the check that it is gone.
  test.use({ allowedErrors: /^(WebSocket connection to 'ws:\/\/127\.0\.0\.1:\d+\/[^']*' failed: .*|Failed to load resource: net::)ERR_(CONNECTION_REFUSED|INTERNET_DISCONNECTED)/ });

  test('the tab syncs straight with the daemon, keeps what changed on both sides, moves to its address and survives a reload', async ({ page, context, rest, canvasId }) => {
    test.setTimeout(45_000);
    const { buildElements } = await shared();
    await rest.post(api.elements(canvasId), { elements: buildElements([{ id: 'a', type: 'rectangle', x: 0, y: 0, width: 200, height: 80, label: 'Before' }], []).elements });
    const proxy = await mountingProxy(`/c/${canvasId}/${TOKEN}/`);
    const seen = await recordStatuses(page);
    await page.goto(`http://127.0.0.1:${proxy.port}/`);
    const status = page.locator('.xl-status');
    await expect(status).toHaveText('live');
    const texts = async () => (await sceneElements(page)).map((e) => e.text).filter(Boolean).sort();
    await expect.poll(texts).toEqual(['Before']);

    // Offline for a moment on both sides: an agent drawing reaches the daemon, a human drawing stays in the tab.
    await context.setOffline(true);
    await proxy.close();
    await expect(status).toHaveText('reconnecting…');
    await rest.post(api.elements(canvasId), { elements: buildElements([{ id: 'b', type: 'rectangle', x: 300, y: 0, width: 200, height: 80, label: 'After' }], []).elements });
    await drawRectangle(page, { x: 500, y: 500 }, { x: 640, y: 600 });
    await page.waitForTimeout(300);
    await context.setOffline(false);

    const direct = `http://127.0.0.1:47500/c/${canvasId}/${TOKEN}/`;
    await expect(page).toHaveURL(direct, { timeout: 15_000 });
    await expect(status).toHaveText('live');
    await expect.poll(texts, { timeout: 10_000 }).toEqual(['After', 'Before']);
    const rectangles = async () => (await rest.get(api.canvas(canvasId))).elements.filter((el: Element) => el.type === 'rectangle' && !el.isDeleted).length;
    await expect.poll(rectangles).toBe(3);

    await page.reload();
    await expect(status).toHaveText('live');
    await expect.poll(async () => (await sceneElements(page)).filter((e) => e.type === 'rectangle' && !e.isDeleted).length).toBe(3);
    await expect.poll(async () => (await rest.get(api.canvas(canvasId))).viewers).toBe(1);
    expect(seen.some((c) => c.includes('stopped'))).toBe(false);
  });
});

test.describe('a proxy that is still there', () => {
  test.use({ allowedErrors: /^WebSocket connection to 'ws:\/\/127\.0\.0\.1:\d+\/ws' failed: .*502/ });

  test('a socket that fails through a live proxy (a daemon swap) falls back, but the tab stays on the proxy', async ({ page, canvasId }) => {
    test.setTimeout(30_000);
    const proxy = await mountingProxy(`/c/${canvasId}/${TOKEN}/`);
    try {
      const url = `http://127.0.0.1:${proxy.port}/`;
      await page.goto(url);
      const status = page.locator('.xl-status');
      await expect(status).toHaveText('live');
      proxy.refuseSockets(true);
      proxy.dropSockets();
      await expect(status).toHaveText('reconnecting…');
      await expect(status).toHaveText('live', { timeout: 15_000 });
      await page.waitForTimeout(4000);
      expect(page.url()).toBe(url);
    } finally {
      await proxy.close();
    }
  });
});
