# Contributing

Architecture notes, rules and gotchas for contributors live in [AGENTS.md](AGENTS.md).

## Development

```sh
npm install
npm run typecheck     # server + viewer
npm test              # unit + integration (builds dist/ first)
npm run build         # viewer (Vite) + server (tsc)
npm run test:e2e      # Playwright: real daemon + viewer in Chromium
npm run check         # everything
npm run readme:art    # re-render the README cards in docs/media/readme/
```
