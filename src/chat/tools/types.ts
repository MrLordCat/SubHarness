import type * as vscode from "vscode";

/** Shown to the user before a call that the approval policy holds back. */
export interface ChatToolConfirmation {
	title: string;
	/** What will run: the command line, the target path. */
	detail: string;
	/** Why the call is held: the matched dangerous-command rule, a path outside the workspace. */
	reason: string;
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
	/** Returns a confirmation when this exact call must be approved by the user; undefined runs it at once. */
	needsConfirmation?(input: unknown): ChatToolConfirmation | undefined;
	invoke(input: unknown, token: vscode.CancellationToken): Promise<string>;
}

export const CHAT_TOOL_GROUPS = {
	files: "files",
	search: "search",
	terminal: "terminal",
	diagnostics: "diagnostics",
	bridge: "bridge",
} as const;
