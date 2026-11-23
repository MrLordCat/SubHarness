import * as vscode from "vscode";
import type { ChatToolGroup, ChatToolImage } from "../shared/protocol";
import { CHAT_TOOL_GROUPS, MAX_IMAGE_BYTES, type ChatTool, type ChatToolOutput } from "./types";

export const TOOL_OVERRIDES_KEY = "llamacpp.chat.toolOverrides";

/** VS Code tools that need a Copilot Chat / VS Code chat session; here they fail or open dialogs in the wrong window. */
export const CHAT_SESSION_TOOLS: ReadonlySet<string> = new Set([
	"runSubagent",
	"manage_todo_list",
	"vscode_askQuestions",
	"vscode_get_confirmation",
	"vscode_get_terminal_confirmation",
	"vscode_editFile_internal",
	"vscode_fetchWebPage_internal",
	"vscode_searchExtensions_internal",
	"vscode_listCodeUsages",
	"vscode_renameSymbol",
	"testFailure",
	"get_terminal_output",
	"terminal_last_command",
	"terminal_selection",
	"create_and_run_task",
	"run_task",
	"get_task_output",
	"open_browser_page",
	"navigate_page",
	"read_page",
	"click_element",
	"drag_element",
	"hover_element",
	"type_in_page",
	"handle_dialog",
	"screenshot_page",
	"run_playwright_code",
]);

/** Tools that only work inside Copilot Chat: contributed by it or carrying its name prefix. */
export function isCopilotOnlyTool(name: string, copilotNames: readonly string[]): boolean {
	return name.startsWith("copilot_") || copilotNames.includes(name);
}

const BUILTIN_GROUP_LABELS: Record<string, string> = {
	[CHAT_TOOL_GROUPS.files]: "Files",
	[CHAT_TOOL_GROUPS.search]: "Search",
	[CHAT_TOOL_GROUPS.web]: "Web",
	[CHAT_TOOL_GROUPS.terminal]: "Terminal",
	[CHAT_TOOL_GROUPS.diagnostics]: "Diagnostics",
	[CHAT_TOOL_GROUPS.planning]: "Planning and questions",
	[CHAT_TOOL_GROUPS.agents]: "Subagents",
	[CHAT_TOOL_GROUPS.bridge]: "SubHarness",
};
const GROUP_ORDER: readonly string[] = Object.keys(BUILTIN_GROUP_LABELS);
const EXTERNAL_NOTE = "Run through VS Code, which asks in a dialog unless its tool approval allows them.";

export interface ToolRegistry {
	tools(): readonly vscode.LanguageModelToolInformation[];
	/** Tools contributed by the Copilot Chat extension; re-read on every catalog refresh so extension changes are followed. */
	copilotToolNames?(): readonly string[];
	invoke(name: string, input: object, token: vscode.CancellationToken): Thenable<vscode.LanguageModelToolResult>;
}

function copilotContributedToolNames(): readonly string[] {
	const contributes = vscode.extensions.getExtension("GitHub.copilot-chat")?.packageJSON?.contributes as { languageModelTools?: unknown } | undefined;
	const tools = contributes?.languageModelTools;
	if (!Array.isArray(tools)) {
		return [];
	}
	return (tools as readonly unknown[]).flatMap(tool => {
		const name = typeof tool === "object" && tool !== null ? (tool as { name?: unknown }).name : undefined;
		return typeof name === "string" ? [name] : [];
	});
}

export const vscodeToolRegistry: ToolRegistry = {
	tools: () => vscode.lm.tools,
	copilotToolNames: copilotContributedToolNames,
	invoke: (name, input, token) => vscode.lm.invokeTool(name, { input, toolInvocationToken: undefined }, token),
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

function resultText(result: vscode.LanguageModelToolResult): ChatToolOutput {
	const decoder = new TextDecoder();
	const texts: string[] = [];
	const images: ChatToolImage[] = [];
	for (const part of result.content) {
		if (part instanceof vscode.LanguageModelTextPart) {
			texts.push(part.value);
		} else if (part instanceof vscode.LanguageModelDataPart && /^(?:text\/|application\/json)/.test(part.mimeType)) {
			texts.push(decoder.decode(part.data));
		} else if (part instanceof vscode.LanguageModelDataPart && part.mimeType.startsWith("image/") && part.data.byteLength <= MAX_IMAGE_BYTES) {
			images.push({ mimeType: part.mimeType, data: Buffer.from(part.data).toString("base64"), byteLength: part.data.byteLength });
		} else {
			texts.push("[non-text output omitted]");
		}
	}
	const text = texts.join("\n");
	return images.length > 0 ? { text, images } : { text };
}

function inputObject(input: unknown): object {
	return typeof input === "object" && input !== null ? input : {};
}

/** External tools are grouped by their name prefix: mcp_, vscode_ or the text before the first underscore. */
function externalGroup(name: string): { id: string; label: string } {
	if (name.startsWith("mcp_")) {
		return { id: "ext:mcp", label: "MCP servers" };
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
				group = { id, label: entry.groupLabel, tools: [], ...(entry.external ? { note: EXTERNAL_NOTE, external: true } : {}) };
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
		const entries: CatalogEntry[] = this._builtins.filter(tool => tool.available?.() !== false).map(tool => ({
			tool,
			groupLabel: BUILTIN_GROUP_LABELS[tool.group] ?? tool.group,
			defaultEnabled: true,
			external: false,
		}));
		const taken = new Set(this._builtins.map(tool => tool.name));
		const copilotNames = this._registry.copilotToolNames?.() ?? [];
		for (const info of this._registry.tools()) {
			if (taken.has(info.name) || CHAT_SESSION_TOOLS.has(info.name) || isCopilotOnlyTool(info.name, copilotNames)) {
				continue;
			}
			taken.add(info.name);
			const group = externalGroup(info.name);
			entries.push({ tool: this._externalTool(info, group.id), groupLabel: group.label, defaultEnabled: false, external: true });
		}
		return entries;
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
