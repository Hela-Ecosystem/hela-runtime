import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import type { CellSpec } from './types.js';
import { resolveDir } from './cell-loader.js';

export interface ToolDefinition {
  name: string;
  description?: string;
  inputSchema: { type: 'object'; [key: string]: unknown };
}

export function validTools(value: unknown): value is ToolDefinition[] {
  if (!Array.isArray(value)) return false;
  const names = new Set<string>();
  return value.every(tool => {
    if (!tool || typeof tool.name !== 'string' || !tool.name || names.has(tool.name) || tool.inputSchema?.type !== 'object') return false;
    names.add(tool.name);
    return true;
  });
}

function hash(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

export function buildDigest(root: string, spec: CellSpec): string {
  const directory = resolveDir(spec, root);
  const files = new Map<string, Buffer>();
  for (const name of ['package.json', 'package-lock.json']) {
    const file = path.join(directory, name);
    if (fs.existsSync(file)) files.set(name, fs.readFileSync(file));
  }
  const visit = (dir: string): void => {
    for (const item of fs.readdirSync(dir, { withFileTypes: true })) {
      const file = path.join(dir, item.name);
      if (item.isDirectory()) visit(file);
      else if (item.isFile() && /\.(?:[cm]?js|json)$/.test(item.name)) files.set(path.relative(directory, file), fs.readFileSync(file));
    }
  };
  const entry = path.join(directory, spec.entry);
  if (!fs.existsSync(entry)) throw new Error(`Missing build for ${spec.id}`);
  visit(path.dirname(entry));
  const digest = createHash('sha256');
  for (const [name, content] of [...files].sort(([a], [b]) => a.localeCompare(b))) {
    digest.update(name).update('\0').update(content).update('\0');
  }
  return digest.digest('hex');
}

export function repositoryRevision(directory: string): string | null {
  let current = path.resolve(directory);
  while (true) {
    const marker = path.join(current, '.git');
    if (fs.existsSync(marker)) {
      try {
        const git = fs.statSync(marker).isDirectory() ? marker : path.resolve(current, fs.readFileSync(marker, 'utf8').trim().replace(/^gitdir:\s*/, ''));
        const head = fs.readFileSync(path.join(git, 'HEAD'), 'utf8').trim();
        if (/^[a-f0-9]{40,64}$/.test(head)) return head;
        const ref = head.replace(/^ref:\s*/, '');
        const commonFile = path.join(git, 'commondir');
        const common = fs.existsSync(commonFile) ? path.resolve(git, fs.readFileSync(commonFile, 'utf8').trim()) : git;
        for (const base of [git, common]) {
          const file = path.join(base, ref);
          if (fs.existsSync(file)) return fs.readFileSync(file, 'utf8').trim();
        }
        const packed = fs.readFileSync(path.join(common, 'packed-refs'), 'utf8');
        return packed.split('\n').find(line => line.endsWith(` ${ref}`))?.split(' ')[0] ?? null;
      } catch { return null; }
    }
    const parent = path.dirname(current);
    if (parent === current) return null;
    current = parent;
  }
}

export function featureConfiguration(root: string, spec: CellSpec): Record<string, boolean> {
  const directory = resolveDir(spec, root);
  return Object.fromEntries(Object.entries(spec.toolFeatures ?? {}).sort().map(([name, rule]) => {
    const raw = (process.env[name] ?? '').toLowerCase();
    const probe = process.platform === 'win32' ? rule.probePathWindows ?? rule.probePath : rule.probePath;
    const fallback = probe ? fs.existsSync(path.resolve(directory, (rule.pathEnv && process.env[rule.pathEnv]) || probe)) : rule.default ?? false;
    return [name, raw === 'true' ? true : raw === 'false' ? false : fallback];
  }));
}

interface CachedCell { fingerprint: string; tools: ToolDefinition[] }
interface CacheFile { format: 2; profiles: Record<string, Record<string, CachedCell>> }

export class ManifestStore {
  private cells: Record<string, CachedCell> = {};
  private readonly key: string;
  constructor(private file: string, private root: string, profile: string | null, namespaced: boolean) {
    this.key = hash([fs.realpathSync(root), profile, namespaced]);
  }

  private read(): CacheFile {
    try {
      const value = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      if (value.format === 2 && value.profiles && typeof value.profiles === 'object') return value;
    } catch { /* A missing, legacy, or incomplete cache is a cold start. */ }
    return { format: 2, profiles: {} };
  }

  identity(spec: CellSpec): { fingerprint: string; digest: string; features: Record<string, boolean>; revision: string | null } {
    const digest = buildDigest(this.root, spec);
    const features = featureConfiguration(this.root, spec);
    const revision = repositoryRevision(resolveDir(spec, this.root));
    const keys = new Set([...(spec.env ?? []), ...Object.keys(spec.toolFeatures ?? {}), 'NODE_ENV']);
    for (const rule of Object.values(spec.toolFeatures ?? {})) if (rule.pathEnv) keys.add(rule.pathEnv);
    const environment = [...keys].sort().map(key => [key, process.env[key] ?? null]);
    return { digest, features, revision, fingerprint: hash([spec, digest, features, revision, environment]) };
  }

  load(spec: CellSpec): { tools: ToolDefinition[]; source: 'cache' | 'catalog' | 'missing'; fingerprint: string } {
    const identity = this.identity(spec);
    const cached = this.read().profiles[this.key]?.[spec.id];
    if (cached?.fingerprint === identity.fingerprint && validTools(cached.tools)) {
      this.cells[spec.id] = cached;
      return { tools: cached.tools, source: 'cache', fingerprint: identity.fingerprint };
    }
    try {
      const catalog = JSON.parse(fs.readFileSync(path.join(this.root, 'config/tool-catalog.json'), 'utf8'));
      const entry = catalog.format === 1 ? catalog.cells?.[spec.id] : undefined;
      const digests = entry?.digests ?? [entry?.digest];
      if (entry && entry.revision === spec.revision && entry.version === spec.version && Array.isArray(digests) && digests.includes(identity.digest)
          && (!identity.revision || identity.revision === spec.revision)) {
        const variant = entry.variants.find((candidate: { features: unknown }) => hash(candidate.features) === hash(identity.features));
        if (variant && validTools(variant.tools)) return { tools: variant.tools, source: 'catalog', fingerprint: identity.fingerprint };
      }
    } catch { /* Explicit pipe routing can discover an uncatalogued cell on demand. */ }
    return { tools: [], source: 'missing', fingerprint: identity.fingerprint };
  }

  save(id: string, fingerprint: string, tools: ToolDefinition[]): void {
    if (!validTools(tools)) throw new Error(`Invalid tool manifest for ${id}`);
    this.cells[id] = { fingerprint, tools };
    const value = this.read();
    value.profiles[this.key] = this.cells;
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const temporary = `${this.file}.${process.pid}.${randomUUID()}.tmp`;
    try {
      fs.writeFileSync(temporary, JSON.stringify(value), { mode: 0o600, flag: 'wx' });
      fs.renameSync(temporary, this.file);
    } finally {
      if (fs.existsSync(temporary)) fs.unlinkSync(temporary);
    }
  }
}
