'use strict';
const vscode = require('vscode');
const { WhiteboardHost, whiteboardHome } = require('./host');
const { BoardTabs } = require('./tabs');
const { announceWindow } = require('./window');

const untitled = (board) => !board.title || board.title === board.id;

async function openBoard(host, tabs) {
  const boards = await host.boards();
  if (!boards.length) return void vscode.window.showInformationMessage('No whiteboards in this workspace yet. Ask your agent to explain something on the whiteboard.');
  const items = boards.map((board) => ({
    label: untitled(board) ? 'Untitled board' : board.title,
    description: `${board.elementCount} elements`,
    detail: new Date(board.updatedAt).toLocaleString(),
    board,
  }));
  const chosen = items.length === 1 ? items[0] : await vscode.window.showQuickPick(items, { placeHolder: 'Open a whiteboard from this workspace' });
  if (chosen) tabs.show(chosen.board.id, host.viewerUrl(chosen.board.id), chosen.label);
}

function activate(context) {
  if (typeof WebSocket !== 'function') {
    void vscode.window.showWarningMessage('Whiteboard MCP needs a newer editor (VS Code 1.101 or later) to show boards beside the chat.');
    return;
  }
  // The extension host is this window's process: its pid names the window, as in Windsurf and Devin Desktop,
  // whose chats already carry it as WINDSURF_EXT_HOST_PID.
  const hostId = String(process.pid);
  const tabs = new BoardTabs(vscode);
  const host = new WhiteboardHost({
    home: whiteboardHome(vscode.workspace.getConfiguration('whiteboardMcp').get('home')),
    hostId,
    folders: () => (vscode.workspace.workspaceFolders ?? []).map((folder) => folder.uri.fsPath),
    focused: () => vscode.window.state.focused,
    onShow: ({ canvasId, url, title }) => tabs.show(canvasId, url, title),
  });
  host.start();
  context.subscriptions.push(
    announceWindow(context.environmentVariableCollection, hostId),
    { dispose: () => host.dispose() },
    { dispose: () => tabs.dispose() },
    vscode.window.onDidChangeWindowState(() => host.update()),
    vscode.workspace.onDidChangeWorkspaceFolders(() => host.update()),
    vscode.commands.registerCommand('whiteboardMcp.openBoard', () => openBoard(host, tabs).catch((error) => vscode.window.showErrorMessage(error.message))),
  );
}

function deactivate() {}

module.exports = { activate, deactivate };
