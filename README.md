# HeLa Runtime (v1.0.0)

A daemon that boots the 10 HeLa cells as supervised MCP processes and multiplexes their tools behind a single MCP stdio endpoint, plus an agent host entry point (`hela.agent.run`) delegating to `hela-mitosis:agent_run`.

## Run

```bash
cd hela-runtime
npm install
npm run build
node dist/index.js
HELA_PROFILE=minimal node dist/index.js
HELA_NAMESPACE_TOOLS=1 node dist/index.js   # opt-in prefixed tool names
HELA_HTTP_PORT=8787 node dist/index.js
```

## Features (v0.3.0)
- Profile-aware cell selection.
- Auto-restart on cell crash (up to 3 attempts, exponential backoff); dead cells tracked and reported via MCP notification.
- Opt-in tool namespacing (`HELA_NAMESPACE_TOOLS=1`) → `hela_<cell>_<tool>`.
- Longer timeouts (agent_run 120s, others 60s).
- HTTP `/healthz` endpoint (opt-in).
- Env-based ecosystem root resolution.

## Cross-cell chaining (two paths)
- **With runtime:** `hela.pipe` runs a sequence of `{cell, tool, args}` steps in-process (zero host round-trips). Supports `{{prev}}` substitution.
- **Without runtime:** use `hela-mitosis:workflow_orchestrator` (host-mediated, supports `dependsOn` + `outputMapping`). Available to every user with the ecosystem installed.

## Status
- [x] Boots all 10 cells (292 tools + `hela.agent.run` + `hela.pipe`).
- [x] Tool proxying verified (canonical + namespaced).
- [x] Profile filtering + lazy ignition.
- [x] Crash restart + dead-cell tracking.
- [x] End-to-end `agent.run` via Needle (verified).
- [x] Cross-cell chaining: `hela.pipe` (runtime) + `workflow_orchestrator` (mitosis, no runtime).