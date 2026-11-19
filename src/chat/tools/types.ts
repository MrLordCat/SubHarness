import type * as vscode from "vscode";

/** Shown to the user before a call that the approval policy holds back. */
export interface ChatToolConfirmation {
	title: string;
	/** What will run: the command line, the target path. */
	detail: string;
	/** Why the call is held: the matched dangerous-command rule, a path outside the workspace. */
	reason: string;
}

export interface SubagentModelOption {
	id: string;
	/** Name as shown in the model picker; the tool's model enum uses it. */
	label: string;
	useWhen: string;
}

export interface SubagentRequest {
	description: string;
	prompt: string;
	model: SubagentModelOption;
}

/** Host services for one call; only the chat controller can provide them. */
export interface ChatToolInvokeContext {
	callId?: string;
	/** Runs a nested agent turn and resolves with its final report; absent inside a subagent. */
	runSubagent?(request: SubagentRequest, token: vscode.CancellationToken): Promise<string>;
}

/** A tool the chat can call; invoke throws on failure and the message becomes an error result. */
export interface ChatTool {
	readonly name: string;
	readonly description: string;
	readonly inputSchema: object;
	/** Tool picker group id; see CHAT_TOOL_GROUPS. */
	readonly group: string;
	/** Never changes files, so the change tracker does not snapshot before it. */
	readonly readOnly?: boolean;
	/** Absolute paths this call may write; lets parallel chats tell their changes apart. */
	writes?(input: unknown): string[];
	/** Returns a confirmation when this exact call must be approved by the user; undefined runs it at once. */
	needsConfirmation?(input: unknown): ChatToolConfirmation | undefined;
	/** False hides the tool from the model and the picker, e.g. when no model can serve it. */
	available?(): boolean;
	invoke(input: unknown, token: vscode.CancellationToken, context?: ChatToolInvokeContext): Promise<string>;
}

export const CHAT_TOOL_GROUPS = {
	files: "files",
	search: "search",
	web: "web",
	terminal: "terminal",
	diagnostics: "diagnostics",
	agents: "agents",
	bridge: "bridge",
} as const;
