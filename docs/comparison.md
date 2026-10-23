# Whiteboard MCP vs Excalidraw MCP

[Excalidraw MCP](https://github.com/excalidraw/excalidraw-mcp) is the official MCP App from the Excalidraw team. It streams a diagram into the chat as an inline widget. **Whiteboard MCP** gives the agent a board that lives beside the chat, that you both work on, and that sticks around.

| | Whiteboard MCP | Excalidraw MCP |
|---|---|---|
| **You draw back** | The agent gets a short list of what you added, moved or deleted, plus your notes, on every look | You can edit in fullscreen; the agent re-reads the whole widget state, with no list of what changed |
| **Agent looks at its own board** | Text description (`canvas_read`) and a PNG (`canvas_screenshot`) | No read or screenshot tool; the model only knows what it sent |
| **Edit one shape** | Re-send an id to move or restyle it; bound arrows follow | Restore a checkpoint, add delete markers, re-send new elements |
| **Point at things** | `canvas_focus` scrolls to elements and pulses a highlight | Animated camera moves while drawing |
| **Boards stick around** | One board per chat, saved on disk; any later chat can reopen it by name or search its text; saved copies library | Checkpoints you continue from inside the same chat |
| **Where it shows** | A tab beside the chat (VS Code, Cursor, Windsurf, Devin Desktop) or a browser tab | Inline in the chat, in clients that render MCP Apps (Claude, ChatGPT, VS Code, Goose) |
| **Clients** | Any MCP client, plus a plain CLI for agents without MCP | Clients that support MCP Apps |
| **Mermaid** | `canvas_mermaid` turns Mermaid into hand-drawn elements | Not available |
| **Export** | `.excalidraw` or `.png` written into your project | Upload to an excalidraw.com share link |
| **Where it runs** | Local daemon on 127.0.0.1, token on every request, fonts bundled | Hosted server at `mcp.excalidraw.com` (recommended) or local |
| **Setup** | One `npx` line in your agent, runs locally | Paste one URL, nothing to install |

**Pick Excalidraw MCP** for a quick one-off diagram inside Claude or ChatGPT on the web: zero install and smooth camera animation.

**Pick Whiteboard MCP** when you want to work on a board together with a coding agent: it sees what you draw, checks its own layout, keeps boards across chats, and works in terminal agents too.

Based on the Excalidraw MCP README and `src/server.ts` (tools `read_me`, `create_view`, `export_to_excalidraw`), October 2026.
