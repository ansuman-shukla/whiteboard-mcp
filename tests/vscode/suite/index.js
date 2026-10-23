'use strict';
// Runs inside a real VS Code extension host (--extensionTestsPath), driven by tests/vscode/vscode.test.ts.
// Two windows run it: "main" (folder W) is the window the agents run in; "other" shows W too, plus the
// agents' workspace X, so routing by folder alone would always pick it. It must never get main's boards.
const vscode = require('vscode');
const { execFile } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const env = process.env;
const dir = env.WB_TEST_DIR;
const role = env.WB_ROLE;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const file = (name) => path.join(dir, name);
const writeJson = (name, value) => fs.writeFileSync(file(name), JSON.stringify(value, null, 1));

async function waitFor(what, check, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  let last;
  while (Date.now() < deadline) {
    try {
      const value = await check();
      if (value) return value;
    } catch (error) {
      last = error;
    }
    await sleep(200);
  }
  throw new Error(`timed out waiting for ${what}${last ? `: ${last.message}` : ''}`);
}

const boardTabs = () =>
  vscode.window.tabGroups.all.flatMap((group) => group.tabs.filter((tab) => tab.input instanceof vscode.TabInputWebview && tab.input.viewType.endsWith('whiteboardMcp.board')));
const boardLabels = () => boardTabs().map((tab) => tab.label);

async function daemon(method, route, body) {
  const res = await fetch(`${env.WB_URL}${route}`, {
    method,
    headers: { Authorization: `Bearer ${env.WB_TOKEN}`, 'Content-Type': 'application/json' },
    body: body && JSON.stringify(body),
    signal: AbortSignal.timeout(10_000),
  });
  return { status: res.status, body: await res.json() };
}

/** Shows a board here through this window's id, which proves the panel host is connected. */
async function connect(id, title, workspace) {
  await daemon('PUT', `/api/canvases/${id}`, { title, workspace });
  return waitFor(`the ${role} window's panel host`, async () => (await daemon('POST', `/api/canvases/${id}/show`, { workspace, host: String(process.pid) })).status === 200);
}

const viewers = async (title) => (await daemon('GET', '/api/canvases')).body.find((board) => board.title === title)?.viewers ?? 0;
const cli = (args, options) =>
  new Promise((resolve) => execFile(env.WB_NODE, [env.WB_CLI, ...args], { timeout: 30_000, ...options }, (error, stdout, stderr) => resolve({ code: error ? error.code ?? 1 : 0, stdout, stderr })));

async function runOther() {
  await connect('ready-other', 'Ready (other)', env.WB_AGENT_WORKSPACE);
  writeJson('other-ready.json', { hostId: String(process.pid) });
  // Report this window's board tabs until main is done, so main's boards would be seen if routed here.
  while (!fs.existsSync(file('main-done'))) {
    writeJson('other-tabs.json', boardLabels());
    await sleep(200);
  }
  writeJson('other-tabs.json', boardLabels());
}

