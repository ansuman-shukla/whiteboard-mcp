# IDE panel: boards beside the chat in VS Code, Cursor and Windsurf

The **Whiteboard MCP** extension (`vscode/`) shows every board your agent draws in an editor tab beside the chat, in the window the agent runs in, instead of a browser window.

```
VS Code window A                                   VS Code window B (same folder)
┌───────────────────────────────┬──────────────┐   ┌───────────────────────────┐
│ terminal: claude / codex / …  │ ▢ Auth flow  │   │ its own chats and boards  │
│ Copilot agent mode (MCP)      │ ▢ How MCP …  │   │ never get A's boards      │
└───────────────────────────────┴──────────────┘   └───────────────────────────┘
```

It works for:

- agents in the integrated terminal (Claude Code, Codex CLI, OpenCode, Gemini CLI…), on MCP or through `whiteboard-mcp call`;
- the editor's own agent: MCP servers configured in VS Code (`mcp.json`), e.g. Copilot agent mode;
- agent extensions that start their agent from the extension host (e.g. the Claude Code or Codex extensions).

## Install

Requires VS Code 1.101 or later (its extension host is Node 22 with a built-in WebSocket), or an editor built on that base, such as Cursor 2.1+. Older editors show a warning and the extension stays idle.

The extension isn't on the Marketplace yet. Build the `.vsix` from a clone and install it:

```sh
npm install && npm run build      # whiteboard-mcp itself
npm run build:vscode              # writes build/whiteboard-mcp-<version>.vsix
code --install-extension build/whiteboard-mcp-0.1.0.vsix
```

Cursor and Windsurf have the same flag (`cursor --install-extension …`, `windsurf --install-extension …`), or use **Extensions › … › Install from VSIX…** in any of them.

Then **open a new terminal** (or restart agents already running): only processes started after the extension activated know which window they are in. Nothing else to configure; add whiteboard-mcp to your agent as usual ([client setup](clients.md)). For VS Code's own agent:

```jsonc
// .vscode/mcp.json, or "MCP: Open User Configuration"
{ "servers": { "whiteboard": { "type": "stdio", "command": "npx", "args": ["-y", "@ansuman-shukla/whiteboard-mcp"] } } }
```

**Whiteboard: Open Board** (command palette) lists the boards of the window's folders.

| Setting | Default | Purpose |
|---|---|---|
| `whiteboardMcp.home` | `WHITEBOARD_HOME`, else `~/.whiteboard-mcp` | The daemon's state folder, if your agents use another `WHITEBOARD_HOME`. Machine-scoped, so a workspace can't change it. |

## How a board finds its window

```
window's extension host (pid 4242) ── panel host: hello {hostId: "4242", folders, focused} ──▶ daemon /ws/host
   │ sets WHITEBOARD_HOST_ID=4242 for
   ├─ integrated terminals ............ environment variable collection
   └─ processes it spawns itself ...... its own environment (VS Code's MCP servers, agent extensions)
                 │
              agent ─▶ whiteboard-mcp ─▶ POST /show {host: "4242", workspace} ─▶ the host with hostId 4242
```

- The window id is the extension host's pid, the same id Windsurf and Devin Desktop already give their chats as `WINDSURF_EXT_HOST_PID`. `whiteboard-mcp` sends `WHITEBOARD_HOST_ID` first, else `WINDSURF_EXT_HOST_PID`.
- VS Code itself gives an agent nothing that names its window: `VSCODE_PID` is the main process, shared by all windows, and integrated terminals don't get `VSCODE_IPC_HOOK_CLI` (checked in VS Code 1.142). It starts stdio MCP servers from the extension host with that process's environment, which is why setting it there reaches them.
- Some agents start MCP servers with a stripped environment (Codex passes only `HOME`, `PATH` and a few others). `whiteboard-mcp` then reads the window id, and whether it runs in an editor at all, from its parent processes' starting environment (`ps -E` on macOS, `/proc/<pid>/environ` on Linux). Not on Windows: there, add `env_vars = ["WHITEBOARD_HOST_ID", "VSCODE_PID"]` under `[mcp_servers.whiteboard]` in Codex's `config.toml`.
- The extension activates as soon as the window starts (`*`), before agent extensions such as Claude Code or Codex start their agents, so they inherit the window id.
- VS Code's own agent (Copilot) also renders [boards inline](inline.md); with the panel extension connected, the panel wins and the inline view shrinks to a note.
- A board with a window id only ever opens in that window. Without one (an agent started before the extension activated, or by something outside the editor) it opens in a window showing the board's folder, focused first, never in an unrelated window.
- Each board gets its own tab; showing it again only reveals that tab.
- The agent's first call often starts the daemon, before windows have found it (they watch for `daemon.json`, and retry every 3 s); a request naming a window, or coming from an agent inside an editor, waits up to 5 s for a window to connect. A window id no window announces any more (stale after a reload) falls back to the folder.

## Troubleshooting

**The agent says "No whiteboard panel is connected"**

- Is the extension installed and enabled in this window? An editor older than VS Code 1.101 shows a warning when it starts.
- In the agent's terminal, `echo $WHITEBOARD_HOST_ID` should print a number. Empty: the terminal (or agent) was started before the extension activated; open a new terminal and restart the agent there.
- After **Developer: Reload Window**, **Restart Extension Host** or an extension update, the window gets a new id but terminals that survived keep the old one. Their boards then open in a window showing their folder (the focused one first); with two windows on one folder, relaunch those terminals (VS Code may offer it) or restart the agent in a new terminal.
- Agent and editor must use the same state folder: if the agent sets `WHITEBOARD_HOME`, set `whiteboardMcp.home` to the same path.
- Remote windows (SSH, WSL, dev containers) aren't supported yet: the board is served on the remote machine's `127.0.0.1`.

**The board opened in another window**: check that `echo $WHITEBOARD_HOST_ID` in the agent's terminal matches this window's extension host (`ps -o command= -p $WHITEBOARD_HOST_ID` shows a `Code Helper (Plugin)` / `extensionHost` process). An agent without the variable falls back to the folder, so with two windows on one folder it can pick the focused one.

**Devin Desktop** already has a panel host (Devin Switch's panels extension). Installing this one there too gives the window two hosts with the same id; keep one of them.

## Development

```sh
npm test                                                     # includes the extension's unit tests (tests/unit/vscode-*.test.ts, vsix.test.ts)
npm run build && WHITEBOARD_TEST_VSCODE=1 npx vitest run tests/vscode   # real VS Code, needs a display
```

The real test opens two isolated VS Code windows (temp `--user-data-dir` and `--extensions-dir` under `/tmp`) with the extension under development, starts a daemon with a temp `WHITEBOARD_HOME`, and checks that boards shown by an integrated-terminal agent, a process the extension host starts and VS Code's own MCP server open live, one tab each, in their window and not in the other window on the same folder. `WHITEBOARD_TEST_VSCODE_BIN` points it at another VS Code build; `WHITEBOARD_TEST_VSCODE_KEEP=1` keeps its temp folder.
