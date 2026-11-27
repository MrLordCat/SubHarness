/**
 * Per-tool limits for the text of one tool result that a provider forwards to its model.
 *
 * Providers cut long results to keep a turn small (Claude 16k characters, Codex 12k, HTTP 24k by
 * default). A subagent's report cannot be fetched again, so cutting its middle loses the work the
 * report describes; those results get a higher bound that still fits Claude's MCP output limit
 * (25k tokens by default).
 */

/** Tools whose result is the only copy of the work behind it. */
const WHOLE_RESULT_TOOLS = new Set(["subagent", "wait_subagents"]);
/** About 20k tokens of prose; longer reports are still cut, head and tail kept. */
export const WHOLE_RESULT_MAX_CHARS = 60_000;

/** Tool name without a host prefix such as `mcp__vscode__`. */
function baseToolName(name: string): string {
	const separator = name.lastIndexOf("__");
	return separator >= 0 ? name.slice(separator + 2) : name;
}

/** True for results the model must receive whole whenever they fit WHOLE_RESULT_MAX_CHARS. */
export function isWholeResultTool(name: string | undefined): boolean {
	return typeof name === "string" && name.length > 0 && WHOLE_RESULT_TOOLS.has(baseToolName(name));
}

/**
 * The character limit for one result of `toolName` when the provider's own limit is `defaultMax`.
 * Zero or a negative `defaultMax` means "no limit" and is returned unchanged.
 */
export function toolResultCharLimit(toolName: string | undefined, defaultMax: number): number {
	if (!(defaultMax > 0) || !isWholeResultTool(toolName)) {
		return defaultMax;
	}
	return Math.max(defaultMax, WHOLE_RESULT_MAX_CHARS);
}
