import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  ListPromptsRequestSchema,
  GetPromptRequestSchema,
  ListResourcesRequestSchema,
  ReadResourceRequestSchema,
  McpError,
  ErrorCode,
  type CallToolResult,
  type Tool,
} from '@modelcontextprotocol/sdk/types.js';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import os from 'node:os';
import { spawn } from 'node:child_process';
import type { CellSpec, CellHandle } from './types.js';
import { bootCell, callTool, shutdownCell } from './cell-loader.js';
import { ManifestStore } from './manifest.js';
import { NativeNeedleAgent, scoreTools, type AgentContext, type AgentTool } from './agent.js';
import { VERSION } from './version.js';
import {
  loadProfileContext,
  PROFILE_PROMPT_NAME,
  PROFILE_RESOURCE_URI,
  renderProfileContext,
  renderProfilePrompt,
} from './profile-context.js';

export interface RuntimeOptions {
  root?: string;
  manifestPath?: string;
  profile?: string | null;
  namespaced?: boolean;
  bootTimeoutMs?: number;
  toolTimeoutMs?: number;
  agentTimeoutMs?: number;
  shutdownGraceMs?: number;
  restartDelayMs?: number;
  maxRestartAttempts?: number;
}

type CellMetrics = { starts: number; restarts: number; failures: number; toolCalls: number; totalMs: number; maxMs: number };
const safeLabel = (value: string): string => /^[a-zA-Z0-9_.-]{1,100}$/.test(value) ? value : 'unknown';
const safeError = (error: unknown): string => error instanceof Error ? safeLabel(error.name) : 'Error';

const RUNTIME_UPDATE_CELL = '__runtime__';
const UPDATE_CHECK_TOOL = 'hela.update.check';
const UPDATE_APPLY_TOOL = 'hela.update.apply';

// Mitosis's agent_run is cell-local; the aggregate surface exposes the runtime agent as hela.agent.run.
const excludedAgentCatalogToolNames = new Set([
  'agent_run',
  'hela.agent.run',
  'hela.agent.plan',
  'hela.catalog.list',
  'hela.catalog.search',
  'hela.pipe',
  'workflow_orchestrator',
  'workflow_status',
  'workflow_cancel',
  'validate_tool_chain',
  'analyze_tool_chain_performance',
  'analyze_tools',
  'generate_route_suggestions',
  'get_tool_chain_analysis',
  'suggest_skill_chain',
  'brainstorming',
  'sequentialthinking',
  'list_mcp_servers',
  'search_instructions',
  'load_instruction',
  'get_prompt',
  'search_prompts',
  'get_resource_set',
  'search_resource_sets',
]);
const excludedAgentCatalogToolPatterns = [
  /^llm_.*$/,
  /^agent_(spawn|send|fork|list|info|close|create)$/,
];

const runtimeUpdateTools: AgentTool[] = [
  {
    name: UPDATE_CHECK_TOOL,
    cell: RUNTIME_UPDATE_CELL,
    realName: UPDATE_CHECK_TOOL,
    description: 'Read-only check for a newer HeLa ecosystem snapshot. Reports changed cells and never modifies the installation.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: UPDATE_APPLY_TOOL,
    cell: RUNTIME_UPDATE_CELL,
    realName: UPDATE_APPLY_TOOL,
    description: 'Apply the latest verified HeLa ecosystem snapshot. Requires confirm=true, preserves a rollback record, and requires a runtime/client restart afterward.',
    inputSchema: {
      type: 'object',
      properties: { confirm: { type: 'boolean', description: 'Explicitly authorize changing the managed installation.' } },
      required: ['confirm'],
      additionalProperties: false,
    },
  },
];

function ecosystemRoot(): string {
  if (process.env.HELA_ECOSYSTEM_ROOT) return process.env.HELA_ECOSYSTEM_ROOT;
  const candidates = [
    path.resolve(process.cwd(), '..', 'hela-mcp-ecosystem'),
    path.resolve(process.cwd(), 'hela-mcp-ecosystem'),
    '/home/azzar/project/MCPservers/hela-mcp-ecosystem',
  ];
  for (const c of candidates) if (fs.existsSync(path.join(c, 'config', 'inventory.json'))) return c;
  return candidates[0];
}

function manifestPath(): string {
  const dir = path.join(os.homedir(), '.cache', 'hela-runtime');
  try { fs.mkdirSync(dir, { recursive: true }); } catch { /* ignore */ }
  return path.join(dir, 'manifest.json');
}

export class HelaRuntime {
  root: string;
  profile: string | null;
  namespaced: boolean;
  cells = new Map<string, CellHandle>();
  toolToCell = new Map<string, string>();
  toolToReal = new Map<string, string>();
  deadCells = new Set<string>();
  specs = new Map<string, CellSpec>();
  lazyCells = new Set<string>();
  server: Server;
  restartAttempts = new Map<string, number>();
  cachedManifest: Record<string, Array<{ name: string; description?: string; inputSchema: any }>> = {};
  booting = new Set<string>();
  private bootTasks = new Map<string, Promise<void>>();
  private restartTimers = new Map<string, NodeJS.Timeout>();
  private stopping = false;
  private booted = false;
  private shutdownTask?: Promise<void>;
  private bootAbort = new AbortController();
  private healthServer?: http.Server;
  private manifests!: ManifestStore;
  manifestSources = new Map<string, 'cache' | 'catalog' | 'missing' | 'live'>();
  cellStartupMs = new Map<string, number>();
  nativeAgent?: NativeNeedleAgent;
  nativeAgentEnabled = process.env.HELA_NATIVE_AGENT !== 'false';
  nativeAgentReady = false;
  private metrics = new Map<string, CellMetrics>();

