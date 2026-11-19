import { CHAT_TOOL_GROUPS, type ChatTool, type SubagentModelOption, type SubagentRequest } from "./types";

/** Not "run_subagent": the bridge would treat that as Copilot's runSubagent and rewrite its description and schema. */
export const SUBAGENT_TOOL_NAME = "subagent";

const DESCRIPTION_HEAD = [
	"Delegate one bounded, independently verifiable subtask to another model that works with the same workspace tools.",
	"The subagent starts without this conversation: put everything it needs into prompt (goal, relevant files, constraints, what to change or only report, the expected output).",
	"It returns only its final report; its file changes join the same Keep/Undo set.",
	"Pick the cheapest model that can do the task reliably and check its report before relying on it.",
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
	const wanted = stringField(record, "model");
	const model = findModel(models, wanted);
	if (!model) {
		const names = models.map(option => `"${option.label}"`).join(", ");
		throw new Error(`Unknown subagent model ${JSON.stringify(wanted)}. Use one of: ${names}.`);
	}
	return { description: stringField(record, "description") || prompt.split("\n")[0].slice(0, 60), prompt, model };
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
			},
			required: ["description", "prompt", "model"],
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
