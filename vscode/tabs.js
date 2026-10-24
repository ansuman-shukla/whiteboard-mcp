'use strict';
// Board tabs: one per board, so showing one chat's board never hides another chat's.

const { randomBytes } = require('node:crypto');

const VIEW_TYPE = 'whiteboardMcp.board';
const LOCAL_HOSTS = ['127.0.0.1', 'localhost'];

function boardHtml(src) {
  const nonce = randomBytes(16).toString('base64');
  return `<!doctype html><html><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; frame-src http://127.0.0.1:* http://localhost:*; style-src 'nonce-${nonce}';">
<style nonce="${nonce}">html,body,iframe{margin:0;padding:0;border:0;width:100%;height:100%;overflow:hidden;display:block}</style>
</head><body><iframe src="${src.replace(/&/g, '&amp;').replace(/"/g, '&quot;')}" sandbox="allow-scripts allow-same-origin allow-forms allow-popups allow-downloads" allow="clipboard-read; clipboard-write"></iframe></body></html>`;
}

/** The editor's built-in browser: VS Code's integrated browser, else Simple Browser (VS Code forks). */
const INTEGRATED_BROWSER = 'workbench.action.browser.open';
const SIMPLE_BROWSER = 'simpleBrowser.api.open';

class BoardTabs {
  /**
   * @param {typeof import('vscode')} vscode
   * @param {() => string} openIn "tab" (a board tab) or "browser" (the editor's built-in browser, when it has one)
   */
  constructor(vscode, openIn = () => 'tab') {
    this.vscode = vscode;
    this.openIn = openIn;
    /** @type {Map<string, { panel: import('vscode').WebviewPanel, src: string }>} board id → its tab */
    this.tabs = new Map();
  }

  /** Adds the editor theme and embed flag to a board URL from the whiteboard daemon. */
  embedUrl(raw) {
    const url = new URL(raw);
    if (url.protocol !== 'http:' || !LOCAL_HOSTS.includes(url.hostname)) throw new Error('Only local whiteboard URLs can be shown.');
    url.searchParams.set('embed', '1');
    const { kind } = this.vscode.window.activeColorTheme;
    const { Light, HighContrastLight } = this.vscode.ColorThemeKind;
    url.searchParams.set('theme', kind === Light || kind === HighContrastLight ? 'light' : 'dark');
    return url.toString();
  }

  /** Shows the board beside the chat: in the editor's built-in browser if the user picked it, else in its tab. */
  show(canvasId, url, title = '') {
    const src = this.embedUrl(url);
    if (this.openIn() !== 'browser') return this.showTab(canvasId, src, title);
    return this.showInBrowser(src).then((shown) => (shown ? undefined : this.showTab(canvasId, src, title)));
  }

  /** Reveals the board's own tab, else opens a new tab beside the chat, next to the other boards. */
  showTab(canvasId, src, title) {
    const label = title && title !== canvasId ? title : 'Whiteboard';
    const tab = this.tabs.get(canvasId);
    if (tab) {
      tab.panel.title = label;
      tab.panel.reveal(undefined, true);
      if (tab.src !== src) this.load(tab, src);
      return;
    }
    const column = [...this.tabs.values()].map((t) => t.panel.viewColumn).filter(Boolean).at(-1) ?? this.vscode.ViewColumn.Beside;
    const panel = this.vscode.window.createWebviewPanel(VIEW_TYPE, label, { viewColumn: column, preserveFocus: true }, {
      enableScripts: true,
      retainContextWhenHidden: true,
    });
    panel.iconPath = new this.vscode.ThemeIcon('edit');
    const entry = { panel, src: '' };
    const closed = panel.onDidDispose(() => {
      closed.dispose();
      if (this.tabs.get(canvasId) === entry) this.tabs.delete(canvasId);
    });
    this.tabs.set(canvasId, entry);
    this.load(entry, src);
  }

  /** Opens the board in the editor's built-in browser beside the chat, reusing its page there; false without one. */
  async showInBrowser(src) {
    const commands = await this.vscode.commands.getCommands(true);
    if (commands.includes(INTEGRATED_BROWSER)) {
      const page = new URL(src);
      await this.vscode.commands.executeCommand(INTEGRATED_BROWSER, { url: src, openToSide: true, reuseUrlFilter: `${page.origin}${page.pathname}` });
      return true;
    }
    if (commands.includes(SIMPLE_BROWSER)) {
      await this.vscode.commands.executeCommand(SIMPLE_BROWSER, this.vscode.Uri.parse(src), { viewColumn: this.vscode.ViewColumn.Beside, preserveFocus: true });
      return true;
    }
    return false;
  }

  load(tab, src) {
    tab.src = src;
    tab.panel.webview.html = boardHtml(src);
  }

  dispose() {
    for (const { panel } of [...this.tabs.values()]) panel.dispose();
  }
}

module.exports = { BoardTabs, VIEW_TYPE };