  constructor(private readonly options: RuntimeOptions = {}) {
    this.root = options.root ?? ecosystemRoot();
    this.profile = options.profile === undefined ? process.env.HELA_PROFILE || 'minimal' : options.profile;
    // Namespacing is on by default: bare names like read_file or execute_command
    // shadow whatever the host already exposes, and a collision is resolved by
    // whichever server connected last. HELA_NAMESPACE_TOOLS=0 opts a client back out.
    this.namespaced = options.namespaced ?? process.env.HELA_NAMESPACE_TOOLS !== '0';
    this.server = this.createServer();
  }

  /** Build the complete, live tool catalog across every selected cell. */
  agentCatalog(): AgentTool[] {
    const seen = new Set<string>();
    const catalog: AgentTool[] = [...runtimeUpdateTools];
    for (const [cellKey, cached] of Object.entries(this.cachedManifest)) {
      if (!this.specs.has(cellKey) || this.deadCells.has(cellKey)) continue;
      const live = this.cells.get(cellKey)?.ready ? [...this.cells.get(cellKey)!.tools.values()] : cached;
      const short = cellKey.replace(/^hela-/, '');
      for (const tool of live) {
        const exposed = this.namespaced ? `hela_${short}_${tool.name}` : tool.name;
        if (seen.has(exposed)
          || excludedAgentCatalogToolNames.has(exposed)
          || excludedAgentCatalogToolNames.has(tool.name)
          || excludedAgentCatalogToolPatterns.some((pattern) => pattern.test(exposed) || pattern.test(tool.name))) continue;
        seen.add(exposed);
        catalog.push({ name: exposed, cell: cellKey, realName: tool.name, description: tool.description, inputSchema: tool.inputSchema });
      }
    }
    return catalog;
  }

  async executeAgentTool(tool: AgentTool, args: Record<string, unknown>): Promise<unknown> {
    if (tool.cell === RUNTIME_UPDATE_CELL) return this.executeRuntimeUpdate(tool.name, args);
    let cell = this.cells.get(tool.cell);
    if (!cell?.ready) cell = await this.ensureCell(tool.cell);
    if (!cell?.ready) throw new Error(`Cell not ready: ${tool.cell}`);
    const realName = this.toolToReal.get(tool.name) ?? tool.realName;
    if (!cell.tools.has(realName)) throw new Error(`Tool ${tool.name} is not registered on ${tool.cell}`);
    return this.invokeTool(tool.cell, realName, () => callTool(cell!, realName, args, this.options.toolTimeoutMs ?? 60000));
  }

  private updateControllerPath(): string {
    return path.join(this.root, 'scripts', 'update-controller.mjs');
  }

  private async executeRuntimeUpdate(name: string, args: Record<string, unknown>): Promise<Record<string, unknown>> {
    if (name === UPDATE_APPLY_TOOL && args.confirm !== true) {
      return { ok: false, requiresConfirmation: true, error: 'Applying an update requires confirm=true.' };
    }
    if (name !== UPDATE_CHECK_TOOL && name !== UPDATE_APPLY_TOOL) {
      return { ok: false, error: `Unknown runtime update tool: ${name}` };
    }
    const controller = this.updateControllerPath();
    if (!fs.existsSync(controller)) {
      return { ok: false, error: `Update controller is not installed at ${controller}` };
    }
    const prefix = process.env.HELA_INSTALL_PREFIX || path.dirname(this.root);
    const command = name === UPDATE_CHECK_TOOL ? 'check' : 'apply';
    const commandArgs = [controller, command, '--prefix', prefix, '--json'];
    if (command === 'apply') commandArgs.push('--confirm');
    return new Promise((resolve) => {
      const child = spawn(process.execPath, commandArgs, {
        cwd: this.root,
        env: { ...process.env, HELA_INSTALL_PREFIX: prefix },
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      let stdout = '';
      let stderr = '';
      child.stdout.on('data', (chunk: Buffer) => { stdout += chunk.toString(); });
      child.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString(); });
      child.once('error', (error) => resolve({ ok: false, error: error.message }));
      child.once('close', (code) => {
        const line = stdout.trim().split('\n').filter(Boolean).pop();
        if (line) {
          try {
            const result = JSON.parse(line) as Record<string, unknown>;
            resolve(code === 0 ? result : { ...result, ok: false, error: result.error ?? (stderr.trim() || `Update controller exited with ${code}`) });
            return;
          } catch { /* fall through to a structured process error */ }
        }
        resolve({ ok: false, error: stderr.trim() || `Update controller exited with ${code ?? 'unknown status'}` });
      });
    });
  }

  agentContext(): AgentContext {
    // The ecosystem root holds the cell sources, not user data. launch.mjs
    // starts the daemon in the installation workspace and exports it as
    // GUARDIAN_PROJECT_ROOT, so prefer those over <root>/workspace (which
    // does not exist in installed layouts).
    const workspace = process.env.HELA_WORKSPACE
      || process.env.GUARDIAN_PROJECT_ROOT
      || (fs.existsSync(path.join(this.root, 'workspace')) ? path.join(this.root, 'workspace') : process.cwd());
    return { workspaceRoot: workspace, cwd: workspace };
  }

  createServer(): Server {
    return new Server(
      { name: 'hela-runtime', version: VERSION },
      { capabilities: { tools: {}, prompts: {}, resources: {} } },
    );
  }

  private profileContext() {
    const toolsByCell = Object.fromEntries(Object.entries(this.cachedManifest).map(([cell, tools]) => [
      cell,
      tools.map((tool) => tool.name),
    ]));
    return loadProfileContext(this.root, this.profile, toolsByCell);
  }

