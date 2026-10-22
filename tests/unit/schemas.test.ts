import { describe, expect, it } from 'vitest';
import { validate, stripNulls, type Schema } from '../../src/mcp/schema.js';
import { TOOLS, toolList } from '../../src/mcp/tools.js';
import { ELEMENT_SPEC_FIELDS } from '../../src/shared/elements.js';

const TOOL_NAMES = ['canvas_open', 'canvas_read', 'canvas_draw', 'canvas_delete', 'canvas_focus', 'canvas_screenshot', 'canvas_mermaid', 'canvas_export', 'canvas_guide'];
const ALLOWED_KEYS = new Set(['type', 'description', 'properties', 'required', 'items', 'enum', 'maxItems', 'additionalProperties']);
const TYPES = new Set(['object', 'array', 'string', 'number', 'integer', 'boolean']);

/** Every problem that would make a schema non-portable across Claude, OpenAI/Codex and Gemini validators. */
function portabilityProblems(schema: unknown, path: string): string[] {
  const s = schema as Record<string, unknown>;
  const problems: string[] = [];
  for (const key of Object.keys(s)) if (!ALLOWED_KEYS.has(key)) problems.push(`${path}: disallowed keyword ${key}`);
  if (typeof s.type !== 'string' || !TYPES.has(s.type)) problems.push(`${path}: type must be a single primitive type name`);
  if (s.type === 'array') {
    if (!s.items || typeof s.items !== 'object' || Array.isArray(s.items)) problems.push(`${path}: array needs a single items schema`);
    else problems.push(...portabilityProblems(s.items, `${path}[]`));
  }
  if (s.type === 'object') {
    const props = (s.properties ?? {}) as Record<string, unknown>;
    if (typeof props !== 'object' || Array.isArray(props)) problems.push(`${path}: properties must be an object`);
    for (const [k, v] of Object.entries(props)) problems.push(...portabilityProblems(v, `${path}.${k}`));
    for (const r of (s.required as string[] | undefined) ?? []) if (!(r in props)) problems.push(`${path}: required "${r}" is not a property`);
  } else if (s.properties || s.required) problems.push(`${path}: properties/required on a non-object`);
  if (s.enum !== undefined && (s.type !== 'string' || !Array.isArray(s.enum) || !s.enum.every((v) => typeof v === 'string'))) problems.push(`${path}: enum must be a string list on a string`);
  return problems;
}

describe('tool schemas', () => {
  it('lists exactly the nine tools', () => {
    expect(TOOLS.map((t) => t.name)).toEqual(TOOL_NAMES);
  });

  it('are portable', () => {
    for (const t of toolList()) {
      expect(t.inputSchema.type).toBe('object');
      expect(portabilityProblems(t.inputSchema, t.name)).toEqual([]);
    }
  });

  it('the portability walk catches the forms it forbids', () => {
    const bad: Array<[unknown, RegExp]> = [
      [{ type: ['string', 'null'] }, /single primitive/],
      [{ type: 'array' }, /items/],
      [{ type: 'array', items: [{ type: 'number' }, { type: 'number' }] }, /items/],
      [{ type: 'object', oneOf: [] }, /oneOf/],
      [{ type: 'object', anyOf: [] }, /anyOf/],
      [{ type: 'object', allOf: [] }, /allOf/],
      [{ type: 'string', format: 'uri' }, /format/],
      [{ type: 'object', properties: { a: { $ref: '#/x' } } }, /\$ref/],
      [{ type: 'object', properties: {}, required: ['a'] }, /required/],
    ];
    for (const [schema, re] of bad) expect(portabilityProblems(schema, 's').join('\n')).toMatch(re);
  });

  it('keep tools/list under 7 KB', () => {
    const size = Buffer.byteLength(JSON.stringify({ tools: toolList() }));
    expect(size).toBeLessThan(7 * 1024);
  });

  it('describe every tool and every top-level property', () => {
    for (const t of toolList()) {
      expect(t.description.length, t.name).toBeGreaterThan(20);
      expect(t.description.length, t.name).toBeLessThanOrEqual(200);
      for (const [k, p] of Object.entries(t.inputSchema.properties ?? {})) expect(p.description, `${t.name}.${k}`).toBeTruthy();
    }
  });

  it('canvas_draw elements mirror ElementSpec, points are arrays of number arrays, max 200 per call', () => {
    const draw = TOOLS.find((t) => t.name === 'canvas_draw')!.inputSchema;
    expect(draw.required).toEqual(['elements']);
    const elements = draw.properties!.elements!;
    expect(elements.maxItems).toBe(200);
    expect(Object.keys(elements.items!.properties!).sort()).toEqual(Object.keys(ELEMENT_SPEC_FIELDS).sort());
    expect(elements.items!.properties!.points).toEqual(expect.objectContaining({ type: 'array', items: { type: 'array', items: { type: 'number' } } }));
  });

  it('require the arguments each tool cannot run without', () => {
    const required = Object.fromEntries(TOOLS.map((t) => [t.name, t.inputSchema.required ?? []]));
    expect(required).toEqual({
      canvas_open: [],
      canvas_read: [],
      canvas_draw: ['elements'],
      canvas_delete: [],
      canvas_focus: [],
      canvas_screenshot: [],
      canvas_mermaid: ['definition'],
      canvas_export: ['path'],
      canvas_guide: [],
    });
  });
});

describe('argument validation', () => {
  const schema: Schema = {
    type: 'object',
    properties: {
      name: { type: 'string' },
      n: { type: 'integer' },
      f: { type: 'string', enum: ['a', 'b'] },
      list: { type: 'array', maxItems: 2, items: { type: 'array', items: { type: 'number' } } },
    },
    required: ['name'],
  };

  it('accepts valid input', () => {
    expect(validate(schema, { name: 'x', n: 2, f: 'a', list: [[1, 2]] })).toBeUndefined();
  });

  it('reports the first problem with its path', () => {
    expect(validate(schema, {})).toBe('arguments.name is required');
    expect(validate(schema, { name: 1 })).toBe('arguments.name must be a string (got number)');
    expect(validate(schema, { name: 'x', n: 1.5 })).toMatch(/arguments\.n must be an? integer/);
    expect(validate(schema, { name: 'x', f: 'c' })).toBe('arguments.f must be one of: a, b');
    expect(validate(schema, { name: 'x', list: [[1], [2], [3]] })).toMatch(/3 items; max is 2/);
    expect(validate(schema, { name: 'x', list: [[1, 'two']] })).toBe('arguments.list[0][1] must be a number (got string)');
    expect(validate(schema, [])).toMatch(/must be an object \(got array\)/);
  });

  it('treats nulls from clients as omitted', () => {
    expect(validate(schema, stripNulls({ name: 'x', n: null, list: [[1, 2]] }))).toBeUndefined();
    expect(stripNulls({ a: null, b: [{ c: null, d: 1 }] })).toEqual({ b: [{ d: 1 }] });
  });
});
