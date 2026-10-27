<a href="#quick-start">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="docs/media/readme/hero-dark.svg">
    <img src="docs/media/readme/hero-light.svg" width="100%" alt="Whiteboard MCP: a live whiteboard your coding agent draws on. You draw back.">
  </picture>
</a>

https://github.com/user-attachments/assets/197876d8-5620-4c1b-9bc3-332e0e7d5622

<p align="center"><b>Whiteboard MCP</b> is a free and extreamly token efficient <b>whiteboard MCP</b> that runs locally. Your coding agent draws diagrams on a live board beside the chat, and sees what you draw back.</p>

<p align="center"> <a href="#add-it-to-your-agent">One command install for every agent ↓</a></sub></p>

<br>

## Features

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="docs/media/readme/features-dark.svg">
  <img src="docs/media/readme/features-light.svg" width="100%" alt="Why Whiteboard MCP: draws step by step, sees what you draw, right beside the chat, remembers boards, local and private, tiny (one runtime dependency, about 7 KB of tool schema per turn).">
</picture>

## What you can do with it

### Understand an architecture

<img src="docs/media/architecture.gif" width="100%" alt="An agent chat beside a live whiteboard: the agent draws a checkout architecture step by step, the human drags Postgres, circles the queue and sends a note asking what happens if the email worker is down, and the agent reads the changes and adds a dead-letter queue">

### Explain a flow

<img src="docs/media/demo.gif" width="100%" alt="The agent draws a login flow step by step, highlights the parts it explains, then answers a note left by the human">

### Play games

<img src="docs/media/dots-and-boxes.gif" width="100%" alt="Playing Dots and Boxes with a coding agent: the human draws a line on the board, the agent sees the move and plays back, until red wins 12 to 4">

### Make something

<img src="docs/media/mona-lisa.gif" width="100%" alt="An agent paints the Mona Lisa on the board, then refines the sky, hair and dress with pencil strokes">

## Quick start

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="docs/media/readme/steps-dark.svg">
  <img src="docs/media/readme/steps-light.svg" width="100%" alt="Get started in a minute: 1. Add it to your agent with one npx line. 2. Start a new chat. 3. Ask for a drawing.">
</picture>

### Add it to your agent

```sh
# Claude Code
claude mcp add whiteboard --scope user -- npx -y @ansuman-shukla/whiteboard-mcp

# Codex CLI
codex mcp add whiteboard -- npx -y @ansuman-shukla/whiteboard-mcp

# Gemini CLI
gemini mcp add --scope user whiteboard npx -y @ansuman-shukla/whiteboard-mcp

# Devin CLI
devin mcp add whiteboard --scope user -- npx -y @ansuman-shukla/whiteboard-mcp

# VS Code
code --add-mcp '{"name":"whiteboard","command":"npx","args":["-y","@ansuman-shukla/whiteboard-mcp"]}'
```

**Cursor, Claude Desktop, Windsurf and other JSON configs** (`~/.cursor/mcp.json`, Claude Desktop's config, …):

```json
{ "mcpServers": { "whiteboard": { "command": "npx", "args": ["-y", "@ansuman-shukla/whiteboard-mcp"] } } }
```

**OpenCode** (`opencode.json`):

```json
{ "mcp": { "whiteboard": { "type": "local", "command": ["npx", "-y", "@ansuman-shukla/whiteboard-mcp"] } } }
```

Agents without MCP, project-level configs and more: [client setup](docs/clients.md). 
The bundled [skill](docs/clients.md#the-skill-recommended-for-every-agent) teaches the agent when a drawing helps.

## Whiteboard MCP vs Excalidraw MCP

<a href="docs/comparison.md">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="docs/media/readme/compare-dark.svg">
    <img src="docs/media/readme/compare-light.svg" width="100%" alt="Whiteboard MCP vs Excalidraw MCP: Whiteboard MCP sees what you draw back as a short list of changes, screenshots its own board, edits one shape in place, keeps boards beyond the chat, works in any MCP client plus a CLI, and converts Mermaid. Excalidraw MCP has animated camera moves and zero install.">
  </picture>
</a>

<p align="center"><sub>Want a quick one-off diagram inside Claude or ChatGPT on the web? Excalidraw MCP is great for that. <a href="docs/comparison.md">Full comparison →</a></sub></p>

<br>

<p align="center">
  <a href="docs/clients.md">Client setup</a> · <a href="docs/boards.md">Boards</a> · <a href="docs/ide-panel.md">IDE panel</a> · <a href="docs/tools.md">Tools &amp; how it works</a> · <a href="docs/configuration.md">Configuration</a> · <a href="docs/security.md">Security</a> · <a href="CONTRIBUTING.md">Contributing</a>
  <br>
  MIT License · built on <a href="https://github.com/excalidraw/excalidraw">Excalidraw</a>
</p>
