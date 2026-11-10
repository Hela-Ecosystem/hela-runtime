import fs from 'node:fs';
import path from 'node:path';

export interface ProfileCell {
  id: string;
  alias: string;
  role: string;
  description: string;
}

export interface ProfileContext {
  id: string;
  name: string;
  system: string;
  persona: string;
  active: ProfileCell[];
  inactive: ProfileCell[];
  toolsByCell: Record<string, string[]>;
}

type JsonRecord = Record<string, unknown>;

function readJson(file: string): unknown {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function loadProfileContext(
  root: string,
  profileId: string | null,
  toolsByCell: Record<string, string[]> = {},
): ProfileContext {
  const inventoryData = readJson(path.join(root, 'config', 'inventory.json'));
  if (!isRecord(inventoryData) || !isRecord(inventoryData.inventory)) throw new Error('Invalid ecosystem inventory');
  const inventory = inventoryData.inventory;

  const all = Object.values(inventory)
    .filter((entry) => isRecord(entry) && entry.kind !== 'runtime' && entry.id !== 'hela-runtime')
    .map(toCell)
    .sort((a, b) => a.id.localeCompare(b.id));

  const id = profileId ?? 'all';
  if (profileId === null) {
    return {
      id,
      name: 'HeLa All (Full Inventory)',
      system: 'any',
      persona: 'Complete HeLa multi-agent engineering stack',
      active: all,
      inactive: [],
      toolsByCell: filterTools(toolsByCell, new Set(all.map((cell) => cell.id))),
    };
  }

  const profilesPath = path.join(root, 'config', 'profiles.json');
  const profileData = readJson(profilesPath);
  const profiles = isRecord(profileData) ? profileData.profiles : undefined;
  const profile = Array.isArray(profiles)
    ? profiles.find((candidate): candidate is JsonRecord => isRecord(candidate) && candidate.id === profileId)
    : undefined;
  if (!profile) throw new Error(`Unknown profile: ${profileId}`);
  if (!Array.isArray(profile.servers)) throw new Error(`Invalid profile: ${profileId}`);

  const selected = new Set<string>(profile.servers.filter((server: unknown): server is string => typeof server === 'string'));
  const active = all.filter((cell) => selected.has(cell.id));
  const inactive = all.filter((cell) => !selected.has(cell.id));
  return {
    id,
    name: typeof profile.name === 'string' ? profile.name : id,
    system: typeof profile.system === 'string' ? profile.system : 'any',
    persona: typeof profile.persona === 'string' ? profile.persona : 'Profile-constrained HeLa agent',
    active,
    inactive,
    toolsByCell: filterTools(toolsByCell, selected),
  };
}

function toCell(entry: unknown): ProfileCell {
  if (!isRecord(entry) || typeof entry.id !== 'string' || !entry.id) throw new Error('Invalid ecosystem cell');
  return {
    id: entry.id,
    alias: typeof entry.alias === 'string' ? entry.alias : entry.id,
    role: typeof entry.role === 'string' ? entry.role : 'cell',
    description: typeof entry.description === 'string' ? entry.description : '',
  };
}

function filterTools(toolsByCell: Record<string, string[]>, selected: Set<string>): Record<string, string[]> {
  return Object.fromEntries(Object.entries(toolsByCell)
    .filter(([cell]) => selected.has(cell))
    .map(([cell, tools]) => [cell, [...new Set(tools)].sort()]));
}

function activeTools(context: ProfileContext): string[] {
  return context.active.flatMap((cell) => context.toolsByCell[cell.id] ?? []).sort();
}

export function renderProfileContext(context: ProfileContext): string {
  const active = context.active.length > 0
    ? context.active.map((cell) => `- \`${cell.id}\` (${cell.alias}) — ${cell.role}: ${cell.description}`).join('\n')
    : '- No cells selected.';
  const inactive = context.inactive.length > 0
    ? context.inactive.map((cell) => `- ❌ \`${cell.id}\` (${cell.alias})`).join('\n')
    : '- None; the full inventory is selected.';
  const tools = activeTools(context);
  return `# HeLa Runtime Profile Context

- **Profile:** \`${context.id}\` (${context.name})
- **System target:** \`${context.system}\`
- **Operating stance:** ${context.persona}
- **Transport boundary:** one managed \`hela-runtime\` MCP endpoint

## Active organelles
${active}

## Profile boundary
Only the active organelles and their tools are available through this runtime. Never invent, invoke, or deploy an inactive organelle.

${inactive}

## Available tools in this profile
${tools.length > 0 ? tools.map((tool) => `- \`${tool}\``).join('\n') : '- Tool schemas are available through MCP tools/list.'}

## Session behavior
- Use the runtime's exposed tools; do not connect to or deploy individual HeLa cell servers.
- Route complex reasoning through the exposed Mitosis tools when available.
- Restore and persist project state through the exposed Genome tools when available.
- Treat this document as the current runtime state, not a workspace file to copy or edit.
`;
}

export function renderProfilePrompt(context: ProfileContext, focus?: string): string {
  const contextText = renderProfileContext(context);
  const taskFocus = focus?.trim() ? `\n\n## Current task focus\n${focus.trim().slice(0, 4000)}` : '';
  return `You are operating as the HeLa agent through the managed runtime. Follow the current profile boundary below for this session. Do not install individual HeLa servers or create a copied persona file.\n\n${contextText}${taskFocus}`;
}

export const PROFILE_RESOURCE_URI = 'hela://profile/context';
export const PROFILE_PROMPT_NAME = 'hela-profile-bootstrap';
