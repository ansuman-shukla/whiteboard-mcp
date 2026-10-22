# whiteboard-mcp

A lightweight local Excalidraw canvas that coding agents draw on live, side by side with a human, to explain things. The human can draw back and leave notes; the agent reads those changes. Exposed as an MCP stdio server (any MCP client) and as a plain CLI (`whiteboard-mcp call <tool> '<json>'`) for harnesses without MCP.

## Architecture

```
agent ──stdio JSON-RPC──▶ whiteboard-mcp (MCP server, one per agent session)
                              │ HTTP + bearer token (src/canvas/client.ts)
                              ▼
                     canvas daemon (one per user, detached, src/canvas/daemon.ts)
                     node:http + ws, bound to 127.0.0.1, JSON files on disk
                              ▲ WebSocket (token in query)
                              │
                     browser viewer (frontend/, served by the daemon at /c/<canvasId>)
```

- `src/shared/protocol.ts` is the wire contract (REST paths, WS messages, merge rule). Change it first, then every side.
- `src/shared/config.ts`: state dir (`WHITEBOARD_HOME`, default `~/.whiteboard-mcp`), port (`WHITEBOARD_PORT`, default 47428), file paths.
- `src/canvas/store.ts`: in-memory canvases persisted as JSON (atomic write, debounced), per-canvas monotonic `rev`, bounded change log, tombstone pruning, idle unload.
- `src/canvas/search.ts`: the word matcher shared by live-board search (`CanvasStore.search`) and saved-board search.
- `src/canvas/saved.ts`: the saved-board library (`<state>/saved/<id>.json`): frozen copies saved by the agent (`canvas_save`) or the viewer (`save` WS message), id = name + workspace (same name overwrites), in-memory search index built from disk on first use. Loading one into a board goes through `CanvasStore.replace` (versions bumped above stored ones so it wins over tombstones).
- `src/canvas/daemon.ts`: REST + WS hub, token auth, Host/Origin checks, viewer request relay (screenshot, mermaid, focus), panel hosts (`/ws/host`: IDE extensions that show boards beside the chat; routed to the host whose `hostId` matches the request's `host` hint, else by workspace folder then focus, never to an unrelated window), heartbeat, idle exit (hosts don't keep it alive), single-instance lock.
- `src/canvas/client.ts`: Node client used by the MCP layer and CLI; starts the daemon on demand.
- `src/shared/elements.ts`: turns compact agent element specs into complete Excalidraw elements (labels as bound text, arrow bindings and edge routing, text metrics), updates and deletes with binding upkeep.
- `src/shared/describe.ts`: compact text description of a scene and of changes since a revision.
- `src/mcp/*`, `src/cli.ts`: minimal stdio JSON-RPC MCP server (no SDK at runtime), tools, CLI mode, viewer opening.
- Scope: one board per chat (`chatBoard(workspace, chat)`), boards tagged with `workspace` + `chat` and listed per workspace; looked up by name in any folder, this one first (`src/mcp/find.ts`, `GET /api/search` for text), because some harnesses (Codex desktop) start every task in a new folder. Chat id: tool-call `_meta` > `WHITEBOARD_CHAT_ID` > `WHITEBOARD_CHAT_COMMAND` > per process. Tool calls get a `ChatContext`, never shared mutable chat state, because one process may serve several chats.
- Showing: `ChatContext.reveal` asks a panel host first, hinting the chat's window (`hostHint()`: `WHITEBOARD_HOST_ID`, else `WINDSURF_EXT_HOST_PID`, which equals the Desktop extension host's pid); without one it opens a browser only outside editors (or per `WHITEBOARD_OPEN`). Never put the board URL in a result when a panel showed it, and never route a board to a window that isn't the chat's: it would hide that window's board.
- `frontend/`: React + Excalidraw viewer; live bidirectional sync using Excalidraw's version/versionNonce reconciliation.

## Rules

- Runtime dependencies: `ws` only. Everything else (Excalidraw, React, MCP SDK for tests) is a devDependency; the frontend is prebuilt into `dist/frontend`.
- Never write to stdout from the MCP server except JSON-RPC frames. Logs go to stderr (only when `WHITEBOARD_DEBUG=1`) or the state dir.
- Never read the user's project `.env`, never write files into the user's working directory unless a tool is asked to export there.
- Tool input schemas must be portable across Claude, OpenAI/Codex and Gemini validators: every property has a single `type`, no type arrays, no tuple `items`, no top-level `oneOf/anyOf/allOf`, no `format`.
- Every network call has a timeout. Every map/timer has a removal path. Every new listener has a cleanup path.
- The daemon only listens on 127.0.0.1 and requires the token for every route except `/health` and static assets.

## Commands

```sh
npm install
npm run typecheck      # server + frontend
npm test               # vitest unit + integration (integration builds dist/ first)
npm run build          # frontend (vite) + server (tsc)
npm run test:e2e       # Playwright against the built daemon + frontend
npm run check          # all of the above
```

## Gotchas

- e2e uses port 47500; a crashed run can leave `tests/e2e/serve.mjs` listening there. Kill it before rerunning.
- Click Excalidraw toolbar tools via their `label`, not the hidden radio input.
- `npm run test:soak` asserts flat heap and zero leaked connections; run it after touching daemon/store lifecycle code.
