# HeLa Runtime (v0.1)

A daemon that boots the 10 HeLa cells as supervised MCP processes and multiplexes their tools behind a single MCP stdio endpoint, plus an agent host entry point (`hela.agent.run`) delegating to `hela-mitosis:agent_run`.

## Run

```bash
cd hela-runtime
npm install
npm run build
node dist/index.js
```

The daemon reads `../hela-mcp-ecosystem/config/inventory.json` to discover cells, spawns each entry, performs MCP `initialize` + `tools/list`, and builds a tool-name → cell routing table. Tool calls are proxied to the owning cell.

## Status

- [x] Boots all 10 cells (292 tools + `hela.agent.run`).
- [x] Tool proxying verified.
- [ ] End-to-end `agent.run` (depends on Needle engine availability).
- [ ] Cell crash containment / auto-restart.
- [ ] Profile-based capability enforcement at runtime.