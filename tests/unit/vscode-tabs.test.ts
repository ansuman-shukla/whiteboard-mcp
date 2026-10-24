import { createRequire } from 'node:module';
import { describe, expect, it } from 'vitest';

const require = createRequire(import.meta.url);
const { BoardTabs, VIEW_TYPE } = require('../../vscode/tabs.js');

const BESIDE = -2;

interface FakePanel {
  viewType: string;
  title: string;
  showOptions: { viewColumn: number; preserveFocus: boolean };
  options: unknown;
  viewColumn: number;
  iconPath?: { id: string };
  reveals: Array<{ column: unknown; preserveFocus: boolean }>;
  webview: { html: string };
  disposed?: boolean;
  dispose(): void;
  listeners(): number;
}

/** Just enough of the vscode API for webview tabs, recording what the extension does. */
function fakeVscode({ theme = 2, commands = [] as string[] } = {}) {
  const created: FakePanel[] = [];
  const executed: unknown[][] = [];
  let nextColumn = 2;
  const vscode = {
    ViewColumn: { Beside: BESIDE },
    Uri: { parse: (value: string) => ({ uri: value }) },
    commands: {
      getCommands: async () => commands,
      executeCommand: async (...args: unknown[]) => void executed.push(args),
    },
    ColorThemeKind: { Light: 1, Dark: 2, HighContrast: 3, HighContrastLight: 4 },
    ThemeIcon: class {
      constructor(readonly id: string) {}
    },
    window: {
      activeColorTheme: { kind: theme },
      createWebviewPanel(viewType: string, title: string, showOptions: FakePanel['showOptions'], options: unknown): FakePanel {
        const disposeListeners = new Set<() => void>();
        const panel: FakePanel = {
          viewType,
          title,
          showOptions,
          options,
          // "Beside" opens a new editor group; a concrete column joins that group.
          viewColumn: showOptions.viewColumn === BESIDE ? nextColumn++ : showOptions.viewColumn,
          reveals: [],
          webview: { html: '' },
          reveal(column: unknown, preserveFocus: boolean) {
            panel.reveals.push({ column, preserveFocus });
          },
          onDidDispose(fn: () => void) {
            disposeListeners.add(fn);
            return { dispose: () => disposeListeners.delete(fn) };
          },
          dispose() {
            panel.disposed = true;
            for (const fn of [...disposeListeners]) fn();
          },
          listeners: () => disposeListeners.size,
        } as FakePanel & { onDidDispose(fn: () => void): { dispose(): void } };
        created.push(panel);
        return panel;
      },
    },
  };
  return { vscode, created, executed };
}

const board = (id: string, port = 47428) => `http://127.0.0.1:${port}/c/${id}?token=tok`;
const iframeSrc = (panel: FakePanel) => /<iframe src="([^"]+)"/.exec(panel.webview.html)![1]!.replace(/&quot;/g, '"').replace(/&amp;/g, '&');

