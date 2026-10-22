import type { WebSocketRoute } from '@playwright/test';
import { api, drawRectangle, expect, openViewer, sceneElements, shared, test, toViewport, type Element } from './fixtures';

const box = (id: string, x: number, label: string, extra: Record<string, unknown> = {}) => ({ id, type: 'rectangle', x, y: 0, width: 200, height: 80, label, ...extra });
const ids = async (page: Parameters<typeof sceneElements>[0]) => (await sceneElements(page)).map((el) => el.id);

test('agent elements posted over REST appear live with labels, and are not echoed back', async ({ page, rest, canvasId }) => {
  await openViewer(page, canvasId);
  const { buildElements } = await shared();
  const { elements } = buildElements([box('a', 0, 'Hello agent'), box('b', 320, 'Second'), { id: 'ab', type: 'arrow', from: 'a', to: 'b' }], []);
  const applied = await rest.post(api.elements(canvasId), { elements, actor: 'agent' });

  await expect.poll(() => ids(page)).toEqual(expect.arrayContaining(['a', 'b', 'ab']));
  const scene = await sceneElements(page);
  const a = scene.find((el) => el.id === 'a')!;
  const label = scene.find((el) => el.type === 'text' && el.containerId === 'a')!;
  expect(label.text).toBe('Hello agent');
  expect(label.width).toBeGreaterThan(20);
  // Re-measured with the real font and still centred in its container.
  expect(Math.abs(label.x + label.width / 2 - (a.x + a.width / 2))).toBeLessThan(2);
  expect(Math.abs(label.y + label.height / 2 - (a.y + a.height / 2))).toBeLessThan(2);

  await page.waitForTimeout(500);
  const changes = await rest.get(api.changes(canvasId));
  expect(changes.rev).toBe(applied.rev);
  expect(changes.changes.every((c: { actor: string }) => c.actor === 'agent')).toBe(true);
});

test('a mouse-drawn rectangle reaches the server as a human change', async ({ page, rest, canvasId }) => {
  await openViewer(page, canvasId);
  await drawRectangle(page, { x: 420, y: 300 }, { x: 580, y: 400 });

  await expect
    .poll(async () => {
      const ch = await rest.get(api.changes(canvasId));
      return ch.changes.filter((c: { actor: string; kind: string }) => c.actor === 'human' && c.kind === 'created').map((c: { id: string }) => ch.elements.find((el: Element) => el.id === c.id)?.type);
    })
    .toContain('rectangle');
  await expect
    .poll(async () => {
      const snap = await rest.get(api.canvas(canvasId));
      return Math.round(snap.elements.find((el: Element) => el.type === 'rectangle')?.width ?? 0);
    })
    .toBeGreaterThan(140);
});

test('agent delete removes elements from the scene; human delete tombstones them on the server', async ({ page, rest, canvasId }) => {
  const { buildElements, deleteElements } = await shared();
  const built = buildElements([box('keep', 0, 'Keep', { backgroundColor: '#a5d8ff', fillStyle: 'solid' }), box('gone', 320, 'Gone')], []);
  await rest.post(api.elements(canvasId), { elements: built.elements });
  await openViewer(page, canvasId);
  await expect.poll(() => ids(page)).toEqual(expect.arrayContaining(['keep', 'gone']));

  const snap = await rest.get(api.canvas(canvasId));
  await rest.post(api.elements(canvasId), { elements: deleteElements(['gone'], snap.elements).elements, actor: 'agent' });
  await expect.poll(async () => (await sceneElements(page)).filter((el) => el.id === 'gone' || el.containerId === 'gone').length).toBe(0);
  expect(await ids(page)).toContain('keep');

  const keep = (await sceneElements(page)).find((el) => el.id === 'keep')!;
  const p = await toViewport(page, keep.x + 15, keep.y + 15);
  await page.mouse.click(p.x, p.y);
  await expect.poll(() => page.evaluate(() => Object.keys(window.__excalidrawAPI.getAppState().selectedElementIds))).toContain('keep');
  await page.keyboard.press('Delete');

  await expect
    .poll(async () => {
      const ch = await rest.get(api.changes(canvasId));
      return ch.changes.some((c: { id: string; kind: string; actor: string }) => c.id === 'keep' && c.kind === 'deleted' && c.actor === 'human');
    })
    .toBe(true);
  const after = await rest.get(api.canvas(canvasId));
  expect(after.elements.map((el: Element) => el.id)).not.toContain('keep');
  expect(await ids(page)).not.toContain('keep');
});

test('two viewers stay in sync both ways', async ({ page, context, rest, canvasId }) => {
  const other = await context.newPage();
  await openViewer(page, canvasId);
  await openViewer(other, canvasId);
  await expect(page.locator('.xl-viewers')).toHaveText('2');
  await expect(other.locator('.xl-viewers')).toHaveText('2');

  await drawRectangle(page, { x: 300, y: 250 }, { x: 420, y: 330 });
  await expect.poll(async () => (await sceneElements(other)).filter((el) => el.type === 'rectangle').length).toBe(1);

  await drawRectangle(other, { x: 600, y: 250 }, { x: 720, y: 330 });
  await expect.poll(async () => (await sceneElements(page)).filter((el) => el.type === 'rectangle').length).toBe(2);
  await expect.poll(async () => (await rest.get(api.canvas(canvasId))).elements.length).toBe(2);

  // Converged: both replicas hold identical versions.
  const stamp = async (p: typeof page) => (await sceneElements(p)).map((el) => `${el.id}@${el.version}`).sort();
  await expect.poll(async () => JSON.stringify(await stamp(page))).toBe(JSON.stringify(await stamp(other)));

  await other.close();
  await expect(page.locator('.xl-viewers')).toHaveCount(0);
});

test('a dropped socket reconnects and resyncs edits made on both sides meanwhile', async ({ page, rest, canvasId }) => {
  let blocked = false;
  const live: { client: WebSocketRoute; server: WebSocketRoute }[] = [];
  await page.routeWebSocket(/\/ws\?/, (client) => {
    if (blocked) return void client.close();
    live.push({ client, server: client.connectToServer() });
  });
  await openViewer(page, canvasId);

  blocked = true;
  for (const { client, server } of live.splice(0)) {
    await server.close();
    await client.close();
  }
  await expect(page.locator('.xl-status')).toHaveText('reconnecting…');

  const { buildElements } = await shared();
  await rest.post(api.elements(canvasId), { elements: buildElements([box('while-away', 0, 'While away')], []).elements });
  await drawRectangle(page, { x: 500, y: 420 }, { x: 640, y: 520 });
  await page.waitForTimeout(300);

  blocked = false;
  await expect(page.locator('.xl-status')).toHaveText('live', { timeout: 20_000 });
  await expect.poll(() => ids(page)).toContain('while-away');
  await expect
    .poll(async () => (await rest.get(api.canvas(canvasId))).elements.filter((el: Element) => el.type === 'rectangle').length)
    .toBe(2);
  const ch = await rest.get(api.changes(canvasId));
  expect(ch.changes.some((c: { actor: string; kind: string }) => c.actor === 'human' && c.kind === 'created')).toBe(true);
});
