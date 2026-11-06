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

export interface CellHandle {
  key: string;
  spec: CellSpec;
  proc: import('node:child_process').ChildProcess;
  tools: Map<string, { name: string; description?: string; inputSchema: any }>;
  ready: boolean;
  stopReason?: 'timeout' | 'shutdown' | 'boot-failure' | 'transport-error';
  exited: Promise<void>;
}

export interface ToolRoute {
  cellKey: string;
  toolName: string;
}
