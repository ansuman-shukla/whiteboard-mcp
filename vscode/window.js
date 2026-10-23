'use strict';
// Window identity: agents started from this window tell the daemon which window they run in.

const HOST_ID_VAR = 'WHITEBOARD_HOST_ID';

/**
 * Puts this window's `hostId` in WHITEBOARD_HOST_ID for every agent it starts, so the daemon shows their
 * boards here and not in another window on the same folder. Integrated terminals get it from the
 * environment variable collection; processes the extension host spawns itself (the editor's own MCP
 * servers, agent extensions such as Claude Code) inherit the extension host's environment.
 *
 * Not persistent: a persisted collection hands terminals restored at startup the previous session's id,
 * which no window announces any more, and the daemon never sends a hinted board to another window.
 * Without the variable the daemon falls back to the window showing the board's folder.
 * @param {import('vscode').EnvironmentVariableCollection} collection
 */
function announceWindow(collection, hostId, env = process.env) {
  collection.persistent = false;
  collection.description = 'Shows whiteboards drawn by agents in this terminal in this window.';
  collection.replace(HOST_ID_VAR, hostId);
  env[HOST_ID_VAR] = hostId;
  return {
    dispose() {
      collection.delete(HOST_ID_VAR);
      if (env[HOST_ID_VAR] === hostId) delete env[HOST_ID_VAR];
    },
  };
}

module.exports = { announceWindow, HOST_ID_VAR };
