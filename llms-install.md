# Installing Whiteboard MCP (for AI agents)

**Whiteboard MCP** is a local stdio MCP server. It needs Node.js 20 or newer and nothing else: no API key, no account, no environment variables. It runs entirely on the user's machine.

## 1. Add the server to the MCP config

Use this entry in the client's MCP settings file (for Cline: `cline_mcp_settings.json`; Cursor: `~/.cursor/mcp.json`; Claude Desktop: `claude_desktop_config.json`; Windsurf: `~/.codeium/windsurf/mcp_config.json`):

```json
{
  "mcpServers": {
    "whiteboard": {
      "command": "npx",
      "args": ["-y", "@ansuman-shukla/whiteboard-mcp"]
    }
  }
}
```

Merge it into any existing `mcpServers` object instead of replacing the file. CLI agents have one-line commands instead:

```sh
claude mcp add whiteboard --scope user -- npx -y @ansuman-shukla/whiteboard-mcp
codex mcp add whiteboard -- npx -y @ansuman-shukla/whiteboard-mcp
gemini mcp add --scope user whiteboard npx -y @ansuman-shukla/whiteboard-mcp
```

## 2. Verify

After the client reloads its MCP servers, the `whiteboard` server lists tools starting with `canvas_` (`canvas_open`, `canvas_draw`, `canvas_read`, …). Call `canvas_guide` once to learn the drawing format, then `canvas_open` with a topic title. Inside an editor or a desktop chat app, open the board link the result gives in your in-app browser or preview tool; from a plain terminal it opens in the user's browser.

## 3. Optional: the skill

`skills/whiteboard-explainer/SKILL.md` (also inside the installed package) tells an agent when a drawing helps and how to explain step by step. Copy that folder into the agent's skills directory if it supports skills.

## Troubleshooting

- `npx` not found or Node older than 20: install Node.js 20+ first.
- The first start downloads the package once (about 16 MB); later starts use the npx cache.
- Boards and state live in `~/.whiteboard-mcp`; the daemon listens on `127.0.0.1:47428` (`WHITEBOARD_PORT` changes it).
