import { getCommonBounds, getVisibleSceneBounds } from '@excalidraw/excalidraw';
import type { ExcalidrawImperativeAPI } from '@excalidraw/excalidraw/types';

const DEBOUNCE_MS = 350;
const USER_IDLE_MS = 3000;
const INTERACTION_EVENTS = ['pointerdown', 'wheel', 'keydown', 'touchstart'] as const;

/**
 * Smoothly brings new agent elements into view when they land outside the
 * viewport, unless the human interacted recently (never fight their panning).
 */
export function createFollower(api: ExcalidrawImperativeAPI, enabled: () => boolean) {
  const pending = new Set<string>();
  let lastInteraction = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const onInteract = () => {
    lastInteraction = Date.now();
  };
  for (const type of INTERACTION_EVENTS) window.addEventListener(type, onInteract, { capture: true, passive: true });

  const run = () => {
    timer = undefined;
    const ids = new Set(pending);
    pending.clear();
    if (!enabled() || Date.now() - lastInteraction < USER_IDLE_MS || document.visibilityState === 'hidden') return;
    const state = api.getAppState();
    if (state.newElement || state.editingTextElement || state.selectedElementsAreBeingDragged) return;
    const targets = api.getSceneElements().filter((el) => ids.has(el.id) || (el.type === 'text' && el.containerId !== null && ids.has(el.containerId)));
    if (!targets.length) return;
    const [x1, y1, x2, y2] = getCommonBounds(targets);
    const [vx1, vy1, vx2, vy2] = getVisibleSceneBounds(state);
    if (x1 >= vx1 && y1 >= vy1 && x2 <= vx2 && y2 <= vy2) return;
    api.scrollToContent(targets, { fitToContent: true, animate: true, duration: 450, maxZoom: Math.max(1, state.zoom.value) });
  };

  return {
    push(ids: readonly string[]) {
      for (const id of ids) pending.add(id);
      clearTimeout(timer);
      timer = setTimeout(run, DEBOUNCE_MS);
    },
    dispose() {
      clearTimeout(timer);
      for (const type of INTERACTION_EVENTS) window.removeEventListener(type, onInteract, { capture: true });
    },
  };
}
