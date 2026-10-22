# Client setup

Build once (see the [README](../README.md#quick-start)), then point your agent at `dist/cli.js`. Replace `/abs/path` with the path of your clone.

## Claude Code

```sh
claude mcp add whiteboard --scope user -- node /abs/path/dist/cli.js
```

## OpenAI Codex CLI

```sh
codex mcp add whiteboard -- node /abs/path/dist/cli.js
```

or in `~/.codex/config.toml`:

```toml
[mcp_servers.whiteboard]
command = "node"
args = ["/abs/path/dist/cli.js"]
```

## Devin CLI

```sh
devin mcp add whiteboard --scope user -- node /abs/path/dist/cli.js
```

This writes `~/.config/devin/mcp_config.json`; `--scope project` writes `.devin/mcp_config.json` instead.

## OpenCode

`opencode.json`:

```json
{ "mcp": { "whiteboard": { "type": "local", "command": ["node", "/abs/path/dist/cli.js"] } } }
```

## Cursor, Gemini CLI, Claude Desktop

`~/.cursor/mcp.json`, `~/.gemini/settings.json`, or Claude Desktop's config:

```json
{ "mcpServers": { "whiteboard": { "command": "node", "args": ["/abs/path/dist/cli.js"] } } }
```

## VS Code

`.vscode/mcp.json`:

```json
{ "servers": { "whiteboard": { "type": "stdio", "command": "node", "args": ["/abs/path/dist/cli.js"] } } }
```

## Agents without MCP (pi and others)

Copy `skills/whiteboard-explainer/` into the agent's skills folder and put `whiteboard-mcp` on your PATH (`npm link` in the clone). The agent then runs the same tools from the shell:

```sh
whiteboard-mcp tools                                  # tool names + input schemas
whiteboard-mcp call canvas_open
whiteboard-mcp call canvas_draw '{"elements":[{"id":"api","type":"rectangle","x":0,"y":0,"label":"API"}]}'
whiteboard-mcp call canvas_read
```

CLI calls share the "last read" cursor, so they behave like one session.

## The skill (recommended for every agent)

`skills/whiteboard-explainer/SKILL.md` teaches the agent when a drawing helps and how to explain step by step. MCP agents benefit from it too. Install it wherever your agent loads skills, e.g. `~/.claude/skills/`, `~/.config/devin/skills/` or `~/.agents/skills/`.