async function runMain(workspace) {
  const results = { hostId: String(process.pid) };
  writeJson('main.json', results);
  // The extension names this window for processes the extension host starts.
  results.extensionHostEnv = env.WHITEBOARD_HOST_ID;
  await connect('ready-main', 'Ready (main)', workspace);
  fs.writeFileSync(file('main-ready'), '');
  results.other = await waitFor('the other window', () => fs.existsSync(file('other-ready.json')) && JSON.parse(fs.readFileSync(file('other-ready.json'), 'utf8')), 90_000);

  // Without a window id the daemon picks by folder, and only the other window shows the agents' workspace.
  const agentWorkspace = env.WB_AGENT_WORKSPACE;
  await daemon('PUT', '/api/canvases/unhinted', { title: 'Unhinted', workspace: agentWorkspace });
  results.unhinted = (await daemon('POST', '/api/canvases/unhinted/show', { workspace: agentWorkspace })).status;
  results.unhintedHere = boardLabels().includes('Unhinted');

  // An agent in this window's integrated terminal. CLI calls of one folder share a chat unless told apart.
  const terminal = vscode.window.createTerminal({
    name: 'agent',
    cwd: workspace,
    shellPath: '/bin/sh',
    shellArgs: ['-c', `env > "${file('terminal-env.txt')}"; WHITEBOARD_WORKSPACE="${agentWorkspace}" WHITEBOARD_CHAT_ID=terminal-agent "${env.WB_NODE}" "${env.WB_CLI}" call canvas_open '{"title":"Terminal agent board"}' > "${file('terminal-call.txt')}" 2>&1; echo $? > "${file('terminal-exit.txt')}"`],
  });
  results.terminalExit = (await waitFor('the terminal agent', () => fs.existsSync(file('terminal-exit.txt')) && fs.readFileSync(file('terminal-exit.txt'), 'utf8').trim(), 60_000));
  terminal.dispose();
  results.terminalHostId = /^WHITEBOARD_HOST_ID=(.*)$/m.exec(fs.readFileSync(file('terminal-env.txt'), 'utf8'))?.[1] ?? null;
  results.terminalCall = fs.readFileSync(file('terminal-call.txt'), 'utf8');
  results.terminalTab = boardLabels().includes('Terminal agent board');

  // A process the extension host starts itself, like an agent extension or the editor's MCP servers.
  results.spawned = await cli(['call', 'canvas_open', '{"title":"Extension agent board"}'], { cwd: workspace, env: { ...process.env, WHITEBOARD_WORKSPACE: agentWorkspace, WHITEBOARD_CHAT_ID: 'extension-agent' } });
  results.spawnedTab = boardLabels().includes('Extension agent board');

  // VS Code's own MCP server (the user's mcp.json from the runner), as its agent mode would call it.
  results.mcp = await mcpCall();
  results.mcpTab = await waitFor('the MCP board tab', () => boardLabels().includes('Editor agent board'), 15_000).catch(() => false);

  results.viewers = {};
  for (const title of ['Terminal agent board', 'Extension agent board', 'Editor agent board']) results.viewers[title] = await waitFor(`a live viewer of ${title}`, () => viewers(title), 15_000).catch(() => 0);

  // Showing a board again reveals its own tab instead of opening another.
  const terminalBoard = (await daemon('GET', '/api/canvases')).body.find((board) => board.title === 'Terminal agent board');
  results.reshown = terminalBoard ? (await daemon('POST', `/api/canvases/${terminalBoard.id}/show`, { workspace, host: results.hostId })).status : 0;
  results.active = await waitFor('the terminal board to be revealed', () => boardTabs().find((tab) => tab.isActive && tab.label === 'Terminal agent board')?.label, 10_000).catch(() => null);
  // Another window's id never shows here, even for this folder.
  results.otherWindowId = (await daemon('POST', '/api/canvases/ready-main/show', { workspace, host: '1' })).status;

  results.mainTabs = boardLabels();
  return results;
}

async function mcpCall() {
  try {
    await vscode.commands.executeCommand('workbench.mcp.startServer', 'mcp.config.usrlocal.whiteboard', { promptType: 'none', waitForLiveTools: true });
    const tool = await waitFor('the whiteboard MCP tools', () => vscode.lm.tools.find((t) => t.name.endsWith('canvas_open') && t.name.includes('whiteboard')), 20_000);
    const result = await vscode.lm.invokeTool(tool.name, { input: { title: 'Editor agent board' }, toolInvocationToken: undefined }, new vscode.CancellationTokenSource().token);
    return { tool: tool.name, text: result.content.map((part) => part.value ?? '').join('\n') };
  } catch (error) {
    return { error: String(error?.stack ?? error) };
  }
}

exports.run = async () => {
  const workspace = vscode.workspace.workspaceFolders[0].uri.fsPath;
  await vscode.extensions.getExtension('ansuman-shukla.whiteboard-mcp').activate();
  if (role === 'other') return runOther();
  let results = {};
  try {
    results = await runMain(workspace);
  } catch (error) {
    results.error = String(error?.stack ?? error);
  } finally {
    writeJson('main.json', results);
    fs.writeFileSync(file('main-done'), '');
  }
};
