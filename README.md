# HeLa Runtime (v0.2.0)

A daemon that boots the 10 HeLa cells as supervised MCP processes and multiplexes their tools behind a single MCP stdio endpoint, plus an agent host entry point (`hela.agent.run`) delegating to `hela-mitosis:agent_run`.

## Run

```bash
cd hela-runtime
npm install
npm run build
# boot all cells
node dist/index.js
# or a profile subset
HELA_PROFILE=minimal node dist/index.js
# optional HTTP health endpoint
HELA_HTTP_PORT=8787 node dist/index.js
```

Configuration via env:
- `HELA_ECOSYSTEM_ROOT` — path to hela-mcp-ecosystem (default: sibling dir).
- `HELA_PROFILE` — profile id from profiles.json (default: all cells).
- `HELA_HTTP_PORT` — enable HTTP health endpoint (default: disabled).

## Features (v0.2.0)
- Profile-aware cell selection.
- Auto-restart on cell crash (up to 3 attempts, exponential backoff).
- Longer timeouts for `agent_run` (120s) and other calls (60s).
- HTTP `/healthz` endpoint (opt-in).
- Env-based ecosystem root resolution.

## Status
- [x] Boots all 10 cells (292 tools + `hela.agent.run`).
- [x] Tool proxying verified.
- [x] Profile filtering.
- [x] Crash restart.
- [ ] End-to-end `agent.run` (depends on Needle engine availability).
- [ ] Profile-based capability enforcement at runtime.