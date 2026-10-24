# Inline boards: MCP Apps

In chat apps that implement [MCP Apps](https://github.com/modelcontextprotocol/ext-apps) (the `io.modelcontextprotocol/ui` extension), `canvas_open` shows the live board **inside the conversation** instead of a browser window. Nothing to install or configure: add whiteboard-mcp to the app as usual ([client setup](clients.md)) and start a new chat.

```
┌ chat ─────────────────────────────────────────────┐
│ you: explain how MCP works on the whiteboard      │
│ agent: canvas_open {title: "How MCP works"}       │
│ ┌ board (live) ─────────────────────────────── ⤢ ┐│
│ │  [Host] ──JSON-RPC──▶ [Server] ──▶ [API]       ││
│ └────────────────────────────────────────────────┘│
│ agent: canvas_draw …   (drawn into the card above)│
└───────────────────────────────────────────────────┘
```

The inline board is the same live viewer as the browser one: the agent's drawings appear as it draws, you can draw back, send notes (the pill's **Note** button), follow the agent, save to the library, and go full screen (⤢) where the host allows it.

## How it works

```
host (chat app) ── renders ──▶ sandboxed iframe: ui://whiteboard-mcp/board.html
   ▲  postMessage JSON-RPC                │ tools/call canvas_view (app-only, proxied by the host)
   └──────────────────────────────────────┘
whiteboard-mcp (stdio) ── viewer WebSocket per inline view ──▶ canvas daemon (127.0.0.1)
```

- When the client's `initialize` advertises the extension (`capabilities.extensions["io.modelcontextprotocol/ui"]`), `canvas_open` is listed with `_meta.ui.resourceUri = "ui://whiteboard-mcp/board.html"` and its result names the board in `_meta["whiteboard-mcp/board"]` (not `structuredContent`, which some clients give the model instead of the text; the view falls back to the `[board-id].` in the text when a host drops result `_meta`). The host renders that resource next to the tool call.
- The resource is one self-contained HTML file (`dist/app/board.html`, built by `vite.app.config.ts`): scripts, styles and Excalidraw's fonts are inlined, since the iframe may load nothing else. The large CJK font (Xiaolai) is left out; those glyphs use a system font inline.
- The iframe can't reach the daemon on 127.0.0.1, so its live link goes through the MCP server: the app-only tool `canvas_view` (`_meta.ui.visibility: ["app"]`, never shown to the model) sends viewer messages and long-polls for the daemon's. The server holds an ordinary viewer WebSocket per inline view, so screenshots, mermaid, focus, notes and saving work as in the browser. A view that stops polling is dropped after 45 s.
- An IDE panel beside the chat wins: when a panel host of the chat's window (or folder) is connected, as for VS Code's own agent with the [panel extension](ide-panel.md), `canvas_open` shows the board there, its result `_meta["whiteboard-mcp/shown"]` is `"panel"`, and the inline view shrinks to a one-line note.
- Otherwise nothing opens a browser. If nobody is watching when the agent draws, the agent is told to call `canvas_open` again. Setting `WHITEBOARD_OPEN` to a browser or command keeps the old behaviour (check your client config: an old `WHITEBOARD_OPEN = "browser"` turns inline off).
- In the Claude desktop app (`CLAUDE_CODE_ENTRYPOINT=claude-desktop`), `canvas_open` also gives the agent the board link to open in the app's built-in Browser pane, which keeps the board beside the chat instead of scrolling away with it.

Clients without the extension see no change: no `canvas_view` tool, no UI metadata on `canvas_open`, and boards open in the IDE panel or browser as before.
