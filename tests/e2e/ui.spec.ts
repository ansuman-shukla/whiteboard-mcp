import { api, daemonSwitch, expect, openViewer, sceneElements, shared, test, untilStopped } from './fixtures';

// `.App-bottom-bar` is a full-height layout wrapper on narrow screens; its visible controls are matched individually.
const CONTROLS = ['.Island', '.mobile-misc-tools-container', '.main-menu-trigger', '.help-icon', '.default-sidebar-trigger', '.ToolIcon', '.zoom-actions', '.undo-redo-buttons'].join(',');

for (const [width, state] of [340, 400, 700, 1280].flatMap((w) => [[w, 'live'], [w, 'stopped']] as const)) {
  test(`status pill (${state}) stays on screen and does not overlap Excalidraw chrome at ${width}px`, async ({ page, rest, canvasId }) => {
    if (state === 'stopped') test.setTimeout(45_000);
    await page.setViewportSize({ width, height: 760 });
    const { buildElements } = await shared();
    await rest.post(api.elements(canvasId), { elements: buildElements([{ id: 'a', type: 'rectangle', x: 0, y: 0, width: 200, height: 80, label: 'Box' }], []).elements });
    const daemon = await daemonSwitch(page);
    await openViewer(page, canvasId);
    if (state === 'stopped') await untilStopped(page, daemon);
    await expect(page.locator('.xl-pill button[title="Note to agent"]')).toBeInViewport({ ratio: 1 });
    const pill = (await page.locator('.xl-pill').boundingBox())!;
    expect(pill.x).toBeGreaterThanOrEqual(0);
    expect(pill.y).toBeGreaterThanOrEqual(0);
    expect(pill.x + pill.width).toBeLessThanOrEqual(width);
    expect(pill.y + pill.height).toBeLessThanOrEqual(760);

    const boxes = await page.locator(CONTROLS).evaluateAll((els) =>
      els
        .filter((el) => !el.closest('.xl-pill-wrap') && getComputedStyle(el).visibility !== 'hidden')
        .map((el) => ({ name: el.className.toString().slice(0, 60), ...el.getBoundingClientRect().toJSON() }) as { name: string; x: number; y: number; width: number; height: number })
        .filter((r) => r.width > 0 && r.height > 0),
    );
    expect(boxes.length).toBeGreaterThan(3);
    const overlapping = boxes.filter((b) => b.x < pill.x + pill.width && pill.x < b.x + b.width && b.y < pill.y + pill.height && pill.y < b.y + b.height);
    expect(overlapping).toEqual([]);
  });
}

test('empty canvas shows the welcome hint; auto theme follows the system live', async ({ page, canvasId }) => {
  await page.emulateMedia({ colorScheme: 'dark' });
  await openViewer(page, canvasId);
  await expect(page.getByText('Your agent will draw here — you can draw too.')).toBeVisible();
  await expect(page.locator('.excalidraw.theme--dark')).toHaveCount(1);
  await page.emulateMedia({ colorScheme: 'light' });
  await expect(page.locator('.excalidraw.theme--dark')).toHaveCount(0);
});

test('theme query parameter wins over the system preference', async ({ page, canvasId }) => {
  await page.emulateMedia({ colorScheme: 'light' });
  await openViewer(page, canvasId, '?theme=dark');
  await expect(page.locator('.excalidraw.theme--dark')).toHaveCount(1);
});

test('follow mode brings far-away agent drawings into view; it can be turned off and stays off', async ({ page, rest, canvasId }) => {
  const { buildElements } = await shared();
  const post = (id: string, x: number) => rest.post(api.elements(canvasId), { elements: buildElements([{ id, type: 'rectangle', x, y: 0, width: 200, height: 80 }], []).elements });
  const inView = (id: string) =>
    page.evaluate((target) => {
      const api = window.__excalidrawAPI;
      const s = api.getAppState();
      const el = api.getSceneElements().find((e: { id: string }) => e.id === target);
      if (!el) return false;
      const x1 = -s.scrollX, y1 = -s.scrollY, x2 = x1 + s.width / s.zoom.value, y2 = y1 + s.height / s.zoom.value;
      return el.x >= x1 && el.y >= y1 && el.x + el.width <= x2 && el.y + el.height <= y2;
    }, id);

  await post('home', 0);
  await openViewer(page, canvasId);
  const follow = page.locator('.xl-btn[aria-pressed]');
  await expect(follow).toHaveAttribute('aria-pressed', 'true');

  await post('east', 6000);
  await expect.poll(() => sceneElements(page).then((els) => els.some((el) => el.id === 'east'))).toBe(true);
  await expect.poll(() => inView('east'), { timeout: 5000 }).toBe(true);

  await follow.click();
  await expect(follow).toHaveAttribute('aria-pressed', 'false');
  await page.mouse.move(5, 300);
  await page.waitForTimeout(3100);
  await post('west', -9000);
  await expect.poll(() => sceneElements(page).then((els) => els.some((el) => el.id === 'west'))).toBe(true);
  await page.waitForTimeout(1200);
  expect(await inView('west')).toBe(false);

  await page.reload();
  await expect(page.locator('.xl-status')).toHaveText('live');
  await expect(page.locator('.xl-btn[aria-pressed]')).toHaveAttribute('aria-pressed', 'false');
});
