import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  McpError,
  ErrorCode,
} from '@modelcontextprotocol/sdk/types.js';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import type { CellSpec, CellHandle } from './types.js';
import { bootCell, callTool, shutdownCell } from './cell-loader.js';

const VERSION = '0.4.0';

function ecosystemRoot(): string {
  if (process.env.HELA_ECOSYSTEM_ROOT) return process.env.HELA_ECOSYSTEM_ROOT;
  // default: sibling hela-mcp-ecosystem
  const candidates = [
    path.resolve(process.cwd(), '..', 'hela-mcp-ecosystem'),
    path.resolve(process.cwd(), 'hela-mcp-ecosystem'),
    '/home/azzar/project/MCPservers/hela-mcp-ecosystem',
  ];
  for (const c of candidates) if (fs.existsSync(path.join(c, 'config', 'inventory.json'))) return c;
  return candidates[0];
}

export class HelaRuntime {
  root: string;
  profile: string | null;
  namespaced: boolean;
  cells = new Map<string, CellHandle>();
  toolToCell = new Map<string, string>(); // exposedName -> cellKey
  toolToReal = new Map<string, string>(); // exposedName -> real tool name
  deadCells = new Set<string>();
  specs = new Map<string, CellSpec>();
  lazyCells = new Set<string>();
  server: Server;
  restartAttempts = new Map<string, number>();

  constructor() {
    this.root = ecosystemRoot();
    this.profile = process.env.HELA_PROFILE || null;
    this.namespaced = process.env.HELA_NAMESPACE_TOOLS === '1';
    this.server = new Server(
      { name: 'hela-runtime', version: VERSION },
      { capabilities: { tools: {} } },
    );
  }

  private selectedSpecs(): CellSpec[] {
    const invPath = path.join(this.root, 'config', 'inventory.json');
    const inv = JSON.parse(fs.readFileSync(invPath, 'utf8'));
    const all: CellSpec[] = Object.values(inv.inventory)
      .filter((s: any) => s.kind !== 'runtime' && s.id !== 'hela-runtime')
      .map((s: any) => {
        const spec: CellSpec = {
          id: s.id,
          alias: s.alias,
          source: s.source,
          dir: s.dir,
          entry: s.entry,
          revision: s.revision,
          version: s.version,
          scope: s.scope,
        };
        (spec as any).lazy = s.lazy === true;
        return spec;
      });

    for (const s of all) {
      this.specs.set(s.id, s);
      if ((s as any).lazy) this.lazyCells.add(s.id);
    }

    if (!this.profile) return all;
    const profilesPath = path.join(this.root, 'config', 'profiles.json');
    if (!fs.existsSync(profilesPath)) return all;
    const profiles = JSON.parse(fs.readFileSync(profilesPath, 'utf8')).profiles;
    const prof = profiles.find((p: any) => p.id === this.profile);
    if (!prof) {
      console.error(`[hela-runtime] unknown profile "${this.profile}", booting all cells`);
      return all;
    }
    const allowed = new Set(prof.servers);
    return all.filter((s) => allowed.has(s.id));
  }

  private async bootOne(spec: CellSpec): Promise<void> {
    try {
      const handle = await bootCell(spec, { root: this.root });
      this.cells.set(handle.key, handle);
      this.deadCells.delete(spec.id);
      const cellShort = spec.id.replace(/^hela-/, '');
      for (const toolName of handle.tools.keys()) {
        const exposed = this.namespaced ? `hela_${cellShort}_${toolName}` : toolName;
        this.toolToCell.set(exposed, handle.key);
        this.toolToReal.set(exposed, toolName);
      }
      this.restartAttempts.set(spec.id, 0);
      console.error(`[hela-runtime] booted ${spec.id} (${handle.tools.size} tools)`);

      handle.proc.on('exit', (code) => {
        if (!handle.ready) return;
        console.error(`[hela-runtime] cell ${spec.id} exited (code ${code}), scheduling restart`);
        handle.ready = false;
        this.scheduleRestart(spec);
      });
      handle.proc.on('error', (err) => {
        console.error(`[hela-runtime] cell ${spec.id} error: ${err.message}`);
      });
    } catch (e: any) {
      console.error(`[hela-runtime] FAILED to boot ${spec.id}: ${e?.message ?? e}`);
    }
  }

  private scheduleRestart(spec: CellSpec): void {
    const attempts = this.restartAttempts.get(spec.id) ?? 0;
    if (attempts >= 3) {
      console.error(`[hela-runtime] cell ${spec.id} dead after ${attempts} restart attempts; keeping other cells online`);
      this.deadCells.add(spec.id);
      const old = this.cells.get(spec.id);
      if (old) {
        for (const [tn, ck] of this.toolToCell) if (ck === spec.id) { this.toolToCell.delete(tn); this.toolToReal.delete(tn); }
        this.cells.delete(spec.id);
      }
      try {
        this.server.notification({ method: 'notifications/message', params: { level: 'error', data: `HeLa cell ${spec.id} is dead after ${attempts} restart attempts; remaining cells stay online.` } });
      } catch {}
      return;
    }
    this.restartAttempts.set(spec.id, attempts + 1);
    const delay = Math.min(1000 * 2 ** attempts, 8000);
    setTimeout(() => {
      const old = this.cells.get(spec.id);
      if (old) {
        for (const [tn, ck] of this.toolToCell) if (ck === spec.id) { this.toolToCell.delete(tn); this.toolToReal.delete(tn); }
        this.cells.delete(spec.id);
      }
      this.bootOne(spec);
    }, delay);
  }

