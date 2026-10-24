# Whiteboard MCP for VS Code

Shows the live whiteboards your coding agent draws with [**Whiteboard MCP**](https://github.com/ansuman-shukla/whiteboard-mcp) in an editor tab beside the chat, instead of a browser window.

- Works for agents in the integrated terminal (Claude Code, Codex CLI, OpenCode…), for the editor's own agent (MCP servers configured in VS Code) and for agent extensions.
- Each board opens in its own tab, in the window the agent runs in, even with several windows on the same folder.
- Command **Whiteboard: Open Board** lists this workspace's boards.

Requires VS Code 1.101+ (or a compatible editor such as Cursor or Windsurf on that base) and Whiteboard MCP itself. Agents that were already running when the extension was installed need a restart (open a new terminal).

Setup, routing and troubleshooting: [docs/ide-panel.md](https://github.com/ansuman-shukla/whiteboard-mcp/blob/main/docs/ide-panel.md).
