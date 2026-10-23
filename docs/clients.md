# Client setup

Every client runs the server with `npx -y @ansuman-shukla/whiteboard-mcp` (Node.js 20+). The first start downloads it once; later starts use the cache. To run your own build instead, replace the command with `node /abs/path/dist/cli.js` (see [CONTRIBUTING.md](../CONTRIBUTING.md)).

## Claude Code

```sh
claude mcp add whiteboard --scope user -- npx -y @ansuman-shukla/whiteboard-mcp
```

## OpenAI Codex CLI

```sh
codex mcp add whiteboard -- npx -y @ansuman-shukla/whiteboard-mcp
```

or in `~/.codex/config.toml`:

```toml
[mcp_servers.whiteboard]
command = "npx"
args = ["-y", "@ansuman-shukla/whiteboard-mcp"]
```

## Devin CLI

```sh
devin mcp add whiteboard --scope user -- npx -y @ansuman-shukla/whiteboard-mcp
```

This writes `~/.config/devin/mcp_config.json`; `--scope project` writes `.devin/mcp_config.json` instead.

## OpenCode

`opencode.json`:

```json
{ "mcp": { "whiteboard": { "type": "local", "command": ["npx", "-y", "@ansuman-shukla/whiteboard-mcp"] } } }
```

## Cursor, Gemini CLI, Claude Desktop

`~/.cursor/mcp.json`, `~/.gemini/settings.json`, or Claude Desktop's config:

```json
{ "mcpServers": { "whiteboard": { "command": "npx", "args": ["-y", "@ansuman-shukla/whiteboard-mcp"] } } }
```

## VS Code

`.vscode/mcp.json`:

```json
{ "servers": { "whiteboard": { "type": "stdio", "command": "npx", "args": ["-y", "@ansuman-shukla/whiteboard-mcp"] } } }
```

In VS Code, Cursor and Windsurf, install the [IDE panel extension](ide-panel.md) to see boards in a tab beside the chat, for the editor's own agent and for agents in its terminal.

## Agents without MCP (pi and others)

Install it globally so `whiteboard-mcp` is on your PATH, and copy the skill into the agent's skills folder:

```sh
npm install -g @ansuman-shukla/whiteboard-mcp
cp -r "$(npm root -g)/@ansuman-shukla/whiteboard-mcp/skills/whiteboard-explainer" <agent-skills-folder>/
```

The agent then runs the same tools from the shell:

```sh
whiteboard-mcp tools                                  # tool names + input schemas
whiteboard-mcp call canvas_open
whiteboard-mcp call canvas_draw '{"elements":[{"id":"api","type":"rectangle","x":0,"y":0,"label":"API"}]}'
whiteboard-mcp call canvas_read
```

CLI calls share the "last read" cursor, so they behave like one session.

## The skill (recommended for every agent)

`skills/whiteboard-explainer/SKILL.md` (in this repo, and in the installed package) teaches the agent when a drawing helps and how to explain step by step. MCP agents benefit from it too. Install it wherever your agent loads skills, e.g. `~/.claude/skills/`, `~/.config/devin/skills/` or `~/.agents/skills/`.
