import * as vscode from "vscode";
import type { ChatToolGroup } from "../shared/protocol";
import { CHAT_TOOL_GROUPS, type ChatTool, type ChatToolRequestResult } from "./types";

export const LIST_TOOLS_TOOL_NAME = "list_tools";
export const REQUEST_TOOLS_TOOL_NAME = "request_tools";

const TOOL_LIST_HEADER = "Enabled tools are already available to you. To use disabled ones, call request_tools with their names and a reason; the user approves them.";
const MAX_TOOL_LINES = 300;
const MAX_SHORT_DESCRIPTION_CHARS = 160;
/** The most tools one request_tools call may ask for; its card lists them all, preselected. */
export const MAX_REQUESTED_TOOLS = 30;
const MAX_REASON_CHARS = 500;

const LIST_TOOLS_DESCRIPTION = "Lists every tool this chat can offer, grouped, with on/off state, including disabled ones (MCP servers, other extensions). Use it when the enabled tools are not enough, then call request_tools with the names you need.";

const REQUEST_TOOLS_DESCRIPTION = "Asks the user to enable tools that are currently off (see list_tools). The user may approve all, some or none; the result says when approved tools become available. Ask only for tools you will use, and explain why in reason.";

const DENIED_TEXT = "The user denied the request. Continue with the enabled tools, or explain in your reply what you need.";
const NEXT_MESSAGE_TEXT = "This model keeps its tool list for the current answer, so they become available with the user's next message; finish what you can now and say which step needs them.";
/** Providers whose live native session cannot take a new tool catalog mid-turn. */
const SESSION_FIXED_TOOL_PROVIDERS = new Set(["Claude", "Coco", "Cursor"]);

/** Whether tools enabled during a turn reach the model in that turn's next request. */
export function toolsArriveMidTurn(provider: string): boolean {
	return !SESSION_FIXED_TOOL_PROVIDERS.has(provider);
}

/** One line of a tool description: the first sentence, cut at 160 characters. */
export function shortToolDescription(description: string): string {
	const line = description.split("\n", 1)[0] ?? "";
	const stop = line.indexOf(". ");
	const sentence = (stop >= 0 ? line.slice(0, stop) : line).trim();
	return sentence.length > MAX_SHORT_DESCRIPTION_CHARS ? `${sentence.slice(0, MAX_SHORT_DESCRIPTION_CHARS - 1)}…` : sentence;
}

export interface ToolListOptions {
	query?: string;
	onlyDisabled?: boolean;
}

/** The model's view of the catalog: what is on, what exists, and how to ask for the rest. */
export function formatToolList(groups: ChatToolGroup[], options: ToolListOptions = {}): string {
	const terms = (options.query ?? "").toLowerCase().split(/\s+/).filter(term => term.length > 0);
	const lines = [TOOL_LIST_HEADER];
	let shown = 0;
	let hidden = 0;
	for (const group of groups) {
		const label = group.label.toLowerCase();
		const matching = group.tools.filter(tool =>
			(!options.onlyDisabled || !tool.enabled)
			&& terms.every(term => tool.name.toLowerCase().includes(term)
				|| tool.description.toLowerCase().includes(term)
				|| label.includes(term))
		);
		if (matching.length === 0) {
			continue;
		}
		const enabled = matching.filter(tool => tool.enabled).length;
		lines.push(`## ${group.label} (${enabled}/${matching.length} enabled)${group.note ? ` — ${group.note}` : ""}`);
		for (const tool of matching) {
			if (shown >= MAX_TOOL_LINES) {
				hidden += 1;
				continue;
			}
			lines.push(`- ${tool.name} [${tool.enabled ? "on" : "off"}]: ${shortToolDescription(tool.description)}`);
			shown += 1;
		}
	}
	if (shown === 0) {
		lines.push("No tools match.");
	} else if (hidden > 0) {
		lines.push(`(${hidden} more tools not shown; narrow the query.)`);
	}
	return lines.join("\n");
}