  private selectedSpecs(): CellSpec[] {
    const invPath = path.join(this.root, 'config', 'inventory.json');
    const inv = JSON.parse(fs.readFileSync(invPath, 'utf8'));
    const all: CellSpec[] = (Object.values(inv.inventory) as Record<string, unknown>[])
      .filter((s) => s.kind !== 'runtime' && s.id !== 'hela-runtime')
      .map((s) => {
        const spec: CellSpec = {
          id: String(s.id),
          alias: String(s.alias),
          source: String(s.source),
          dir: String(s.dir),
          entry: String(s.entry),
          revision: s.revision ? String(s.revision) : undefined,
          version: s.version ? String(s.version) : undefined,
          scope: s.scope ? String(s.scope) : undefined,
          lazy: s.lazy === true,
          env: Array.isArray(s.env) ? s.env as string[] : [],
          toolFeatures: s.toolFeatures as CellSpec['toolFeatures'],
        };
        return spec;
      });

    let selected = all;
    const profilesPath = path.join(this.root, 'config', 'profiles.json');
    if (this.profile) {
      const profiles = JSON.parse(fs.readFileSync(profilesPath, 'utf8')).profiles;
      const prof = profiles.find((p: { id: string }) => p.id === this.profile);
      if (!prof) throw new Error(`Unknown profile: ${this.profile}`);
      const allowed = new Set(prof.servers);
      selected = all.filter((s) => allowed.has(s.id));
    }
    this.specs.clear();
    this.lazyCells.clear();
    for (const s of selected) {
      this.specs.set(s.id, s);
      // ALL cells are lazy by default for fast startup
      this.lazyCells.add(s.id);
    }

    return selected;
  }

  private bootOne(spec: CellSpec): Promise<void> {
    if (this.stopping || this.deadCells.has(spec.id) || !this.specs.has(spec.id)) return Promise.resolve();
    const task = this.bootTasks.get(spec.id);
    if (task) return task;
    if (this.cells.has(spec.id) || this.restartTimers.has(spec.id)) return Promise.resolve();
    this.booting.add(spec.id);
    const boot = this.startCell(spec).finally(() => {
      this.booting.delete(spec.id);
      this.bootTasks.delete(spec.id);
    });
    this.bootTasks.set(spec.id, boot);
    return boot;
  }

  private async startCell(spec: CellSpec): Promise<void> {
    this.metric(spec.id).starts++;
    try {
      const started = performance.now();
      const fingerprint = this.manifests.identity(spec).fingerprint;
      const handle = await bootCell(spec, {
        root: this.root,
        timeoutMs: this.options.bootTimeoutMs ?? 60000,
        shutdownGraceMs: this.options.shutdownGraceMs,
        signal: this.bootAbort.signal,
      });
      if (this.stopping) {
        await shutdownCell(handle);
        return;
      }
      this.cells.set(handle.key, handle);
      this.logEvent(spec.id, 'start', true);
      this.cellStartupMs.set(spec.id, performance.now() - started);
      this.deadCells.delete(spec.id);
      const cellShort = spec.id.replace(/^hela-/, '');
      for (const toolName of handle.tools.keys()) {
        const exposed = this.namespaced ? `hela_${cellShort}_${toolName}` : toolName;
        this.toolToCell.set(exposed, handle.key);
        this.toolToReal.set(exposed, toolName);
      }

      const onExit = () => {
        if (this.stopping || this.cells.get(spec.id) !== handle) return;
        this.metric(spec.id).failures++;
        this.logEvent(spec.id, 'stop', false, undefined, undefined, 'cell exited');
        this.scheduleRestart(spec);
      };
      handle.proc.once('exit', onExit);
      if (handle.proc.exitCode !== null || handle.proc.signalCode !== null) onExit();

      this.cachedManifest[spec.id] = [...handle.tools.values()];
      this.manifestSources.set(spec.id, 'live');
      try { this.manifests.save(spec.id, fingerprint, [...handle.tools.values()]); }
      catch { console.error(`[hela-runtime] manifest save failed for ${spec.id}`); }
    } catch (e: unknown) {
      if (this.stopping) return;
      this.metric(spec.id).failures++;
      this.logEvent(spec.id, 'start', false, undefined, undefined, safeError(e));
      this.scheduleRestart(spec);
    }
  }

  private scheduleRestart(spec: CellSpec): void {
    if (this.stopping || this.restartTimers.has(spec.id) || this.deadCells.has(spec.id)) return;
    const attempts = this.restartAttempts.get(spec.id) ?? 0;
    if (attempts >= (this.options.maxRestartAttempts ?? 3)) {
      console.error(`[hela-runtime] cell ${spec.id} dead after ${attempts} restart attempts`);
      this.deadCells.add(spec.id);
      const old = this.cells.get(spec.id);
      if (old) {
        for (const [tn, ck] of this.toolToCell) if (ck === spec.id) { this.toolToCell.delete(tn); this.toolToReal.delete(tn); }
        this.cells.delete(spec.id);
      }
      return;
    }
    this.restartAttempts.set(spec.id, attempts + 1);
    this.metric(spec.id).restarts++;
    this.logEvent(spec.id, 'restart', true);
    const delay = Math.min((this.options.restartDelayMs ?? 1000) * 2 ** attempts, 8000);
    const timer = setTimeout(() => {
      this.restartTimers.delete(spec.id);
      if (this.stopping) return;
      const old = this.cells.get(spec.id);
      if (old) {
        for (const [tn, ck] of this.toolToCell) if (ck === spec.id) { this.toolToCell.delete(tn); this.toolToReal.delete(tn); }
        this.cells.delete(spec.id);
      }
      void this.bootOne(spec);
    }, delay);
    this.restartTimers.set(spec.id, timer);
  }

