import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { crc32, inflateRawSync } from 'node:zlib';
import { afterAll, describe, expect, it } from 'vitest';
import { buildVsix } from '../../scripts/build-vsix.mjs';
import { removeTempDir } from '../helpers/cleanup.js';

const root = fileURLToPath(new URL('../..', import.meta.url));
const dir = mkdtempSync(path.join(tmpdir(), 'wb-vsix-'));
afterAll(() => removeTempDir(dir));

/** Reads a zip through its central directory, checking every entry's local header and CRC. */
function unzip(archive: Buffer): Map<string, Buffer> {
  const end = archive.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  const count = archive.readUInt16LE(end + 10);
  let at = archive.readUInt32LE(end + 16);
  const entries = new Map<string, Buffer>();
  for (let i = 0; i < count; i++) {
    expect(archive.readUInt32LE(at)).toBe(0x02014b50);
    const method = archive.readUInt16LE(at + 10);
    const crc = archive.readUInt32LE(at + 16);
    const packedSize = archive.readUInt32LE(at + 20);
    const size = archive.readUInt32LE(at + 24);
    const nameLength = archive.readUInt16LE(at + 28);
    const extraLength = archive.readUInt16LE(at + 30);
    const commentLength = archive.readUInt16LE(at + 32);
    const offset = archive.readUInt32LE(at + 42);
    const name = archive.subarray(at + 46, at + 46 + nameLength).toString('utf8');
    expect(archive.readUInt32LE(offset)).toBe(0x04034b50);
    expect(archive.subarray(offset + 30, offset + 30 + archive.readUInt16LE(offset + 26)).toString('utf8')).toBe(name);
    const start = offset + 30 + archive.readUInt16LE(offset + 26) + archive.readUInt16LE(offset + 28);
    const packed = archive.subarray(start, start + packedSize);
    const data = method === 8 ? inflateRawSync(packed) : packed;
    expect(data.length).toBe(size);
    expect(crc32(data)).toBe(crc);
    entries.set(name, data);
    at += 46 + nameLength + extraLength + commentLength;
  }
  return entries;
}

describe('buildVsix', () => {
  const file: string = buildVsix(dir);
  const entries = unzip(readFileSync(file));
  const pkg = JSON.parse(readFileSync(path.join(root, 'vscode/package.json'), 'utf8'));

  it('names the package after the extension and holds the manifest, content types and every extension file unchanged', () => {
    expect(path.basename(file)).toBe(`whiteboard-mcp-${pkg.version}.vsix`);
    expect([...entries.keys()]).toEqual([
      '[Content_Types].xml',
      'extension.vsixmanifest',
      'extension/extension.js',
      'extension/host.js',
      'extension/LICENSE.txt',
      'extension/package.json',
      'extension/README.md',
      'extension/tabs.js',
      'extension/window.js',
    ]);
    for (const name of ['extension.js', 'host.js', 'tabs.js', 'window.js', 'package.json', 'README.md']) {
      expect(entries.get(`extension/${name}`)!.equals(readFileSync(path.join(root, 'vscode', name)))).toBe(true);
    }
    expect(entries.get('extension/LICENSE.txt')!.equals(readFileSync(path.join(root, 'LICENSE')))).toBe(true);
  });

  it("declares the extension's identity, engine and assets in the manifest", () => {
    const manifest = entries.get('extension.vsixmanifest')!.toString('utf8');
    expect(manifest).toContain(`<Identity Language="en-US" Id="whiteboard-mcp" Version="${pkg.version}" Publisher="${pkg.publisher}"/>`);
    expect(manifest).toContain(`<Property Id="Microsoft.VisualStudio.Code.Engine" Value="${pkg.engines.vscode}"/>`);
    expect(manifest).toContain('<Asset Type="Microsoft.VisualStudio.Code.Manifest" Path="extension/package.json" Addressable="true"/>');
    for (const [, assetPath] of manifest.matchAll(/Path="([^"]+)"/g)) expect(entries.has(assetPath!)).toBe(true);
    const types = entries.get('[Content_Types].xml')!.toString('utf8');
    for (const name of entries.keys()) if (name !== '[Content_Types].xml') expect(types).toContain(`Extension="${path.extname(name)}"`);
  });

  it('builds the same bytes from the same sources', () => {
    const again = buildVsix(path.join(dir, 'again'));
    expect(readFileSync(again).equals(readFileSync(file))).toBe(true);
  });
});
