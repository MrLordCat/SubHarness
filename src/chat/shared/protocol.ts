// Shared by the extension host and the chat webview bundle: no `vscode` or Node imports here.

export interface ChatUsage {
	promptTokens?: number;
	completionTokens?: number;
	totalTokens?: number;
	cachedTokens?: number;
}

export type ChatTextKind = "text" | "thinking";

export type ChatPart =
	| { kind: "text"; text: string }
	| { kind: "thinking"; text: string }
	| { kind: "toolCall"; callId: string; name: string; input: unknown }
	/** truncated: the model received a cut result; preview: the webview holds only the first WEBVIEW_TOOL_RESULT_PREVIEW_CHARS. */
	| { kind: "toolResult"; callId: string; text: string; isError?: boolean; truncated?: boolean; preview?: boolean }
	| { kind: "notice"; level: "info" | "warning" | "error"; text: string; limit?: ChatLimitInfo }
	/** Messages before keepFromMessageId reach the model only as this summary. */
	| {
		kind: "compaction"; summary: string; keepFromMessageId: string; summarizedMessages: number;
		tokensBefore: number; tokensAfter: number; method: "deepseek" | "extractive";
	}
	/** What a subagent tool call did; the model sees only the subagent's report in the tool result. */
	| ({ kind: "subagent" } & ChatSubagentRun);

export type ChatSubagentStep =
	| { kind: "tool"; name: string; summary: string; isError?: boolean }
	| { kind: "text"; text: string }
	| { kind: "notice"; level: "info" | "warning" | "error"; text: string };

export interface ChatSubagentRun {
	/** The subagent tool call this run answers. */
	callId: string;
	description: string;
	modelId: string;
	modelName: string;
	status: "running" | "done" | "failed" | "stopped";
	steps: ChatSubagentStep[];
	startedAt: number;
	durationMs?: number;
	usage?: ChatUsage;
}

export type ChatStructuredPart = Exclude<ChatPart, { kind: ChatTextKind }>;

/** A provider refused the request because of a subscription limit or an empty balance. */
export interface ChatLimitInfo {
	kind: "limit" | "balance";
	provider: string;
	window?: string;
	/** Epoch milliseconds. */
	resetAt?: number;
}

export interface ChatAttachment {
	id: string;
	kind: "file" | "selection";
	/** Workspace-relative path for display, forward slashes; absolute when outside the workspace. */
	path: string;
	uri: string;
	/** 1-based inclusive lines of a selection. */
	startLine?: number;
	endLine?: number;
	/** Selection text captured when it was attached. */
	text?: string;
	languageId?: string;
}

export interface ChatMessage {
	id: string;
	role: "user" | "assistant";
	/** Number of the user turn; the assistant reply shares it with the user message it answers. */
	turn: number;
	createdAt: number;
	modelId?: string;
	parts: ChatPart[];
	usage?: ChatUsage;
	/** Host context sent with this user message (date, active file); kept so every later request repeats it byte for byte. */
	hostContext?: string;
	/** Display info of the attached files and selections; never their text. */
	attachments?: ChatAttachment[];
	/** The rendered <attachments> block sent to the model; kept so later requests repeat it byte for byte. */
	attachmentContext?: string;
}

export interface ChatSessionMeta {
	id: string;
	title: string;
	createdAt: number;
	updatedAt: number;
	modelId?: string;
	messageCount: number;
}

export type ChatSessionActivityState = "running" | "approval" | "finished";

export interface ChatSessionActivity {
	id: string;
	title: string;
	state: ChatSessionActivityState;
}

export interface ChatModelEntry {
	id: string;
	/** Name without the provider suffix, unique inside its group. */
	name: string;
	maxInputTokens: number;
	detail?: string;
	/** Reasoning levels the model accepts, from its configurationSchema. */
	thinking?: ChatThinkingOptions;
}

export interface ChatThinkingLevel {
	value: string;
	label: string;
	description?: string;
}

export interface ChatThinkingOptions {
	levels: ChatThinkingLevel[];
	/** The level the provider uses when the chat sends none. */
	default?: string;
}

/** A subscription window such as "5h" or "Week". */
export interface ChatQuotaWindow {
	label: string;
	/** Used share, 0-100. */
	percent: number;
	/** Epoch milliseconds. */
	resetsAt?: number;
}

/** What is left with one provider: subscription windows or an account balance. */
export interface ChatProviderQuota {
	/** Matches a model group's provider label, e.g. "Codex". */
	provider: string;
	plan?: string;
	windows: ChatQuotaWindow[];
	balance?: string;
}

export interface ChatModelGroup {
	provider: string;
	models: ChatModelEntry[];
}

export interface ChatRunState {
	running: boolean;
	detail?: string;
}

export interface ChatToolInfo {
	name: string;
	description: string;
	enabled: boolean;
}

export interface ChatToolGroup {
	id: string;
	label: string;
	/** Shown in the picker, e.g. that VS Code may ask before running these tools. */
	note?: string;
	tools: ChatToolInfo[];
}

export interface ChatChangedFile {
	/** Stable key of the file inside the change set. */
	id: string;
	/** Workspace-relative path with forward slashes; prefixed with the folder name in multi-root workspaces. */
	path: string;
	status: "added" | "modified" | "deleted";
	additions?: number;
	deletions?: number;
}

/** Files the agent changed that the user has not kept or undone yet. */
export interface ChatChangeSet {
	files: ChatChangedFile[];
	/** Distinct files the agent changed at or after each turn, for undoing them when that turn's message is edited. */
	sinceTurn: Array<{ turn: number; files: number }>;
	/** Outcome of the last keep or undo, e.g. that a file edited by hand was left as is. */
	notice?: string;
	/** Why change tracking is off, e.g. git is missing. */
	unavailable?: string;
}