  async boot(): Promise<void> {
    if (this.stopping || this.booted) return;
    const specs = this.selectedSpecs();
    this.manifests = new ManifestStore(this.options.manifestPath ?? manifestPath(), this.root, this.profile, this.namespaced);
    this.cachedManifest = {};
    const recoverySpecs: CellSpec[] = [];
    const reasons = new Map<string, string>();
    for (const spec of specs) {
      try {
        const manifest = this.manifests.load(spec);
        this.manifestSources.set(spec.id, manifest.source);
        reasons.set(spec.id, manifest.reason);
        this.cachedManifest[spec.id] = manifest.tools;
        const cellShort = spec.id.replace(/^hela-/, '');
        for (const tool of manifest.tools) {
          const exposed = this.namespaced ? `hela_${cellShort}_${tool.name}` : tool.name;
          if (this.toolToCell.has(exposed)) throw new Error(`Duplicate tool: ${exposed}`);
          this.toolToCell.set(exposed, spec.id);
          this.toolToReal.set(exposed, tool.name);
        }
        if (manifest.source === 'missing') recoverySpecs.push(spec);
      } catch (error) {
        if (error instanceof Error && error.message.startsWith('Duplicate tool:')) throw error;
        this.manifestSources.set(spec.id, 'missing');
        reasons.set(spec.id, error instanceof Error ? error.message : 'manifest load failed');
        recoverySpecs.push(spec);
      }
    }
    console.error(`[hela-runtime] profile=${this.profile ?? 'all'} cells=${specs.length} mode=on-demand`);
    const profileArg = this.profile ?? 'all';
    const regenerate = `cd ${this.root} && npm run catalog:generate -- --profile ${profileArg}`;
    for (const spec of specs) {
      const source = this.manifestSources.get(spec.id) ?? 'missing';
      console.error(`[hela-runtime] manifest cell=${spec.id} source=${source} reason=${reasons.get(spec.id) ?? 'manifest load failed'}; regenerate: ${regenerate}`);
    }

    if (this.nativeAgentEnabled) {
      this.nativeAgent = new NativeNeedleAgent(this, {
        root: this.root,
        profile: this.profile,
        needleTimeoutMs: parseInt(process.env.NEEDLE_TIMEOUT_MS || '30000', 10),
      });
      const health = this.nativeAgent.health();
      // Only advertise the native agent when its engine and weights exist.
      // Fixture runtimes have no Needle assets and must keep the cell-local
      // agent_run contract untouched.
      this.nativeAgentReady = health.ok;
      console.error(`[hela-runtime] native agent ${health.ok ? 'ready' : 'unavailable'}: ${health.detail ?? `${health.engine}${health.model ? ` + ${health.model}` : ''}`}`);
    }

    // cross-cell pipe (runtime-internal chaining)
    this.toolToCell.set('hela.pipe', '__runtime__');
    this.toolToReal.set('hela.pipe', 'hela.pipe');

    this.attachHandlers(this.server);
    this.booted = true;

    // A stale/missing generated schema cannot safely advertise the cell. Probe
    // only those cells once, then replace the missing manifest with live tools.
    for (const spec of recoverySpecs) await this.bootOne(spec);

    // optional HTTP health endpoint
    const httpPort = parseInt(process.env.HELA_HTTP_PORT || '0', 10);
    if (httpPort > 0) {
      const srv = http.createServer((req, res) => {
        if (req.url === '/livez') {
          res.setHeader('Content-Type', 'application/json');
          res.end(JSON.stringify({ status: 'live' }));
          return;
        }
        if (req.url === '/readyz') {
          const ready = this.isReady();
          res.statusCode = ready ? 200 : 503;
          res.setHeader('Content-Type', 'application/json');
          res.end(JSON.stringify({ status: ready ? 'ready' : 'not_ready', manifestSources: Object.fromEntries(this.manifestSources) }));
          return;
        }
        if (req.url === '/healthz') {
          const ready = this.isReady();
          const status = {
            status: 'ok', liveness: 'live', readiness: ready ? 'ready' : 'not_ready', ready,
            version: VERSION,
            profile: this.profile ?? 'all',
            counters: this.metricsSnapshot(),
            cells: [...this.specs.keys()].map((id) => {
              const cell = this.cells.get(id);
              return { id, ready: cell?.ready ?? false, tools: cell?.tools.size ?? (this.cachedManifest[id]?.length ?? 0), manifestSource: this.manifestSources.get(id) ?? 'missing' };
            }),
          };
          res.setHeader('Content-Type', 'application/json');
          res.end(JSON.stringify(status));
        } else {
          res.statusCode = 404;
          res.end('not found');
        }
      });
      this.healthServer = srv;
      srv.on('error', (err) => {
        console.error(`[hela-runtime] http health on :${httpPort} failed: ${err.message} (continuing without http)`);
      });
      srv.listen(httpPort, () => console.error(`[hela-runtime] http health on :${httpPort}`));
    }
  }

  private metric(cell: string): CellMetrics {
    let value = this.metrics.get(cell);
    if (!value) { value = { starts: 0, restarts: 0, failures: 0, toolCalls: 0, totalMs: 0, maxMs: 0 }; this.metrics.set(cell, value); }
    return value;
  }

  private metricsSnapshot(): Record<string, CellMetrics> {
    return Object.fromEntries([...this.metrics].map(([cell, value]) => [cell, { ...value }]));
  }

  private isReady(): boolean {
    return this.booted && [...this.specs.keys()].every((id) => this.manifestSources.get(id) !== undefined && this.manifestSources.get(id) !== 'missing');
  }

  private logEvent(cell: string, event: string, ok: boolean, tool?: string, durationMs?: number, error?: string): void {
    console.error(JSON.stringify({ ts: new Date().toISOString(), cell: safeLabel(cell), event, ...(tool ? { tool: safeLabel(tool) } : {}), ...(durationMs === undefined ? {} : { durationMs }), ok, ...(error ? { error: safeLabel(error) } : {}) }));
  }

