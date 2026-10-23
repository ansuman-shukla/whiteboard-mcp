import { readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import react from '@vitejs/plugin-react';
import { defineConfig, type Plugin } from 'vite';

/**
 * The inline view for MCP Apps hosts: one self-contained HTML file (dist/app/board.html) that the MCP
 * server returns as its ui:// resource. Hosts render it in a sandboxed iframe that can't load anything
 * else, so every chunk, the CSS and the fonts are inlined.
 */
const root = fileURLToPath(new URL('.', import.meta.url));
const fontsDir = resolve(root, 'node_modules/@excalidraw/excalidraw/dist/prod/fonts');
const version = (JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as { version: string }).version;
/** CJK fallback, 12 MB: left out; those glyphs use a system font inline. */
const SKIP_FONTS = new Set(['Xiaolai']);

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    return statSync(path).isDirectory() ? walk(path) : [path];
  });
}

/** `virtual:inline-fonts`: Excalidraw's font files as base64, keyed by their path under fonts/. */
function inlineFonts(): Plugin {
  const id = 'virtual:inline-fonts';
  return {
    name: 'inline-excalidraw-fonts',
    resolveId: (source) => (source === id ? `\0${id}` : undefined),
    load(loaded) {
      if (loaded !== `\0${id}`) return undefined;
      const fonts: Record<string, string> = {};
      for (const file of walk(fontsDir)) {
        const rel = relative(fontsDir, file).split(sep).join('/');
        if (!rel.endsWith('.woff2') || SKIP_FONTS.has(rel.split('/')[0]!)) continue;
        fonts[rel] = readFileSync(file).toString('base64');
      }
      return `export default ${JSON.stringify(fonts)};`;
    },
  };
}

/** `</script` or `<!--` inside inlined code would end or confuse the script element; `\x3C` is `<` in JS strings and regexes. */
const scriptSafe = (code: string) => code.replace(/<(\/script|!--)/gi, '\\x3C$1');

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
/** Excalidraw's CSS loads its UI font (Assistant) by URL; data: fonts break hosts' default CSP, so app-fonts.ts registers it from bytes instead. */
const withoutFontFaces = (css: string) => css.replace(/@font-face\{[^}]*\}/g, '');

/**
 * Inlines the single JS chunk and the CSS into the HTML, writes it as board.html and removes the rest.
 * Runs once the bundle is written, when Vite has finished rewriting the chunk.
 */
function singleFile(): Plugin {
  return {
    name: 'single-file',
    enforce: 'post',
    writeBundle(options, bundle) {
      const outDir = options.dir!;
      const html = Object.values(bundle).find((f) => f.type === 'asset' && f.fileName.endsWith('.html'));
      if (!html || html.type !== 'asset') throw new Error('single-file: no HTML in the bundle');
      let page = String(html.source);
      for (const file of Object.values(bundle)) {
        if (file === html) continue;
        const script = new RegExp(`<script[^>]*src="[./]*${escapeRe(file.fileName)}"[^>]*></script>`);
        const link = new RegExp(`<link[^>]*href="[./]*${escapeRe(file.fileName)}"[^>]*>`);
        if (file.type === 'chunk' && script.test(page)) page = page.replace(script, () => `<script type="module">${scriptSafe(file.code)}</script>`);
        else if (file.type === 'asset' && file.fileName.endsWith('.css') && link.test(page)) page = page.replace(link, () => `<style>${withoutFontFaces(String(file.source))}</style>`);
        else if (file.type === 'chunk') throw new Error(`single-file: chunk ${file.fileName} is not referenced by the page`);
        rmSync(join(outDir, file.fileName), { force: true });
      }
      rmSync(join(outDir, html.fileName), { force: true });
      rmSync(join(outDir, 'assets'), { recursive: true, force: true });
      writeFileSync(join(outDir, 'board.html'), page);
    },
  };
}

export default defineConfig({
  root: 'frontend',
  base: './',
  publicDir: false,
  define: { __APP_VERSION__: JSON.stringify(version) },
  plugins: [react(), inlineFonts(), singleFile()],
  build: {
    outDir: resolve(root, 'dist/app'),
    emptyOutDir: true,
    target: 'es2020',
    modulePreload: false,
    cssCodeSplit: false,
    assetsInlineLimit: () => true,
    chunkSizeWarningLimit: 20_000,
    reportCompressedSize: false,
    rollupOptions: {
      input: resolve(root, 'frontend/app.html'),
      output: { inlineDynamicImports: true },
    },
  },
});
