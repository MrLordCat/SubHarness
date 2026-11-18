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
	| { kind: "notice"; level: "info" | "warning" | "error"; text: string };

export type ChatStructuredPart = Exclude<ChatPart, { kind: ChatTextKind }>;

export interface ChatMessage {
	id: string;
	role: "user" | "assistant";
	/** Number of the user turn; the assistant reply shares it with the user message it answers. */
	turn: number;
	createdAt: number;
	modelId?: string;
	parts: ChatPart[];
	usage?: ChatUsage;
}

export interface ChatSessionMeta {
	id: string;
	title: string;
	createdAt: number;
	updatedAt: number;
	modelId?: string;
	messageCount: number;
}

export interface ChatModelEntry {
	id: string;
	/** Name without the provider suffix, unique inside its group. */
	name: string;
	maxInputTokens: number;
	detail?: string;
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
	}
	| { type: "changes"; changes: ChatChangeSet }
	| { type: "models"; models: ChatModelGroup[]; selectedModelId?: string }
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
	| { type: "toolResultFull"; messageId: string; callId: string; text: string };

/** Webview → host. */
export type WebviewMessage =
	| { type: "ready" }
	| { type: "send"; text: string }
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
	| { type: "setToolsEnabled"; names: string[]; enabled: boolean }
	| { type: "approve"; id: string; allow: boolean }
	| { type: "newChat" }
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