/** Reports each partition of a request_tools call, in the order the model needs them. */
export function formatToolRequestResult(result: ChatToolRequestResult): string {
	const lines: string[] = [];
	if (result.dismissed && result.enabled.length === 0) {
		lines.push(DENIED_TEXT);
	}
	if (result.enabled.length > 0) {
		lines.push(result.availableFrom === "nextMessage"
			? `Enabled: ${result.enabled.join(", ")}. ${NEXT_MESSAGE_TEXT}`
			: `Enabled: ${result.enabled.join(", ")}. They are available from your next request.`);
	}
	if (result.declined.length > 0) {
		lines.push(`Declined by the user: ${result.declined.join(", ")}.`);
	}
	if (result.alreadyEnabled.length > 0) {
		lines.push(`Already enabled: ${result.alreadyEnabled.join(", ")}.`);
	}
	if (result.unknown.length > 0) {
		lines.push(`Unknown tools (check list_tools): ${result.unknown.join(", ")}.`);
	}
	return lines.length > 0 ? lines.join("\n") : "No tools to enable.";
}

function textValue(value: unknown): string {
	return typeof value === "string" ? value.trim() : "";
}

function parseRequest(input: unknown): { names: string[]; reason: string } {
	const record = typeof input === "object" && input !== null && !Array.isArray(input) ? input as Record<string, unknown> : {};
	const raw = record.names;
	if (!Array.isArray(raw) || raw.length < 1 || raw.length > MAX_REQUESTED_TOOLS) {
		throw new Error(`names must be an array of 1 to ${MAX_REQUESTED_TOOLS} tool names.`);
	}
	const names: string[] = [];
	for (const value of raw) {
		const name = textValue(value);
		if (!name) {
			throw new Error("names must contain only non-empty tool names.");
		}
		if (!names.includes(name)) {
			names.push(name);
		}
	}
	const reason = textValue(record.reason);
	if (!reason) {
		throw new Error("reason must not be empty.");
	}
	if (reason.length > MAX_REASON_CHARS) {
		throw new Error(`reason must be at most ${MAX_REASON_CHARS} characters.`);
	}
	return { names, reason };
}

export function createToolAccessTools(): ChatTool[] {
	return [
		{
			name: LIST_TOOLS_TOOL_NAME,
			group: CHAT_TOOL_GROUPS.planning,
			description: LIST_TOOLS_DESCRIPTION,
			readOnly: true,
			inputSchema: {
				type: "object",
				properties: {
					query: { type: "string", description: "Words to filter by name, description or group; all must match." },
					onlyDisabled: { type: "boolean", description: "List only the tools that are off (default false)." },
				},
			},
			invoke: async (input, _token, context) => {
				if (!context?.listTools) {
					throw new Error("list_tools is only available to the main chat agent.");
				}
				const record = typeof input === "object" && input !== null && !Array.isArray(input) ? input as Record<string, unknown> : {};
				const query = textValue(record.query);
				return formatToolList(context.listTools(), {
					...(query ? { query } : {}),
					...(record.onlyDisabled === true ? { onlyDisabled: true } : {}),
				});
			},
		},
		{
			name: REQUEST_TOOLS_TOOL_NAME,
			group: CHAT_TOOL_GROUPS.planning,
			description: REQUEST_TOOLS_DESCRIPTION,
			readOnly: true,
			inputSchema: {
				type: "object",
				properties: {
					names: { type: "array", items: { type: "string" }, minItems: 1, maxItems: MAX_REQUESTED_TOOLS, description: `Exact tool names from list_tools, 1 to ${MAX_REQUESTED_TOOLS}.` },
					reason: { type: "string", description: "One or two sentences on what you need them for." },
				},
				required: ["names", "reason"],
			},
			invoke: async (input, token, context) => {
				if (!context?.requestTools) {
					throw new Error("request_tools is only available to the main chat agent.");
				}
				const { names, reason } = parseRequest(input);
				const result = await context.requestTools(names, reason, token);
				if (token.isCancellationRequested) {
					throw new vscode.CancellationError();
				}
				return formatToolRequestResult(result);
			},
		},
	];
}
