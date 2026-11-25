## [1.4.4] - 2026-11-25

### Fixed
- `hela.agent.run` no longer ends a run as "single action complete" after one non-failing call to a tool that does not address the task. A call counts as answering when the tool name overlaps the task wording (ignoring "do not …" clauses) or its result repeats a distinctive task word; otherwise the run keeps trying other tools and ends `degraded` if none answers. The `hela-runtime#4` repro ("current time in Asia/Jakarta, do not modify any files") no longer finishes `ok:true` on `watch_file` (RT-07).
- A write ban scoped to the task's own input ("without modifying the original") no longer drops a permitted action: that task now plans `copy_file`. A ban naming a concrete file or path stays a full ban (RT-03).
- A read-only tool that fails with a timeout-like error gets one bounded retry; permanent errors and mutating tools are never retried (RT-04).
- A plan cut short by `maxToolCalls` reports `status: "degraded"` with a `pendingSteps` list instead of `ok` (RT-05), and early exits (missing task, empty catalog, engine unavailable, planner throw) return `status: "failed"` (RT-06).

### Known limits
- RT-07 is a heuristic; a tool with neither name overlap nor task words in its result ends `degraded`, not `ok`.
- `write_file` arguments embed a timestamp, so the duplicate-call key differs each attempt and a failing write is retried up to the iteration cap.

### Tests
- `tests/agent-rt-fixes.test.mjs`: one regression per row plus the concrete-path ban. Suite 86/86.

## [1.4.3] - 2026-11-25

