# HeLa Runtime

> **HeLa Runtime v1.1.0** — a supervising daemon that boots HeLa cells as MCP child processes and multiplexes their tools behind one stdio or Streamable HTTP endpoint. Optional companion to the [HeLa MCP Ecosystem](https://github.com/Hela-Ecosystem/hela-mcp-ecosystem).

![Blotcat plugging MCP server cables into the central AI Hub](https://raw.githubusercontent.com/Hela-Ecosystem/.github/main/profile/hela-logo-1024.png)

---

## Respectful Attribution & Metaphor

The **HeLa Runtime** is part of the HeLa MCP Ecosystem, named in respectful recognition of **Henrietta Lacks** (1920–1951) and the immortal scientific legacy of HeLa cells. In this architecture, the runtime acts as the **cytoplasmic matrix** that hosts the organelles (cells) and routes signals between them without the host agent needing to manage each one individually.

---

## What It Does

Instead of connecting your AI client to 10 separate MCP servers, you connect to **one** — the HeLa Runtime. It:

* **Boots** the cells defined by your chosen profile as supervised child processes.
* **Multiplexes** their tools behind a single MCP stdio endpoint (canonical names by default, opt-in namespaced).
* **Starts** selected cells in the background at staggered intervals; true first-call-only ignition remains planned.
* **Recovers** from crashes and tool timeouts after the old process exits, with up to three cumulative retries per cell/runtime and exponential backoff. Hung processes receive SIGTERM followed by SIGKILL if necessary; other cells stay online.
* **Chains** tool calls in-process via `hela.pipe` (zero host round-trips).
* **Hosts** agents via `hela.agent.run` (Needle 3 orchestration).

---

## Quick Start

### 1. Prerequisites
* **Node.js**: Node 22 LTS is the tested runtime and Nix development environment.
* **HeLa MCP Ecosystem**: cloned as a sibling directory (or set `HELA_ECOSYSTEM_ROOT`).

### 2. Install & Build
```bash
git clone https://github.com/Hela-Ecosystem/hela-runtime.git
cd hela-runtime
npm install
npm run build
```

Or use the pinned Nix package, which fetches npm dependencies through a fixed-output derivation and builds offline:

```bash
nix build .
HELA_ECOSYSTEM_ROOT=/path/to/hela-mcp-ecosystem ./result/bin/hela-runtime
nix develop
```

Keep the output link for deployed packages as a garbage-collection root. Node dependencies are installed from `package-lock.json`; a populated but stale `node_modules` directory is not dependency validation.

### 3. Run
```bash
node dist/index.js                              # dev-workspace profile (default, 8 cells)
node dist/index.js --transport http --port 8090   # /mcp and /healthz on one HTTP listener
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

| Profile | Cells booted |
|---|---|
| `minimal` | mitosis, genome, enzyme |
| `dev-workspace` | mitosis, genome, membrane, nucleus, ribosome, enzyme, phenotype, cytosol |
| `headless-server` | mitosis, genome, membrane, nucleus, ribosome, enzyme, phenotype |
| `research` | mitosis, genome, enzyme, membrane, cytosol |
| `web-devops` | mitosis, genome, membrane, nucleus, phenotype, cytosol |
| `android-testing` | mitosis, genome, nucleus, receptor, enzyme |
| `3d-modeling` | mitosis, genome, plastid, membrane, nucleus |
| `all` | all 10 cells |

Discovery is profile-scoped, including cached manifests; an unknown profile fails instead of silently booting every cell. Tool counts depend on enabled cell features, so use `tools/list` rather than a static total. Full revision/configuration cache invalidation and true lazy ignition remain follow-up work.

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

### Genome memory and mission coordination

Memory safety belongs to the Genome cell, not the runtime transport. Rebuild `project-mcp` when updating its backup, vault-sync, or mission-claim implementation; restarting an old build does not install those changes. Keep SQLite as the base engine and Obsidian optional. Use Genome's conflict-aware `dist/vault-sync.js` hook rather than bidirectional `rsync --delete`; see the [Genome configuration and recovery guide](https://github.com/Hela-Ecosystem/project-mcp#obsidian-vault-mirror-optional-remote-capable-agent-controllable).

Exclusive mission claims coordinate callers of the same Genome ledger. Agents on different machines must use that shared server endpoint; separate local SQLite databases and vault mirrors do not replicate missions or provide a distributed lock. Runtime deployment, cell revisions, and session behavior require separate verification.

---

## Diagnostics

```bash
npm test                         # isolated hung-cell, restart, profile, and shutdown tests
# From the ecosystem directory
./setup.sh doctor          # includes hela-runtime (build artifact + stdio smoke + version)
node scripts/verify-versions.mjs --profile dev-workspace  # initialize/list + package/inventory/snapshot/pin agreement
node scripts/test-runtime-parity.mjs  # parity + crash-recovery harness
```

Ecosystem doctor, integration, and version probes use temporary homes/project memory with vault hooks and credentials excluded. They require real MCP replies; merely staying alive is not a successful handshake. Optional hardware capability still requires separate device/Blender integration tests.

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
