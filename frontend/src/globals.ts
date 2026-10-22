import type { ExcalidrawImperativeAPI } from '@excalidraw/excalidraw/types';

declare global {
  interface Window {
    EXCALIDRAW_ASSET_PATH?: string | string[];
    __excalidrawAPI?: ExcalidrawImperativeAPI;
  }
}

// Fonts are served by the daemon at /fonts/*; must be set before Excalidraw loads any.
window.EXCALIDRAW_ASSET_PATH = '/';
