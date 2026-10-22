import { Excalidraw, Footer, MainMenu, WelcomeScreen, useDevice } from '@excalidraw/excalidraw';
import type { ExcalidrawImperativeAPI, UIOptions } from '@excalidraw/excalidraw/types';
import { useEffect, useMemo, useRef, useState } from 'react';
import { readConfig, storage, type ThemePreference } from './config';
import type { LinkStatus } from './connection';
import { createFollower } from './follow';
import { startLive, type Live } from './live';
import { StatusPill } from './StatusPill';

const FOLLOW_KEY = 'whiteboard-mcp:follow';
const UI_OPTIONS: Partial<UIOptions> = {
  canvasActions: { loadScene: false, saveToActiveFile: false, toggleTheme: false, saveAsImage: true },
};

function useTheme(pref: ThemePreference): 'light' | 'dark' {
  const query = '(prefers-color-scheme: dark)';
  const [systemDark, setSystemDark] = useState(() => window.matchMedia?.(query).matches ?? false);
  useEffect(() => {
    if (pref !== 'auto' || !window.matchMedia) return;
    const mq = window.matchMedia(query);
    const onChange = () => setSystemDark(mq.matches);
    onChange();
    mq.addEventListener('change', onChange);
    return () => mq.removeEventListener('change', onChange);
  }, [pref]);
  return pref === 'auto' ? (systemDark ? 'dark' : 'light') : pref;
}

export function App() {
  const config = useMemo(() => readConfig(), []);
  const theme = useTheme(config.theme);
  const [api, setApi] = useState<ExcalidrawImperativeAPI | null>(null);
  const [status, setStatus] = useState<LinkStatus>('connecting');
  const [viewers, setViewers] = useState(0);
  const [follow, setFollow] = useState(() => storage.get(FOLLOW_KEY) !== '0');
  const live = useRef<Live | null>(null);
  const themeRef = useRef(theme);
  const followRef = useRef(follow);
  themeRef.current = theme;
  followRef.current = follow;

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
  }, [theme]);

  useEffect(() => {
    if (!api || !config.canvasId) return;
    window.__excalidrawAPI = api;
    const follower = createFollower(api, () => followRef.current);
    const session = startLive(api, config.wsUrl, {
      status: setStatus,
      viewers: setViewers,
      agentDrew: follower.push,
      dark: () => themeRef.current === 'dark',
    });
    live.current = session;
    return () => {
      live.current = null;
      session.stop();
      follower.dispose();
      if (window.__excalidrawAPI === api) delete window.__excalidrawAPI;
    };
  }, [api, config]);

  const toggleFollow = () => {
    setFollow((on) => {
      storage.set(FOLLOW_KEY, on ? '0' : '1');
      return !on;
    });
  };

  const pill = config.canvasId ? (
    <StatusPill
      status={status}
      viewers={viewers}
      follow={follow}
      onToggleFollow={toggleFollow}
      onNote={(text) => live.current?.sendNote(text) ?? false}
    />
  ) : (
    <div className="xl-pill xl-pill--error" role="status">
      No canvas in this link — open it from your agent.
    </div>
  );

  return (
    <div className="xl-root">
      <Excalidraw excalidrawAPI={setApi} theme={theme} name={config.canvasId || 'canvas'} UIOptions={UI_OPTIONS} aiEnabled={false}>
        <MainMenu>
          <MainMenu.DefaultItems.SaveAsImage />
          <MainMenu.DefaultItems.Export />
          <MainMenu.DefaultItems.SearchMenu />
          <MainMenu.DefaultItems.Help />
          <MainMenu.DefaultItems.ClearCanvas />
          <MainMenu.Separator />
          <MainMenu.DefaultItems.ChangeCanvasBackground />
        </MainMenu>
        <WelcomeScreen>
          <WelcomeScreen.Center>
            <WelcomeScreen.Center.Heading>Your agent will draw here — you can draw too.</WelcomeScreen.Center.Heading>
          </WelcomeScreen.Center>
        </WelcomeScreen>
        <Chrome>{pill}</Chrome>
      </Excalidraw>
    </div>
  );
}

/** Desktop: inside Excalidraw's footer, between zoom and help. Mobile: its own slot clear of the toolbars. */
function Chrome({ children }: { children: React.ReactNode }) {
  const device = useDevice();
  if (device.editor.isMobile) return <div className="xl-chrome xl-chrome--mobile">{children}</div>;
  return (
    <Footer>
      <div className="xl-chrome xl-chrome--footer">{children}</div>
    </Footer>
  );
}
