import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema, } from '@modelcontextprotocol/sdk/types.js';
import fs from 'node:fs';
import path from 'node:path';
import { bootCell, callTool, shutdownCell } from './cell-loader.js';
const INVENTORY_PATH = path.resolve(process.cwd(), '..', 'hela-mcp-ecosystem', 'config', 'inventory.json');
export class HelaRuntime {
    cells = new Map();
    toolToCell = new Map();
    server;
    constructor() {
        this.server = new Server({ name: 'hela-runtime', version: '0.1.0' }, { capabilities: { tools: {} } });
    }
    async boot() {
        const inv = JSON.parse(fs.readFileSync(INVENTORY_PATH, 'utf8'));
        const specs = Object.values(inv.inventory).map((s) => ({
            id: s.id,
            alias: s.alias,
            source: s.source,
            dir: s.dir,
            entry: s.entry,
            revision: s.revision,
            version: s.version,
            scope: s.scope,
        }));
        // boot cells in parallel
        const results = await Promise.allSettled(specs.map((sp) => bootCell(sp)));
        for (let i = 0; i < specs.length; i++) {
            const r = results[i];
            if (r.status === 'fulfilled') {
                this.cells.set(r.value.key, r.value);
                for (const toolName of r.value.tools.keys()) {
                    this.toolToCell.set(toolName, r.value.key);
                }
                console.error(`[hela-runtime] booted ${specs[i].id} (${r.value.tools.size} tools)`);
            }
            else {
                console.error(`[hela-runtime] FAILED to boot ${specs[i].id}: ${r.reason}`);
            }
        }
        // agent host: expose hela.agent.run delegating to mitosis agent_run if available
        if (this.toolToCell.has('agent_run')) {
            this.toolToCell.set('hela.agent.run', this.toolToCell.get('agent_run'));
        }
        this.server.setRequestHandler(ListToolsRequestSchema, async () => {
            const tools = [];
            for (const cell of this.cells.values()) {
                for (const t of cell.tools.values()) {
                    tools.push({ name: t.name, description: t.description, inputSchema: t.inputSchema });
                }
            }
            // add agent alias if not already exposed
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
            try {
                const res = await callTool(cell, targetName, args);
                // normalize: MCP tools/call result has content
                if (res?.result)
                    return res.result;
                if (res?.content)
                    return res;
                return { content: [{ type: 'text', text: JSON.stringify(res) }] };
            }
            catch (e) {
                return { content: [{ type: 'text', text: `Error: ${e?.message ?? e}` }], isError: true };
            }
        });
    }
    async serveStdio() {
        const transport = new StdioServerTransport();
        await this.server.connect(transport);
        console.error('[hela-runtime] serving on stdio');
    }
    async shutdown() {
        for (const c of this.cells.values())
            shutdownCell(c);
        await this.server.close();
    }
}
