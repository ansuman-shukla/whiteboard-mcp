import { mkdtempSync, rmSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, test, type Frame, type Page } from '@playwright/test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

/**
 * The board inline in an MCP Apps chat, end to end: a stand-in host page renders the ui:// resource in a
 * sandboxed iframe under the spec's default CSP and proxies the view's tool calls to a real
 * whiteboard-mcp server (with its own daemon), as MCP Apps hosts do.
 */
const repo = fileURLToPath(new URL('../..', import.meta.url));
const BOARD_URI = 'ui://whiteboard-mcp/board.html';
/** The MCP Apps spec's default policy when a resource declares no domains. */
const DEFAULT_CSP = "default-src 'none'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; media-src 'self' data:; connect-src 'none'";

type ToolResult = { content: Array<{ type: string; text?: string; data?: string }>; structuredContent?: Record<string, unknown>; isError?: boolean };

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.once('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address() as { port: number };
      srv.close(() => resolve(port));
    });
  });
}

/** Minimal MCP Apps host: handshake, the canvas_open result, and tools/call proxied to Node. */
const HOST_SCRIPT = `
window.sizes = [];
window.startHost = (html, toolResult) => {
  const frame = document.createElement('iframe');
  frame.id = 'app';
  frame.setAttribute('sandbox', 'allow-scripts');
  frame.style.cssText = 'display:block;width:960px;height:560px;border:0';
  const post = (msg) => frame.contentWindow.postMessage({ jsonrpc: '2.0', ...msg }, '*');
  window.addEventListener('message', async (e) => {
    if (e.source !== frame.contentWindow) return;
    const m = e.data;
    if (!m || m.jsonrpc !== '2.0' || !m.method) return;
    if (m.method === 'ui/initialize') {
      post({ id: m.id, result: { protocolVersion: '2026-01-26', hostInfo: { name: 'e2e-host', version: '1' }, hostCapabilities: { serverTools: {} }, hostContext: { theme: 'light', displayMode: 'inline', availableDisplayModes: ['inline', 'fullscreen'] } } });
    } else if (m.method === 'ui/notifications/initialized') {
      post({ method: 'ui/notifications/tool-input', params: { arguments: { title: 'Inline e2e' } } });
      post({ method: 'ui/notifications/tool-result', params: toolResult });
    } else if (m.method === 'ui/notifications/size-changed') {
      window.sizes.push(m.params);
    } else if (m.method === 'tools/call') {
      try { post({ id: m.id, result: await window.mcpCallTool(m.params) }); }
      catch (err) { post({ id: m.id, error: { code: -32000, message: String(err) } }); }
    } else if (m.id !== undefined) {
      post({ id: m.id, result: {} });
    }
  });
  frame.srcdoc = html;
  document.body.appendChild(frame);
};`;

let home: string;
let client: Client;
let html: string;

test.beforeAll(async () => {
  home = mkdtempSync(join(tmpdir(), 'whiteboard-mcp-inline-'));
  const env = { ...(process.env as Record<string, string>), WHITEBOARD_HOME: home, WHITEBOARD_PORT: String(await freePort()), WHITEBOARD_OPEN: 'none', WHITEBOARD_CHAT_ID: 'e2e-inline', WHITEBOARD_WORKSPACE: home };
  for (const key of ['WHITEBOARD_HOST_ID', 'WINDSURF_EXT_HOST_PID', 'WHITEBOARD_CHAT_COMMAND']) delete env[key];
  client = new Client({ name: 'e2e-host', version: '1' }, { capabilities: { extensions: { 'io.modelcontextprotocol/ui': { mimeTypes: ['text/html;profile=mcp-app'] } } } });
  await client.connect(new StdioClientTransport({ command: process.execPath, args: [join(repo, 'dist', 'cli.js')], env, stderr: 'ignore' }));
  const { contents } = await client.readResource({ uri: BOARD_URI });
  html = (contents[0] as { text: string }).text.replace('<head>', `<head><meta http-equiv="Content-Security-Policy" content="${DEFAULT_CSP}">`);
});

