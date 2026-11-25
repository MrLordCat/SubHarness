import { CHAT_TOOL_GROUPS, type ChatChangesDiffRequest, type ChatTool } from "./types";

export const CHANGES_DIFF_TOOL_NAME = "changes_diff";

const MIN_CHARS = 2_000;
const MAX_CHARS = 120_000;

function record(input: unknown): Record<string, unknown> {
	return typeof input === "object" && input !== null && !Array.isArray(input) ? input as Record<string, unknown> : {};
}

/** Reads the call's arguments; throws a message the model can act on. */
export function parseChangesDiffInput(input: unknown): ChatChangesDiffRequest {
	const value = record(input);
	const scope = value.scope ?? "turn";
	if (scope !== "turn" && scope !== "pending") {
		throw new Error("scope must be \"turn\" or \"pending\".");
	}
	if (value.paths !== undefined && (!Array.isArray(value.paths) || value.paths.some(entry => typeof entry !== "string"))) {
		throw new Error("paths must be an array of strings.");
	}
	const integer = (key: string, min: number, max: number): number | undefined => {
		const raw = value[key];
		if (raw === undefined) {
			return undefined;
		}
		if (typeof raw !== "number" || !Number.isInteger(raw) || raw < min || raw > max) {
			throw new Error(`${key} must be a whole number from ${min} to ${max}.`);
		}
		return raw;
	};
	const contextLines = integer("contextLines", 0, 20);
	const maxChars = integer("maxChars", MIN_CHARS, MAX_CHARS);
	return {
		scope,
		...(value.paths ? { paths: value.paths as string[] } : {}),
		...(contextLines !== undefined ? { contextLines } : {}),
		...(maxChars !== undefined ? { maxChars } : {}),
	};
}

/**
 * The agent's own changes as a unified diff, read from the Keep/Undo snapshots: the agent, or a reviewer subagent,
 * checks them against the request before the answer.
 */
export function createChangesDiffTool(): ChatTool {
	return {
		name: CHANGES_DIFF_TOOL_NAME,
		group: CHAT_TOOL_GROUPS.files,
		readOnly: true,
		description: [
			"Unified diff of the files this chat's agent changed, as Keep/Undo will list them: scope \"turn\" (default) shows",
			"this turn, a subagent's edits included; \"pending\" shows everything still waiting for Keep or Undo.",
			"Use it to review the changes against the request before answering, or tell a reviewer subagent to call it.",
			"paths narrows it to files or folders; a long diff is cut at maxChars and names the files left out.",
		].join(" "),
		inputSchema: {
			type: "object",
			properties: {
				scope: { type: "string", enum: ["turn", "pending"], description: "\"turn\" (default): this turn; \"pending\": everything waiting for Keep or Undo." },
				paths: { type: "array", items: { type: "string" }, description: "Files or folders, relative to the workspace or absolute; omit for every changed file." },
				contextLines: { type: "number", minimum: 0, maximum: 20, description: "Unchanged lines around each change (default 3)." },
				maxChars: { type: "number", minimum: MIN_CHARS, maximum: MAX_CHARS, description: "Upper bound of the answer in characters (default 40000)." },
			},
		},
		invoke: async (input, _token, context) => {
			const request = parseChangesDiffInput(input);
			if (!context?.changesDiff) {
				throw new Error("This chat does not track file changes, so there is no diff to show.");
			}
			return context.changesDiff(request);
		},
	};
}
