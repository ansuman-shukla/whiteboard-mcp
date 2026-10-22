# Boards: scope and where they appear

## One board per chat

```
workspace folder ("space")
├─ chat "what is MCP?"        → its own board, titled by topic
├─ chat "auth architecture"   → its own board
└─ any chat can list these and open one: canvas_open {"board":"auth architecture"}
```

- **One board per chat**, created on its first drawing and kept in `~/.whiteboard-mcp/canvases/`. Closing the chat or restarting keeps it.
- **Boards belong to the workspace folder** (the agent's MCP root, else its working directory). Chats in the same folder can read and draw on each other's boards; other folders don't see them.
- **Another chat's board is only used when asked**: `canvas_open {"board":"<title or id>"}`, and `{"board":"own"}` goes back.

## How a chat is identified

First match wins:

1. the host's chat id in tool-call `_meta` (`sessionId`, `conversationId`, `chatId`…)
2. `WHITEBOARD_CHAT_ID`
3. the output of `WHITEBOARD_CHAT_COMMAND`
4. otherwise, the MCP server process

Set one of the env vars if your agent restarts its MCP servers within a chat and you want it to keep its board.

### Per harness

| Harness | What you get |
|---|---|
| Terminal agents (Claude Code, Codex, OpenCode…) | The MCP server starts with each session, so every new session gets a fresh board. Two sessions in one folder never share one. |
| Devin Desktop through Devin Switch | Every chat gets its own server; its board follows the conversation id (`WHITEBOARD_CHAT_COMMAND`), even across account handoffs. |
| Devin Desktop's built-in agent | One agent process per window serves all of that window's chats, so one server: those chats share a board unless the chat id arrives in `_meta`. |
| Any host sharing one server between chats | Must pass the chat id in `_meta` for separate boards. |

## Where the board appears

```
canvas_open / canvas_draw while nobody is watching
   ├─ an editor panel host is connected (e.g. a VS Code-style extension) → shown beside the chat
   ├─ agent runs inside an editor without a panel host → nothing opens; the agent tells you how to open it
   └─ elsewhere (terminal agents) → your browser
```

Change the browser fallback with [`WHITEBOARD_OPEN`](configuration.md).

### Panel hosts and window routing

Panel hosts connect to the daemon at `/ws/host` (token-protected) and say which folders they show, plus an optional `hostId` naming their window. A board opens in the chat's own window:

1. the host whose `hostId` matches the agent's `WHITEBOARD_HOST_ID` (else Windsurf/Devin Desktop's `WINDSURF_EXT_HOST_PID`),
2. otherwise a window showing the board's workspace (focused first) that doesn't announce a different `hostId`.

It never opens in an unrelated window, where it would hide that window's own board. Hosts show each board in its own tab and never retarget another board's tab, so chats never replace each other's boards. The agent never gets the board link while a panel can show it, and it is told not to open board links in browser or preview tools.
