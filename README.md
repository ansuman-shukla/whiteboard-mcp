# whiteboard-mcp

**A live whiteboard your coding agent draws on while it explains things to you.**

Ask your agent "how does auth work here?" and instead of a wall of text or a markdown table, it sketches the flow on a whiteboard next to the chat, step by step, pointing at the parts it's talking about. You can draw back, move boxes, or leave a note ("what about the cache?"), and the agent reads your changes on its next turn.

It's an MCP server (plus a plain CLI) that any coding agent can use, with a hand-drawn [Excalidraw](https://github.com/excalidraw/excalidraw) canvas that opens in your browser or an editor split view.

```
 you ◀──── chat ────▶ coding agent
  │                        │ MCP (stdio) or CLI
  │                        ▼
  │                whiteboard-mcp ── HTTP + token ──▶ canvas daemon (127.0.0.1)
  │                                                     │  JSON files on disk
  └──── draws / watches ◀──── WebSocket ──── Excalidraw viewer
```

- **Works with any MCP client.** Claude Code, Codex CLI, OpenCode, Cursor, Gemini CLI, Devin, VS Code. Agents without MCP (e.g. pi) can use the `whiteboard-mcp call` CLI plus the bundled skill.
- **Both directions.** The agent draws; you edit, sketch, or send a "note to agent". It sees what you changed since its last look.
- **Keep what's worth keeping.** Save a board from the menu (or Cmd/Ctrl+S) or let the agent save it; any later chat, in any harness or workspace, can search your saved boards and load one.
- **Built for explaining.** Eleven compact tools (~7 KB of schema per turn). Labels, arrows that stay bound to shapes, focus with highlight, screenshots so the agent can check its own layout, Mermaid for quick sequence diagrams.
- **Lightweight and local.** `ws` is the only runtime dependency, with no native addons. One small shared daemon serves every agent session and exits when idle. Nothing leaves your machine; fonts are bundled.

## Quick start

Requires Node.js 20+.

```sh
git clone https://github.com/ansuman-shukla/whiteboard-mcp && cd whiteboard-mcp
npm install && npm run build
node dist/cli.js open         # opens your workspace board in the browser
```

Then add the MCP server to your agent (below) and ask it to explain something "on the canvas".

Using VS Code, Cursor or Windsurf? Install the [IDE panel extension](docs/ide-panel.md) to get boards in an editor tab beside the chat instead of the browser.

Once published to npm, `npx -y whiteboard-mcp` replaces `node /abs/path/dist/cli.js` in every config below.

## Client setup

Replace `/abs/path` with the path of your clone.

**Claude Code**
```sh
claude mcp add whiteboard --scope user -- node /abs/path/dist/cli.js
```

**OpenAI Codex CLI**
```sh
codex mcp add whiteboard -- node /abs/path/dist/cli.js
```
or in `~/.codex/config.toml`:
```toml
[mcp_servers.whiteboard]
command = "node"
args = ["/abs/path/dist/cli.js"]
```

**Devin CLI**
```sh
devin mcp add whiteboard --scope user -- node /abs/path/dist/cli.js
```
(writes `~/.config/devin/mcp_config.json`; `--scope project` writes `.devin/mcp_config.json`)

**OpenCode** (`opencode.json`)
```json
{ "mcp": { "whiteboard": { "type": "local", "command": ["node", "/abs/path/dist/cli.js"] } } }
```

**Cursor** (`~/.cursor/mcp.json`), **Gemini CLI** (`~/.gemini/settings.json`), **Claude Desktop**
```json
{ "mcpServers": { "whiteboard": { "command": "node", "args": ["/abs/path/dist/cli.js"] } } }
```

**VS Code** (`.vscode/mcp.json`)
```json
{ "servers": { "whiteboard": { "type": "stdio", "command": "node", "args": ["/abs/path/dist/cli.js"] } } }
```

**Agents without MCP (pi and others).** Copy `skills/whiteboard-explainer/` into the agent's skills folder and make `whiteboard-mcp` available on PATH (`npm link`). The agent then runs:
```sh
whiteboard-mcp tools                                  # tool names + input schemas
whiteboard-mcp call canvas_open
whiteboard-mcp call canvas_draw '{"elements":[{"id":"api","type":"rectangle","x":0,"y":0,"label":"API"}]}'
whiteboard-mcp call canvas_read
```
CLI calls share the "last read" cursor, so they behave like one session.

