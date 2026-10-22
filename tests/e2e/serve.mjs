// Playwright webServer: a throwaway daemon on a fixed port with a known token.
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const home = mkdtempSync(join(tmpdir(), 'whiteboard-mcp-e2e-'));
process.env.WHITEBOARD_HOME = home;
const { startDaemon } = await import('../../dist/canvas/daemon.js');
const daemon = await startDaemon({ port: Number(process.env.E2E_PORT ?? 47500), dir: home, token: 'e2e-token', idleExitMs: 0 });

let stopping = false;
const stop = async () => {
  if (stopping) return;
  stopping = true;
  await daemon.close();
  rmSync(home, { recursive: true, force: true });
  process.exit(0);
};
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
