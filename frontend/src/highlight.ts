import { getCommonBounds, sceneCoordsToViewportCoords } from '@excalidraw/excalidraw';
import type { ExcalidrawElement } from '@excalidraw/excalidraw/element/types';
import type { ExcalidrawImperativeAPI } from '@excalidraw/excalidraw/types';

const SVG_NS = 'http://www.w3.org/2000/svg';
const PAD = 10;
const MAX_BOXES = 12;

/**
 * Pulses an outline around elements as a DOM overlay (never a scene element),
 * re-positioned every frame so it follows pan/zoom. Returns a cancel function.
 */
export function pulseHighlight(api: ExcalidrawImperativeAPI, elements: readonly ExcalidrawElement[], ms = 2500): () => void {
  const groups = elements.length > MAX_BOXES ? [elements] : elements.map((el) => [el]);
  const bounds = groups.map((g) => getCommonBounds(g));
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('class', 'xl-highlight');
  svg.setAttribute('aria-hidden', 'true');
  const rects = bounds.map(() => svg.appendChild(document.createElementNS(SVG_NS, 'rect')));
  document.body.appendChild(svg);

  let frame = 0;
  const place = () => {
    const state = api.getAppState();
    bounds.forEach(([x1, y1, x2, y2], i) => {
      const a = sceneCoordsToViewportCoords({ sceneX: x1, sceneY: y1 }, state);
      const b = sceneCoordsToViewportCoords({ sceneX: x2, sceneY: y2 }, state);
      const r = rects[i]!;
      r.setAttribute('x', String(a.x - PAD));
      r.setAttribute('y', String(a.y - PAD));
      r.setAttribute('width', String(Math.max(0, b.x - a.x) + PAD * 2));
      r.setAttribute('height', String(Math.max(0, b.y - a.y) + PAD * 2));
    });
    frame = requestAnimationFrame(place);
  };
  place();
  const timer = setTimeout(() => cancel(), ms);
  const cancel = () => {
    clearTimeout(timer);
    cancelAnimationFrame(frame);
    svg.remove();
  };
  return cancel;
}
