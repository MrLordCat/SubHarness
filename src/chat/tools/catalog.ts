import * as vscode from "vscode";
import { COCO_TERMINAL_TOOLS } from "../../coco/terminal-tools";
import { getLocalTool } from "../../tools/local-tools";
import { WAIT_TERMINAL_TOOL_NAME } from "../../tools/wait-terminal";
import type { ChatToolGroup } from "../shared/protocol";
import { CHAT_TOOL_GROUPS, type ChatTool } from "./types";

export const TOOL_OVERRIDES_KEY = "llamacpp.chat.toolOverrides";

/** The chat has its own terminal tools; these bridge tools serve Copilot and Coco. */
const HIDDEN_TOOLS = new Set<string>([...Object.values(COCO_TERMINAL_TOOLS), WAIT_TERMINAL_TOOL_NAME]);

const BUILTIN_GROUP_LABELS: Record<string, string> = {
	[CHAT_TOOL_GROUPS.files]: "Files",
	[CHAT_TOOL_GROUPS.search]: "Search",
	[CHAT_TOOL_GROUPS.terminal]: "Terminal",
	[CHAT_TOOL_GROUPS.diagnostics]: "Diagnostics",
	[CHAT_TOOL_GROUPS.bridge]: "AI Agent Bridge",
};
const GROUP_ORDER: readonly string[] = Object.keys(BUILTIN_GROUP_LABELS);
const EXTERNAL_NOTE = "Run through VS Code, which may ask for confirmation in a dialog.";

export interface ToolRegistry {
	tools(): readonly vscode.LanguageModelToolInformation[];
	invoke(name: string, input: object, token: vscode.CancellationToken): Thenable<vscode.LanguageModelToolResult>;
	/** Implementation of a tool this extension registered; it runs without the VS Code confirmation dialog. */
	local(name: string): vscode.LanguageModelTool<object> | undefined;
}

export const vscodeToolRegistry: ToolRegistry = {
	tools: () => vscode.lm.tools,
	invoke: (name, input, token) => vscode.lm.invokeTool(name, { input, toolInvocationToken: undefined }, token),
	local: getLocalTool,
};

export interface ChatToolCatalogOptions {
	builtins: readonly ChatTool[];
	state: vscode.Memento;
	registry?: ToolRegistry;
}

interface CatalogEntry {
	tool: ChatTool;
	groupLabel: string;
	defaultEnabled: boolean;
	external: boolean;
}

function resultText(result: vscode.LanguageModelToolResult): string {
	const decoder = new TextDecoder();
	return result.content.map(part => {
		if (part instanceof vscode.LanguageModelTextPart) {
			return part.value;
		}
		if (part instanceof vscode.LanguageModelDataPart && /^(?:text\/|application\/json)/.test(part.mimeType)) {
			return decoder.decode(part.data);
		}
		return "[non-text output omitted]";
	}).join("\n");
}

function inputObject(input: unknown): object {
	return typeof input === "object" && input !== null ? input : {};
}

/** External tools are grouped by their name prefix: mcp_, copilot_, vscode_ or the text before the first underscore. */
function externalGroup(name: string): { id: string; label: string } {
	if (name.startsWith("mcp_")) {
		return { id: "ext:mcp", label: "MCP servers" };
	}
	if (name.startsWith("copilot_")) {
		return { id: "ext:copilot", label: "Copilot" };
	}
	const separator = name.search(/[_.]/);
	if (name.startsWith("vscode_") || separator <= 0) {
		return { id: "ext:vscode", label: "VS Code" };
	}
	const prefix = name.slice(0, separator);
	return { id: `ext:${prefix}`, label: prefix };
}

/** All tools the chat can offer, with the user's on/off choices; builtins and bridge tools start enabled. */
export class ChatToolCatalog {
	private readonly _builtins: readonly ChatTool[];
	private readonly _state: vscode.Memento;
	private readonly _registry: ToolRegistry;

	constructor(options: ChatToolCatalogOptions) {
		this._builtins = options.builtins;
		this._state = options.state;
		this._registry = options.registry ?? vscodeToolRegistry;
	}

