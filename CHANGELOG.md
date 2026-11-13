# Changelog

## 1.2.1 - 2026-11-13

- Make runtime cleanup platform-neutral through a Node script and discover Windows Needle executables (`needle3.exe` / `needle.exe`) automatically.
- Add a runtime-native Needle 3 agent behind `agent_run` / `hela.agent.run`. It retrieves from the full aggregated catalog, plans with the bundled model, repairs arguments against each JSON Schema, and executes cell tools in-process without an OpenRouter key.
- Add `hela.agent.plan`, `hela.catalog.list`, and `hela.catalog.search` for inspection.
- Preserve the legacy Mitosis `hela.agent.run` alias when Needle assets are missing or `HELA_NATIVE_AGENT=false`.
- Document native-agent workspace, memory, and Needle environment settings.

## 1.2.0

- Start cells on first invocation only, share concurrent startup attempts, and avoid all-cell scanning on unknown calls. Discovery uses a generated ecosystem catalog without starting cells.
- Invalidate schema caches by root/profile/namespace, declared and actual revisions, build contents, effective tool features, and declared environment configuration; publish caches atomically without environment values.
- Reject stale catalog entries; retain explicit `hela.pipe` bootstrap for uncatalogued cells. Preserve standalone servers and the `dev-workspace` default.
- Expand isolated regressions to cover lazy startup, concurrency, cache changes, profile switching, and cold/warm measurements. Runtime version surfaces now derive from package metadata.

### Included reliability fixes

- Reap hung cells with SIGTERM/SIGKILL, reject pending RPCs, and restart after actual exit, including calls through `hela.pipe`.
- Cancel scheduled/in-flight boots and restarts during shutdown; bound retries per cell/runtime.
- Restrict cached tool discovery and routing to the selected profile; reject unknown profiles.
- Add isolated fault-injection tests and reproducible Node 22 Nix packaging with pinned inputs and fixed-output npm dependencies.

## 1.1.0

- Background staggered cell startup, manifest caching, and Streamable HTTP transport. Background startup is not true on-demand ignition.
