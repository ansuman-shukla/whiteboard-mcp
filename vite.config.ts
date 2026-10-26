import { cpSync, existsSync } from 'node:fs';
import { createReadStream } from 'node:fs';
import { join, normalize, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import react from '@vitejs/plugin-react';
import { defineConfig, type Plugin } from 'vite';

const root = fileURLToPath(new URL('.', import.meta.url));
const fontsDir = resolve(root, 'node_modules/@excalidraw/excalidraw/dist/prod/fonts');
const outDir = resolve(root, 'dist/frontend');
const daemonPort = Number(process.env.WHITEBOARD_PORT ?? 47428);

/**
 * Excalidraw loads its fonts at runtime from `${EXCALIDRAW_ASSET_PATH}fonts/...`.
 * Ship them next to the build (served next to the page, fonts/*) so nothing is fetched from a CDN,
 * and serve them from node_modules in dev.
 */
function excalidrawFonts(): Plugin {
  return {
    name: 'excalidraw-local-fonts',
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        const name = /^(?:\/c\/[^/]+\/[^/]+)?\/fonts(\/[^?]*)/.exec(req.url ?? '')?.[1];
        if (!name) return next();
        const file = normalize(join(fontsDir, decodeURIComponent(name)));
        if (!file.startsWith(fontsDir + sep) || !existsSync(file)) return next();
        res.setHeader('Content-Type', 'font/woff2');
        createReadStream(file).pipe(res);
      });
    },
    closeBundle() {
      cpSync(fontsDir, join(outDir, 'fonts'), { recursive: true });
    },
  };
}

export default defineConfig({
  root: 'frontend',
  // Relative, so the viewer works under /c/<id>/<token>/ and behind a proxy that mounts it elsewhere.
  base: './',
  publicDir: false,
  plugins: [react(), excalidrawFonts()],
  build: {
    outDir,
    emptyOutDir: true,
    target: 'es2020',
    chunkSizeWarningLimit: 4000,
    reportCompressedSize: true,
  },
  server: {
    // Dev: run a daemon (`whiteboard-mcp serve`) and open http://localhost:5173/c/<id>/<token>/.
    proxy: {
      '^/c/[^/]+/[^/]+/ws$': { target: `ws://127.0.0.1:${daemonPort}`, ws: true, changeOrigin: true },
      '/api': { target: `http://127.0.0.1:${daemonPort}`, changeOrigin: true },
    },
  },
});