  private async invokeTool<T>(cell: string, tool: string, invoke: () => Promise<T>): Promise<T> {
    const started = performance.now();
    let ok = false;
    try { const result = await invoke(); ok = true; return result; }
    catch (error) { this.metric(cell).failures++; throw error; }
    finally {
      const durationMs = Math.round(performance.now() - started);
      const counters = this.metric(cell);
      counters.toolCalls++; counters.totalMs += durationMs; counters.maxMs = Math.max(counters.maxMs, durationMs);
      this.logEvent(cell, 'tool', ok, tool, durationMs, ok ? undefined : 'tool invocation failed');
    }
  }

  async ensureCell(cellKey: string): Promise<CellHandle | undefined> {
    if (this.stopping || this.deadCells.has(cellKey) || !this.specs.has(cellKey)) return undefined;
    const existing = this.cells.get(cellKey);
    if (existing && existing.ready) return existing;
    const boot = this.bootTasks.get(cellKey);
    if (boot) {
      await boot;
      const cell = this.cells.get(cellKey);
      return !this.stopping && cell?.ready ? cell : undefined;
    }
    if (existing || this.restartTimers.has(cellKey)) return undefined;
    const spec = this.specs.get(cellKey);
    if (!spec) return undefined;
    await this.bootOne(spec);
    const cell = this.cells.get(cellKey);
    return !this.stopping && cell?.ready ? cell : undefined;
  }

  /**
   * Interpret a cell's tool result. Cells report failure inside the payload
   * (`{success:false}` / `{ok:false}`) rather than through the transport, so the
   * pipe has to read the body to know a step failed (hela-runtime#3).
   */
  /**
   * Degradation markers a cell may set on its payload. The ecosystem contract is
   * `status: ok | degraded | failed`: a lossy, partial or substituted result must
   * be visible in the shape, not only in prose (hela-mcp-ecosystem#8).
   */
  private static degradationReasons(structured: unknown): string[] {
    if (structured === null || typeof structured !== 'object') return [];
    const record = structured as Record<string, unknown>;
    const reasons: string[] = [];
    for (const key of ['degraded', 'partial', 'truncated'] as const) {
      if (record[key] === true) reasons.push(key);
      const detail = record[key];
      if (detail && typeof detail === 'object' && typeof (detail as { reason?: unknown }).reason === 'string') {
        reasons.push(String((detail as { reason: string }).reason));
      }
    }
    if (record.status === 'degraded') reasons.push('status=degraded');
    if (Array.isArray(record.warnings)) {
      for (const warning of record.warnings) {
        if (typeof warning === 'string' && warning.trim()) reasons.push(warning.trim());
      }
    }
    return [...new Set(reasons)];
  }

  private pipeStepOutcome(res: unknown): { ok: boolean; payload: unknown; error?: string; degraded: string[] } {
    const envelope = res as { content?: Array<{ type?: string; text?: string }>; isError?: boolean } | undefined;
    const text = (envelope?.content ?? [])
      .filter((part) => part?.type === 'text' && typeof part.text === 'string')
      .map((part) => part.text as string)
      .join('\n');

    let structured: unknown;
    try {
      structured = JSON.parse(text);
    } catch {
      structured = undefined;
    }

    const failed = envelope?.isError === true
      || (structured !== null && typeof structured === 'object'
        && ((structured as Record<string, unknown>).success === false || (structured as Record<string, unknown>).ok === false));
    if (!failed) {
      return {
        ok: true,
        payload: structured !== undefined ? structured : text,
        degraded: HelaRuntime.degradationReasons(structured),
      };
    }

    const record = (structured ?? {}) as Record<string, unknown>;
    const reason = record.error ?? record.message ?? text.slice(0, 300) ?? 'step failed';
    return { ok: false, payload: structured !== undefined ? structured : text, error: String(reason), degraded: [] };
  }

