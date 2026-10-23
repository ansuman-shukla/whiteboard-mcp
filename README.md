# whiteboard-mcp

**A live whiteboard your coding agent draws on while it explains things to you.**

Ask "how does login work here?" and instead of a wall of text, your agent sketches it on a whiteboard next to the chat, step by step, pointing at the parts it's talking about. You can draw back or leave a note, and the agent sees it on its next turn.

![The agent draws a login flow step by step, highlights the parts it explains, then answers a note left by the human](docs/media/demo.gif)

Works with Claude Code, Codex, Cursor, Gemini CLI, OpenCode, Devin, VS Code, and any other MCP client. Agents without MCP can use the plain CLI.

## What it can do

### Explain step by step

The agent opens a board for the topic, draws one idea at a time (components, then the flow between them, then notes) and highlights what it's talking about. Arrows stay attached to boxes, so the agent can move and restyle things without redrawing. It can also take a screenshot of the board to check its own layout.

### Listen when you draw back

It's your board too. Circle something, scribble a question, move a box, or press **Note** to send a message. On its next look the agent gets a short list of exactly what you changed:

<img src="docs/media/draw-back.png" alt="A hand-drawn red circle around Redis with the note 'single point of failure?'" width="720">

```text
Human changes since your last read:
Added (2):
  freedraw "RSPj…" hand sketch (1345,193) 254×140 stroke #e03131
  text "2CLo…" "single point of failure?" (1090,92) stroke #e03131
```

> MCP can't interrupt the agent mid-turn, so after you draw, just tell it to "look at the board".

### Quick diagrams from Mermaid

For sequence diagrams and quick flowcharts the agent can write Mermaid and get an editable hand-drawn diagram:

<img src="docs/media/mermaid.png" alt="An OAuth login sequence diagram converted from Mermaid" width="480">

### Keep and share boards

- **One board per chat**, named after the topic and saved on disk, so it's still there after a restart.
- Any later chat can open another chat's board by name: *"open the auth architecture board"*. It looks in this project first, then everywhere, so it also works in apps that start every task in a new folder (like Codex desktop).
- **Save a frozen copy** to your library from the board's menu, with Cmd/Ctrl+S, or by asking the agent. Any later chat, in any project, can search your boards by the text on them and load a copy.
- Export any board as `.excalidraw` (open it at [excalidraw.com](https://excalidraw.com)) or `.png`.

More in [docs/boards.md](docs/boards.md).

### Light and local

- One runtime dependency (`ws`), no native addons, nothing to compile.
- A small shared background process serves every agent session and exits when idle.
- Everything stays on your machine: local-only server, token-protected, fonts bundled. Details in [docs/security.md](docs/security.md).
- Eleven compact tools, about 7 KB of schema per turn, so it barely touches your context window.

## Quick start

Requires Node.js 20+.

**1. Install**

```sh
git clone https://github.com/ansuman-shukla/whiteboard-mcp && cd whiteboard-mcp
npm install && npm run build
```

**2. Add it to your agent** (Claude Code shown; replace `/abs/path` with your clone's path)

```sh
claude mcp add whiteboard --scope user -- node /abs/path/dist/cli.js
```

Codex, Cursor, Gemini CLI, OpenCode, Devin, VS Code, Claude Desktop and agents without MCP: see [docs/clients.md](docs/clients.md).

**3. Ask for a drawing**

The board opens in your browser, or in a tab beside the chat in VS Code, Cursor, Windsurf and Devin Desktop ([details](docs/boards.md#where-the-board-appears)). A few things to try:

- *"Explain how a request flows through this repo, on the whiteboard."*
- *"Sketch the state machine in `src/checkout.ts`."*
- *"Compare option A and option B side by side on the board."*
- *"I drew something on the board, take a look."*

**Optional:**

- Using VS Code, Cursor or Windsurf? Install the [IDE panel extension](docs/ide-panel.md) to get boards in an editor tab beside the chat instead of the browser.
- Install the bundled skill (`skills/whiteboard-explainer/`) so the agent knows when a drawing helps and how to explain well. See [docs/clients.md](docs/clients.md#the-skill-recommended-for-every-agent).

## Tools

| Tool | What it does |
|---|---|
| `canvas_open` | Show this chat's board, give it a title, open another chat's board (this project first, then any folder), or load a saved copy |
| `canvas_draw` | Create or update shapes, text, labelled arrows bound to shapes, frames |
| `canvas_read` | Describe the board, plus what you changed and noted since the agent last looked |
| `canvas_focus` | Scroll your view to some elements and pulse a highlight around them |
| `canvas_screenshot` | PNG of the board so the agent can check its layout |
| `canvas_mermaid` | Turn a Mermaid diagram into hand-drawn elements |
| `canvas_delete` | Delete elements, or clear the board |
| `canvas_export` | Save the board as `.excalidraw` or `.png` in your project |
| `canvas_save` | Save a frozen copy of the board to your library, so later chats can find it |
| `canvas_search` | Find other chats' boards and saved copies, in every folder, by name or the text on them |
| `canvas_guide` | Short guide for the agent on explaining well (layout, colours, sizes) |

Every tool result also tells the agent when you've changed something since its last `canvas_read`.

## How it works

```
 you ◀──── chat ────▶ coding agent
  │                        │ MCP (stdio) or CLI
  │                        ▼
  │                whiteboard-mcp ── HTTP + token ──▶ canvas daemon (127.0.0.1)
  │                                                     │  JSON files on disk
  └──── draws / watches ◀──── WebSocket ──── Excalidraw viewer
```

Each agent session runs its own small MCP server. They all talk to one shared daemon on `127.0.0.1`, which stores boards as JSON and syncs them live with the [Excalidraw](https://github.com/excalidraw/excalidraw) viewer in your browser or editor.

## Docs

- [Client setup](docs/clients.md): every supported agent, the CLI, and the skill
- [Boards](docs/boards.md): which board a chat gets, finding and saving boards, and which window it shows up in
- [IDE panel](docs/ide-panel.md): boards in a tab beside the chat in VS Code, Cursor and Windsurf
- [Configuration](docs/configuration.md): environment variables and CLI commands
- [Security](docs/security.md)
- [AGENTS.md](AGENTS.md): architecture notes for contributors

## Development

```sh
npm install
npm run typecheck   # server + viewer
npm test            # unit + integration (builds dist/ first)
npm run build       # viewer (Vite) + server (tsc)
npm run test:e2e    # Playwright: real daemon + viewer in Chromium
npm run check       # everything
npm run build:vscode  # IDE panel extension (.vsix), see docs/ide-panel.md
```

## License

MIT. The canvas is built on [Excalidraw](https://github.com/excalidraw/excalidraw) (MIT).
