import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import type { CellSpec, CellHandle, ToolDescriptor } from './types.js';
import { VERSION } from './version.js';

export interface BootOptions {
  root: string;
  timeoutMs?: number;
  shutdownGraceMs?: number;
  signal?: AbortSignal;
  /** Extra environment for this cell, layered over the runtime's own. */
  env?: Record<string, string | undefined>;
}

/** One line of the cell's JSON-RPC stream, before any payload is trusted. */
export interface JsonRpcEnvelope {
  jsonrpc: string;
  id?: number | string | null;
  result?: unknown;
  error?: { code?: number; message?: string; data?: unknown };
}

/** The MCP `tools/call` payload, as narrowed by {@link isToolResult}. */
export interface McpToolResult {
  content?: Array<{ type: string; [key: string]: unknown }>;
  structuredContent?: Record<string, unknown>;
  isError?: boolean;
  [key: string]: unknown;
}

export class CellTimeoutError extends Error {
  constructor(timeoutMs: number) {
    super(`timeout after ${timeoutMs}ms`);
    this.name = 'CellTimeoutError';
  }
}

/** A cell answered, but not with a payload the runtime is allowed to forward. */
export class CellProtocolError extends Error {
  constructor(message: string, readonly keys: string[] = []) {
    super(keys.length > 0 ? `${message} (keys: ${keys.join(', ')})` : message);
    this.name = 'CellProtocolError';
  }
}

/** No directory under the searched roots holds the cell's build. */
export class CellDirectoryError extends Error {
  constructor(spec: CellSpec, readonly root: string, readonly tried: string[]) {
    super(`Cell ${spec.id} directory ${spec.dir} not found from root ${root}; tried: ${tried.join(', ')}`);
    this.name = 'CellDirectoryError';
  }
}

const SAMPLE_LIMIT = 200;

interface CellState {
  request: (method: string, params?: unknown, timeoutMs?: number) => Promise<JsonRpcEnvelope>;
  rejectPending: (error: Error) => void;
  graceMs: number;
  stopped?: Promise<void>;
}

const states = new WeakMap<CellHandle, CellState>();

function keysOf(value: unknown): string[] {
  return value !== null && typeof value === 'object' ? Object.keys(value as object) : [];
}

function describe(value: unknown): string {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  return typeof value;
}

function truncate(line: string): string {
  return line.length > SAMPLE_LIMIT ? `${line.slice(0, SAMPLE_LIMIT)}…` : line;
}

function isEnvelope(value: unknown): value is JsonRpcEnvelope {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return record.jsonrpc === '2.0' && ('result' in record || 'error' in record);
}

function isContentBlock(value: unknown): value is { type: string } {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    && typeof (value as Record<string, unknown>).type === 'string';
}

/** Narrow a `tools/call` payload to the MCP tool result shape the daemon forwards. */
export function isToolResult(value: unknown): value is McpToolResult {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  if ('isError' in record && typeof record.isError !== 'boolean') return false;
  if ('content' in record) return Array.isArray(record.content) && record.content.every(isContentBlock);
  return record.structuredContent !== undefined || record.toolResult !== undefined;
}

function expectToolResult(envelope: JsonRpcEnvelope, cell: string, tool: string): McpToolResult {
  if (envelope.error) {
    const { code, message } = envelope.error;
    throw new CellProtocolError(
      `Cell ${cell} answered ${tool} with a JSON-RPC error: ${message ?? 'no message'}${code === undefined ? '' : ` (code ${code})`}`,
      keysOf(envelope.error),
    );
  }
  if (!isToolResult(envelope.result)) {
    throw new CellProtocolError(
      `Cell ${cell} answered ${tool} with a ${describe(envelope.result)} that is not an MCP tool result`,
      keysOf(envelope.result),
    );
  }
  return envelope.result;
}

function expectToolList(envelope: JsonRpcEnvelope, cell: string): ToolDescriptor[] {
  if (envelope.error) throw new Error(`tools/list failed: ${JSON.stringify(envelope.error)}`);
  const result = envelope.result;
  if (result === null || typeof result !== 'object' || Array.isArray(result)) {
    throw new CellProtocolError(`Cell ${cell} answered tools/list with a ${describe(result)}`, keysOf(result));
  }
  const tools = (result as Record<string, unknown>).tools;
  if (tools === undefined) return [];
  if (!Array.isArray(tools)) {
    throw new CellProtocolError(`Cell ${cell} answered tools/list with a ${describe(tools)} tool list`, keysOf(result));
  }
  return tools.map((tool) => {
    const record = tool as Record<string, unknown> | null;
    const schema = record?.inputSchema as Record<string, unknown> | undefined;
    if (record === null || typeof record !== 'object' || typeof record.name !== 'string' || record.name === ''
      || schema === null || typeof schema !== 'object' || schema.type !== 'object') {
      throw new CellProtocolError(`Cell ${cell} listed a tool without a name and an object inputSchema`, keysOf(tool));
    }
    return record as unknown as ToolDescriptor;
  });
}