test.afterAll(async () => {
  await client?.close();
  try {
    const { pid } = JSON.parse((await import('node:fs')).readFileSync(join(home, 'daemon.json'), 'utf8')) as { pid: number };
    process.kill(pid, 'SIGTERM');
    await new Promise((r) => setTimeout(r, 500));
  } catch {
    // no daemon
  }
  rmSync(home, { recursive: true, force: true });
});

const call = async (name: string, args: Record<string, unknown> = {}) => (await client.callTool({ name, arguments: args })) as ToolResult;
const textOf = (r: ToolResult) => r.content.filter((c) => c.type === 'text').map((c) => c.text).join('\n');

async function openInline(page: Page, problems: string[]): Promise<Frame> {
  page.on('pageerror', (err) => problems.push(`page error: ${err.message}`));
  page.on('console', (msg) => {
    if (msg.type() === 'error') problems.push(`console error: ${msg.text()}`);
  });
  page.on('request', (req) => {
    if (!req.url().startsWith('data:') && !req.url().startsWith('about:')) problems.push(`request: ${req.url()}`);
  });
  const opened = await call('canvas_open', { title: 'Inline e2e' });
  expect(textOf(opened)).toContain('Shown inline in the chat.');
  await page.exposeFunction('mcpCallTool', (params: { name: string; arguments?: Record<string, unknown> }) => client.callTool(params));
  await page.setContent(`<!doctype html><html><body style="margin:0"><script>${HOST_SCRIPT}</script></body></html>`);
  await page.evaluate(([page, result]) => (window as unknown as { startHost(h: string, r: unknown): void }).startHost(page, result), [html, opened] as const);
  const frame = page.frameLocator('#app');
  await expect(frame.locator('.xl-status'), problems.join('\n')).toHaveText('live', { timeout: 20_000 });
  return page.frames().find((f) => f !== page.mainFrame())!;
}

const sceneIds = (frame: Frame) => frame.evaluate(() => (window as unknown as { __excalidrawAPI: { getSceneElements(): Array<{ id: string }> } }).__excalidrawAPI.getSceneElements().map((e) => e.id));

test('renders the live board inline, in sync both ways, with fonts, under the default CSP', async ({ page }) => {
  const problems: string[] = [];
  const frame = await openInline(page, problems);

  // The agent draws: it shows up in the inline board, label in Excalifont from the embedded bytes.
  await call('canvas_draw', { elements: [{ id: 'agent-box', type: 'rectangle', x: 0, y: 0, label: 'Drawn by the agent' }] });
  await expect.poll(() => sceneIds(frame)).toContain('agent-box');
  await expect
    .poll(() => frame.evaluate(() => [...document.fonts].some((f) => f.family.replace(/"/g, '') === 'Excalifont' && f.status === 'loaded')))
    .toBe(true);

  // The human draws in the inline board: the agent reads it.
  await frame.locator('label:has([data-testid="toolbar-rectangle"])').click();
  await page.mouse.move(600, 300);
  await page.mouse.down();
  await page.mouse.move(680, 350, { steps: 4 });
  await page.mouse.move(760, 420, { steps: 4 });
  await page.mouse.up();
  await expect.poll(async () => textOf(await call('canvas_read')), { timeout: 10_000 }).toMatch(/rectangle "[^"]+" \(600,300\)/);

  // Viewer requests round-trip through the relay: a screenshot rendered by the inline board.
  const shot = await call('canvas_screenshot');
  expect(shot.isError, textOf(shot)).toBeFalsy();
  expect(shot.content.some((c) => c.type === 'image' && (c.data?.length ?? 0) > 1000)).toBe(true);

  // A note from the human reaches the agent (the frame is sandboxed without allow-forms, like hosts').
  const app = page.frameLocator('#app');
  await app.getByTitle('Note to agent').click();
  await app.getByLabel('Note to agent').fill('looks good');
  await app.getByRole('button', { name: 'Send', exact: true }).click();
  await expect(app.locator('.xl-status')).toHaveText('sent to agent ✓');
  await expect.poll(async () => textOf(await call('canvas_read'))).toContain('looks good');

  expect(await page.evaluate(() => (window as unknown as { sizes: Array<{ height?: number }> }).sizes.at(-1)?.height)).toBe(560);
  expect(problems).toEqual([]);
});
