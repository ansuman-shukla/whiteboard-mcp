// Soak test: run with `node --expose-gc tests/perf/soak.mjs` after `npm run build:server`.
// Drives the real daemon with REST edits, WebSocket churn and viewer requests,
// then checks that retained heap stops growing and all per-connection state is released.
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import WebSocket from 'ws';
import { startDaemon } from '../../dist/canvas/daemon.js';

if (typeof globalThis.gc !== 'function') throw new Error('run with node --expose-gc');

const ROUNDS = Number(process.env.SOAK_ROUNDS ?? 8);
const dir = mkdtempSync(join(tmpdir(), 'exl-soak-'));
const d = await startDaemon({ port: 0, dir, token: 'soak', idleExitMs: 0, heartbeatMs: 60_000 });
const auth = { Authorization: 'Bearer soak', 'Content-Type': 'application/json' };
const canvas = 'soak';
let version = 1;

const el = (i, v) => ({ id: `e${i}`, type: 'rectangle', x: i * 10, y: v % 500, width: 100, height: 50, version: v, versionNonce: (i * 7919 + v) % 100000, isDeleted: false, updated: Date.now(), label: 'x'.repeat(40) });

async function post(path, body) {
  const res = await fetch(`${d.url}${path}`, { method: 'POST', headers: auth, body: JSON.stringify(body) });
  await res.arrayBuffer();
  if (res.status !== 200) throw new Error(`${path} -> ${res.status}`);
  posts++;
}
let posts = 0;

function viewer() {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`${d.url.replace('http', 'ws')}/ws?canvas=${canvas}&token=soak`);
    ws.once('message', () => resolve(ws));
    ws.once('error', reject);
  });
}

async function round() {
  for (let n = 0; n < 300; n++) {
    version++;
    await post(`/api/canvases/${canvas}/elements`, { elements: Array.from({ length: 20 }, (_, i) => el((n * 20 + i) % 200, version)) });
  }
  for (let n = 0; n < 50; n++) {
    const a = await viewer();
    const b = await viewer();
    a.send(JSON.stringify({ t: 'elements', elements: [el(n, ++version)] }));
    a.send(JSON.stringify({ t: 'note', text: `note ${n}` }));
    const req = fetch(`${d.url}/api/canvases/${canvas}/request`, { method: 'POST', headers: auth, body: JSON.stringify({ type: 'focus', payload: {}, timeoutMs: 1000 }) });
    const target = await Promise.race([
      new Promise((r) => a.once('message', (m) => r([a, m]))),
      new Promise((r) => b.once('message', (m) => r([b, m]))),
    ]);
    void target;
    a.terminate();
    b.terminate();
    await (await req).arrayBuffer();
  }
  await post(`/api/canvases/${canvas}/notes`, { text: 'tail' });
}

const heap = () => {
  globalThis.gc();
  globalThis.gc();
  return process.memoryUsage().heapUsed / 1024 / 1024;
};

await round();
const baseline = heap();
const samples = [];
for (let r = 1; r < ROUNDS; r++) {
  await round();
  await new Promise((res) => setTimeout(res, 50));
  samples.push(heap());
}
const stats = d.stats();
const snap = await (await fetch(`${d.url}/api/canvases/${canvas}`, { headers: auth })).json();
const scene = { rev: snap.rev, elements: snap.elements.length, notes: snap.notes.length, posts };
await d.close();
rmSync(dir, { recursive: true, force: true });

const growth = samples.at(-1) - baseline;
const lateGrowth = samples.at(-1) - samples[Math.floor(samples.length / 2)];
console.log(JSON.stringify({ baselineMB: baseline.toFixed(1), samplesMB: samples.map((s) => s.toFixed(1)), growthMB: growth.toFixed(2), lateGrowthMB: lateGrowth.toFixed(2), stats, scene }));
const failures = [];
if (scene.elements !== 200 || scene.posts < ROUNDS * 300) failures.push(`load did not land: ${JSON.stringify(scene)}`);
if (stats.viewers || stats.pending || stats.sockets) failures.push(`leaked connection state ${JSON.stringify(stats)}`);
if (lateGrowth > 3) failures.push(`heap still growing in the second half: +${lateGrowth.toFixed(2)} MB`);
if (failures.length) {
  console.error(failures.join('\n'));
  process.exit(1);
}