  private async runPipe(args: Record<string, unknown>): Promise<{ content: Array<{ type: string; text: string }>; isError?: boolean }> {
    const steps = Array.isArray(args?.steps) ? args.steps : [];
    const onError = args?.onError === 'continue' ? 'continue' : 'stop';
    const results: Record<string, unknown>[] = [];
    let prev: unknown = null;
    let failedStep: number | null = null;
    let firstError: string | undefined;

    for (let i = 0; i < steps.length; i++) {
      const step = steps[i] as any;
      const cellKey = step.cell;
      const toolName = step.tool;
      if (!this.specs.has(cellKey)) {
        return { content: [{ type: 'text', text: `Pipe failed at step ${i}: cell ${cellKey} is not in the selected profile` }], isError: true };
      }
      if (this.specs.has(cellKey) && !this.cells.get(cellKey)?.ready) {
        await this.ensureCell(cellKey);
      }
      const cell = this.cells.get(cellKey);
      if (!cell || !cell.ready) {
        return { content: [{ type: 'text', text: `Pipe failed at step ${i}: cell ${cellKey} not ready` }], isError: true };
      }

      let stepArgs = step.args ? { ...step.args } : {};
      for (const k of Object.keys(stepArgs)) {
        if (typeof stepArgs[k] !== 'string') continue;
        const raw = stepArgs[k] as string;
        if (raw.includes('{{prev}}')) {
          // Never hand a failed step's error text to the next tool as input. With
          // onError=continue it becomes null so the next step fails loudly instead
          // of analysing an error string.
          if (prev === null) stepArgs[k] = raw === '{{prev}}' ? null : raw.replace(/\{\{prev\}\}/g, '');
          else stepArgs[k] = raw.replace(/\{\{prev\}\}/g, typeof prev === 'string' ? prev : JSON.stringify(prev));
        }
      }
      if (prev !== null && stepArgs.prev === undefined && stepArgs.input === undefined) {
        stepArgs.prev = prev;
      }

      try {
        const res = await this.invokeTool(cellKey, toolName, () => callTool(cell, toolName, stepArgs, this.options.toolTimeoutMs ?? 60000));
        const outcome = this.pipeStepOutcome(res);
        results.push({
          step: i,
          cell: cellKey,
          tool: toolName,
          ok: outcome.ok,
          status: outcome.ok ? (outcome.degraded.length ? 'degraded' : 'ok') : 'failed',
          ...(outcome.ok ? {} : { error: outcome.error }),
          ...(outcome.ok && outcome.degraded.length ? { degraded: outcome.degraded } : {}),
          result: res,
        });
        if (!outcome.ok) {
          if (failedStep === null) { failedStep = i; firstError = outcome.error; }
          if (onError === 'stop') break;
          prev = null;
        } else {
          prev = outcome.payload;
        }
      } catch (e: unknown) {
        const message = e instanceof Error ? e.message : String(e);
        results.push({ step: i, cell: cellKey, tool: toolName, ok: false, error: message });
        if (failedStep === null) { failedStep = i; firstError = message; }
        if (onError === 'stop') break;
        prev = null;
      }
    }

    const ok = failedStep === null;
    const degradations = results
      .filter((step) => step.status === 'degraded')
      .map((step) => ({ step: step.step, cell: step.cell, tool: step.tool, reasons: step.degraded }));
    const status = !ok ? 'failed' : degradations.length ? 'degraded' : 'ok';
    const payload = {
      ok,
      status,
      steps: results.length,
      ...(failedStep !== null ? { failedStep, error: firstError } : {}),
      // Degradation is part of the shape, not a note a caller can miss.
      ...(degradations.length ? { degraded: degradations } : {}),
      results,
    };
    return {
      content: [{ type: 'text', text: JSON.stringify(payload, null, 2) }],
      ...(ok ? {} : { isError: true }),
    };
  }

  private jsonResult(value: unknown): { content: Array<{ type: string; text: string }>; isError?: boolean } {
    const failed = Boolean(value && typeof value === 'object' && (value as Record<string, unknown>).ok === false);
    return {
      content: [{ type: 'text', text: JSON.stringify(value, null, 2) }],
      ...(failed ? { isError: true } : {}),
    };
  }

  private catalogList(args: Record<string, unknown>): Record<string, unknown> {
    const catalog = this.agentCatalog();
    const cell = typeof args.cell === 'string' ? args.cell.trim() : '';
    const query = typeof args.query === 'string' ? args.query.trim() : '';
    let tools = cell ? catalog.filter((tool) => tool.cell === cell || tool.cell === `hela-${cell}`) : catalog;
    if (query) tools = scoreTools(tools, query).map((entry) => entry.tool);
    const limit = Number.isFinite(Number(args.limit)) ? Math.max(1, Math.min(300, Math.floor(Number(args.limit)))) : undefined;
    const cells = [...new Set(catalog.map((tool) => tool.cell))];
    return {
      ok: true,
      total: catalog.length,
      count: tools.length,
      cells: cells.map((id) => ({ id, tools: catalog.filter((tool) => tool.cell === id).length })),
      tools: (limit ? tools.slice(0, limit) : tools).map((tool) => ({
        name: tool.name,
        cell: tool.cell,
        description: tool.description,
      })),
    };
  }

  private catalogSearch(args: Record<string, unknown>): Record<string, unknown> {
    const query = String(args.query ?? '').trim();
    if (!query) return { ok: false, error: 'query is required' };
    const limit = Number.isFinite(Number(args.limit)) ? Math.max(1, Math.min(50, Math.floor(Number(args.limit)))) : 10;
    const ranked = scoreTools(this.agentCatalog(), query).slice(0, limit);
    return {
      ok: true,
      query,
      total: this.agentCatalog().length,
      matches: ranked.map((entry) => ({
        name: entry.tool.name,
        cell: entry.tool.cell,
        score: Math.round(entry.score * 100) / 100,
        description: entry.tool.description,
      })),
    };
  }

