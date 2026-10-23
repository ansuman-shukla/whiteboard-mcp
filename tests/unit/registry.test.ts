import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const read = (file: string) => JSON.parse(readFileSync(new URL(`../../${file}`, import.meta.url), 'utf8'));
const pkg = read('package.json');
const server = read('server.json');

describe('server.json for the official MCP registry', () => {
  it('names the server after package.json mcpName, which the registry checks on npm to verify ownership', () => {
    expect(server.name).toBe(pkg.mcpName);
    expect(server.name).toBe('io.github.ansuman-shukla/whiteboard-mcp');
  });

  it('points at the npm package and version being published', () => {
    expect(server.version).toBe(pkg.version);
    expect(server.packages).toEqual([{ registryType: 'npm', identifier: pkg.name, version: pkg.version, transport: { type: 'stdio' } }]);
  });

  it('keeps the description within the registry limit of 100 characters', () => {
    expect(server.description.length).toBeGreaterThan(0);
    expect(server.description.length).toBeLessThanOrEqual(100);
  });

  it('links the same repository as package.json', () => {
    expect(pkg.repository.url).toBe(`git+${server.repository.url}.git`);
  });
});
