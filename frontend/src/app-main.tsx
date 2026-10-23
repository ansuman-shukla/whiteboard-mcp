import './globals';
import './app-fonts';
import '@excalidraw/excalidraw/index.css';
import './styles.css';
import { StrictMode, useEffect, useMemo, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import { HostBridge, relayLink, type HostContext, type ToolResult } from './bridge';
import type { ViewerConfig } from './config';
import { Icon } from './Icon';

/** The board inline in a chat (MCP Apps): canvas_open's result names the board, the host proxies its link. */
const INLINE_HEIGHT = 560;
const APP_INFO = { name: 'whiteboard-mcp', version: __APP_VERSION__ };
const EXPAND = 'M15 3h6v6M9 21H3v-6M21 3l-7 7M3 21l7-7';
const COLLAPSE = 'M4 14h6v6M20 10h-6V4M14 10l7-7M3 21l7-7';

type State = { phase: 'waiting' } | { phase: 'board'; board: string } | { phase: 'error'; message: string };

function boardFrom(result: ToolResult): State {
  const board = result.structuredContent?.board;
  if (!result.isError && typeof board === 'string' && board) return { phase: 'board', board };
  const why = result.content?.find((c) => c.type === 'text')?.text;
  return { phase: 'error', message: why ? `The board could not be opened: ${why}` : 'The board could not be opened.' };
}

function InlineBoard({ bridge, events }: { bridge: HostBridge; events: Events }) {
  const [state, setState] = useState<State>({ phase: 'waiting' });
  const [ctx, setCtx] = useState<HostContext>(bridge.context);
  useEffect(() => {
    events.toolResult = (r) => setState(boardFrom(r));
    events.hostContext = setCtx;
    if (events.pending) setState(boardFrom(events.pending));
    return () => {
      events.toolResult = undefined;
      events.hostContext = undefined;
    };
  }, [events]);

  const fullscreen = ctx.displayMode === 'fullscreen';
  const canFullscreen = ctx.availableDisplayModes?.includes('fullscreen') ?? false;
  useEffect(() => {
    const fixed = ctx.containerDimensions?.height;
    const height = fullscreen ? (fixed ?? window.innerHeight) : (fixed ?? Math.min(INLINE_HEIGHT, ctx.containerDimensions?.maxHeight ?? INLINE_HEIGHT));
    document.documentElement.style.height = fullscreen ? '100vh' : `${height}px`;
    bridge.sizeChanged(height);
  }, [bridge, ctx, fullscreen]);

  const board = state.phase === 'board' ? state.board : '';
  const config = useMemo<ViewerConfig>(() => ({ canvasId: board, token: '', theme: 'auto', embed: true, link: relayLink(bridge, board) }), [bridge, board]);

  if (state.phase !== 'board') return <div className={`xl-inline-msg${state.phase === 'error' ? ' xl-inline-msg--error' : ''}`}>{state.phase === 'error' ? state.message : 'Opening the board…'}</div>;
  const toggle = canFullscreen ? (
    <button
      type="button"
      className="xl-pill xl-expand"
      title={fullscreen ? 'Back to the chat' : 'Full screen'}
      aria-label={fullscreen ? 'Back to the chat' : 'Full screen'}
      onClick={() => void bridge.requestDisplayMode(fullscreen ? 'inline' : 'fullscreen').catch(() => undefined)}
    >
      <Icon d={fullscreen ? COLLAPSE : EXPAND} size={16} />
    </button>
  ) : undefined;
  return <App key={board} config={config} theme={ctx.theme === 'dark' ? 'dark' : ctx.theme === 'light' ? 'light' : undefined} actions={toggle} />;
}

/** Bridge events land here until the React tree subscribes (the tool result can beat the first render). */
interface Events {
  toolResult?: (r: ToolResult) => void;
  hostContext?: (c: HostContext) => void;
  pending?: ToolResult;
}

const events: Events = {};
const root = createRoot(document.getElementById('root')!);
const bridge = new HostBridge({
  toolResult(r) {
    events.pending = r;
    events.toolResult?.(r);
  },
  hostContext: (c) => events.hostContext?.(c),
  teardown() {
    root.unmount();
    bridge.dispose();
  },
});

document.documentElement.dataset.inline = '1';
bridge
  .connect(APP_INFO)
  .then(() =>
    root.render(
      <StrictMode>
        <InlineBoard bridge={bridge} events={events} />
      </StrictMode>,
    ),
  )
  .catch(() => root.render(<div className="xl-inline-msg xl-inline-msg--error">This page shows a whiteboard inside an MCP Apps chat; open boards from your agent instead.</div>));
