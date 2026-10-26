import { test as base, expect, type Page } from '@playwright/test';

declare global {
  interface Window {
    // Exposed by the viewer for tests (an ExcalidrawImperativeAPI).
    __excalidrawAPI?: any;
  }
}

export const TOKEN = 'e2e-token';
const LOCAL_HOSTS = new Set(['127.0.0.1', 'localhost']);

export interface Element {
  id: string;
  type: string;
  x: number;
  y: number;
  width: number;
  height: number;
  version: number;
  isDeleted: boolean;
  text?: string;
  containerId?: string | null;
  [key: string]: unknown;
}

export interface Rest {
  get<T = any>(path: string): Promise<T>;
  post<T = any>(path: string, body: unknown, expectStatus?: number): Promise<T>;
}

/** Every test gets a fresh canvas id, a REST client, and fails on console errors or non-local requests. */
export const test = base.extend<{ canvasId: string; rest: Rest; guard: void }>({
  canvasId: async ({}, use, info) => {
    await use(`e2e-${info.workerIndex}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`);
  },
  rest: async ({ request }, use) => {
    const headers = { Authorization: `Bearer ${TOKEN}` };
    await use({
      async get(path) {
        const res = await request.get(path, { headers });
        expect(res.status(), `GET ${path}`).toBe(200);
        return res.json();
      },
      async post(path, body, expectStatus = 200) {
        const res = await request.post(path, { headers, data: body, timeout: 40_000 });
        expect(res.status(), `POST ${path}: ${await res.text()}`).toBe(expectStatus);
        return res.json();
      },
    });
  },
  guard: [
    async ({ context }, use) => {
      const problems: string[] = [];
      const watch = (page: Page) => {
        page.on('console', (msg) => {
          if (msg.type() === 'error') problems.push(`console error: ${msg.text()}`);
        });
        page.on('pageerror', (err) => problems.push(`page error: ${err.message}`));
      };
      context.pages().forEach(watch);
      context.on('page', watch);
      context.on('request', (req) => {
        const url = new URL(req.url());
        if (/^(https?|wss?):$/.test(url.protocol) && !LOCAL_HOSTS.has(url.hostname)) problems.push(`external request: ${req.url()}`);
      });
      await use();
      expect(problems).toEqual([]);
    },
    { auto: true },
  ],
});

export { expect };

export const api = {
  elements: (id: string) => `/api/canvases/${id}/elements`,
  canvas: (id: string) => `/api/canvases/${id}`,
  changes: (id: string, since = 0) => `/api/canvases/${id}/changes?since=${since}`,
  request: (id: string) => `/api/canvases/${id}/request`,
};

/** Element builders from the compiled server (loaded lazily: dist/ is built by the webServer). */
export async function shared() {
  // @ts-ignore -- compiled JS without declarations next to it in this project layout
  return (await import('../../dist/shared/elements.js')) as {
    buildElements(specs: unknown[], scene: unknown[]): { elements: Element[]; ids: string[] };
    deleteElements(ids: string[], scene: unknown[]): { elements: Element[]; ids: string[] };
  };
}

export async function openViewer(page: Page, canvasId: string, query = ''): Promise<void> {
  await page.goto(`/c/${canvasId}/${TOKEN}/${query}`);
  await page.waitForFunction(() => !!window.__excalidrawAPI);
  await expect(page.locator('.xl-status')).toHaveText('live');
}

export function sceneElements(page: Page): Promise<Element[]> {
  return page.evaluate(() => window.__excalidrawAPI!.getSceneElements().map((el) => ({ ...el }) as unknown as Element));
}

/** Viewport coordinates of a scene point. */
export function toViewport(page: Page, sceneX: number, sceneY: number): Promise<{ x: number; y: number }> {
  return page.evaluate(([sx, sy]) => {
    const s = window.__excalidrawAPI!.getAppState();
    return { x: (sx! + s.scrollX) * s.zoom.value + s.offsetLeft, y: (sy! + s.scrollY) * s.zoom.value + s.offsetTop };
  }, [sceneX, sceneY]);
}

export async function drawRectangle(page: Page, from: { x: number; y: number }, to: { x: number; y: number }): Promise<void> {
  // The radio input is visually hidden under its icon; users click the label.
  await page.locator('label:has([data-testid="toolbar-rectangle"])').click();
  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  await page.mouse.move((from.x + to.x) / 2, (from.y + to.y) / 2, { steps: 4 });
  await page.mouse.move(to.x, to.y, { steps: 4 });
  await page.mouse.up();
}
