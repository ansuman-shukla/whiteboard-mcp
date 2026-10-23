<a href="#quick-start">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="docs/media/readme/hero-dark.svg">
    <img src="docs/media/readme/hero-light.svg" width="100%" alt="whiteboard-mcp: a live whiteboard your coding agent draws on, and you draw back. Works with Claude Code, Codex, Cursor, Gemini CLI, VS Code and any MCP client.">
  </picture>
</a>

<br>

<img src="docs/media/dots-and-boxes.gif" width="100%" alt="Playing Dots and Boxes with a coding agent: the human draws a line on the board, the agent sees the move and plays back, until red wins 12 to 4">

<p align="center"><sub>Playing Dots and Boxes with an agent: you draw a line, it sees your move and plays back.</sub></p>

<br>

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="docs/media/readme/features-dark.svg">
  <img src="docs/media/readme/features-light.svg" width="100%" alt="Why whiteboard-mcp: draws step by step, sees what you draw, right beside the chat, remembers boards, local and private, tiny (one runtime dependency, about 7 KB of tool schema per turn).">
</picture>

<br><br>

**Understand an architecture.** *"How does a typical checkout backend work? Draw it on the whiteboard."* The agent draws it piece by piece and highlights what it's explaining. You move a box, circle the part you're unsure about and leave a note. It reads exactly what you changed and answers on the board.

<img src="docs/media/architecture.gif" width="100%" alt="An agent chat beside a live whiteboard: the agent draws a checkout architecture step by step, the human drags Postgres, circles the queue and sends a note asking what happens if the email worker is down, and the agent reads the changes and adds a dead-letter queue">

**Explain a flow.** *"How does login work here?"* Arrows stay attached as things move, and the agent answers your notes on its next look.

<img src="docs/media/demo.gif" width="100%" alt="The agent draws a login flow step by step, highlights the parts it explains, then answers a note left by the human">

**Make something.** *"Paint the Mona Lisa, then refine it with the pencil."* Shapes, freehand strokes and frames, all editable.

<img src="docs/media/mona-lisa.gif" width="100%" alt="An agent paints the Mona Lisa on the board, then refines the sky, hair and dress with pencil strokes">

More to try:

- *"Explain how a request flows through this repo, on the whiteboard."*
- *"Teach me how a TCP handshake works, step by step."*
- *"Draw our deploy pipeline and mark the single points of failure."*
- *"Compare option A and option B side by side on the board."*
- *"I circled something on the board, take a look."*

<br>

<a name="quick-start"></a>

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="docs/media/readme/steps-dark.svg">
  <img src="docs/media/readme/steps-light.svg" width="100%" alt="Get started in a minute: 1. Clone and build. 2. Add it to your agent. 3. Ask for a drawing.">
</picture>

Requires Node.js 20+.

```sh
git clone https://github.com/ansuman-shukla/whiteboard-mcp && cd whiteboard-mcp
npm install && npm run build
claude mcp add whiteboard --scope user -- node "$PWD/dist/cli.js"
```

Codex, Cursor, Gemini CLI, OpenCode, Devin, VS Code, Claude Desktop and agents without MCP: see [client setup](docs/clients.md). For boards in a tab beside the chat, install the [IDE panel](docs/ide-panel.md). The bundled [skill](docs/clients.md#the-skill-recommended-for-every-agent) teaches the agent when a drawing helps.

<br>

<a href="docs/comparison.md">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="docs/media/readme/compare-dark.svg">
    <img src="docs/media/readme/compare-light.svg" width="100%" alt="whiteboard-mcp vs Excalidraw MCP: whiteboard-mcp sees what you draw back as a short list of changes, screenshots its own board, edits one shape in place, keeps boards beyond the chat, works in any MCP client plus a CLI, and converts Mermaid. Excalidraw MCP has animated camera moves and zero install.">
  </picture>
</a>

<p align="center"><sub>Want a quick one-off diagram inside Claude or ChatGPT on the web? Excalidraw MCP is great for that. <a href="docs/comparison.md">Full comparison →</a></sub></p>

<br>

<p align="center">
  <a href="docs/clients.md">Client setup</a> · <a href="docs/boards.md">Boards</a> · <a href="docs/ide-panel.md">IDE panel</a> · <a href="docs/tools.md">Tools &amp; how it works</a> · <a href="docs/configuration.md">Configuration</a> · <a href="docs/security.md">Security</a> · <a href="CONTRIBUTING.md">Contributing</a>
  <br>
  MIT License · built on <a href="https://github.com/excalidraw/excalidraw">Excalidraw</a>
</p>