/** A tool call held until the user allows or denies it. */
export interface ChatApprovalRequest {
	id: string;
	messageId: string;
	callId: string;
	toolName: string;
	title: string;
	/** What will run, e.g. the command line or the target path. */
	detail: string;
	/** Why it needs confirmation, e.g. the matched dangerous-command rule. */
	reason: string;
}

/** Host → webview. */
export type HostMessage =
	| {
		type: "init"; session: ChatSessionMeta; messages: ChatMessage[]; models: ChatModelGroup[]; selectedModelId?: string; run: ChatRunState;
		tools: ChatToolGroup[]; approvals: ChatApprovalRequest[]; changes: ChatChangeSet;
		/** Chosen reasoning level of the selected model; absent means the model's default. */
		selectedThinking?: string;
		quota: ChatProviderQuota[];
		activity: ChatSessionActivity[];
	}
	| { type: "changes"; changes: ChatChangeSet }
	| { type: "models"; models: ChatModelGroup[]; selectedModelId?: string; selectedThinking?: string }
	| { type: "quota"; quota: ChatProviderQuota[] }
	| { type: "session"; session: ChatSessionMeta }
	/** Chats for the history list, newest first; empty chats other than the active one are left out. */
	| { type: "sessions"; sessions: ChatSessionMeta[]; activeId: string }
	/** Opens the chat list, e.g. from the view title button. */
	| { type: "showSessions" }
	| { type: "tools"; tools: ChatToolGroup[] }
	| { type: "messageAdded"; message: ChatMessage }
	| { type: "partAdded"; messageId: string; part: ChatStructuredPart }
	| { type: "textDelta"; messageId: string; kind: ChatTextKind; text: string }
	| { type: "usage"; messageId: string; usage: ChatUsage }
	/** The message and everything after it were removed (an earlier message was edited). */
	| { type: "truncated"; messageId: string }
	| { type: "run"; run: ChatRunState }
	| { type: "approval"; request: ChatApprovalRequest }
	| { type: "approvalResolved"; id: string; allowed: boolean }
	| { type: "toolResultFull"; messageId: string; callId: string; text: string }
	/** Live state of a running subagent; the finished run arrives as a "subagent" part. */
	| { type: "subagent"; messageId: string; run: ChatSubagentRun }
	/** Chats other than the shown one that run, wait for an approval or finished unseen. */
	| { type: "activity"; activity: ChatSessionActivity[] }
	/** Attachments to show in the composer; they are sent with the next message. */
	| { type: "attachmentsAdded"; attachments: ChatAttachment[] };

/** Webview → host. */
export type WebviewMessage =
	| { type: "ready" }
	| { type: "send"; text: string; attachments?: ChatAttachment[] }
	/** Opens the attachment picker; the picked files come back as "attachmentsAdded". */
	| { type: "pickAttachments" }
	/** Files dropped on the composer. */
	| { type: "addAttachments"; uris: string[] }
	| { type: "openAttachment"; attachment: ChatAttachment }
	/**
	 * Replaces an earlier user message: it and everything after it are dropped, then the text is sent as a new turn.
	 * undoChanges also restores the files the agent changed since that message.
	 */
	| { type: "editMessage"; messageId: string; text: string; undoChanges?: boolean }
	/** Without ids the whole change set is kept or undone. */
	| { type: "keepChanges"; ids?: string[] }
	| { type: "undoChanges"; ids?: string[] }
	| { type: "openChange"; id: string }
	| { type: "stop" }
	| { type: "selectModel"; modelId: string }
	/** Reasoning level for the selected model; remembered per model. */
	| { type: "selectThinking"; value: string }
	/** Asks the providers for fresh limits and balances, e.g. when the quota popup opens. */
	| { type: "refreshQuota" }
	| { type: "setToolsEnabled"; names: string[]; enabled: boolean }
	| { type: "approve"; id: string; allow: boolean }
	| { type: "newChat" }
	| { type: "listSessions" }
	| { type: "openSession"; sessionId: string }
	| { type: "deleteSession"; sessionId: string }
	| { type: "loadToolResult"; messageId: string; callId: string };

/** Tool results longer than this reach the webview as a preview; the full text is loaded on request. */
export const WEBVIEW_TOOL_RESULT_PREVIEW_CHARS = 4_000;

/** Streaming text joins the last part when it has the same kind, otherwise it starts a new part. */
export function appendChatText(parts: ChatPart[], kind: ChatTextKind, text: string): void {
	if (!text) { return; }
	const last = parts.at(-1);
	if (last && last.kind === kind) { last.text += text; return; }
	parts.push({ kind, text });
}

/** Applies one host update to a message list in place; the host and the webview use the same rules. */
export function applyHostUpdate(messages: ChatMessage[], update: HostMessage): void {
	const find = (id: string) => messages.find(message => message.id === id);
	switch (update.type) {
		case "messageAdded": messages.push(update.message); break;
		case "partAdded": find(update.messageId)?.parts.push(update.part); break;
		case "textDelta": { const message = find(update.messageId); if (message) { appendChatText(message.parts, update.kind, update.text); } break; }
		case "usage": { const message = find(update.messageId); if (message) { message.usage = update.usage; } break; }
		case "truncated": { const index = messages.findIndex(message => message.id === update.messageId); if (index >= 0) { messages.splice(index); } break; }
		default: break;
	}
}
