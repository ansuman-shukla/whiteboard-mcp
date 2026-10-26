# Boards: scope, finding, saving and where they appear

## One board per chat

```
workspace folder ("space")
├─ chat "what is MCP?"        → its own board, titled by topic
├─ chat "auth architecture"   → its own board
└─ any chat can list these and open one: canvas_open {"board":"auth architecture"}
```

- **One board per chat**, created on its first drawing and kept in `~/.whiteboard-mcp/canvases/`. Closing the chat or restarting keeps it.
- **Boards are filed by workspace folder** (the agent's MCP root, else its working directory). The list a chat sees is this folder's boards; chats in the same folder can read and draw on each other's boards.
- **Another chat's board is only used when asked**: `canvas_open {"board":"<title or id>"}`, and `{"board":"own"}` goes back.

## Finding a board from any folder

Asking by name or id finds a board in **any** folder, this one first:

```
canvas_open {"board":"<title or id>"}
   1. this folder's boards              → found? open it
   2. every folder, newest first        → one match: open it, saying which folder it came from
                                           several: list their ids, open nothing
                                           none: list the closest boards and saved copies to pick from
```

That matters for apps that start every task in a new folder (Codex desktop uses `~/Documents/Codex/<date>/<task>`): a later task still opens the board an earlier one made. `canvas_search {"query":"<words>"}` finds boards by the text on them too, and `whiteboard-mcp url <board>` uses the same lookup.

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
   ├─ an editor panel host is connected (the IDE panel extension, Devin Switch in Devin Desktop) → shown beside the chat
   ├─ agent runs inside an editor without a panel host → nothing opens; the agent tells you how to open it
   └─ elsewhere (terminal agents) → your browser
```

In VS Code, Cursor or Windsurf, install the [IDE panel extension](ide-panel.md) to get the panel. Change the browser fallback with [`WHITEBOARD_OPEN`](configuration.md).

### Light and dark theme

Boards follow your editor's theme in the panel and your system's elsewhere. To pick one yourself, open the board's menu and choose light, dark or system under Theme (or press Alt+Shift+D). The pick is kept in `~/.whiteboard-mcp/prefs.json` and applies to every board, in every viewer, until you choose System again.

### Panel hosts and window routing

Panel hosts connect to the daemon at `/ws/host` (token-protected) and say which folders they show, plus an optional `hostId` naming their window. A board opens in the chat's own window:

1. the host whose `hostId` matches the agent's `WHITEBOARD_HOST_ID` (else Windsurf/Devin Desktop's `WINDSURF_EXT_HOST_PID`), looked up in the agent's ancestors when its own environment lacks it (Codex passes MCP servers only a few variables);
2. otherwise a window showing the board's workspace, focused first. While the hinted window may still be connecting (a daemon that just started), windows announcing another `hostId` are skipped; a window id no host announces (stale after Reload Window) falls back to the folder.

It never opens in a window of another folder. The [IDE panel extension](ide-panel.md) sets `WHITEBOARD_HOST_ID` for the agents each window starts. Hosts show each board in its own tab and never retarget another board's tab, so chats never replace each other's boards. The agent never gets the board link while a panel can show it. When none can (inside an editor without the extension, or in a desktop chat app), the result gives the link, and the agent is told to open it in its in-app browser or preview tool, never an external browser.

A daemon that just started gives windows 5 s to connect before answering that no panel is there: shows naming their window, and shows from agents inside an editor that don't know their window.