The skill file also helps MCP agents decide when to draw. Install it where your agent loads skills (e.g. `~/.claude/skills/`, `~/.config/devin/skills/`, `~/.agents/skills/`).

## Tools

| Tool | What it does |
|---|---|
| `canvas_open` | Show this chat's board beside the chat, name it (`title`), switch to another chat's board (`board`: this workspace first, then any folder), or load a copy of a saved board into it (`saved`) |
| `canvas_read` | Describe the board compactly, plus what you changed and noted since the agent's last read |
| `canvas_draw` | Create or update elements: shapes, text, labelled arrows bound with `from`/`to`, frames |
| `canvas_delete` | Delete elements by id, or clear the board |
| `canvas_focus` | Scroll the viewer to elements, optionally pulsing a highlight around them |
| `canvas_screenshot` | PNG of the board (or some elements) so the agent can check its layout |
| `canvas_mermaid` | Convert a Mermaid diagram and add it to the board |
| `canvas_export` | Save the board as `.excalidraw` or `.png` inside the workspace |
| `canvas_save` | Save a frozen copy of the board to your library, so later chats can find it |
| `canvas_search` | Search other chats' live boards and saved boards (every folder, this one first) by name or the text on them |
| `canvas_guide` | Short drawing guide for explaining well (layout, colours, sizes) |

Every tool result also says when you've changed something since the agent's last `canvas_read`. MCP can't interrupt the agent mid-turn, so when you draw something for it, tell it to "look at the canvas".

## Boards and scope

```
workspace folder ("space")
├─ chat "what is MCP?"        → its own board, titled by topic
├─ chat "auth architecture"   → its own board
└─ any chat can list these and open one: canvas_open {"board":"auth architecture"}

canvas_open {"board":"<title>"} from anywhere
   1. this folder's boards              → found? open it
   2. every folder, newest first        → one match: open it, saying which folder it came from
                                           several: list their ids, open nothing
                                           none: list the closest boards and saved copies to pick from
```

