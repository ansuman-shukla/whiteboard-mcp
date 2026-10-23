import fonts from 'virtual:inline-fonts';

/**
 * Inline (MCP Apps) only: the sandboxed iframe can't fetch Excalidraw's fonts, so the build embeds them
 * (all but the large CJK Xiaolai) and FontFace gets their bytes instead of a URL. Binary FontFace
 * sources involve no fetch, so the host's CSP doesn't matter. Must run before Excalidraw creates fonts.
 */
const BASE = 'https://whiteboard-mcp.invalid/';
window.EXCALIDRAW_ASSET_PATH = BASE;

const decode = (b64: string): ArrayBuffer => {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes.buffer;
};

/**
 * The embedded bytes for a FontFace source that points at a bundled font. A font that isn't bundled
 * (Xiaolai) gets a local() source: no request the host's CSP would block, the browser falls back.
 */
function inlineSource(source: string): ArrayBuffer | string | undefined {
  let ours = false;
  for (const [, url] of source.matchAll(/url\(\s*["']?([^"')]+)["']?\s*\)/g)) {
    if (!url?.startsWith(`${BASE}fonts/`)) continue;
    ours = true;
    const b64 = fonts[decodeURIComponent(url.slice(BASE.length + 'fonts/'.length))];
    if (b64) return decode(b64);
  }
  return ours ? 'local("whiteboard-mcp-not-bundled")' : undefined;
}

const NativeFontFace = window.FontFace;
window.FontFace = class extends NativeFontFace {
  constructor(family: string, source: string | BufferSource, descriptors?: FontFaceDescriptors) {
    super(family, typeof source === 'string' ? (inlineSource(source) ?? source) : source, descriptors);
  }
};

// Excalidraw's UI font; the build drops its @font-face rules (data: URLs break hosts' default CSP).
const ASSISTANT: Array<[string, string]> = [
  ['Regular', '400'],
  ['Medium', '500'],
  ['SemiBold', '600'],
  ['Bold', '700'],
];
for (const [style, weight] of ASSISTANT) {
  const b64 = fonts[`Assistant/Assistant-${style}.woff2`];
  if (b64) document.fonts.add(new NativeFontFace('Assistant', decode(b64), { weight, display: 'swap' }));
}
