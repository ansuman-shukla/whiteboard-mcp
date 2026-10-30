# Configuration

All settings are environment variables on the MCP server (or CLI) process.

| Variable | Default | Purpose |
|---|---|---|
| `WHITEBOARD_OPEN` | `auto` | When no panel host of the chat's window or workspace is connected: `auto` (browser, but nothing inside an editor), `browser`, `none`, or a command template containing `{url}` (run without a shell), e.g. `firefox --new-window {url}` |
| `WHITEBOARD_CHAT_ID` | | Fixed chat id for this MCP server process |
| `WHITEBOARD_CHAT_COMMAND` | | Command printing the current chat id (run once, without a shell), for hosts that restart MCP servers within a chat |
| `WHITEBOARD_HOST_ID` | `WINDSURF_EXT_HOST_PID`, else found in the agent's parent processes | The `hostId` of the editor window (panel host) this agent runs in, so its boards open there. Set but empty: no window, and no lookup |
| `WHITEBOARD_PORT` | `47428` | Daemon port (falls back to a free port if taken by something else) |
| `WHITEBOARD_HOME` | `~/.whiteboard-mcp` | State: boards, saved boards, viewer settings, token, daemon info, logs |
| `WHITEBOARD_IDLE_MS` | `0` (never) | Daemon exits after this long with no viewers or requests. By default it keeps running until `whiteboard-mcp stop`, logout or reboot; a newer version replaces it automatically |
| `WHITEBOARD_WORKSPACE` | MCP root or cwd | Override the workspace used to pick the default board |
| `WHITEBOARD_EXPORT_DIR` | | Extra directory `canvas_export` may write to (besides the workspace and temp) |
| `WHITEBOARD_DEBUG` | | `1` logs MCP diagnostics to stderr |

See [boards.md](boards.md) for how the chat id and host id decide which board you get and where it shows up.

## CLI

```
whiteboard-mcp [mcp]                 MCP stdio server (default)
whiteboard-mcp call <tool> [json|-]  run a tool once (JSON args inline or on stdin)
whiteboard-mcp tools [--json]        list tools and their input schemas
whiteboard-mcp open                  show your board (panel or browser)
whiteboard-mcp url [board]           print a board's viewer URL (yours, or any board by id/title)
whiteboard-mcp status                show the canvas daemon and its boards
whiteboard-mcp stop                  stop the canvas daemon
whiteboard-mcp serve                 run the canvas daemon in the foreground
```

CLI calls act as one chat with its own board.
