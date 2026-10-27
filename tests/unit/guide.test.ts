import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { GUIDE } from '../../src/mcp/guide.js';
import { PALETTE, buildElements, type ElementSpec } from '../../src/shared/elements.js';

const SKILL = readFileSync(new URL('../../skills/whiteboard-explainer/SKILL.md', import.meta.url), 'utf8');
const lineWith = (doc: string, needle: string): string => doc.split('\n').find((l) => l.includes(needle)) ?? '';

/** The section rectangle each doc teaches, as a canvas_draw spec. */
function guideSection(): ElementSpec {
  const recipe = /Never frames\. A section is a rectangle around its boxes \(([^)]+)\)/.exec(GUIDE)![1]!;
  const fields = Object.fromEntries(recipe.split(', ').map((pair) => {
    const [key, value] = pair.split(' ');
    return [key!, JSON.parse(value!) as unknown];
  }));
  return { id: 'backend', type: 'rectangle', x: -40, y: -60, width: 600, height: 240, ...fields };
}
const skillSection = (): ElementSpec => JSON.parse(/`(\{"id":"backend"[^`]+\})`/.exec(lineWith(SKILL, '- Sections/zones'))![1]!) as ElementSpec;

describe('agent docs: sections instead of frames', () => {
  it.each([['canvas_guide', GUIDE], ['SKILL.md', SKILL]])('%s only mentions frames to forbid them', (_name, doc) => {
    const mentions = doc.split('\n').filter((l) => /frame/i.test(l));
    expect(mentions).toHaveLength(1);
    expect(mentions[0]).toMatch(/never frames/i);
  });

  it.each([['canvas_guide', guideSection], ['SKILL.md', skillSection]])('%s section recipe draws an unframed dashed gray box arrows can bind to', (_name, section) => {
    const r = buildElements([
      section(),
      { id: 'title', type: 'text', x: -20, y: -40, text: 'Backend' },
      { id: 'api', type: 'rectangle', x: 0, y: 0, label: 'API' },
      { id: 'client', type: 'rectangle', x: -400, y: 0, label: 'Client' },
      { id: 'a', type: 'arrow', from: 'client', to: 'backend' },
    ], [], { now: 1000, random: () => 0.5 });
    const get = (id: string) => r.elements.find((e) => e.id === id) as Record<string, any>;
    expect(r.warnings).toEqual([]);
    expect(get('backend')).toMatchObject({ type: 'rectangle', backgroundColor: 'transparent', strokeStyle: 'dashed', strokeColor: PALETTE.gray!.stroke, roughness: 0 });
    expect(r.elements.every((e) => e.type !== 'frame' && (e as Record<string, any>).frameId === null)).toBe(true);
    expect(get('a').endBinding).toMatchObject({ elementId: 'backend' });
  });
});