	groups(): ChatToolGroup[] {
		const overrides = this._overrides();
		const groups = new Map<string, ChatToolGroup>();
		for (const entry of this._entries()) {
			const id = entry.tool.group;
			let group = groups.get(id);
			if (!group) {
				group = { id, label: entry.groupLabel, tools: [], ...(entry.external ? { note: EXTERNAL_NOTE } : {}) };
				groups.set(id, group);
			}
			group.tools.push({ name: entry.tool.name, description: entry.tool.description, enabled: overrides[entry.tool.name] ?? entry.defaultEnabled });
		}
		const rank = (id: string): number => {
			const index = GROUP_ORDER.indexOf(id);
			return index >= 0 ? index : GROUP_ORDER.length;
		};
		return [...groups.values()]
			.map(group => ({ ...group, tools: group.tools.sort((left, right) => left.name.localeCompare(right.name)) }))
			.sort((left, right) => rank(left.id) - rank(right.id) || left.label.localeCompare(right.label));
	}

	enabledTools(): ChatTool[] {
		const overrides = this._overrides();
		return this._entries().filter(entry => overrides[entry.tool.name] ?? entry.defaultEnabled).map(entry => entry.tool);
	}

	async setEnabled(names: readonly string[], enabled: boolean): Promise<void> {
		const known = new Map(this._entries().map(entry => [entry.tool.name, entry]));
		const overrides = { ...this._overrides() };
		for (const name of names) {
			const entry = known.get(name);
			if (!entry) {
				continue;
			}
			// Storing only differences lets a later change of the defaults reach untouched tools.
			if (enabled === entry.defaultEnabled) {
				delete overrides[name];
			} else {
				overrides[name] = enabled;
			}
		}
		await this._state.update(TOOL_OVERRIDES_KEY, overrides);
	}

	private _overrides(): Record<string, boolean> {
		const stored = this._state.get<unknown>(TOOL_OVERRIDES_KEY);
		if (typeof stored !== "object" || stored === null) {
			return {};
		}
		const overrides: Record<string, boolean> = {};
		for (const [name, value] of Object.entries(stored)) {
			if (typeof value === "boolean") {
				overrides[name] = value;
			}
		}
		return overrides;
	}

	private _entries(): CatalogEntry[] {
		const entries: CatalogEntry[] = this._builtins.map(tool => ({
			tool,
			groupLabel: BUILTIN_GROUP_LABELS[tool.group] ?? tool.group,
			defaultEnabled: true,
			external: false,
		}));
		const taken = new Set(this._builtins.map(tool => tool.name));
		for (const info of this._registry.tools()) {
			if (taken.has(info.name) || HIDDEN_TOOLS.has(info.name)) {
				continue;
			}
			taken.add(info.name);
			const local = info.name.startsWith("llamacpp_") ? this._registry.local(info.name) : undefined;
			if (local) {
				entries.push({ tool: this._localTool(info, local), groupLabel: BUILTIN_GROUP_LABELS[CHAT_TOOL_GROUPS.bridge], defaultEnabled: true, external: false });
				continue;
			}
			const group = externalGroup(info.name);
			entries.push({ tool: this._externalTool(info, group.id), groupLabel: group.label, defaultEnabled: false, external: true });
		}
		return entries;
	}

	private _localTool(info: vscode.LanguageModelToolInformation, implementation: vscode.LanguageModelTool<object>): ChatTool {
		return {
			name: info.name,
			description: info.description,
			inputSchema: info.inputSchema ?? { type: "object", properties: {} },
			group: CHAT_TOOL_GROUPS.bridge,
			invoke: async (input, token) => {
				const options = { input: inputObject(input), toolInvocationToken: undefined } as vscode.LanguageModelToolInvocationOptions<object>;
				const result = await implementation.invoke(options, token);
				return result ? resultText(result) : "";
			},
		};
	}

	private _externalTool(info: vscode.LanguageModelToolInformation, group: string): ChatTool {
		return {
			name: info.name,
			description: info.description,
			inputSchema: info.inputSchema ?? { type: "object", properties: {} },
			group,
			invoke: async (input, token) => resultText(await this._registry.invoke(info.name, inputObject(input), token)),
		};
	}
}