  async boot(): Promise<void> {
    const specs = this.selectedSpecs();
    const eager = specs.filter((s) => !this.lazyCells.has(s.id));
    const lazy = specs.filter((s) => this.lazyCells.has(s.id));
    console.error(`[hela-runtime] profile=${this.profile ?? 'all'} eager=${eager.length} lazy=${lazy.length} root=${this.root}`);
    await Promise.allSettled(eager.map((s) => this.bootOne(s)));
    if (lazy.length) console.error(`[hela-runtime] lazy cells (on-demand): ${lazy.map((s) => s.id).join(', ')}`);

    // agent host alias
    const mitosis = this.cells.get('hela-mitosis');
    if (mitosis?.tools.has('agent_run') && !this.toolToCell.has('hela.agent.run')) {
      this.toolToCell.set('hela.agent.run', 'hela-mitosis');
      this.toolToReal.set('hela.agent.run', 'agent_run');
    }

    this.server.setRequestHandler(ListToolsRequestSchema, async () => {
      const tools: any[] = [];
      for (const cell of this.cells.values()) {
        if (!cell.ready) continue;
        if (this.deadCells.has(cell.key)) continue;
        const cellShort = cell.key.replace(/^hela-/, '');
        for (const t of cell.tools.values()) {
          const exposed = this.namespaced ? `hela_${cellShort}_${t.name}` : t.name;
          tools.push({ name: exposed, description: t.description, inputSchema: t.inputSchema });
        }
      }
      const mitosisCell = this.cells.get('hela-mitosis');
      const agentTool = mitosisCell?.tools.get('agent_run');
      if (agentTool && !tools.find((t) => t.name === 'hela.agent.run')) {
        tools.push({ name: 'hela.agent.run', description: 'Run a task through the HeLa agent host (Needle).', inputSchema: agentTool.inputSchema });
      }
      return { tools };
    });

    this.server.setRequestHandler(CallToolRequestSchema, async (req) => {
      const name = req.params.name;
      const args = req.params.arguments ?? {};
      let cellKey = this.toolToCell.get(name) ?? (name === 'hela.agent.run' ? 'hela-mitosis' : undefined);
      // lazy ignition: if unknown, try booting lazy cells on demand
      if (!cellKey) {
        for (const lc of this.lazyCells) {
          if (this.deadCells.has(lc)) continue;
          if (!this.cells.has(lc)) await this.ensureCell(lc);
          cellKey = this.toolToCell.get(name);
          if (cellKey) break;
        }
      }
      if (!cellKey) {
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
      const timeout = name === 'hela.agent.run' ? 120000 : 60000;
      try {
        const res = await callTool(cell, targetName, args, timeout);
        if (res?.result) return res.result;
        if (res?.content) return res;
        return { content: [{ type: 'text', text: JSON.stringify(res) }] };
      } catch (e: any) {
        return { content: [{ type: 'text', text: `Error: ${e?.message ?? e}` }], isError: true };
      }
    });

    // optional HTTP health endpoint
    const httpPort = parseInt(process.env.HELA_HTTP_PORT || '0', 10);
    if (httpPort > 0) {
      const srv = http.createServer((req, res) => {
        if (req.url === '/healthz') {
          const status = {
            status: 'ok',
            version: VERSION,
            profile: this.profile ?? 'all',
            cells: [...this.cells.values()].map((c) => ({ id: c.key, ready: c.ready, tools: c.tools.size })),
          };
          res.setHeader('Content-Type', 'application/json');
          res.end(JSON.stringify(status));
        } else {
          res.statusCode = 404;
          res.end('not found');
        }
      });
      srv.listen(httpPort, () => console.error(`[hela-runtime] http health on :${httpPort}`));
    }
  }

  async ensureCell(cellKey: string): Promise<CellHandle | undefined> {
    const existing = this.cells.get(cellKey);
    if (existing && existing.ready) return existing;
    if (this.deadCells.has(cellKey)) return undefined;
    const spec = this.specs.get(cellKey);
    if (!spec) return undefined;
    console.error(`[hela-runtime] lazy-booting ${cellKey}`);
    await this.bootOne(spec);
    return this.cells.get(cellKey);
  }

  async serveStdio(): Promise<void> {
    const transport = new StdioServerTransport();
    await this.server.connect(transport);
    console.error('[hela-runtime] serving on stdio');
  }

  async shutdown(): Promise<void> {
    for (const c of this.cells.values()) shutdownCell(c);
    await this.server.close();
  }
}