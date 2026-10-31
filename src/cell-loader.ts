import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import type { CellSpec, CellHandle } from './types.js';

const ROOT = path.resolve(process.cwd(), '..');

function resolveDir(spec: CellSpec): string {
  const candidates = [
    path.join(ROOT, spec.dir),
    path.join(process.cwd(), '..', spec.dir),
    path.join(process.cwd(), spec.dir),
  ];
  for (const c of candidates) if (existsSync(c)) return c;
  return candidates[0];
}

export async function bootCell(spec: CellSpec): Promise<CellHandle> {
  const dir = resolveDir(spec);
  const entry = path.join(dir, spec.entry);
  const proc = spawn('node', [entry], { cwd: dir, stdio: ['pipe', 'pipe', 'pipe'] });

  const handle: CellHandle = {
    key: spec.id,
    spec,
    proc,
    tools: new Map(),
    ready: false,
  };

  // JSON-RPC plumbing
  let buffer = '';
  const pending = new Map<number, (msg: any) => void>();
  let nextId = 1;

  proc.stdout.on('data', (chunk) => {
    buffer += chunk.toString();
    let idx;
    while ((idx = buffer.indexOf('\n')) !== -1) {
      const line = buffer.slice(0, idx).trim();
      buffer = buffer.slice(idx + 1);
      if (!line) continue;
      try {
        const msg = JSON.parse(line);
        if (msg.id !== undefined && pending.has(msg.id)) {
          pending.get(msg.id)!(msg);
          pending.delete(msg.id);
        }
      } catch {
        // ignore non-JSON (logs)
      }
    }
  });

  function request(method: string, params: any = {}): Promise<any> {
    return new Promise((resolve, reject) => {
      const id = nextId++;
      const timer = setTimeout(() => { pending.delete(id); reject(new Error('timeout')); }, 10000);
      pending.set(id, (msg) => { clearTimeout(timer); resolve(msg); });
      proc.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
    });
  }

  // initialize
  const initRes = await request('initialize', {
    protocolVersion: '2024-11-05',
    capabilities: {},
    clientInfo: { name: 'hela-runtime', version: '0.1.0' },
  });
  if (initRes.error) throw new Error(`init failed: ${JSON.stringify(initRes.error)}`);
  proc.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');

  // tools/list
  const listRes = await request('tools/list', {});
  if (listRes.error) throw new Error(`tools/list failed: ${JSON.stringify(listRes.error)}`);
  for (const t of listRes.result?.tools ?? []) {
    handle.tools.set(t.name, t);
  }
  handle.ready = true;
  (handle as any).__request = request;
  return handle;
}

export function callTool(handle: CellHandle, name: string, args: any): Promise<any> {
  const req = (handle as any).__request;
  return req('tools/call', { name, arguments: args ?? {} });
}

export function shutdownCell(handle: CellHandle): void {
  try { handle.proc.kill('SIGTERM'); } catch {}
}