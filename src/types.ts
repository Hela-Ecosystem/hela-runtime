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
}

export interface CellHandle {
  key: string;
  spec: CellSpec;
  proc: import('node:child_process').ChildProcess;
  tools: Map<string, { name: string; description?: string; inputSchema: any }>;
  ready: boolean;
}

export interface ToolRoute {
  cellKey: string;
  toolName: string;
}