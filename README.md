# HeLa Runtime

> **HeLa Runtime v1.0.0** — a single-process daemon that boots the HeLa cells as supervised MCP child processes and multiplexes their tools behind one MCP stdio endpoint. Optional companion to the [HeLa MCP Ecosystem](https://github.com/Hela-Ecosystem/hela-mcp-ecosystem).

![Blotcat plugging MCP server cables into the central AI Hub](https://raw.githubusercontent.com/Hela-Ecosystem/.github/main/profile/hela-logo-1024.png)

---

## Respectful Attribution & Metaphor

The **HeLa Runtime** is part of the HeLa MCP Ecosystem, named in respectful recognition of **Henrietta Lacks** (1920–1951) and the immortal scientific legacy of HeLa cells. In this architecture, the runtime acts as the **cytoplasmic matrix** that hosts the organelles (cells) and routes signals between them without the host agent needing to manage each one individually.

---

## What It Does

Instead of connecting your AI client to 10 separate MCP servers, you connect to **one** — the HeLa Runtime. It:

* **Boots** the cells defined by your chosen profile as supervised child processes.
* **Multiplexes** their tools behind a single MCP stdio endpoint (canonical names by default, opt-in namespaced).
* **Lazy-ignites** heavy cells (Plastid, Receptor) on first tool call.
* **Recovers** from cell crashes automatically (up to 3 attempts, exponential backoff); other cells stay online.
* **Chains** tool calls in-process via `hela.pipe` (zero host round-trips).
* **Hosts** agents via `hela.agent.run` (Needle 3 orchestration).

---

## Quick Start

### 1. Prerequisites
* **Node.js**: `>= 18.0.0` (v20+ LTS recommended)
* **HeLa MCP Ecosystem**: cloned as a sibling directory (or set `HELA_ECOSYSTEM_ROOT`).

### 2. Install & Build
```bash
git clone https://github.com/Hela-Ecosystem/hela-runtime.git
cd hela-runtime
npm install
npm run build
```

### 3. Run
```bash
node dist/index.js                              # dev-workspace profile (default, 8 cells)
HELA_PROFILE=minimal node dist/index.js          # 3 cells only
HELA_PROFILE=all node dist/index.js              # all 10 cells
HELA_NAMESPACE_TOOLS=1 node dist/index.js        # opt-in prefixed tool names (hela_<cell>_<tool>)
HELA_HTTP_PORT=8787 node dist/index.js           # enable HTTP /healthz endpoint
```

### 4. Via the Ecosystem Installer
```bash
cd ../hela-mcp-ecosystem
./setup.sh --profile dev-workspace --client opencode --runtime --non-interactive
```
This builds all profile cells + the daemon and writes a single-entry client config.

---

## Profile-Aware by Default

The runtime respects `HELA_PROFILE` exactly like the ecosystem installer. Default is `dev-workspace`.

| Profile | Cells booted | Tools |
|---|---|---|
| `minimal` | mitosis, genome, enzyme | 79 |
| `dev-workspace` | mitosis, genome, membrane, nucleus, ribosome, enzyme, phenotype, cytosol | 233 |
| `headless-server` | mitosis, genome, membrane, nucleus, ribosome, enzyme, phenotype | 160 |
| `research` | mitosis, genome, enzyme, membrane, cytosol | 148 |
| `web-devops` | mitosis, genome, membrane, nucleus, phenotype, cytosol | 183 |
| `android-testing` | mitosis, genome, nucleus, receptor, enzyme | 126 |
| `3d-modeling` | mitosis, genome, plastid, membrane, nucleus | 103 |
| `all` | all 10 cells | 293 |

Heavy cells (`hela-receptor`, `hela-plastid`) are **lazy-ignited** — booted on first tool call, not at startup.

---

## Environment Variables

| Variable | Default | Description |
|---|---|---|
| `HELA_ECOSYSTEM_ROOT` | sibling `hela-mcp-ecosystem` | Path to the ecosystem root (inventory, profiles). |
| `HELA_PROFILE` | `dev-workspace` | Profile id selecting which cells to boot. |
| `HELA_NAMESPACE_TOOLS` | unset | Set to `1` to expose tools as `hela_<cell>_<tool>`. |
| `HELA_HTTP_PORT` | unset | Enable HTTP `/healthz` endpoint on this port. |

---

## Cross-Cell Chaining (Two Paths)

* **With runtime:** `hela.pipe` runs a sequence of `{cell, tool, args}` steps in-process (zero host round-trips). Supports `{{prev}}` substitution for piping results.
* **Without runtime:** use `hela-mitosis:workflow_orchestrator` (host-mediated, supports `dependsOn` + `outputMapping`). Available to every user with the ecosystem installed.

---

## Diagnostics

```bash
# From the ecosystem directory
./setup.sh doctor          # includes hela-runtime (build artifact + stdio smoke + version)
node scripts/verify-versions.mjs   # version consistency across all cells + runtime
node scripts/test-runtime-parity.mjs  # parity + crash-recovery harness
```

---

## Docker

```bash
docker build -t hela-runtime .
docker run -e HELA_ECOSYSTEM_ROOT=/ecosystem -e HELA_PROFILE=dev-workspace -p 8787:8787 hela-runtime
```

Mount the ecosystem directory at `/ecosystem` so the daemon can spawn cells.

---

## Documentation Index

* **[HeLa MCP Ecosystem](https://github.com/Hela-Ecosystem/hela-mcp-ecosystem)**: installer, profiles, client matrix, docs site.
* **[Architecture Guide](https://github.com/Hela-Ecosystem/hela-mcp-ecosystem/blob/master/docs/architecture.md)**: cellular architecture and the runtime's place in it.
* **[Profiles Reference](https://github.com/Hela-Ecosystem/hela-mcp-ecosystem/blob/master/docs/profiles.md)**: profile definitions and the runtime serve mode.
* **[Migration Guide](https://github.com/Hela-Ecosystem/hela-mcp-ecosystem/blob/master/scripts/migrate-to-runtime.mjs)**: convert an existing 10-server config to the single-endpoint runtime.

---

## License

Distributed under the MIT License. Underlying repositories remain independently copyrighted by their respective authors.

The HeLa project respectfully recognizes **Henrietta Lacks** and the enduring scientific legacy of HeLa cells.