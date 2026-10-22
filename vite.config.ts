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
 * Ship them next to the build (served at /fonts/*) so nothing is fetched from a CDN,
 * and serve them from node_modules in dev.
 */
function excalidrawFonts(): Plugin {
  return {
    name: 'excalidraw-local-fonts',
    configureServer(server) {
      server.middlewares.use('/fonts', (req, res, next) => {
        const file = normalize(join(fontsDir, decodeURIComponent((req.url ?? '').split('?')[0] ?? '')));
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
  base: '/',
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
    // Dev: run a daemon (`whiteboard-mcp serve`) and open http://localhost:5173/c/<id>?token=<t>.
    proxy: {
      '/ws': {
        target: `ws://127.0.0.1:${daemonPort}`,
        ws: true,
        changeOrigin: true,
        // The daemon only accepts its own origin.
        configure: (proxy) => proxy.on('proxyReqWs', (req) => req.setHeader('Origin', `http://127.0.0.1:${daemonPort}`)),
      },
      '/api': { target: `http://127.0.0.1:${daemonPort}`, changeOrigin: true },
    },
  },
});
