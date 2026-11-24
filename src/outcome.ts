/**
 * One definition of "did this tool call actually succeed?" for the runtime.
 *
 * Cells report failure in the payload, not by throwing: an MCP `isError`, or a JSON
 * body with `success: false` / `ok: false`. hela_pipe (runtime#3) and the native agent
 * (runtime#4) both need that distinction, so they share this function rather than each
 * keeping a variant (hela-mcp-ecosystem#8).
 */

export interface ToolOutcome {
  ok: boolean;
  /** Parsed JSON body when the text is JSON, otherwise the joined text (or the raw object). */
  payload: unknown;
  /** Why the call failed; set only when `ok` is false. */
  error?: string;
  /** Reasons the call succeeded only partially (`degraded`, `partial`, `truncated`, warnings). */
  degraded: string[];
}

export function degradationReasons(structured: unknown): string[] {
  if (structured === null || typeof structured !== 'object') return [];
  const record = structured as Record<string, unknown>;
  const reasons: string[] = [];
  for (const key of ['degraded', 'partial', 'truncated'] as const) {
    if (record[key] === true) reasons.push(key);
    const detail = record[key];
    if (detail && typeof detail === 'object' && typeof (detail as { reason?: unknown }).reason === 'string') {
      reasons.push(String((detail as { reason: string }).reason));
    }
  }
  if (record.status === 'degraded') reasons.push('status=degraded');
  if (Array.isArray(record.warnings)) {
    for (const warning of record.warnings) {
      if (typeof warning === 'string' && warning.trim()) reasons.push(warning.trim());
    }
  }
  return [...new Set(reasons)];
}

/** Classify the value a cell (or a runtime-hosted tool) returned. Never throws. */
export function classifyToolResult(res: unknown): ToolOutcome {
  const envelope = res as { content?: Array<{ type?: string; text?: string }>; isError?: boolean } | undefined | null;
  const hasEnvelope = !!envelope && typeof envelope === 'object' && Array.isArray(envelope.content);
  const text = hasEnvelope
    ? envelope!.content!
        .filter((part) => part?.type === 'text' && typeof part.text === 'string')
        .map((part) => part.text as string)
        .join('\n')
    : '';

  let structured: unknown;
  if (hasEnvelope) {
    try {
      structured = JSON.parse(text);
    } catch {
      structured = undefined;
    }
  } else if (res !== null && typeof res === 'object') {
    // Runtime-hosted tools return a plain object rather than an MCP envelope.
    structured = res;
  }

  const record = structured !== null && typeof structured === 'object' ? (structured as Record<string, unknown>) : undefined;
  const failed = (hasEnvelope && envelope!.isError === true) || record?.success === false || record?.ok === false;
  if (!failed) {
    return {
      ok: true,
      payload: structured !== undefined ? structured : hasEnvelope ? text : res,
      degraded: degradationReasons(structured),
    };
  }
  const reason = record?.error ?? record?.message ?? (text ? text.slice(0, 300) : 'step failed');
  return { ok: false, payload: structured !== undefined ? structured : text, error: String(reason), degraded: [] };
}
