import type * as vscode from "vscode";
import type { ChatQuestion, ChatQuestionAnswer, ChatToolGroup, ChatToolImage } from "../shared/protocol";

export interface ChatToolOutput {
	text: string;
	images?: ChatToolImage[];
}

/** Largest image a tool result may carry; view_image and external tools share it. */
export const MAX_IMAGE_BYTES = 3_750_000;

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

/** What the user did with a request_tools call. */
export interface ChatToolRequestResult {
	enabled: string[];
	declined: string[];
	alreadyEnabled: string[];
	unknown: string[];
	dismissed: boolean;
	/** When the enabled tools reach the model; absent means the next request. */
	availableFrom?: "nextRequest" | "nextMessage";
}

/** Host services for one call; only the chat controller can provide them. */
export interface ChatToolInvokeContext {
	callId?: string;
	/** Runs a nested agent turn and resolves with its final report; absent inside a subagent. */
	runSubagent?(request: SubagentRequest, token: vscode.CancellationToken): Promise<string>;
	/** Asks the user in the chat and resolves with the answers; undefined when skipped; absent inside a subagent. */
	askQuestions?(questions: ChatQuestion[], token: vscode.CancellationToken): Promise<ChatQuestionAnswer[] | undefined>;
	/** Every tool the chat can offer, with its on/off state; absent inside a subagent. */
	listTools?(): ChatToolGroup[];
	/** Asks the user to enable tools; absent inside a subagent. */
	requestTools?(names: string[], reason: string, token: vscode.CancellationToken): Promise<ChatToolRequestResult>;
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
	invoke(input: unknown, token: vscode.CancellationToken, context?: ChatToolInvokeContext): Promise<string | ChatToolOutput>;
}

export const CHAT_TOOL_GROUPS = {
	files: "files",
	search: "search",
	web: "web",
	terminal: "terminal",
	diagnostics: "diagnostics",
	planning: "planning",
	agents: "agents",
	bridge: "bridge",
} as const;
