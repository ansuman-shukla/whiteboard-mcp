import net from 'node:net';

// Stands in for a sandbox (e.g. Codex's macOS seatbelt) that forbids listening on loopback.
net.Server.prototype.listen = function () {
  process.nextTick(() => this.emit('error', Object.assign(new Error('listen EPERM: operation not permitted 127.0.0.1'), { code: 'EPERM', syscall: 'listen' })));
  return this;
};

const { runDaemon } = await import('../../dist/canvas/daemon.js');
await runDaemon();
