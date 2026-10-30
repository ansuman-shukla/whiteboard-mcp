import { createServer, request } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { Duplex } from 'node:stream';
import { api, expect, sceneElements, shared, test, TOKEN } from './fixtures';

const DAEMON = { host: '127.0.0.1', port: 47500 };

/**
 * Like an editor's in-app browser preview (Devin's, for one): serves the board URL at its own root on
 * another port, prefixing every path with the board's, and passes the page's Origin through unchanged.
 */
async function mountingProxy(prefix: string): Promise<{ port: number; close: () => Promise<void> }> {
  const headers = (raw: NodeJS.Dict<string | string[]>) => ({ ...raw, host: `${DAEMON.host}:${DAEMON.port}` });
  const upgraded = new Set<Duplex>();
  const server = createServer((req, res) => {
    const up = request({ ...DAEMON, method: req.method, path: prefix + (req.url ?? '/').slice(1), headers: headers(req.headers) }, (r) => {
      res.writeHead(r.statusCode ?? 502, r.headers);
      r.pipe(res);
    });
    up.on('error', () => res.destroy());
    req.pipe(up);
  });
  server.on('upgrade', (req, socket, head) => {
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

test.describe('a proxy that goes away', () => {
  // The browser reports the one attempt through the closed proxy before the viewer moves on.
  test.use({ allowedErrors: [/^WebSocket connection to 'ws:\/\/127\.0\.0\.1:\d+\/ws' failed: .*ERR_CONNECTION_REFUSED/] });

  test('the tab reconnects straight to the daemon, gets what changed meanwhile, and never says the server stopped', async ({ page, rest, canvasId }) => {
    test.setTimeout(45_000);
    const { buildElements } = await shared();
    await rest.post(api.elements(canvasId), { elements: buildElements([{ id: 'a', type: 'rectangle', x: 0, y: 0, width: 200, height: 80, label: 'Before' }], []).elements });
    const proxy = await mountingProxy(`/c/${canvasId}/${TOKEN}/`);
    await page.goto(`http://127.0.0.1:${proxy.port}/`);
    const status = page.locator('.xl-status');
    await expect(status).toHaveText('live');
    await page.evaluate(() => {
      const seen: string[] = ((window as unknown as { seen: string[] }).seen = []);
      new MutationObserver(() => seen.push(document.querySelector('.xl-status')?.className ?? '')).observe(document.body, { subtree: true, childList: true, characterData: true, attributes: true });
    });

    await proxy.close();
    await expect(status).toHaveText('reconnecting…');
    await rest.post(api.elements(canvasId), { elements: buildElements([{ id: 'b', type: 'rectangle', x: 300, y: 0, width: 200, height: 80, label: 'After' }], []).elements });
    await expect(status).toHaveText('live', { timeout: 15_000 });
    await expect.poll(async () => (await sceneElements(page)).map((e) => e.text).filter(Boolean).sort(), { timeout: 10_000 }).toEqual(['After', 'Before']);
    await expect.poll(async () => (await rest.get(api.canvas(canvasId))).viewers).toBe(1);
    await page.waitForTimeout(12_000);
    await expect(status).toHaveText('live');
    expect(await page.evaluate(() => (window as unknown as { seen: string[] }).seen.some((c) => c.includes('stopped')))).toBe(false);
  });
});