### Fixed
- Mitosis workflow steps that target another cell work out of the box. The runtime now gives the Mitosis cell `HELA_RUNTIME_URL`: a loopback-only endpoint (`127.0.0.1`, ephemeral port) whose path is a random 128-bit capability, so no other local process can call tools through it without being handed the URL. An operator-set `HELA_RUNTIME_URL` still wins, other cells never receive it, and the listener closes with the runtime. Previously every non-Mitosis step failed with `No runtime transport bound for server '…'` unless the variable was set by hand (chaining-mcp#28, ISS-61).

### Added
- `bootCell` accepts a per-cell `env` layered over the runtime's environment; `HttpAdapter` accepts a `secretPath` and reports its `boundPort`.

### Tests
- `tests/runtime-url.test.mjs`: the Mitosis cell receives a loopback capability URL that serves MCP, `/mcp` and `/` are refused on that listener, the endpoint closes on shutdown, other cells see nothing, and an operator-set URL is preserved. Suite 76/76.

## [1.4.2] - 2026-11-25

### Fixed
- `hela.agent.run` no longer reports a clean success when the tool it called returned `success: false`, `ok: false` or `isError: true`. Failed payloads and thrown errors are recorded as failed in `history`, an identical failing call is skipped instead of retried verbatim, and the result carries `ok`, `status`, `failedCalls`, `degraded` and `decision.action: "failed"` (hela-runtime#4).
- A task that forbids modification is enforced on the final tool selection, not only on retrieval: the deterministic plan no longer treats the word "edit" inside "Do not edit any files" as a write request, and the run loop filters mutating tools after the shortlist is built. If no permitted tool remains, the run stops with `no permitted tools` instead of writing (hela-runtime#5, RT-01).
- `classifyToolResult` now honours `isError` on results that carry `structuredContent` but no `content` array, and reads failure/degradation from `structuredContent` before the text summary. `hela.pipe` is fail-closed again for that shape (hela-runtime#5, RT-02).
- The failure classifier is shared by `hela.pipe` and the native agent, so both paths agree on what a failed or degraded call is (hela-mcp-ecosystem#8).

### Tests
- Five regressions cover the read-only plan, the stubbed-write override, structured `isError`, structured degradation and the ordinary write plan; the full suite is 74/74.

## [1.4.1] - 2026-11-22

### Added
- `hela.pipe` reports the ecosystem response contract: a top-level `status` of `ok` / `degraded` / `failed`, a per-step `status`, and a `degraded` array naming the step and the reasons. A step whose payload marks `degraded`, `partial`, `truncated`, `status: "degraded"` or `warnings` makes the pipe `degraded` while `ok` stays true and `isError` stays unset. Documented in `docs/response-contract.md` (hela-mcp-ecosystem#8).

## [1.4.0] - 2026-11-22

### Changed
- **Breaking default for `hela.pipe`:** a failing step now makes the pipe fail. `ok` reflects every step (plus `failedStep`), `onError` defaults to `stop`, and each result carries its own `ok`. Previously the top-level verdict said `ok: true` while a middle step had failed (hela-runtime#3).

### Fixed
- A failed step is no longer piped onward as data. `{{prev}}` used to receive the previous step's result even when that step failed, so a downstream tool produced a confident answer computed from an error string. On failure with `onError: "continue"` the next step now sees no previous value, so it fails loudly instead.
- Cell failures are detected from the payload (`success: false` / `ok: false`) as well as the transport, because cells report failure inside a text content block rather than as an MCP protocol error.

## [1.3.7] - 2026-11-19

### Changed
- **Breaking for clients that pin tool names:** namespacing is now on by default, so cells advertise `hela_nucleus_execute_command` instead of `execute_command`. A bare name collides with whatever the host already exposes and a collision is settled by whichever server connected last, which is the tool-shadowing failure class clients cannot see. `HELA_NAMESPACE_TOOLS=0` restores the previous surface; `HELA_NAMESPACE_TOOLS=1` is still accepted and is now the default. The manifest cache key already includes the namespace mode, so a switched client rebuilds its fingerprints once instead of reusing the stale identity.
- The prompt, resource and pipe paths address cells by their real tool names, so a namespaced call still reaches the same cell tool; a test asserts the cell reports its own name back.

## [1.3.6] - 2026-11-19

### Changed
- The cell RPC boundary is typed instead of `any`: `request` resolves a `JsonRpcEnvelope`, `callTool` resolves a validated MCP tool result, and a payload that is not one (or a JSON-RPC error answer) raises a named `CellProtocolError` naming the offending keys rather than flowing on as `undefined`. A cell that answers `tools/call` with a JSON-RPC error now surfaces as a tool error instead of a success-shaped blob containing the error.
- Cell directory resolution no longer guesses from `process.cwd()`. Only the caller's root and its parent are searched (installed layouts keep cells under the installation dir, a dev checkout keeps them beside the runtime), and when neither exists `CellDirectoryError` names the root and every path tried instead of returning a path that later fails as a spawn `ENOENT`.

### Fixed
- A corrupted response no longer costs the caller a full timeout. A line that is not JSON stays ignored, as a cell logging to stdout is normal; a line that fails to parse yet carries `jsonrpc`, or parses onto a pending id without being a JSON-RPC response, is counted on the handle, logged once with a truncated sample, and rejects the pending request immediately.

## [1.3.5] - 2026-11-19

### Fixed
- Exclude Mitosis's cell-local `agent_run` from the aggregated tool surface and expose only the runtime-native `hela.agent.run` entry.

## [1.3.4] - 2026-11-19

### Fixed
- A cell rebuilt on a different host hashes differently, so its catalog manifest no longer matched and the runtime silently dropped that cell from the tool surface (on servy: 209 instead of 240 tools, and calls answered "Unknown tool"). Missing or mismatched cells are now named on startup with the regeneration command, probed once so their real tools are advertised, and reported per cell in `/readyz`.

### Added
- `npm run nix:hash` refreshes the flake's fixed-output npm dependency hash by probing the mismatch, writing the value and rebuilding; it leaves the file untouched when Nix is unavailable.

## [1.3.3] - 2026-11-19

### Changed
- `npm audit fix` clears two moderate advisories; the fixed-output npm dependency hash moves with the refreshed lockfile.

# Changelog

## 1.3.4 - 2026-11-19

- Recover missing or digest-mismatched cell manifests by probing only those cells at startup; report manifest source and regeneration guidance.
- Add `npm run nix:refresh-hash` to refresh and verify the fixed-output Nix dependency hash after lockfile changes.

## 1.3.2 - 2026-11-18

- Guard the package-derived runtime version against drift with a test.

## 1.3.1 - 2026-11-18

- Add redacted structured lifecycle and tool logs plus per-cell counters to `/healthz`.
- Separate process liveness from manifest-based readiness with `/livez` and `/readyz`.
- Keep restart, failure, and tool latency counters in memory for the process lifetime.

## 1.3.0 - 2026-11-14

- Expose read-only `hela.update.check` and confirmation-gated `hela.update.apply` controls through the runtime and native agent catalog.
- Route update requests through the managed snapshot controller with rollback reporting and an explicit restart-required result.
- Keep automatic update checks opt-in and check-only; the runtime never grants the agent arbitrary installer shell access.

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