/**
 * Locate a cell's build without consulting the process working directory: installed
 * layouts keep cells under the installation root, a dev checkout keeps them beside it.
 */
export function resolveDir(spec: CellSpec, root: string): string {
  const candidates = [path.join(root, '..', spec.dir), path.join(root, spec.dir)];
  for (const candidate of candidates) if (existsSync(candidate)) return candidate;
  throw new CellDirectoryError(spec, root, candidates);
}

export async function bootCell(spec: CellSpec, opts: BootOptions): Promise<CellHandle> {
  opts.signal?.throwIfAborted();
  const dir = resolveDir(spec, opts.root);
  const timeoutMs = opts.timeoutMs ?? 15000;
  const proc = spawn(process.execPath, [path.join(dir, spec.entry)], { cwd: dir, stdio: ['pipe', 'pipe', 'pipe'], env: { ...process.env, ...opts.env } });
  let resolveExit!: () => void;
  const handle: CellHandle = {
    key: spec.id,
    spec,
    proc,
    tools: new Map(),
    ready: false,
    protocolErrors: 0,
    exited: new Promise<void>((resolve) => { resolveExit = resolve; }),
  };
  let ended = false;
  let buffer = '';
  let nextId = 1;
  const pending = new Map<number, { resolve: (msg: JsonRpcEnvelope) => void; reject: (error: Error) => void; timer: NodeJS.Timeout }>();

  function settle(id: number): { reject: (error: Error) => void; resolve: (msg: JsonRpcEnvelope) => void } | undefined {
    const request = pending.get(id);
    if (!request) return undefined;
    pending.delete(id);
    clearTimeout(request.timer);
    return request;
  }

  function rejectPending(error: Error): void {
    for (const request of pending.values()) {
      clearTimeout(request.timer);
      request.reject(error);
    }
    pending.clear();
  }

  /** A corrupted frame costs the caller its request now, not one full timeout later. */
  function failFrame(line: string, detail: string): void {
    handle.protocolErrors++;
    console.error(`[hela-runtime] cell ${spec.id} ${detail}: ${truncate(line)}`);
    rejectPending(new CellProtocolError(`Cell ${spec.id} ${detail}`));
  }

  function request(method: string, params: unknown = {}, t = timeoutMs): Promise<JsonRpcEnvelope> {
    if (ended || handle.stopReason) return Promise.reject(new Error(`Cell ${spec.id} is unavailable`));
    return new Promise<JsonRpcEnvelope>((resolve, reject) => {
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
      let parsed: unknown;
      try {
        parsed = JSON.parse(line);
      } catch {
        // A cell logging to stdout is normal; a mangled JSON-RPC frame is not.
        if (line.includes('jsonrpc')) failFrame(line, 'sent an unparsable JSON-RPC line');
        continue;
      }
      const framed = parsed as { id?: unknown; method?: unknown } | null;
      // A cell-initiated request or notification carries a method and is not ours to settle.
      if (framed?.method !== undefined) continue;
      const id = framed?.id;
      if (typeof id !== 'number') continue;
      const request = settle(id);
      if (!request) continue;
      if (!isEnvelope(parsed)) {
        handle.protocolErrors++;
        console.error(`[hela-runtime] cell ${spec.id} sent a malformed response for request ${id}: ${truncate(line)}`);
        request.reject(new CellProtocolError(`Cell ${spec.id} sent a malformed response for request ${id}`, keysOf(parsed)));
        continue;
      }
      request.resolve(parsed);
    }
  });
  opts.signal?.addEventListener('abort', abort, { once: true });

  try {
    const initRes = await request('initialize', {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: { name: 'hela-runtime', version: VERSION },
    });
    if (initRes.error) throw new Error(`init failed: ${JSON.stringify(initRes.error)}`);
    proc.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');
    const tools = expectToolList(await request('tools/list'), spec.id);
    opts.signal?.throwIfAborted();
    if (ended || handle.stopReason) throw new Error(`Cell ${spec.id} stopped during boot`);
    for (const tool of tools) handle.tools.set(tool.name, tool);
    handle.ready = true;
    return handle;
  } catch (error) {
    await shutdownCell(handle, 'boot-failure');
    throw error;
  }
}

/** Invoke a cell tool; the resolved value is a validated MCP tool result. */
export function callTool(
  handle: CellHandle,
  name: string,
  args?: Record<string, unknown>,
  timeoutMs = 30000,
): Promise<unknown> {
  const state = states.get(handle);
  if (!state || !handle.ready) return Promise.reject(new Error(`Cell ${handle.key} is unavailable`));
  return state.request('tools/call', { name, arguments: args ?? {} }, timeoutMs)
    .then((envelope) => expectToolResult(envelope, handle.key, name));
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
