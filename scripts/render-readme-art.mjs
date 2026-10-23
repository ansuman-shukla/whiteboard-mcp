// Renders the README cards (light + dark SVGs) into docs/media/readme/.
// Run: npm run readme:art
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const OUT = join(dirname(fileURLToPath(import.meta.url)), '..', 'docs', 'media', 'readme');
const W = 1600;

const THEMES = {
  light: { card: '#fafaf7', tile: '#ffffff', line: '#e7e5df', head: '#1c1c1a', body: '#5c5c57', faint: '#8a8a84', yes: '#2f9e44', no: '#c2c2bc' },
  dark: { card: '#202020', tile: '#2a2a2a', line: '#363636', head: '#efeee6', body: '#b8b8b0', faint: '#85857f', yes: '#51cf66', no: '#5a5a56' },
};
const ORANGE = '#ffa94d';
const VIOLET = '#b07ce8';
const BLUE = '#4dabf7';

const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const STYLE = `<style>
.serif{font-family:'New York','Iowan Old Style',ui-serif,Georgia,serif}
.sans{font-family:-apple-system,BlinkMacSystemFont,'SF Pro Text','Segoe UI',Helvetica,Arial,sans-serif}
.mono{font-family:ui-monospace,'SF Mono',Menlo,Consolas,monospace}
</style>`;
const svg = (h, label, body) =>
  `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${h}" viewBox="0 0 ${W} ${h}" role="img" aria-label="${esc(label)}">\n<title>${esc(label)}</title>\n${STYLE}\n${body}\n</svg>\n`;
const text = (x, y, s, { size = 26, cls = 'sans', fill, weight = 400, anchor = 'start' } = {}) =>
  `<text x="${x}" y="${y}" class="${cls}" font-size="${size}" font-weight="${weight}" fill="${fill}" text-anchor="${anchor}">${esc(s)}</text>`;
const lines = (x, y, rows, opts, gap = 36) => rows.map((r, i) => text(x, y + i * gap, r, opts)).join('\n');
const card = (h, t) => `<rect x="1" y="1" width="${W - 2}" height="${h - 2}" rx="40" fill="${t.card}" stroke="${t.line}" stroke-width="2"/>`;
const tile = (x, y, w, h, t) => `<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="28" fill="${t.tile}" stroke="${t.line}" stroke-width="2"/>`;
const badge = (x, y, color, icon) =>
  `<g transform="translate(${x} ${y})"><rect width="68" height="68" rx="18" fill="${color}" fill-opacity="0.22"/><g transform="translate(14 14)" fill="none" stroke="${color}" stroke-width="3.2" stroke-linecap="round" stroke-linejoin="round">${icon}</g></g>`;

// 40x40 line icons
const ICONS = {
  steps: '<rect x="2" y="4" width="14" height="10" rx="2"/><rect x="24" y="26" width="14" height="10" rx="2"/><path d="M9 14v8a4 4 0 0 0 4 4h11"/><path d="M20 22l4 4-4 4"/>',
  drawBack: '<path d="M6 30c4-14 10-20 16-20s10 6 8 12-10 8-14 4"/><path d="M28 34l6-6"/><circle cx="34" cy="8" r="4"/>',
  panel: '<rect x="2" y="5" width="36" height="30" rx="4"/><path d="M15 5v30"/><path d="M6 13h5M6 19h5"/><path d="M21 26l5-7 4 4 5-8"/>',
  memory: '<path d="M8 4h18l8 8v24H8z"/><path d="M26 4v8h8"/><path d="M14 22h12M14 28h8"/>',
  lock: '<rect x="7" y="17" width="26" height="19" rx="4"/><path d="M13 17v-5a7 7 0 0 1 14 0v5"/><circle cx="20" cy="26" r="2.5"/>',
  feather: '<path d="M34 6C20 6 10 16 10 30"/><path d="M34 6c0 14-10 22-24 24"/><path d="M6 34l8-8"/>',
};

