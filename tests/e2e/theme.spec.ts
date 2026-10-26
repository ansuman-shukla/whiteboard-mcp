import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Page } from '@playwright/test';
import { expect, test } from './fixtures';

// The theme pick is shared by every viewer of a daemon, so these tests get a daemon of their own
// instead of changing the theme under the other e2e tests running in parallel.
const TOKEN = 'theme-token';
let daemon: { url: string; close(): Promise<void> };
let dir: string;

test.beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'whiteboard-mcp-theme-'));
  // @ts-ignore -- compiled JS without declarations next to it in this project layout
  const { startDaemon } = await import('../../dist/canvas/daemon.js');
  daemon = await startDaemon({ port: 0, dir, token: TOKEN, idleExitMs: 0 });
});

test.afterEach(async () => {
  await daemon.close();
  rmSync(dir, { recursive: true, force: true });
});

async function open(page: Page, board: string, query = ''): Promise<void> {
  await page.goto(`${daemon.url}/c/${board}/${TOKEN}/${query}`);
  await expect(page.locator('.xl-status')).toHaveText('live');
}

async function pick(page: Page, choice: 'Light' | 'Dark' | 'System'): Promise<void> {
  await page.locator('.main-menu-trigger').click();
  await page.locator(`.RadioGroup__choice[title^="${choice}"]`).click();
  await page.keyboard.press('Escape');
}

const dark = (page: Page) => expect(page.locator('.excalidraw.theme--dark')).toHaveCount(1);
const light = (page: Page) => expect(page.locator('.excalidraw.theme--dark')).toHaveCount(0);
const saved = () => JSON.parse(readFileSync(join(dir, 'prefs.json'), 'utf8'));

test('a theme picked in one viewer applies to every board, live and after a reload, until System gives it back', async ({ page, context }) => {
  await page.emulateMedia({ colorScheme: 'light' });
  await open(page, 'board-a');
  await light(page);
  await pick(page, 'Dark');
  await dark(page);
  expect(saved()).toEqual({ theme: 'dark' });

  const other = await context.newPage();
  await other.emulateMedia({ colorScheme: 'light' });
  await open(other, 'board-b');
  await dark(other);

  await pick(other, 'Light');
  await light(page);
  await page.emulateMedia({ colorScheme: 'dark' });
  await light(page);

  await pick(other, 'System');
  await dark(page);
  await light(other);
  await page.reload();
  await expect(page.locator('.xl-status')).toHaveText('live');
  await dark(page);
  expect(saved()).toEqual({ theme: 'system' });
});

test('a pick wins over the editor theme in the link, and the keyboard shortcut is kept like a menu pick', async ({ page, context }) => {
  await page.emulateMedia({ colorScheme: 'dark' });
  await open(page, 'board-a', '?theme=dark');
  await dark(page);
  await pick(page, 'Light');
  await light(page);

  const other = await context.newPage();
  await open(other, 'board-b');
  await light(other);
  await page.locator('.excalidraw').click({ position: { x: 400, y: 300 } });
  await page.keyboard.press('Alt+Shift+KeyD');
  await dark(page);
  await dark(other);
  expect(saved()).toEqual({ theme: 'dark' });
});
