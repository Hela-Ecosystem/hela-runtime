import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import type { CellSpec, CellHandle } from './types.js';
import { bootCell, callTool, shutdownCell } from './cell-loader.js';

const VERSION = '0.2.0';

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
  cells = new Map<string, CellHandle>();
  toolToCell = new Map<string, string>();
  server: Server;
  restartAttempts = new Map<string, number>();

  constructor() {
    this.root = ecosystemRoot();
    this.profile = process.env.HELA_PROFILE || null;
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
      .map((s: any) => ({
        id: s.id,
        alias: s.alias,
        source: s.source,
        dir: s.dir,
        entry: s.entry,
        revision: s.revision,
        version: s.version,
        scope: s.scope,
      }));

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
      for (const toolName of handle.tools.keys()) this.toolToCell.set(toolName, handle.key);
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
      console.error(`[hela-runtime] giving up restarting ${spec.id} after ${attempts} attempts`);
      return;
    }
    this.restartAttempts.set(spec.id, attempts + 1);
    const delay = Math.min(1000 * 2 ** attempts, 8000);
    setTimeout(() => {
      // remove stale handle
      const old = this.cells.get(spec.id);
      if (old) {
        for (const [tn, ck] of this.toolToCell) if (ck === spec.id) this.toolToCell.delete(tn);
        this.cells.delete(spec.id);
      }
      this.bootOne(spec);
    }, delay);
  }

  async boot(): Promise<void> {
    const specs = this.selectedSpecs();
    console.error(`[hela-runtime] profile=${this.profile ?? 'all'} cells=${specs.length} root=${this.root}`);
    await Promise.allSettled(specs.map((s) => this.bootOne(s)));

    // agent host alias
    const mitosis = this.cells.get('hela-mitosis');
    if (mitosis?.tools.has('agent_run') && !this.toolToCell.has('hela.agent.run')) {
      this.toolToCell.set('hela.agent.run', 'hela-mitosis');
    }

    this.server.setRequestHandler(ListToolsRequestSchema, async () => {
      const tools: any[] = [];
      for (const cell of this.cells.values()) {
        if (!cell.ready) continue;
        for (const t of cell.tools.values()) {
          tools.push({ name: t.name, description: t.description, inputSchema: t.inputSchema });
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
      const cellKey = this.toolToCell.get(name) ?? (name === 'hela.agent.run' ? 'hela-mitosis' : undefined);
      if (!cellKey) {
        return { content: [{ type: 'text', text: `Unknown tool: ${name}` }], isError: true };
      }
      const cell = this.cells.get(cellKey);
      if (!cell || !cell.ready) {
        return { content: [{ type: 'text', text: `Cell not ready: ${cellKey}` }], isError: true };
      }
      const targetName = name === 'hela.agent.run' ? 'agent_run' : name;
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