- **One board per chat**, created on its first drawing, kept in `~/.whiteboard-mcp/canvases/`. Closing the chat or restarting keeps it.
- **Boards are filed by workspace folder** (the agent's MCP root, else its working directory). The list a chat sees is this folder's boards, but **asking by name or id finds a board in any folder**. That matters for apps that start every task in a new folder (Codex desktop uses `~/Documents/Codex/<date>/<task>`): a later task still opens the board an earlier one made. `canvas_search` finds them by the text on them too.
- **How a chat is identified**, first match wins: the host's chat id in tool-call `_meta` (`sessionId`, `conversationId`, `chatId`…), `WHITEBOARD_CHAT_ID`, the output of `WHITEBOARD_CHAT_COMMAND`, else the MCP server process. Set one of the env vars if your agent restarts its MCP servers within a chat and you want it to keep its board.
- **Per harness**: terminal agents (Claude Code, Codex, OpenCode…) start the MCP server with each session, so every new session gets a fresh board (two sessions in one folder never share one). In Devin Desktop through Devin Switch every chat gets its own server and its board follows the conversation id (`WHITEBOARD_CHAT_COMMAND`), even across account handoffs. Desktop's built-in agent runs one agent process per window for all of that window's chats, and so one server: those chats share a board unless the chat id arrives in `_meta`. Any host that shares one server between chats must pass the chat id in `_meta` for separate boards. Another chat's board is only used when asked: `canvas_open {"board":"<title or id>"}`.

## Saved boards

Live boards belong to one chat and change as you both draw. When something is worth keeping, save it:

```
chat A (any harness)                     your library (~/.whiteboard-mcp/saved/)      chat B, days later, any workspace
  Excalidraw menu → Save to library  ─┐
  or Cmd/Ctrl+S                       ├─▶  "Auth flow"  (frozen copy)  ◀── canvas_search {"query":"auth"}
  or the agent: canvas_save           ─┘                               ──▶ canvas_open {"saved":"auth-flow-1a2b3c"}
                                                                              (a copy lands in chat B's own board)
```

- **A save is a frozen copy.** Later edits or clears on the live board don't touch it. Saving the same name again (in the same workspace) overwrites that entry.
- **Search covers every workspace**, this workspace's boards first, and lists other chats' live boards next to saved copies. It matches every word against the name, the id, the folder name and the text on the board.
- **Loading copies** the saved drawing into the chat's own board and leaves the saved copy unchanged. If the board already has a drawing the agent must pass `fresh:true` to replace it.
- It's the daemon that stores everything, so it works the same from Claude Code, Codex, Devin, the CLI or anything else.

## Where the board appears

```
canvas_open / canvas_draw while nobody is watching
   ├─ an editor panel host is connected (the IDE panel extension, Devin Switch in Devin Desktop) → shown beside the chat
   ├─ agent runs inside an editor without a panel host → nothing opens; the agent tells you how to open it
   └─ elsewhere (terminal agents) → your browser
```

Panel hosts connect to the daemon at `/ws/host` (token-protected) and say which folders they show, plus an optional `hostId` naming their window. The board opens in the chat's own window: the host whose `hostId` matches the agent's `WHITEBOARD_HOST_ID` (else Windsurf/Devin Desktop's `WINDSURF_EXT_HOST_PID`), otherwise a window showing the board's workspace (focused first) that doesn't announce a different `hostId`. It never opens in an unrelated window, where it would hide that window's own board. The [IDE panel extension](docs/ide-panel.md) sets `WHITEBOARD_HOST_ID` for the agents each window starts. Hosts show each board in its own tab and never retarget another board's tab, so chats never replace each other's boards. The agent never gets the board link while a panel can show it, and it is told not to open board links in browser or preview tools.

## Configuration

| Variable | Default | Purpose |
|---|---|---|
| `WHITEBOARD_OPEN` | `auto` | When no panel host of the chat's window or workspace is connected: `auto` (browser, but nothing inside an editor), `browser`, `none`, or a command template containing `{url}` (run without a shell), e.g. `firefox --new-window {url}` |
| `WHITEBOARD_CHAT_ID` | | Fixed chat id for this MCP server process |
| `WHITEBOARD_CHAT_COMMAND` | | Command printing the current chat id (run once, without a shell), for hosts that restart MCP servers within a chat |
| `WHITEBOARD_HOST_ID` | `WINDSURF_EXT_HOST_PID` | The `hostId` of the editor window (panel host) this agent runs in, so its boards open there |
| `WHITEBOARD_PORT` | `47428` | Daemon port (falls back to a free port if taken by something else) |
| `WHITEBOARD_HOME` | `~/.whiteboard-mcp` | State: boards, saved boards, token, daemon info, logs |
| `WHITEBOARD_IDLE_MS` | `1800000` | Daemon exits after this long with no viewers or requests (`0` = never) |
| `WHITEBOARD_WORKSPACE` | MCP root or cwd | Override the workspace used to pick the default board |
| `WHITEBOARD_EXPORT_DIR` | | Extra directory `canvas_export` may write to (besides the workspace and temp) |
| `WHITEBOARD_DEBUG` | | `1` logs MCP diagnostics to stderr |

CLI: `whiteboard-mcp [mcp] | call <tool> [json|-] | tools | open | url [board] | status | stop | serve`. CLI calls act as one chat with its own board; `url` prints its viewer link, or another board's by id or title (this folder first, then any).

## Security

- The daemon listens on `127.0.0.1` only.
- Every API and WebSocket call needs a random per-user token (`~/.whiteboard-mcp/token`, mode 0600). The viewer URL carries it.
- Requests with a foreign `Host` header (DNS rebinding) or a foreign WebSocket `Origin` are rejected. There are no CORS headers, so other web pages can't talk to it.
- The MCP server never writes outside the workspace/temp, never reads your project's `.env`, and keeps stdout strictly for protocol frames.

## Development

```sh
npm install
npm run typecheck   # server + viewer
npm test            # unit + integration (builds dist/ first)
npm run build       # viewer (Vite) + server (tsc)
npm run test:e2e    # Playwright: real daemon + viewer in Chromium
npm run build:vscode  # IDE panel extension (.vsix), see docs/ide-panel.md
npm run check       # everything
```

Architecture notes for contributors: [AGENTS.md](AGENTS.md).

## License

MIT. The canvas is built on [Excalidraw](https://github.com/excalidraw/excalidraw) (MIT).
