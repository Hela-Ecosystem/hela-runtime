# Changelog

## Unreleased

- Reap hung cells with SIGTERM/SIGKILL, reject pending RPCs, and restart after actual exit, including calls through `hela.pipe`.
- Cancel scheduled/in-flight boots and restarts during shutdown; bound retries per cell/runtime.
- Restrict cached tool discovery and routing to the selected profile; reject unknown profiles.
- Add isolated fault-injection tests and reproducible Node 22 Nix packaging with pinned inputs and fixed-output npm dependencies.

## 1.1.0

- Background staggered cell startup, manifest caching, and Streamable HTTP transport. Background startup is not true on-demand ignition.