  attachHandlers(server: Server): void {
    server.setRequestHandler(ListResourcesRequestSchema, async () => ({
      resources: [{
        uri: PROFILE_RESOURCE_URI,
        name: 'HeLa runtime profile context',
        description: 'Current profile, active organelles, boundaries, and available runtime tools.',
        mimeType: 'text/markdown',
      }],
    }));

    server.setRequestHandler(ReadResourceRequestSchema, async (req) => {
      if (req.params.uri !== PROFILE_RESOURCE_URI) {
        throw new McpError(ErrorCode.InvalidRequest, `Unknown resource: ${req.params.uri}`);
      }
      return {
        contents: [{
          uri: PROFILE_RESOURCE_URI,
          mimeType: 'text/markdown',
          text: renderProfileContext(this.profileContext()),
        }],
      };
    });

    server.setRequestHandler(ListPromptsRequestSchema, async () => ({
      prompts: [{
        name: PROFILE_PROMPT_NAME,
        description: 'Load the current profile-aware HeLa runtime instructions without creating workspace files.',
        arguments: [{
          name: 'focus',
          description: 'Optional task-specific focus to append to the runtime instructions.',
          required: false,
        }],
      }],
    }));

    server.setRequestHandler(GetPromptRequestSchema, async (req) => {
      if (req.params.name !== PROFILE_PROMPT_NAME) {
        throw new McpError(ErrorCode.InvalidRequest, `Unknown prompt: ${req.params.name}`);
      }
      const focus = req.params.arguments?.focus;
      if (focus !== undefined && typeof focus !== 'string') {
        throw new McpError(ErrorCode.InvalidParams, 'Prompt argument "focus" must be a string');
      }
      return {
        description: 'Profile-aware HeLa runtime instructions',
        messages: [{
          role: 'user',
          content: { type: 'text', text: renderProfilePrompt(this.profileContext(), focus) },
        }],
      };
    });

    server.setRequestHandler(ListToolsRequestSchema, async () => {
      const tools: Tool[] = [];
      const seen = new Set<string>();

      for (const tool of runtimeUpdateTools) {
        seen.add(tool.name);
        tools.push({ name: tool.name, description: tool.description, inputSchema: tool.inputSchema });
      }

      // From booted cells
      for (const cell of this.cells.values()) {
        if (!this.specs.has(cell.key)) continue;
        if (!cell.ready) continue;
        if (this.deadCells.has(cell.key)) continue;
        const cellShort = cell.key.replace(/^hela-/, '');
        for (const t of cell.tools.values()) {
          // Hide Mitosis's cell-local agent; the runtime-native tool is added below.
          if (cell.key === 'hela-mitosis' && t.name === 'agent_run') continue;
          const exposed = this.namespaced ? `hela_${cellShort}_${t.name}` : t.name;
          if (seen.has(exposed)) continue;
          seen.add(exposed);
          tools.push({ name: exposed, description: t.description, inputSchema: t.inputSchema });
        }
      }

      // From cached manifest (for not-yet-booted cells)
      for (const [cellKey, cachedTools] of Object.entries(this.cachedManifest)) {
        if (!this.specs.has(cellKey)) continue;
        if (this.cells.get(cellKey)?.ready) continue;
        if (this.deadCells.has(cellKey)) continue;
        const cellShort = cellKey.replace(/^hela-/, '');
        for (const t of cachedTools) {
          // Hide Mitosis's cell-local agent; the runtime-native tool is added below.
          if (cellKey === 'hela-mitosis' && t.name === 'agent_run') continue;
          const exposed = this.namespaced ? `hela_${cellShort}_${t.name}` : t.name;
          if (seen.has(exposed)) continue;
          seen.add(exposed);
          tools.push({ name: exposed, description: t.description, inputSchema: t.inputSchema });
        }
      }

      // Runtime-native Needle agent. This shadows the cell-local agent_run:
      // Mitosis can only discover its own tools, while the runtime can see
      // every cell. The agent plans over the complete catalog and executes
      // in-process, so it works with the bundled Needle 3 and no API key.
      if (this.nativeAgentEnabled && this.nativeAgentReady && this.nativeAgent) {
        const agentInputSchema = {
          type: 'object' as const,
          properties: {
            task: { type: 'string', description: 'The task or objective for the agent to accomplish' },
            maxIterations: { type: 'number', minimum: 1, maximum: 20, default: 8, description: 'Maximum decide-act-observe iterations' },
            maxToolCalls: { type: 'number', minimum: 1, maximum: 30, default: 12, description: 'Maximum tool executions per run' },
            maxExecutionMs: { type: 'number', minimum: 1000, maximum: 300000, default: 180000, description: 'Maximum run wall-clock time in milliseconds' },
          },
          required: ['task'],
        };
        const description = 'Runtime-native Needle agent: retrieves relevant tools from the full aggregated catalog, plans with the bundled Needle 3 model, repairs arguments against each JSON Schema, and executes cell tools in-process. No OpenRouter key required. This supersedes the cell-local Mitosis agent_run.';
        if (!tools.find((tool) => tool.name === 'hela.agent.run')) {
          tools.push({ name: 'hela.agent.run', description, inputSchema: agentInputSchema });
        }
        if (!tools.find((tool) => tool.name === 'hela.agent.plan')) {
          tools.push({
            name: 'hela.agent.plan',
            description: 'Inspect the runtime-native agent plan for a task: the deterministic step plan plus the tools retrieved from the full catalog. Read-only; no tool execution.',
            inputSchema: {
              type: 'object',
              properties: {
                task: { type: 'string', description: 'The task to plan' },
                limit: { type: 'number', minimum: 1, maximum: 20, default: 8, description: 'Maximum retrieved tools to return' },
              },
              required: ['task'],
            },
          });
        }
        if (!tools.find((tool) => tool.name === 'hela.catalog.list')) {
          tools.push({
            name: 'hela.catalog.list',
            description: 'List the runtime\'s complete aggregated tool catalog, optionally filtered by cell or ranked by a query. Use this to verify that the runtime sees all cells.',
            inputSchema: {
              type: 'object',
              properties: {
                cell: { type: 'string', description: 'Optional cell id filter, e.g. hela-cytosol' },
                query: { type: 'string', description: 'Optional retrieval query to rank tools' },
                limit: { type: 'number', minimum: 1, maximum: 300, description: 'Maximum tools to return' },
              },
            },
          });
        }
        if (!tools.find((tool) => tool.name === 'hela.catalog.search')) {
          tools.push({
            name: 'hela.catalog.search',
            description: 'Rank the runtime\'s complete aggregated tool catalog against a query. Read-only; returns names, cells, scores and descriptions.',
            inputSchema: {
              type: 'object',
              properties: {
                query: { type: 'string', description: 'What capability to search for' },
                limit: { type: 'number', minimum: 1, maximum: 50, default: 10, description: 'Maximum matches' },
              },
              required: ['query'],
            },
          });
        }
      }

      // Legacy agent host alias. When the native agent cannot run (no Needle
      // assets, or HELA_NATIVE_AGENT=false) keep routing hela.agent.run to the
      // Mitosis agent_run exactly as before.
      if (!this.nativeAgentReady) {
        const mitosisCell = this.cells.get('hela-mitosis');
        const agentTool = this.specs.has('hela-mitosis') && !this.deadCells.has('hela-mitosis')
          ? mitosisCell?.tools.get('agent_run') ?? this.cachedManifest['hela-mitosis']?.find((t) => t.name === 'agent_run')
          : undefined;
        if (agentTool && !tools.find((t) => t.name === 'hela.agent.run')) {
          tools.push({ name: 'hela.agent.run', description: 'Run a task through the HeLa agent host (Needle).', inputSchema: (agentTool as any).inputSchema });
        }
      }

      if (!tools.find((t) => t.name === 'hela.pipe')) {
        tools.push({
          name: 'hela.pipe',
          description: 'Run a sequence of tool calls across cells in-process, piping each result to the next. Steps: [{cell, tool, args}]. Use "{{prev}}" in string args to inject the previous result. Fails closed: onError defaults to "stop", ok is false when any step failed, and a failed step is never piped onward as data.',
          inputSchema: {
            type: 'object',
            properties: {
              steps: {
                type: 'array',
                items: {
                  type: 'object',
                  properties: {
                    cell: { type: 'string', description: 'Cell id (e.g. hela-membrane)' },
                    tool: { type: 'string', description: 'Tool name on that cell' },
                    args: { type: 'object', description: 'Arguments; use "{{prev}}" to inject previous result' },
                  },
                  required: ['cell', 'tool'],
                },
              },
            },
            onError: {
              type: 'string',
              enum: ['stop', 'continue'],
              description: 'What to do when a step fails. Default "stop"; "continue" runs the remaining steps with {{prev}} unset.',
              default: 'stop',
            },
            required: ['steps'],
          },
        });
      }
      return { tools };
    });

    server.setRequestHandler(CallToolRequestSchema, async (req) => {
      const name = req.params.name;
      const args = req.params.arguments ?? {};
      if (this.stopping) return { content: [{ type: 'text', text: 'Runtime is shutting down' }], isError: true };

      if (name === UPDATE_CHECK_TOOL || name === UPDATE_APPLY_TOOL) {
        return this.jsonResult(await this.invokeTool(RUNTIME_UPDATE_CELL, name, () => this.executeRuntimeUpdate(name, args)));
      }

      if (this.nativeAgentEnabled && this.nativeAgentReady && this.nativeAgent) {
        if (name === 'agent_run' || name === 'hela.agent.run') {
          return this.jsonResult(await this.invokeTool(RUNTIME_UPDATE_CELL, name, () => this.nativeAgent!.run(args)));
        }
        if (name === 'hela.agent.plan') {
          return this.jsonResult(await this.invokeTool(RUNTIME_UPDATE_CELL, name, () => this.nativeAgent!.plan(args)));
        }
        if (name === 'hela.catalog.list') {
          return this.jsonResult(await this.invokeTool(RUNTIME_UPDATE_CELL, name, async () => this.catalogList(args)));
        }
        if (name === 'hela.catalog.search') {
          return this.jsonResult(await this.invokeTool(RUNTIME_UPDATE_CELL, name, async () => this.catalogSearch(args)));
        }
      }
      if (name === 'hela.pipe') {
        return await this.runPipe(args);
      }
      const legacyAgentKnown = this.cells.get('hela-mitosis')?.tools.has('agent_run')
        || this.cachedManifest['hela-mitosis']?.some((tool) => tool.name === 'agent_run');
      const cellKey = this.toolToCell.get(name)
        ?? (name === 'hela.agent.run' && !this.nativeAgentReady && legacyAgentKnown ? 'hela-mitosis' : undefined);
      if (!cellKey || !this.specs.has(cellKey)) {
        throw new McpError(ErrorCode.MethodNotFound, `Unknown tool: ${name}`);
      }
      let cell = this.cells.get(cellKey);
      if ((!cell || !cell.ready) && this.specs.has(cellKey)) {
        cell = await this.ensureCell(cellKey);
      }
      if (!cell || !cell.ready) {
        if (this.deadCells.has(cellKey)) {
          throw new McpError(ErrorCode.MethodNotFound, `Cell ${cellKey} is unavailable (-32601)`);
        }
        return { content: [{ type: 'text', text: `Cell not ready: ${cellKey}` }], isError: true };
      }
      const targetName = name === 'hela.agent.run' && !this.nativeAgentReady
        ? 'agent_run'
        : (this.toolToReal.get(name) ?? name);
      if (!cell.tools.has(targetName)) throw new McpError(ErrorCode.MethodNotFound, `Unknown tool: ${name}`);
      const timeout = name === 'hela.agent.run' && !this.nativeAgentReady
        ? this.options.agentTimeoutMs ?? 120000
        : this.options.toolTimeoutMs ?? 60000;
      try {
        return await this.invokeTool(cellKey, targetName, () => callTool(cell!, targetName, args, timeout)) as CallToolResult;
      } catch (e: unknown) {
        const msg = e instanceof Error ? e.message : String(e);
        return { content: [{ type: 'text', text: `Error: ${msg}` }], isError: true };
      }
    });
  }

  async serveStdio(): Promise<void> {
    const transport = new StdioServerTransport();
    await this.server.connect(transport);
    console.error('[hela-runtime] serving on stdio');
  }

  shutdown(): Promise<void> {
    if (this.shutdownTask) return this.shutdownTask;
    this.stopping = true;
    for (const cell of this.cells.values()) this.logEvent(cell.key, 'stop', true);
    for (const timer of this.restartTimers.values()) clearTimeout(timer);
    this.restartTimers.clear();
    this.bootAbort.abort();
    this.shutdownTask = Promise.all([
      ...[...this.cells.values()].map((cell) => shutdownCell(cell)),
      ...this.bootTasks.values(),
      this.server.close(),
      new Promise<void>((resolve) => {
        if (this.healthServer) this.healthServer.close(() => resolve());
        else resolve();
      }),
    ]).then(() => {});
    return this.shutdownTask;
  }
}
