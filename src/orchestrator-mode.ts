/**
 * Passive mode for external DAG coordinators (chaining-mcp#30). With
 * MITOSIS_EXTERNAL_ORCHESTRATOR set, the runtime offers no way to orchestrate:
 * its own agent and pipe are hidden, and so is every Mitosis tool outside the
 * allow-list. The list mirrors chaining-mcp's src/config/orchestrator-mode.ts;
 * the runtime needs its own copy because it advertises cells from cached
 * manifests without starting them.
 */
export const MITOSIS_CELL = 'hela-mitosis';

export interface OrchestratorMode {
  passive: boolean;
  externalOrchestrator: string | null;
}

const PASSIVE_MITOSIS_TOOLS: ReadonlySet<string> = new Set([
  'list_mcp_servers', 'analyze_tools',
  'get_tool_chain_analysis', 'validate_tool_chain', 'analyze_tool_chain_performance',
  'get_current_time', 'convert_time',
  'search_instructions', 'load_instruction',
  'get_prompt', 'search_prompts', 'get_resource_set', 'search_resource_sets',
  'list_skills', 'search_skills', 'get_skill',
]);
const PASSIVE_LLM_TOOLS: ReadonlySet<string> = new Set(['llm_query', 'llm_summarize']);
const RUNTIME_ORCHESTRATION_TOOLS: ReadonlySet<string> = new Set(['hela.agent.run', 'agent_run', 'hela.pipe']);
export function orchestratorMode(env: NodeJS.ProcessEnv = process.env): OrchestratorMode {
  const externalOrchestrator = (env.MITOSIS_EXTERNAL_ORCHESTRATOR ?? '').trim() || null;
  return { passive: externalOrchestrator !== null, externalOrchestrator };
}

/** Whether a cell's tool, by its own (never namespaced) name, may be offered in the current mode. */
export function isCellToolAllowed(cell: string, tool: string, env: NodeJS.ProcessEnv = process.env): boolean {
  if (cell !== MITOSIS_CELL || !orchestratorMode(env).passive) return true;
  if (PASSIVE_MITOSIS_TOOLS.has(tool)) return true;
  return PASSIVE_LLM_TOOLS.has(tool) && (env.CHAINING_LLM_ENABLED || 'true').trim().toLowerCase() !== 'false';
}

/** A bare `agent_run` belongs to the runtime unless the name is routed to a cell other than Mitosis. */
function isMitosisOrUnrouted(owner: string | undefined): boolean {
  return owner === undefined || owner === MITOSIS_CELL;
}

export function isRuntimeToolHidden(name: string, owner: string | undefined, env: NodeJS.ProcessEnv = process.env): boolean {
  if (!orchestratorMode(env).passive || !RUNTIME_ORCHESTRATION_TOOLS.has(name)) return false;
  return name !== 'agent_run' || isMitosisOrUnrouted(owner);
}

/**
 * The structured refusal for a direct call to a hidden tool, or null. `owner` is the cell the runtime
 * routes this name to; `filtered` holds the Mitosis tool names the allow-list removed, so a tool added
 * later is refused the same way. A `hela_mitosis_` name is judged by the allow-list itself.
 */
export function passiveRefusal(name: string, owner: string | undefined, filtered: ReadonlySet<string> = new Set(), env: NodeJS.ProcessEnv = process.env) {
  const { passive, externalOrchestrator } = orchestratorMode(env);
  if (!passive) return null;
  const namespaced = /^hela_mitosis_(.+)$/.exec(name)?.[1];
  const hidden = isRuntimeToolHidden(name, owner, env)
    || (namespaced !== undefined && !isCellToolAllowed(MITOSIS_CELL, namespaced, env))
    || (filtered.has(name) && isMitosisOrUnrouted(owner));
  if (!hidden) return null;
  return {
    ok: false as const,
    code: 'MITOSIS_PASSIVE_MODE' as const,
    mode: 'passive' as const,
    externalOrchestrator,
    tool: name,
    error: `${name} is disabled while MITOSIS_EXTERNAL_ORCHESTRATOR=${externalOrchestrator}`,
  };
}

/** Additive health fields, present only in passive mode so the autonomous payload is unchanged. */
export function passiveHealthFields(env: NodeJS.ProcessEnv = process.env): { mode?: 'passive'; externalOrchestrator?: string | null } {
  const { passive, externalOrchestrator } = orchestratorMode(env);
  return passive ? { mode: 'passive', externalOrchestrator } : {};
}
