import { CHAT_TOOL_GROUPS, type ChatTool, type SubagentModelOption, type SubagentRequest } from "./types";

/** Tool name used by the SubHarness chat. */
export const SUBAGENT_TOOL_NAME = "subagent";

/** Tool for releasing an open subagent. */
export const CLOSE_SUBAGENT_TOOL_NAME = "close_subagent";

// Coco CLI caps tool descriptions at COCO_TOOL_DESCRIPTION_LIMIT characters; the model list comes on top.
const DESCRIPTION_HEAD = [
	"Delegate one bounded, verifiable subtask to the cheapest model that can do it; it gets the same workspace tools.",
	"It starts without this conversation, so the prompt must hold everything: goal, files, constraints, change or only report, expected output.",
	"It returns only its report; its file changes join the same Keep/Undo set, so check the report.",
	"With keepOpen it stays open: send fixes with subagentId, close it with close_subagent.",
].join(" ");

export interface SubagentToolOptions {
	/** Models a subagent may use right now, cheapest first. */
	models(): readonly SubagentModelOption[];
}

function stringField(input: Record<string, unknown>, key: string): string {
	const value = input[key];
	return typeof value === "string" ? value.trim() : "";
}

/** "DeepSeek Flash", "deepseek-flash" and "deepseek-flash (DeepSeek)" all become "deepseekflash". */
function modelKey(value: string): string {
	return (value.split("::").at(-1) ?? value).toLowerCase().replace(/\([^)]*\)/g, "").replace(/[^a-z0-9]/g, "");
}

function findModel(models: readonly SubagentModelOption[], wanted: string): SubagentModelOption | undefined {
	const exact = models.find(option => option.label === wanted || option.id === wanted)
		?? models.find(option => option.label.toLowerCase() === wanted.toLowerCase());
	if (exact) {
		return exact;
	}
	const key = modelKey(wanted);
	const loose = key ? models.filter(option => modelKey(option.label) === key || modelKey(option.id) === key) : [];
	return loose.length === 1 ? loose[0] : undefined;
}

/** Reads the call's arguments; throws a message the model can act on. */
export function parseSubagentInput(input: unknown, models: readonly SubagentModelOption[]): SubagentRequest {
	const record = typeof input === "object" && input !== null ? input as Record<string, unknown> : {};
	const prompt = stringField(record, "prompt");
	if (!prompt) {
		throw new Error("prompt is required: describe the subtask completely.");
	}
	const subagentId = stringField(record, "subagentId");
	if (subagentId) {
		return { subagentId, prompt, description: stringField(record, "description") };
	}
	const wanted = stringField(record, "model");
	const model = findModel(models, wanted);
	if (!model) {
		const names = models.map(option => `"${option.label}"`).join(", ");
		throw new Error(`Unknown subagent model ${JSON.stringify(wanted)}. Use one of: ${names}.`);
	}
	return { description: stringField(record, "description") || prompt.split("\n")[0].slice(0, 60), prompt, model, ...(record.keepOpen === true ? { keepOpen: true } : {}) };
}

/** Creates the tool that closes an open subagent. */
export function createCloseSubagentTool(options: SubagentToolOptions): ChatTool {
	return {
		name: CLOSE_SUBAGENT_TOOL_NAME,
		group: CHAT_TOOL_GROUPS.agents,
		description: "Close an open subagent of this chat once its work is accepted; it frees its context and its idle terminals. Open subagents are listed in the host context.",
		inputSchema: { type: "object", properties: { subagentId: { type: "string" } }, required: ["subagentId"] },
		available: () => options.models().length > 0,
		invoke: async (input, _token, context) => {
			if (!context?.closeSubagent) {
				throw new Error("Only the main agent can close subagents.");
			}
			const id = stringField(typeof input === "object" && input !== null ? input as Record<string, unknown> : {}, "subagentId");
			if (!id) {
				throw new Error("subagentId is required.");
			}
			return context.closeSubagent(id);
		},
	};
}

/** The subagent tool; the chat controller supplies runSubagent, so the tool cannot run anywhere else. */
export function createSubagentTool(options: SubagentToolOptions): ChatTool {
	return {
		name: SUBAGENT_TOOL_NAME,
		group: CHAT_TOOL_GROUPS.agents,
		get description(): string {
			const models = options.models().map(option => `- "${option.label}": ${option.useWhen}.`);
			return `${DESCRIPTION_HEAD}\nModels (pass the quoted name as model):\n${models.join("\n")}`;
		},
		// Static, without an enum: providers check calls against the schema and may keep an old copy of it.
		inputSchema: {
			type: "object",
			properties: {
				description: { type: "string", description: "A short (3-6 words) label for the subtask, shown to the user." },
				prompt: { type: "string", description: "The complete task for the subagent." },
				model: { type: "string", description: "One of the model names listed in this tool's description." },
				keepOpen: { type: "boolean", description: "Keep the subagent open after its report, with its context, so you can send it follow-up tasks with subagentId. Close it with close_subagent once its work is accepted." },
				subagentId: { type: "string", description: "Id of an open subagent to continue with prompt as its next task; it keeps its model and context." },
			},
			required: ["prompt"],
		},
		available: () => options.models().length > 0,
		invoke: async (input, token, context) => {
			if (!context?.runSubagent) {
				throw new Error("A subagent cannot start another subagent.");
			}
			return context.runSubagent(parseSubagentInput(input, options.models()), token);
		},
	};
}
