---
name: whiteboard-explainer
description: Explain code, architecture, data flows, algorithms, plans or trade-offs visually on a live Excalidraw whiteboard (whiteboard-mcp) shown to the user beside the chat (they can draw on it or annotate). Use when a diagram would explain better than prose, when the user asks to "draw", "sketch", "diagram", "visualise" or "show" something, or when they mention the canvas, the whiteboard or something they drew.
---

# Excalidraw explainer

A live whiteboard shared with the user. You draw through the `whiteboard-mcp` MCP tools (`canvas_*`) or, without MCP, the `whiteboard-mcp call` CLI. They watch it update beside the chat and can move things, draw back or leave notes. Each chat has its own board; boards of other chats can be opened with `canvas_open {"board":"<title or id>"}`, this workspace's first, then any folder (some apps, like Codex desktop, start every task in a new folder).

## When to draw

- Architecture, request/data flows, pipelines, sequences, state machines, data structures, before/after, options side by side.
- Skip it for one-line answers or things that are just a list.

## The live explain loop

1. **Open**: `canvas_open {"title":"<topic>"}` once per topic. It shows this chat's board to the user and tells you what is already on it. Never open board links in a browser or preview tool yourself, unless a tool result tells you to (e.g. the Claude desktop app's Browser pane). Call `canvas_guide` once if you haven't read it yet (layout, sizes, colours).
2. **Draw step by step**: one `canvas_draw` per idea (the components, then the flow between them, then annotations). After each call, write one or two short sentences in chat that point at the canvas ("the blue boxes are the services"). The canvas carries the detail, keep the chat brief.
3. **Point**: `canvas_focus {"ids":["api","db"],"highlight":true}` when you talk about specific parts.
4. **Check once**: after the main layout, `canvas_screenshot` one time to catch overlaps or cut-off labels, then fix them with `canvas_draw` on the same ids.
5. **Listen**: when the user mentions the canvas or a tool result says they changed something or left a note, call `canvas_read`. It lists what they added, changed or deleted and their notes since your last read. Respond to them.
6. **Update, don't redraw**: re-send an existing id with only the fields that change (`{"id":"api","x":400}`, `{"id":"db","label":"Postgres"}`). Use `canvas_delete` for removals. Start over only with `canvas_open {"fresh":true}`.
7. **Keep it**: when a drawing is worth reusing or the user asks to save it, `canvas_save {"name":"<topic>"}` stores a frozen copy in the user's library (the user can also save from the board's menu or with Cmd/Ctrl+S). In a later chat, in any workspace, `canvas_search {"query":"<words>"}` finds other chats' live boards and saved copies: `canvas_open {"board":"<id>"}` opens a live one, `canvas_open {"saved":"<id>"}` loads a copy into this chat's board (add `"fresh":true` if the board already has a drawing). When the user names a board loosely and `canvas_open {board}` doesn't find it, it lists the closest boards: pick the one they meant by id.

## Element cheatsheet

- Shapes: `{"id":"api","type":"rectangle","x":0,"y":0,"label":"API","backgroundColor":"blue"}`. ellipse = start/end/actor, diamond = decision, frame = zone.
- Arrows bind to shapes: `{"type":"arrow","from":"api","to":"db","label":"SQL"}`; `"strokeStyle":"dashed"` for async.
- Free text: `{"type":"text","x":0,"y":-60,"text":"Checkout flow","fontSize":32}`.
- Spacing: shapes ~160x80, 60-100px gaps, left-to-right for flows, top-down for hierarchies. 2-4 colours, each with a meaning.
- Sequence diagrams or quick flowcharts: `canvas_mermaid {"definition":"sequenceDiagram\n A->>B: hi"}`.

## Without MCP (CLI)

For harnesses without MCP support (for example pi), run the same tools from the shell. Calls from the same directory share one session, so `canvas_read` still only reports what changed since your last read.

```sh
whiteboard-mcp call canvas_open
whiteboard-mcp call canvas_draw '{"elements":[{"id":"api","type":"rectangle","x":0,"y":0,"label":"API"},{"id":"db","type":"rectangle","x":260,"y":0,"label":"DB"},{"type":"arrow","from":"api","to":"db","label":"SQL"}]}'
whiteboard-mcp call canvas_focus '{"ids":["db"],"highlight":true}'
whiteboard-mcp call canvas_screenshot      # prints the path of a PNG; view it to check the layout
whiteboard-mcp call canvas_read
whiteboard-mcp call canvas_save '{"name":"Auth flow"}'
whiteboard-mcp call canvas_search '{"query":"auth"}'
whiteboard-mcp call canvas_draw - < spec.json   # long specs from stdin
whiteboard-mcp tools                       # every tool with its JSON schema
```

Exit code 1 means the tool failed; the message says what to do (for example when nobody can see the board yet).
