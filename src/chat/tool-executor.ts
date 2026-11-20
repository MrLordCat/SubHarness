import type * as vscode from "vscode";
import type { ChatToolGroup, ChatToolImage } from "./shared/protocol";
import type { ChatTool, ChatToolConfirmation, ChatToolInvokeContext } from "./tools/types";

export interface ChatToolCallContext extends ChatToolInvokeContext {
	/** Resolves true when the user allows the call; a cancelled turn resolves false. */
	approve(confirmation: ChatToolConfirmation): Promise<boolean>;
}

/** What the chat controller needs from the tool layer; groups and setEnabled feed the tool picker. */
export interface ChatToolSource {
	readonly tools: readonly vscode.LanguageModelChatTool[];
	invoke(name: string, input: unknown, token: vscode.CancellationToken, context?: ChatToolCallContext): Promise<{ text: string; isError: boolean; images?: ChatToolImage[] }>;
	groups?(): ChatToolGroup[];
	setEnabled?(names: readonly string[], enabled: boolean): Promise<void>;
	/** True when the tool never changes files; unknown tools count as writing. */
	isReadOnly?(name: string): boolean;
	/** Absolute paths the call may write; empty when the tool does not report them. */
	writtenPaths?(name: string, input: unknown): string[];
}

export interface ChatToolCatalogLike {
	enabledTools(): ChatTool[];
	groups(): ChatToolGroup[];
	setEnabled(names: readonly string[], enabled: boolean): Promise<void>;
}

export const DENIED_TOOL_RESULT = "The user denied this tool call. Do not retry it; ask the user how to proceed if it is needed.";

function confirmationFor(tool: ChatTool, input: unknown): ChatToolConfirmation | undefined {
	try {
		return tool.needsConfirmation?.(input);
	} catch (error) {
		// A check that fails must not let the call through unseen.
		return { title: `Run ${tool.name}`, detail: JSON.stringify(input, undefined, 2) ?? "", reason: `The safety check failed: ${error instanceof Error ? error.message : String(error)}` };
	}
}

/** Offers the enabled catalog tools to the agent loop and holds calls that need the user's approval. */
export function createChatToolSource(catalog: ChatToolCatalogLike): ChatToolSource {
	return {
		get tools(): readonly vscode.LanguageModelChatTool[] {
			return catalog.enabledTools().map(tool => ({ name: tool.name, description: tool.description, inputSchema: tool.inputSchema }));
		},
		async invoke(name, input, token, context) {
			const tool = catalog.enabledTools().find(candidate => candidate.name === name);
			if (!tool) {
				return { text: `Unknown or disabled tool: ${name}`, isError: true };
			}
			const confirmation = confirmationFor(tool, input);
			if (confirmation && !(context && await context.approve(confirmation))) {
				return { text: DENIED_TOOL_RESULT, isError: true };
			}
			const output = await tool.invoke(input, token, {
				callId: context?.callId,
				runSubagent: context?.runSubagent,
				askQuestions: context?.askQuestions,
				listTools: context?.listTools,
				requestTools: context?.requestTools,
			});
			const result = typeof output === "string" ? { text: output } : output;
			return { text: result.text, isError: false, ...(result.images && result.images.length > 0 ? { images: result.images } : {}) };
		},
		groups: () => catalog.groups(),
		setEnabled: (names, enabled) => catalog.setEnabled(names, enabled),
		isReadOnly: name => catalog.enabledTools().find(tool => tool.name === name)?.readOnly === true,
		writtenPaths(name, input) {
			try {
				return catalog.enabledTools().find(tool => tool.name === name)?.writes?.(input) ?? [];
			} catch {
				return [];
			}
		},
	};
}