function logo(x, y, s) {
  const k = s / 120;
  return `<g transform="translate(${x} ${y}) scale(${k})">
  <defs><linearGradient id="lg" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#4dabf7"/><stop offset="1" stop-color="#9775fa"/></linearGradient></defs>
  <rect width="120" height="120" rx="28" fill="url(#lg)"/>
  <rect x="18" y="30" width="34" height="24" rx="6" fill="none" stroke="#fff" stroke-width="5"/>
  <rect x="68" y="66" width="34" height="24" rx="6" fill="#fff"/>
  <path d="M35 54c0 16 8 24 30 24" fill="none" stroke="#fff" stroke-width="5" stroke-linecap="round"/>
  <path d="M58 70l8 8-8 8" fill="none" stroke="#fff" stroke-width="5" stroke-linecap="round" stroke-linejoin="round"/>
  <path d="M74 26c6-4 14-4 22 2" fill="none" stroke="${ORANGE}" stroke-width="5" stroke-linecap="round"/>
</g>`;
}

function hero(t) {
  const label = 'whiteboard-mcp: a live whiteboard your coding agent draws on. You draw back.';
  return svg(260, label, [
    logo(40, 70, 120),
    text(196, 154, 'whiteboard-mcp', { size: 76, cls: 'serif', fill: t.head, weight: 700 }),
    text(1560, 92, 'A live whiteboard your', { size: 46, fill: t.head, weight: 600, anchor: 'end' }),
    text(1560, 150, 'coding agent draws on.', { size: 46, fill: t.head, weight: 600, anchor: 'end' }),
    text(1560, 208, 'You draw back.', { size: 46, fill: t.faint, weight: 600, anchor: 'end' }),
  ].join('\n'));
}

function features(t) {
  const items = [
    ['Draws step by step', ['Boxes, arrows and notes, one idea', 'at a time, pointing at each part.'], BLUE, ICONS.steps],
    ['Sees what you draw', ['Move, circle or note anything. It gets', 'a short list of exactly what changed.'], ORANGE, ICONS.drawBack],
    ['Right beside the chat', ['A tab next to the chat in VS Code,', 'Cursor, Windsurf, or your browser.'], VIOLET, ICONS.panel],
    ['Remembers boards', ['One board per chat, saved on disk.', 'Reopen or search it from any chat.'], BLUE, ICONS.memory],
    ['Local and private', ['Runs on 127.0.0.1 with a token.', 'Nothing leaves your machine.'], ORANGE, ICONS.lock],
    ['Tiny', ['One runtime dependency and about', '7 KB of tool schema per turn.'], VIOLET, ICONS.feather],
  ];
  const label = `Why whiteboard-mcp: ${items.map(([h, d]) => `${h}: ${d.join(' ')}`).join(' ')}`;
  const tw = 456, th = 300, gx = 32, x0 = 80, y0 = 170;
  const tiles = items.map(([h, d, c, ic], i) => {
    const x = x0 + (i % 3) * (tw + gx), y = y0 + Math.floor(i / 3) * (th + gx);
    return [tile(x, y, tw, th, t), badge(x + 40, y + 40, c, ic), text(x + 40, y + 170, h, { size: 34, cls: 'serif', fill: t.head, weight: 700 }), lines(x + 40, y + 218, d, { size: 24, fill: t.body }, 35)].join('\n');
  });
  return svg(850, label, [card(850, t), text(80, 120, 'Why whiteboard-mcp', { size: 60, cls: 'serif', fill: t.head, weight: 700 }), ...tiles].join('\n'));
}

function steps(t) {
  const items = [
    ['Clone and build', 'git clone … && npm run build'],
    ['Add it to your agent', 'claude mcp add whiteboard …'],
    ['Ask for a drawing', '"Draw this repo for me"'],
  ];
  const label = `Get started in a minute: ${items.map(([h, s], i) => `${i + 1}. ${h} (${s})`).join(' ')}`;
  const tw = 456, th = 300, gx = 32, x0 = 80, y0 = 170;
  const tiles = items.map(([h, s], i) => {
    const x = x0 + i * (tw + gx), y = y0;
    return [
      tile(x, y, tw, th, t),
      text(x + 40, y + 84, String(i + 1), { size: 60, cls: 'serif', fill: t.faint, weight: 700 }),
      `<rect x="${x + 40}" y="${y + 128}" width="${tw - 80}" height="56" rx="12" fill="${t.card}" stroke="${t.line}" stroke-width="2"/>`,
      text(x + 60, y + 164, s, { size: 20, cls: 'mono', fill: t.body }),
      text(x + 40, y + 250, h, { size: 32, fill: t.head, weight: 700 }),
    ].join('\n');
  });
  return svg(540, label, [card(540, t), text(80, 120, 'Get started in a minute', { size: 60, cls: 'serif', fill: t.head, weight: 700 }), ...tiles].join('\n'));
}

