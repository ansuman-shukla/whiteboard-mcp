import { Excalidraw, Footer, MainMenu, WelcomeScreen, useDevice } from '@excalidraw/excalidraw';
import type { ExcalidrawImperativeAPI, UIOptions } from '@excalidraw/excalidraw/types';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { ThemeChoice } from '../../src/shared/protocol';
import { readConfig, storage, type ThemePreference } from './config';
import type { LinkStatus } from './connection';
import { createFollower } from './follow';
import { Icon } from './Icon';
import { startLive, type Live } from './live';
import { leaveDeadProxy } from './proxy';
import { SAVE_ICON, SaveForm } from './SaveForm';
import { StatusPill } from './StatusPill';

const FOLLOW_KEY = 'whiteboard-mcp:follow';
const SAVE_SHORTCUT = /Mac|iPhone|iPad/.test(navigator.platform) ? '⌘S' : 'Ctrl+S';
const SAVED_TOAST_MS = 4000;
const isSaveKey = (e: KeyboardEvent) => (e.metaKey || e.ctrlKey) && !e.shiftKey && !e.altKey && e.key.toLowerCase() === 's';
const isThemeKey = (e: KeyboardEvent) => e.altKey && e.shiftKey && !e.metaKey && !e.ctrlKey && e.code === 'KeyD';
const UI_OPTIONS: Partial<UIOptions> = {
  canvasActions: { loadScene: false, saveToActiveFile: false, toggleTheme: true, saveAsImage: true },
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
  const editorTheme = useTheme(config.theme);
  // The user's pick, kept by the daemon for every viewer; 'system' follows the editor's or system's theme.
  const [themeChoice, setThemeChoice] = useState<ThemeChoice>('system');
  const theme = themeChoice === 'system' ? editorTheme : themeChoice;
  const [api, setApi] = useState<ExcalidrawImperativeAPI | null>(null);
  const [status, setStatus] = useState<LinkStatus>('connecting');
  const [viewers, setViewers] = useState(0);
  const [follow, setFollow] = useState(() => storage.get(FOLLOW_KEY) !== '0');
  const [title, setTitle] = useState('');
  const [saving, setSaving] = useState(false);
  const closeSave = useCallback(() => setSaving(false), []);
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
    const session = startLive(api, config.wsUrls, {
      status: setStatus,
      viewers: setViewers,
      agentDrew: follower.push,
      title: (t) => setTitle(t === config.canvasId ? '' : t),
      prefs: (p) => setThemeChoice(p.theme),
      dark: () => themeRef.current === 'dark',
      fellBack: () => void leaveDeadProxy(config.directPage),
    });
    live.current = session;
    return () => {
      live.current = null;
      session.stop();
      follower.dispose();
      if (window.__excalidrawAPI === api) delete window.__excalidrawAPI;
    };
  }, [api, config]);

  // Excalidraw's own ⌘/Ctrl+S needs a file opened from disk; here it saves to the library instead.
  useEffect(() => {
    if (!config.canvasId) return;
    const onKey = (e: KeyboardEvent) => {
      if (!isSaveKey(e)) return;
      e.preventDefault();
      e.stopPropagation();
      setSaving(true);
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [config]);

  const save = async (name: string) => {
    try {
      if (!live.current) throw new Error('offline');
      const saved = await live.current.save(name);
      api?.setToast({ message: `Saved "${saved.name}". Any chat can find it with canvas_search.`, duration: SAVED_TOAST_MS });
      setSaving(false);
    } catch (err) {
      api?.setToast({ message: `Not saved: ${err instanceof Error ? err.message : String(err)}`, closable: true });
      throw err;
    }
  };

  const pickTheme = useCallback((choice: ThemeChoice) => {
    setThemeChoice(choice);
    live.current?.setPrefs({ theme: choice });
  }, []);

  // Excalidraw's own theme shortcut would flip only its local state; here it's a pick like the menu's.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!isThemeKey(e)) return;
      e.preventDefault();
      e.stopPropagation();
      pickTheme(themeRef.current === 'dark' ? 'light' : 'dark');
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [pickTheme]);

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
          {config.canvasId && (
            <MainMenu.Item icon={<Icon d={SAVE_ICON} size={16} />} shortcut={SAVE_SHORTCUT} onSelect={() => setSaving(true)} data-testid="save-to-library">
              Save to library
            </MainMenu.Item>
          )}
          <MainMenu.DefaultItems.SaveAsImage />
          <MainMenu.DefaultItems.Export />
          <MainMenu.DefaultItems.SearchMenu />
          <MainMenu.DefaultItems.Help />
          <MainMenu.DefaultItems.ClearCanvas />
          <MainMenu.Separator />
          <MainMenu.DefaultItems.ToggleTheme allowSystemTheme theme={themeChoice} onSelect={pickTheme} />
          <MainMenu.DefaultItems.ChangeCanvasBackground />
        </MainMenu>
        <WelcomeScreen>
          <WelcomeScreen.Center>
            <WelcomeScreen.Center.Heading>Your agent will draw here — you can draw too.</WelcomeScreen.Center.Heading>
          </WelcomeScreen.Center>
        </WelcomeScreen>
        <Chrome>
          {pill}
          {saving && <SaveForm initialName={title} onSave={save} onClose={closeSave} />}
        </Chrome>
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
