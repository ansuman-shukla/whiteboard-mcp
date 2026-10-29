import { existsSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { join } from 'node:path';

// Stands in for an installed daemon of another version (FAKE_VERSION): holds the lock, advertises itself
// in daemon.json, answers /health, and on SIGTERM removes both files and exits, as every release does.
const home = process.env.WHITEBOARD_HOME;
const version = process.env.FAKE_VERSION;
const lock = join(home, 'daemon.lock');
const info = join(home, 'daemon.json');
const token = join(home, 'token');
if (!existsSync(token)) writeFileSync(token, 'ab'.repeat(32), { mode: 0o600 });
writeFileSync(lock, String(process.pid), { flag: 'wx', mode: 0o600 });

const server = createServer((req, res) => {
  const ok = req.url === '/health';
  res.writeHead(ok ? 200 : 404, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(ok ? { ok: true, app: 'whiteboard-mcp', version, pid: process.pid } : { error: 'not_found' }));
});
server.listen(Number(process.env.WHITEBOARD_PORT), '127.0.0.1', () => {
  writeFileSync(info, JSON.stringify({ pid: process.pid, port: server.address().port, startedAt: Date.now(), version }), { mode: 0o600 });
});
process.on('SIGTERM', () => {
  for (const file of [info, lock]) if (readFileSync(file, 'utf8').includes(String(process.pid))) unlinkSync(file);
  server.close(() => process.exit(0));
  server.closeAllConnections();
});
