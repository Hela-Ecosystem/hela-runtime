export interface CellSpec {
  id: string;
  alias: string;
  source: string;
  dir: string;
  entry: string;
  revision?: string;
  version?: string;
  scope?: string;
  lazy?: boolean;
  env?: string[];
  toolFeatures?: Record<string, { default?: boolean; probePath?: string; probePathWindows?: string; pathEnv?: string }>;
}

export interface ToolDescriptor {
  name: string;
  description?: string;
  inputSchema: { type: 'object'; [key: string]: unknown };
  annotations?: { readOnlyHint?: boolean; destructiveHint?: boolean };
}

/** Annotations may be absent; present ones must be an object whose effect hints, if given, are booleans. */
export function validAnnotations(value: unknown): boolean {
  if (value === undefined) return true;
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const { readOnlyHint, destructiveHint } = value as Record<string, unknown>;
  return [readOnlyHint, destructiveHint].every((hint) => hint === undefined || typeof hint === 'boolean');
}

export interface CellHandle {
  key: string;
  spec: CellSpec;
  proc: import('node:child_process').ChildProcess;
  tools: Map<string, ToolDescriptor>;
  ready: boolean;
  /** Count of malformed JSON-RPC frames seen on this cell's stdout. */
  protocolErrors: number;
  stopReason?: 'timeout' | 'shutdown' | 'boot-failure' | 'transport-error';
  exited: Promise<void>;
}

export interface ToolRoute {
  cellKey: string;
  toolName: string;
}
