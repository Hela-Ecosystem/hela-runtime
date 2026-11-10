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
  type Tool,
} from '@modelcontextprotocol/sdk/types.js';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import os from 'node:os';
import type { CellSpec, CellHandle } from './types.js';
import { bootCell, callTool, shutdownCell } from './cell-loader.js';
import { ManifestStore } from './manifest.js';
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
  manifestSources = new Map<string, 'cache' | 'catalog' | 'missing'>();
  cellStartupMs = new Map<string, number>();

  constructor(private readonly options: RuntimeOptions = {}) {
    this.root = options.root ?? ecosystemRoot();
    this.profile = options.profile === undefined ? process.env.HELA_PROFILE || 'minimal' : options.profile;
    this.namespaced = options.namespaced ?? process.env.HELA_NAMESPACE_TOOLS === '1';
    this.server = this.createServer();
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
      this.cellStartupMs.set(spec.id, performance.now() - started);
      this.deadCells.delete(spec.id);
      const cellShort = spec.id.replace(/^hela-/, '');
      for (const toolName of handle.tools.keys()) {
        const exposed = this.namespaced ? `hela_${cellShort}_${toolName}` : toolName;
        this.toolToCell.set(exposed, handle.key);
        this.toolToReal.set(exposed, toolName);
      }
      console.error(`[hela-runtime] booted ${spec.id} (${handle.tools.size} tools)`);

      const onExit = () => {
        if (this.stopping || this.cells.get(spec.id) !== handle) return;
        console.error(`[hela-runtime] cell ${spec.id} exited (${handle.stopReason ?? 'crash'}), scheduling restart`);
        this.scheduleRestart(spec);
      };
      handle.proc.once('exit', onExit);
      if (handle.proc.exitCode !== null || handle.proc.signalCode !== null) onExit();

      this.cachedManifest[spec.id] = [...handle.tools.values()];
      try { this.manifests.save(spec.id, fingerprint, [...handle.tools.values()]); }
      catch { console.error(`[hela-runtime] manifest save failed for ${spec.id}`); }
    } catch (e: unknown) {
      if (this.stopping) return;
      const msg = e instanceof Error ? e.message : String(e);
      console.error(`[hela-runtime] FAILED to boot ${spec.id}: ${msg}`);
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
    for (const spec of specs) {
      try {
        const manifest = this.manifests.load(spec);
        this.manifestSources.set(spec.id, manifest.source);
        this.cachedManifest[spec.id] = manifest.tools;
        const cellShort = spec.id.replace(/^hela-/, '');
        for (const tool of manifest.tools) {
          const exposed = this.namespaced ? `hela_${cellShort}_${tool.name}` : tool.name;
          if (this.toolToCell.has(exposed)) throw new Error(`Duplicate tool: ${exposed}`);
          this.toolToCell.set(exposed, spec.id);
          this.toolToReal.set(exposed, tool.name);
        }
      } catch (error) {
        if (error instanceof Error && error.message.startsWith('Duplicate tool:')) throw error;
        this.manifestSources.set(spec.id, 'missing');
      }
    }
    console.error(`[hela-runtime] profile=${this.profile ?? 'all'} cells=${specs.length} mode=on-demand`);

    // agent host alias (will be set when mitosis boots, handled in CallTool)
    // cross-cell pipe (runtime-internal chaining)
    this.toolToCell.set('hela.pipe', '__runtime__');
    this.toolToReal.set('hela.pipe', 'hela.pipe');

    this.attachHandlers(this.server);
    this.booted = true;

    // optional HTTP health endpoint
    const httpPort = parseInt(process.env.HELA_HTTP_PORT || '0', 10);
    if (httpPort > 0) {
      const srv = http.createServer((req, res) => {
        if (req.url === '/healthz') {
          const status = {
            status: 'ok',
            version: VERSION,
            profile: this.profile ?? 'all',
            cells: [...this.specs.keys()].map((id) => {
              const cell = this.cells.get(id);
              return { id, ready: cell?.ready ?? false, tools: cell?.tools.size ?? (this.cachedManifest[id]?.length ?? 0) };
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
    console.error(`[hela-runtime] lazy-booting ${cellKey}`);
    await this.bootOne(spec);
    const cell = this.cells.get(cellKey);
    return !this.stopping && cell?.ready ? cell : undefined;
  }

  private async runPipe(args: Record<string, unknown>): Promise<{ content: Array<{ type: string; text: string }>; isError?: boolean }> {
    const steps = Array.isArray(args?.steps) ? args.steps : [];
    const results: Record<string, unknown>[] = [];
    let prev: unknown = null;
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
        if (typeof stepArgs[k] === 'string') {
          stepArgs[k] = (stepArgs[k] as string).replace(/\{\{prev\}\}/g, typeof prev === 'string' ? prev : JSON.stringify(prev));
        }
      }
      if (prev !== null && stepArgs.prev === undefined && stepArgs.input === undefined) {
        stepArgs.prev = prev;
      }
      try {
        const res = await callTool(cell, toolName, stepArgs, this.options.toolTimeoutMs ?? 60000);
        const normalized = res?.result ?? res;
        prev = normalized;
        results.push({ step: i, cell: cellKey, tool: toolName, result: normalized });
      } catch (e: unknown) {
        const msg = e instanceof Error ? e.message : String(e);
        return { content: [{ type: 'text', text: `Pipe failed at step ${i} (${cellKey}/${toolName}): ${msg}` }], isError: true };
      }
    }
    return { content: [{ type: 'text', text: JSON.stringify({ ok: true, steps: results.length, results }, null, 2) }] };
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

      // From booted cells
      for (const cell of this.cells.values()) {
        if (!this.specs.has(cell.key)) continue;
        if (!cell.ready) continue;
        if (this.deadCells.has(cell.key)) continue;
        const cellShort = cell.key.replace(/^hela-/, '');
        for (const t of cell.tools.values()) {
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
          const exposed = this.namespaced ? `hela_${cellShort}_${t.name}` : t.name;
          if (seen.has(exposed)) continue;
          seen.add(exposed);
          tools.push({ name: exposed, description: t.description, inputSchema: t.inputSchema });
        }
      }

      // agent host alias
      const mitosisCell = this.cells.get('hela-mitosis');
      const agentTool = this.specs.has('hela-mitosis') && !this.deadCells.has('hela-mitosis')
        ? mitosisCell?.tools.get('agent_run') ?? this.cachedManifest['hela-mitosis']?.find((t) => t.name === 'agent_run')
        : undefined;
      if (agentTool && !tools.find((t) => t.name === 'hela.agent.run')) {
        tools.push({ name: 'hela.agent.run', description: 'Run a task through the HeLa agent host (Needle).', inputSchema: (agentTool as any).inputSchema });
      }

      if (!tools.find((t) => t.name === 'hela.pipe')) {
        tools.push({
          name: 'hela.pipe',
          description: 'Run a sequence of tool calls across cells in-process, piping each result to the next. Steps: [{cell, tool, args}]. Use "{{prev}}" in string args to inject previous result.',
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

      if (name === 'hela.pipe') {
        return await this.runPipe(args);
      }
      const agentKnown = this.cells.get('hela-mitosis')?.tools.has('agent_run')
        || this.cachedManifest['hela-mitosis']?.some(tool => tool.name === 'agent_run');
      const cellKey = this.toolToCell.get(name) ?? (name === 'hela.agent.run' && agentKnown ? 'hela-mitosis' : undefined);
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
      const targetName = name === 'hela.agent.run' ? 'agent_run' : (this.toolToReal.get(name) ?? name);
      if (!cell.tools.has(targetName)) throw new McpError(ErrorCode.MethodNotFound, `Unknown tool: ${name}`);
      const timeout = name === 'hela.agent.run' ? this.options.agentTimeoutMs ?? 120000 : this.options.toolTimeoutMs ?? 60000;
      try {
        const res = await callTool(cell, targetName, args, timeout);
        if (res?.result) return res.result;
        if (res?.content) return res;
        return { content: [{ type: 'text', text: JSON.stringify(res) }] };
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