describe('BoardTabs', () => {
  it("opens one tab per board beside the chat, titled after the board, and never retargets another board's tab", () => {
    const { vscode, created } = fakeVscode();
    const tabs = new BoardTabs(vscode);
    tabs.show('app-111111', board('app-111111'), 'How MCP works');
    tabs.show('app-222222', board('app-222222'), 'Auth flow');
    expect(created).toHaveLength(2);
    expect(created.map((p) => p.title)).toEqual(['How MCP works', 'Auth flow']);
    expect(created.map((p) => p.viewType)).toEqual([VIEW_TYPE, VIEW_TYPE]);
    expect(created[0]!.showOptions).toEqual({ viewColumn: BESIDE, preserveFocus: true });
    // Later boards join the first board's group as tabs instead of splitting the editor again.
    expect(created[1]!.showOptions).toEqual({ viewColumn: created[0]!.viewColumn, preserveFocus: true });
    expect(iframeSrc(created[0]!)).toBe('http://127.0.0.1:47428/c/app-111111?token=tok&embed=1&theme=dark');
    expect(iframeSrc(created[1]!)).toBe('http://127.0.0.1:47428/c/app-222222?token=tok&embed=1&theme=dark');
    expect(created[1]!.options).toEqual({ enableScripts: true, retainContextWhenHidden: true });
    expect(created[0]!.iconPath!.id).toBe('edit');
    expect(created[0]!.webview.html).toMatch(/Content-Security-Policy" content="default-src 'none'; frame-src http:\/\/127\.0\.0\.1:\* http:\/\/localhost:\*;/);
  });

  it('showing a board again reveals its own tab in place without reloading it or opening another', () => {
    const { vscode, created } = fakeVscode();
    const tabs = new BoardTabs(vscode);
    tabs.show('app-111111', board('app-111111'), 'How MCP works');
    tabs.show('app-222222', board('app-222222'), 'Auth flow');
    const html = created[0]!.webview.html;
    tabs.show('app-111111', board('app-111111'), 'How MCP works (renamed)');
    expect(created).toHaveLength(2);
    expect(created[0]!.reveals).toEqual([{ column: undefined, preserveFocus: true }]);
    expect(created[1]!.reveals).toEqual([]);
    expect(created[0]!.title).toBe('How MCP works (renamed)');
    expect(created[0]!.webview.html).toBe(html);
    expect(iframeSrc(created[1]!)).toBe('http://127.0.0.1:47428/c/app-222222?token=tok&embed=1&theme=dark');
    // The daemon restarted on another port: the same board's tab follows it.
    tabs.show('app-111111', board('app-111111', 50000), 'How MCP works');
    expect(iframeSrc(created[0]!)).toBe('http://127.0.0.1:50000/c/app-111111?token=tok&embed=1&theme=dark');
    expect(created).toHaveLength(2);
  });

  it('closing a tab forgets it, so the board opens in a new tab next time', () => {
    const { vscode, created } = fakeVscode();
    const tabs = new BoardTabs(vscode);
    tabs.show('app-111111', board('app-111111'), 'How MCP works');
    tabs.show('app-222222', board('app-222222'), 'Auth flow');
    created[0]!.dispose();
    expect(created[0]!.listeners()).toBe(0);
    expect([...tabs.tabs.keys()]).toEqual(['app-222222']);
    tabs.show('app-111111', board('app-111111'), 'How MCP works');
    expect(created).toHaveLength(3);
    expect(created[2]!.showOptions.viewColumn).toBe(created[1]!.viewColumn);
    tabs.dispose();
    expect(created[1]!.disposed && created[2]!.disposed).toBe(true);
    expect(tabs.tabs.size).toBe(0);
  });

  it('gives untitled boards a generic title, follows light themes, escapes the URL and shows only local boards', () => {
    const { vscode, created } = fakeVscode({ theme: 4 });
    const tabs = new BoardTabs(vscode);
    tabs.show('app-333333', board('app-333333'), 'app-333333');
    tabs.show('app-444444', `${board('app-444444')}&x="><script>`, '');
    expect(created.map((p) => p.title)).toEqual(['Whiteboard', 'Whiteboard']);
    expect(iframeSrc(created[0]!)).toMatch(/theme=light$/);
    expect(created[1]!.webview.html).not.toContain('"><script>');
    expect(created[0]!.webview.html).toContain('?token=tok&amp;embed=1&amp;theme=light"');
    expect(() => tabs.show('x', 'https://evil.example/c/x', 'X')).toThrow(/Only local/);
    expect(() => tabs.show('y', 'http://192.168.1.2:1/c/y', 'Y')).toThrow(/Only local/);
    expect(() => tabs.show('z', 'https://127.0.0.1:1/c/z', 'Z')).toThrow(/Only local/);
    expect(created).toHaveLength(2);
    expect(tabs.tabs.size).toBe(2);
  });

  describe('in the built-in browser (whiteboardMcp.openIn = "browser")', () => {
    it("opens the board in VS Code's integrated browser beside the chat, reusing that board's page", async () => {
      const { vscode, created, executed } = fakeVscode({ commands: ['workbench.action.browser.open', 'simpleBrowser.api.open'] });
      const tabs = new BoardTabs(vscode, () => 'browser');
      await tabs.show('app-111111', board('app-111111'), 'How MCP works');
      expect(created).toEqual([]);
      expect(executed).toEqual([
        ['workbench.action.browser.open', { url: 'http://127.0.0.1:47428/c/app-111111?token=tok&embed=1&theme=dark', openToSide: true, reuseUrlFilter: 'http://127.0.0.1:47428/c/app-111111' }],
      ]);
    });

    it('uses Simple Browser in editors without the integrated browser', async () => {
      const { vscode, created, executed } = fakeVscode({ commands: ['simpleBrowser.api.open'] });
      await new BoardTabs(vscode, () => 'browser').show('app-111111', board('app-111111'), 'How MCP works');
      expect(created).toEqual([]);
      expect(executed).toEqual([['simpleBrowser.api.open', { uri: 'http://127.0.0.1:47428/c/app-111111?token=tok&embed=1&theme=dark' }, { viewColumn: BESIDE, preserveFocus: true }]]);
    });

    it('falls back to a board tab when the editor has no built-in browser', async () => {
      const { vscode, created, executed } = fakeVscode();
      await new BoardTabs(vscode, () => 'browser').show('app-111111', board('app-111111'), 'How MCP works');
      expect(executed).toEqual([]);
      expect(created).toHaveLength(1);
    });
  });
});
