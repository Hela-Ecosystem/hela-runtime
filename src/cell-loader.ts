import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import type { CellSpec, CellHandle } from './types.js';

export interface BootOptions {
  root: string;
  timeoutMs?: number;
  shutdownGraceMs?: number;
  signal?: AbortSignal;
}

export class CellTimeoutError extends Error {
  constructor(timeoutMs: number) {
    super(`timeout after ${timeoutMs}ms`);
    this.name = 'CellTimeoutError';
  }
}

interface CellState {
  request: (method: string, params?: unknown, timeoutMs?: number) => Promise<any>;
  rejectPending: (error: Error) => void;
  graceMs: number;
  stopped?: Promise<void>;
}

const states = new WeakMap<CellHandle, CellState>();

function resolveDir(spec: CellSpec, root: string): string {
  const candidates = [
    path.join(root, '..', spec.dir),
    path.join(root, spec.dir),
    path.join(process.cwd(), '..', spec.dir),
    path.join(process.cwd(), spec.dir),
  ];
  for (const c of candidates) if (existsSync(c)) return c;
  return candidates[0];
}

export async function bootCell(spec: CellSpec, opts: BootOptions): Promise<CellHandle> {
  opts.signal?.throwIfAborted();
  const dir = resolveDir(spec, opts.root);
  const timeoutMs = opts.timeoutMs ?? 15000;
  const proc = spawn(process.execPath, [path.join(dir, spec.entry)], { cwd: dir, stdio: ['pipe', 'pipe', 'pipe'] });
  let resolveExit!: () => void;
  const handle: CellHandle = {
    key: spec.id,
    spec,
    proc,
    tools: new Map(),
    ready: false,
    exited: new Promise<void>((resolve) => { resolveExit = resolve; }),
  };
  let ended = false;
  let buffer = '';
  let nextId = 1;
  const pending = new Map<number, { resolve: (msg: any) => void; reject: (error: Error) => void; timer: NodeJS.Timeout }>();

  function rejectPending(error: Error): void {
    for (const request of pending.values()) {
      clearTimeout(request.timer);
      request.reject(error);
    }
    pending.clear();
  }

  function request(method: string, params: unknown = {}, t = timeoutMs): Promise<any> {
    if (ended || handle.stopReason) return Promise.reject(new Error(`Cell ${spec.id} is unavailable`));
    return new Promise((resolve, reject) => {
      const id = nextId++;
      const payload = JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n';
      const timer = setTimeout(() => {
        pending.delete(id);
        const error = new CellTimeoutError(t);
        reject(error);
        void shutdownCell(handle, 'timeout', error);
      }, t);
      pending.set(id, { resolve, reject, timer });
      proc.stdin.write(payload, (error) => {
        if (error && !ended) void shutdownCell(handle, 'transport-error', error);
      });
    });
  }

  states.set(handle, { request, rejectPending, graceMs: opts.shutdownGraceMs ?? 2000 });
  const abort = () => { void shutdownCell(handle, 'shutdown'); };
  const onExit = () => {
    ended = true;
    handle.ready = false;
    rejectPending(new Error(`Cell ${spec.id} exited`));
    opts.signal?.removeEventListener('abort', abort);
    resolveExit();
  };
  proc.once('exit', onExit);
  proc.on('error', (error) => {
    rejectPending(error);
    if (proc.pid === undefined) onExit();
    else void shutdownCell(handle, 'transport-error', error);
  });
  proc.stdin.on('error', (error) => {
    if (!ended) void shutdownCell(handle, 'transport-error', error);
  });
  proc.stderr.resume();
  proc.stdout.on('data', (chunk) => {
    buffer += chunk.toString();
    let idx;
    while ((idx = buffer.indexOf('\n')) !== -1) {
      const line = buffer.slice(0, idx).trim();
      buffer = buffer.slice(idx + 1);
      if (!line) continue;
      try {
        const msg = JSON.parse(line);
        const request = pending.get(msg.id);
        if (request) {
          pending.delete(msg.id);
          clearTimeout(request.timer);
          request.resolve(msg);
        }
      } catch {
        // Cells may write non-JSON logs to stdout.
      }
    }
  });
  opts.signal?.addEventListener('abort', abort, { once: true });

  try {
    const initRes = await request('initialize', {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: { name: 'hela-runtime', version: '0.2.0' },
    });
    if (initRes.error) throw new Error(`init failed: ${JSON.stringify(initRes.error)}`);
    proc.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');
    const listRes = await request('tools/list');
    if (listRes.error) throw new Error(`tools/list failed: ${JSON.stringify(listRes.error)}`);
    opts.signal?.throwIfAborted();
    if (ended || handle.stopReason) throw new Error(`Cell ${spec.id} stopped during boot`);
    for (const tool of listRes.result?.tools ?? []) handle.tools.set(tool.name, tool);
    handle.ready = true;
    return handle;
  } catch (error) {
    await shutdownCell(handle, 'boot-failure');
    throw error;
  }
}

export function callTool(handle: CellHandle, name: string, args: any, timeoutMs = 30000): Promise<any> {
  const state = states.get(handle);
  if (!state || !handle.ready) return Promise.reject(new Error(`Cell ${handle.key} is unavailable`));
  return state.request('tools/call', { name, arguments: args ?? {} }, timeoutMs);
}

export function shutdownCell(
  handle: CellHandle,
  reason: NonNullable<CellHandle['stopReason']> = 'shutdown',
  error = new Error(`Cell ${handle.key} stopped (${reason})`),
): Promise<void> {
  const state = states.get(handle);
  if (!state) return handle.exited;
  if (state.stopped) return state.stopped;
  handle.stopReason = reason;
  handle.ready = false;
  state.rejectPending(error);
  const exited = () => handle.proc.exitCode !== null || handle.proc.signalCode !== null || handle.proc.pid === undefined;
  const timer = setTimeout(() => {
    if (!exited()) handle.proc.kill('SIGKILL');
  }, state.graceMs);
  state.stopped = handle.exited.finally(() => { clearTimeout(timer); });
  if (!exited()) handle.proc.kill('SIGTERM');
  return state.stopped;
}