function compare(t) {
  const rows = [
    ['Sees what you draw back', 'yes', 'Short list of your changes + notes', 'part', 'Re-reads the whole scene'],
    ['Agent screenshots its own board', 'yes', '', 'no', ''],
    ['Edit one shape in place', 'yes', 'Arrows stay attached', 'part', 'Re-sends from a checkpoint'],
    ['Boards outlive the chat', 'yes', 'Reopen by name, search the text', 'no', 'Tied to the chat'],
    ['Works in any MCP client', 'yes', 'Plus a plain CLI', 'no', 'Only hosts with MCP Apps'],
    ['Mermaid to hand-drawn', 'yes', '', 'no', ''],
    ['Animated camera moves', 'no', '', 'yes', ''],
    ['Zero install (hosted URL)', 'no', 'Clone and build', 'yes', ''],
  ];
  const label = `whiteboard-mcp vs Excalidraw MCP. ${rows.map(([f, a, an, b, bn]) => `${f}: whiteboard-mcp ${a}${an ? ` (${an})` : ''}, Excalidraw MCP ${b}${bn ? ` (${bn})` : ''}.`).join(' ')}`;
  const mark = (x, y, v) => {
    if (v === 'yes') return `<g transform="translate(${x} ${y})"><circle r="17" fill="${t.yes}"/><path d="M-8 0l5 5 10-10" fill="none" stroke="#fff" stroke-width="3.6" stroke-linecap="round" stroke-linejoin="round"/></g>`;
    if (v === 'part') return `<g transform="translate(${x} ${y})"><circle r="17" fill="none" stroke="${ORANGE}" stroke-width="3.2"/><path d="M0 -17a17 17 0 0 1 0 34z" fill="${ORANGE}"/></g>`;
    return `<g transform="translate(${x} ${y})"><circle r="17" fill="none" stroke="${t.no}" stroke-width="3.2"/><path d="M-7 0h14" stroke="${t.no}" stroke-width="3.6" stroke-linecap="round"/></g>`;
  };
  const top = 230, rh = 84, cA = 640, cB = 1120;
  const h = top + rows.length * rh + 60;
  const body = [
    card(h, t),
    text(80, 120, 'whiteboard-mcp vs Excalidraw MCP', { size: 60, cls: 'serif', fill: t.head, weight: 700 }),
    text(cA, 196, 'whiteboard-mcp', { size: 26, fill: t.head, weight: 700 }),
    text(cB, 196, 'Excalidraw MCP', { size: 26, fill: t.faint, weight: 700 }),
    ...rows.map(([f, a, an, b, bn], i) => {
      const y = top + i * rh, mid = y + rh / 2;
      return [
        `<path d="M80 ${y}H${W - 80}" stroke="${t.line}" stroke-width="2"/>`,
        text(80, mid + 9, f, { size: 27, fill: t.head }),
        mark(cA + 17, mid, a),
        an ? text(cA + 52, mid + 8, an, { size: 23, fill: t.body }) : '',
        mark(cB + 17, mid, b),
        bn ? text(cB + 52, mid + 8, bn, { size: 23, fill: t.body }) : '',
      ].join('\n');
    }),
  ];
  return svg(h, label, body.join('\n'));
}

mkdirSync(OUT, { recursive: true });
for (const [name, render] of Object.entries({ hero, features, steps, compare })) {
  for (const [theme, t] of Object.entries(THEMES)) writeFileSync(join(OUT, `${name}-${theme}.svg`), render(t));
}
console.log(`wrote 8 cards to ${OUT}`);
