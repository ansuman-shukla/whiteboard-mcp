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
- **Built for explaining.** Nine compact tools (~6 KB of schema per turn). Labels, arrows that stay bound to shapes, focus with highlight, screenshots so the agent can check its own layout, Mermaid for quick sequence diagrams.
- **Lightweight and local.** `ws` is the only runtime dependency, with no native addons. One small shared daemon serves every agent session and exits when idle. Nothing leaves your machine; fonts are bundled.

## Quick start

Requires Node.js 20+.

```sh
git clone https://github.com/ansuman-shukla/whiteboard-mcp && cd whiteboard-mcp
npm install && npm run build
node dist/cli.js open         # opens your workspace board in the browser
```

Then add the MCP server to your agent (below) and ask it to explain something "on the canvas".

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
| `canvas_open` | Show this chat's board beside the chat, name it (`title`), or switch to another chat's board in this workspace (`board`) |
| `canvas_read` | Describe the board compactly, plus what you changed and noted since the agent's last read |
| `canvas_draw` | Create or update elements: shapes, text, labelled arrows bound with `from`/`to`, frames |
| `canvas_delete` | Delete elements by id, or clear the board |
| `canvas_focus` | Scroll the viewer to elements, optionally pulsing a highlight around them |
| `canvas_screenshot` | PNG of the board (or some elements) so the agent can check its layout |
| `canvas_mermaid` | Convert a Mermaid diagram and add it to the board |
| `canvas_export` | Save the board as `.excalidraw` or `.png` inside the workspace |
| `canvas_guide` | Short drawing guide for explaining well (layout, colours, sizes) |

Every tool result also says when you've changed something since the agent's last `canvas_read`. MCP can't interrupt the agent mid-turn, so when you draw something for it, tell it to "look at the canvas".

## Boards and scope

```
workspace folder ("space")
├─ chat "what is MCP?"        → its own board, titled by topic
├─ chat "auth architecture"   → its own board
└─ any chat can list these and open one: canvas_open {"board":"auth architecture"}
```

- **One board per chat**, created on its first drawing, kept in `~/.whiteboard-mcp/canvases/`. Closing the chat or restarting keeps it.
- **Boards belong to the workspace folder** (the agent's MCP root, else its working directory). Chats in the same folder can read and draw on each other's boards; other folders don't see them.
- **How a chat is identified**, first match wins: the host's chat id in tool-call `_meta` (`sessionId`, `conversationId`, `chatId`…), `WHITEBOARD_CHAT_ID`, the output of `WHITEBOARD_CHAT_COMMAND`, else the MCP server process. Set one of the env vars if your agent restarts its MCP servers within a chat and you want it to keep its board.

## Where the board appears

```
canvas_open / canvas_draw while nobody is watching
   ├─ an editor panel host is connected (e.g. a VS Code-style extension) → shown beside the chat
   ├─ agent runs inside an editor without a panel host → nothing opens; the agent tells you how to open it
   └─ elsewhere (terminal agents) → your browser
```

Panel hosts connect to the daemon at `/ws/host` (token-protected) and say which folders they show; the daemon asks the one showing the board's workspace (else the focused one) to open it. The agent never gets the board link while a panel can show it, and it is told not to open board links in browser or preview tools.

## Configuration

| Variable | Default | Purpose |
|---|---|---|
| `WHITEBOARD_OPEN` | `auto` | When no panel host is connected: `auto` (browser, but nothing inside an editor), `browser`, `none`, or a command template containing `{url}` (run without a shell), e.g. `firefox --new-window {url}` |
| `WHITEBOARD_CHAT_ID` | | Fixed chat id for this MCP server process |
| `WHITEBOARD_CHAT_COMMAND` | | Command printing the current chat id (run once, without a shell), for hosts that restart MCP servers within a chat |
| `WHITEBOARD_PORT` | `47428` | Daemon port (falls back to a free port if taken by something else) |
| `WHITEBOARD_HOME` | `~/.whiteboard-mcp` | State: boards, token, daemon info, logs |
| `WHITEBOARD_IDLE_MS` | `1800000` | Daemon exits after this long with no viewers or requests (`0` = never) |
| `WHITEBOARD_WORKSPACE` | MCP root or cwd | Override the workspace used to pick the default board |
| `WHITEBOARD_EXPORT_DIR` | | Extra directory `canvas_export` may write to (besides the workspace and temp) |
| `WHITEBOARD_DEBUG` | | `1` logs MCP diagnostics to stderr |

CLI: `whiteboard-mcp [mcp] | call <tool> [json|-] | tools | open | url [board] | status | stop | serve`. CLI calls act as one chat with its own board; `url` prints its viewer link, or a workspace board's by title.

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
npm run check       # everything
```

Architecture notes for contributors: [AGENTS.md](AGENTS.md).

## License

MIT. The canvas is built on [Excalidraw](https://github.com/excalidraw/excalidraw) (MIT).
