# Security

Everything stays on your machine.

- The daemon listens on `127.0.0.1` only.
- Every API and WebSocket call needs a random per-user token (`~/.whiteboard-mcp/token`, mode 0600). The viewer URL carries it.
- Requests with a foreign `Host` header (DNS rebinding) or a foreign WebSocket `Origin` are rejected. There are no CORS headers, so other web pages can't talk to it.
- The MCP server never writes outside the workspace/temp, never reads your project's `.env`, and keeps stdout strictly for protocol frames.
- Fonts are bundled, so the viewer makes no requests to the internet.
