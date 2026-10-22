import { api, expect, openViewer, sceneElements, shared, test, toViewport, type Element, type Rest } from './fixtures';

const box = (id: string, x: number, label: string) => ({ id, type: 'rectangle', x, y: 0, width: 200, height: 80, label });

async function seed(rest: Rest, canvasId: string, specs: unknown[]) {
  const { buildElements } = await shared();
  await rest.post(api.elements(canvasId), { elements: buildElements(specs, []).elements });
}

test('screenshot returns a PNG (all or some elements) and reports an empty canvas', async ({ page, rest, canvasId }) => {
  await openViewer(page, canvasId);
  const empty = await rest.post(api.request(canvasId), { type: 'screenshot', payload: {} }, 502);
  expect(empty.error).toBe('canvas is empty');

  await seed(rest, canvasId, [box('a', 0, 'Alpha'), box('b', 600, 'Beta')]);
  await expect.poll(async () => (await sceneElements(page)).length).toBe(4);

  const png = async (payload: unknown) => {
    const { result } = await rest.post(api.request(canvasId), { type: 'screenshot', payload });
    expect(result.mimeType).toBe('image/png');
    expect(result.base64).not.toMatch(/^data:/);
    const buf = Buffer.from(result.base64, 'base64');
    expect(buf.subarray(0, 8).toString('hex')).toBe('89504e470d0a1a0a');
    expect(buf.subarray(12, 16).toString('ascii')).toBe('IHDR');
    expect({ width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) }).toEqual({ width: result.width, height: result.height });
    return result as { width: number; height: number };
  };
  const all = await png({ dark: true });
  expect(Math.max(all.width, all.height)).toBeLessThanOrEqual(1600);
  expect(all.width).toBeGreaterThan(all.height);
  const one = await png({ ids: ['a'] });
  expect(one.width).toBeLessThan(all.width);
  const scaled = await png({ ids: ['a'], scale: 1 });
  expect(scaled.width).toBe(200 + 2 * 24);

  const missing = await rest.post(api.request(canvasId), { type: 'screenshot', payload: { ids: ['nope'] } }, 502);
  expect(missing.error).toMatch(/none of the requested elements/);
});

test('mermaid appends a diagram right of existing content as the agent and returns its ids', async ({ page, rest, canvasId }) => {
  await seed(rest, canvasId, [box('existing', 0, 'Existing')]);
  await openViewer(page, canvasId);
  await expect.poll(async () => (await sceneElements(page)).length).toBe(2);

  const { result } = await rest.post(api.request(canvasId), { type: 'mermaid', payload: { definition: 'flowchart LR\n  A[Start] --> B[Done]' }, timeoutMs: 30_000 });
  const ids: string[] = result.ids;
  expect(ids.length).toBeGreaterThanOrEqual(3);

  const scene = await sceneElements(page);
  expect(scene.map((el) => el.id)).toEqual(expect.arrayContaining(['existing', 'existing-label', ...ids]));
  const added = scene.filter((el) => ids.includes(el.id));
  expect(Math.min(...added.map((el) => el.x))).toBeGreaterThanOrEqual(200 + 80 - 1);
  expect(added.some((el) => el.type === 'text' && el.text === 'Start')).toBe(true);

  await expect.poll(async () => (await rest.get(api.canvas(canvasId))).elements.map((el: Element) => el.id)).toEqual(expect.arrayContaining(['existing', ...ids]));
  const ch = await rest.get(api.changes(canvasId, 1));
  expect(ch.changes.length).toBeGreaterThan(0);
  expect(ch.changes.every((c: { actor: string; kind: string }) => c.actor === 'agent' && c.kind === 'created')).toBe(true);

  const placed = await rest.post(api.request(canvasId), { type: 'mermaid', payload: { definition: 'flowchart TD\n  X --> Y', x: -1000, y: 500 } });
  const placedEls = (await sceneElements(page)).filter((el) => placed.result.ids.includes(el.id));
  expect(Math.round(Math.min(...placedEls.map((el) => el.x)))).toBe(-1000);
  expect(Math.round(Math.min(...placedEls.map((el) => el.y)))).toBe(500);

  const bad = await rest.post(api.request(canvasId), { type: 'mermaid', payload: { definition: 'this is not mermaid at all' } }, 502);
  expect(typeof bad.error).toBe('string');
  expect(bad.error).not.toBe('viewer_error');
  expect((await sceneElements(page)).length).toBe(2 + ids.length + placed.result.ids.length);
});

test('focus scrolls to elements and pulses a transient highlight overlay', async ({ page, rest, canvasId }) => {
  await seed(rest, canvasId, [box('a', 0, 'Here'), box('far', 4000, 'Far away')]);
  await openViewer(page, canvasId);
  await expect.poll(async () => (await sceneElements(page)).length).toBe(4);

  const res = await rest.post(api.request(canvasId), { type: 'focus', payload: { ids: ['far'], highlight: true } });
  expect(res.result).toEqual({ ok: true });
  const rect = page.locator('.xl-highlight rect');
  await expect(rect).toHaveCount(1);
  await page.waitForTimeout(700);
  const far = (await sceneElements(page)).find((el) => el.id === 'far')!;
  const tl = await toViewport(page, far.x, far.y);
  const br = await toViewport(page, far.x + far.width, far.y + far.height);
  const hb = (await rect.boundingBox())!;
  expect(hb.x).toBeLessThan(tl.x);
  expect(hb.y).toBeLessThan(tl.y);
  expect(hb.x + hb.width).toBeGreaterThan(br.x);
  expect(hb.y + hb.height).toBeGreaterThan(br.y);
  expect(tl.x).toBeGreaterThan(0);
  expect(br.x).toBeLessThan(page.viewportSize()!.width);
  await expect(page.locator('.xl-highlight')).toHaveCount(0, { timeout: 5000 });
  // Never part of the scene.
  expect((await sceneElements(page)).length).toBe(4);

  const zoomed = await rest.post(api.request(canvasId), { type: 'focus', payload: { zoom: 0.5 } });
  expect(zoomed.result).toEqual({ ok: true });
  await expect.poll(() => page.evaluate(() => window.__excalidrawAPI.getAppState().zoom.value)).toBeCloseTo(0.5, 2);

  const missing = await rest.post(api.request(canvasId), { type: 'focus', payload: { ids: ['nope'] } }, 502);
  expect(missing.error).toMatch(/none of the requested elements/);
});

test('a note typed in the viewer reaches the agent', async ({ page, rest, canvasId }) => {
  await openViewer(page, canvasId);
  await page.getByTitle('Note to agent').click();
  const field = page.getByLabel('Note to agent');
  await field.fill('Please make the database box bigger');
  await field.press('Control+Enter');
  await expect(page.locator('.xl-status')).toHaveText('sent to agent ✓');
  await expect(field).toHaveCount(0);
  await expect
    .poll(async () => (await rest.get(api.changes(canvasId))).notes.map((n: { text: string }) => n.text))
    .toContain('Please make the database box bigger');
  await expect(page.locator('.xl-status')).toHaveText('live', { timeout: 5000 });
});
