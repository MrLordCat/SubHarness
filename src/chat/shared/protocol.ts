// Shared by the extension host and the chat webview bundle: no `vscode` or Node imports here.

export interface ChatUsage {
	promptTokens?: number;
	completionTokens?: number;
	totalTokens?: number;
	cachedTokens?: number;
}

export interface ChatUsageTotals {
	requests: number;
	promptTokens: number;
	cachedTokens: number;
	completionTokens: number;
	cacheReported: number;
	/** Prompt tokens of the requests that reported cached tokens; the cache-hit denominator. */
	cachedPromptTokens?: number;
}

/** Counters of a provider prompt that reports cache separately from context occupancy. */
export interface ChatPromptCache {
	promptTokens: number;
	cachedTokens?: number;
	cacheWriteTokens?: number;
	completionTokens: number;
	requests: number;
}

export type ChatTextKind = "text" | "thinking";

export interface ChatToolImage {
	mimeType: string;
	/** Base64; left out of webview views. */
	data?: string;
	byteLength: number;
	/** File name or label shown in the chat. */
	name?: string;
}

export type ChatPart =
	/** Only the tail of a long thinking text; the full text loads on request. */
	| { kind: "text"; text: string; preview?: boolean }
	| { kind: "thinking"; text: string; preview?: boolean }
	| { kind: "toolCall"; callId: string; name: string; input: unknown }
	/** truncated: the model received a cut result; preview: the webview holds only the first WEBVIEW_TOOL_RESULT_PREVIEW_CHARS, fullLength its full length. */
	| { kind: "toolResult"; callId: string; text: string; isError?: boolean; truncated?: boolean; preview?: boolean; fullLength?: number; images?: ChatToolImage[] }
	/** Shows Retry when the notice is in the last answer. */
	| { kind: "notice"; level: "info" | "warning" | "error"; text: string; limit?: ChatLimitInfo; retryable?: boolean }
	/** Messages before keepFromMessageId reach the model only as this summary. */
	| {
		kind: "compaction"; summary: string; keepFromMessageId: string; summarizedMessages: number;
		tokensBefore: number; tokensAfter: number; method: "deepseek" | "model" | "extractive";
		/** The kept turn was cut between tool rounds: parts before fromPart of this answer reach the model only through the summary. */
		trimmedTurn?: { messageId: string; fromPart: number; rounds: number };
		/** Tool results in kept messages before this user message reach the model shortened to their start and end. */
		abbreviatedUntil?: string;
		/** Name of the chat model that wrote a "model" summary. */
		summaryModel?: string;
		/** Why DeepSeek, or then the chat model, did not write the summary. */
		fallbackReason?: string;
		/** The chat log with every message, named in the summary so the model can look details up. */
		transcriptPath?: string;
		/** The user's summarized requests, verbatim (long ones cut), oldest first; the summary alone may paraphrase them. */
		requests?: string[];
	}
	/** What a subagent tool call did; the model sees only the subagent's report in the tool result. */
	| ({ kind: "subagent" } & ChatSubagentRun);

export type ChatSubagentStep =
	/** input and output are display copies (at most 4,000 and 2,000 characters); summary stays for old sessions. */
	| { kind: "tool"; name: string; summary: string; input?: string; output?: string; outputChars?: number; isError?: boolean }
	| { kind: "text"; text: string }
	| { kind: "notice"; level: "info" | "warning" | "error"; text: string };

export interface ChatSubagentRun {
	/** The subagent tool call this run answers. */
	callId: string;
	/** The open subagent that ran this task; absent for a one-off subagent. */
	subagentId?: string;
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

/** A subagent kept open in a chat for follow-up tasks; the panel above the input lists them. */
export interface ChatOpenSubagent {
	id: string;
	description: string;
	modelName: string;
	status: "running" | "idle";
	/** First line of its current or last task. */
	task: string;
	/** What it does right now, while it runs. */
	activity?: string;
	/** Start of its last report. */
	report?: string;
	updatedAt: number;
}

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
	/** Why the host could not include this attachment. Set by the host only. */
	error?: string;
}

/** A subscription the chat could use after the user signs in; the model picker offers it. */
export interface ChatSignInOffer {
	provider: string;
	label: string;
	detail?: string;
}

/** What the composer of a chat holds before it is sent; kept per chat across reloads. */
export interface ChatDraft {
	text: string;
	attachments: ChatAttachment[];
}

/** The working-context settings the context popup edits; the Provider Context panel edits the same settings. */
export interface ChatContextSettings {
	/** Shared working context of Codex, Claude, Coco and Cursor in tokens, as the slider stores it. */
	shared: number;
	sharedMin: number;
	sharedMax: number;
	/** The shared context follows the newest known Codex Sol window. */
	followCodex: boolean;
	/** The followed Codex model and its window, once Codex reported or catalogued one. */
	codexModel?: string;
	codexWindow?: number;
	/** Tokens a model may receive when it takes over a chat; a longer chat is compacted first. */
	switchTokens: number;
	switchMin: number;
	switchMax: number;
}

/** A change from the context popup; absent fields stay as they are. */
export interface ChatContextSettingsChange {
	shared?: number;
	followCodex?: boolean;
	switchTokens?: number;
}

/** A message sent while the agent works; it is delivered after the current tool round. */
export interface ChatQueuedMessage {
	id: string;
	text: string;
	attachments?: ChatAttachment[];
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
	/** Sums over every request of this answer; the last request alone is `usage`. */
	usageTotals?: ChatUsageTotals;
	/** Newest prompt-cache counters when the provider reports them apart from context usage. */
	promptCache?: ChatPromptCache;
	/** Host context sent with this user message (date, active file); kept so every later request repeats it byte for byte. */
	hostContext?: string;
	/** Shared memory block sent before this user message; kept so later requests repeat it byte for byte. */
	memoryContext?: string;
	/** Revisions of the memory entries and index this message already shows. */
	memoryRevisions?: Array<{ id: string; revision: string }>;
	/** Display info of the attached files and selections; never their text. */
	attachments?: ChatAttachment[];
	/** The rendered <attachments> block sent to the model; kept so later requests repeat it byte for byte. */
	attachmentContext?: string;
	/** Image attachments of a user message, sent after its text to models that accept images; left out of webview views. */
	images?: ChatToolImage[];
	/** A user message the bridge sent when Retry continued a failed answer; the chat shows it as a one-line marker. */
	continuation?: ChatContinuation;
}

/** Why a continuation was sent: the notice that stopped the answer it continues. */
export interface ChatContinuation {
	error?: string;
}

/** Each pasted file; larger ones are not attached. */
export const PASTED_FILE_MAX_BYTES = 20 * 1024 * 1024;
export const PASTED_FILES_LIMIT = 10;

/** A file pasted into the composer; the webview has its bytes but no path. */
export interface ChatPastedFile {
	name: string;
	mimeType: string;
	/** Base64. */
	data: string;
}

export interface ChatSessionMeta {
	id: string;
	title: string;
	createdAt: number;
	updatedAt: number;
	modelId?: string;
	messageCount: number;
	customTitle?: boolean;
	/** Pending automatic continuation after a subscription limit. */
	autoContinue?: {
		/** Assistant message to continue. */
		messageId: string;
		/** Scheduled time in epoch milliseconds. */
		at: number;
		/** Whether automatic continuation is enabled. */
		enabled: boolean;
		/** Consecutive automatic continuations that hit the limit. */
		attempts: number;
	};
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
	/** Tokens reserved for the answer; maxInputTokens + maxOutputTokens is the model's context window. */
	maxOutputTokens?: number;
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
	/** Stop was requested and the turn is still settling. */
	stopping?: boolean;
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

/** One item of the plan manage_todo_list shows above the composer. */
export interface ChatTodoItem {
	id: number;
	title: string;
	status: "not-started" | "in-progress" | "completed";
}

/** Kinds the shared memory service accepts; keep in sync with SharedMemoryKind. */
export const ChatMemoryKinds = ["preference", "decision", "environment", "workflow", "externalFact", "other"] as const;

export type ChatMemoryKind = typeof ChatMemoryKinds[number];

/** The service's title cap. */
export const CHAT_MEMORY_TITLE_MAX_CHARS = 160;

/** Transport cap; the service applies its own content limits. */
export const CHAT_MEMORY_CONTENT_MAX_CHARS = 100_000;

/** A shared memory entry as the chat panel shows it. */
export interface ChatMemoryEntry {
	id: string;
	title: string;
	content: string;
	kind: string;
	scope: "global" | "workspace";
	pinned: boolean;
	tags: string[];
	/** Epoch milliseconds. */
	updatedAt: number;
	expiresAt?: number;
	expired: boolean;
}

/** What the panel may change; the other entry fields stay as they are. */
export interface ChatMemorySaveInput {
	id?: string;
	title: string;
	content: string;
	kind: string;
	scope: "global" | "workspace";
	pinned: boolean;
}

export interface ChatQuestionOption {
	label: string;
	description?: string;
	recommended?: boolean;
	/** Preselected in the card without the "Recommended" tag. */
	checked?: boolean;
}

export interface ChatQuestion {
	header: string;
	question: string;
	message?: string;
	options?: ChatQuestionOption[];
	multiSelect?: boolean;
	allowFreeformInput?: boolean;
}

export interface ChatQuestionAnswer {
	header: string;
	selected: string[];
	freeform?: string;
}

/** Questions ask_questions waits on; the user answers or skips them in the chat. */
export interface ChatQuestionRequest {
	id: string;
	messageId: string;
	callId: string;
	questions: ChatQuestion[];
	/** Heading above the questions; the card's aria-label uses it too. */
	title?: string;
	submitLabel?: string;
	skipLabel?: string;
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
		tools: ChatToolGroup[]; approvals: ChatApprovalRequest[]; questions?: ChatQuestionRequest[]; changes: ChatChangeSet;
		/** Chosen reasoning level of the selected model; absent means the model's default. */
		selectedThinking?: string;
		quota: ChatProviderQuota[];
		activity: ChatSessionActivity[];
		queued?: ChatQueuedMessage[];
		/** The shown chat's unsent text and attachments; the composer takes them over when the chat changes. */
		draft?: ChatDraft;
		signIn?: ChatSignInOffer[];
		contextSettings?: ChatContextSettings;
		/** Model ids starred in the model picker, oldest first; the picker opens on them. */
		favoriteModels?: string[];
		/** Subagents kept open in the shown chat. */
		subagents?: ChatOpenSubagent[];
	}
	| { type: "changes"; changes: ChatChangeSet }
	| { type: "contextSettings"; settings: ChatContextSettings }
	| { type: "models"; models: ChatModelGroup[]; selectedModelId?: string; selectedThinking?: string; signIn?: ChatSignInOffer[]; favoriteModels?: string[] }
	| { type: "quota"; quota: ChatProviderQuota[] }
	/** The shared memory entries visible here; notice is the last save or delete error. */
	| { type: "memory"; enabled: boolean; projectLabel?: string; entries: ChatMemoryEntry[]; notice?: string }
	| { type: "session"; session: ChatSessionMeta }
	/** Chats for the history list, newest first; empty chats other than the active one are left out. */
	| { type: "sessions"; sessions: ChatSessionMeta[]; activeId: string }
	/** Opens the chat list, e.g. from the view title button. */
	| { type: "showSessions" }
	| { type: "tools"; tools: ChatToolGroup[] }
	| { type: "messageAdded"; message: ChatMessage }
	| { type: "partAdded"; messageId: string; part: ChatStructuredPart }
	| { type: "textDelta"; messageId: string; kind: ChatTextKind; text: string }
	| { type: "usage"; messageId: string; usage?: ChatUsage; totals?: ChatUsageTotals; promptCache?: ChatPromptCache }
	/** The message and everything after it were removed (an earlier message was edited). */
	| { type: "truncated"; messageId: string }
	| { type: "run"; run: ChatRunState }
	| { type: "approval"; request: ChatApprovalRequest }
	| { type: "approvalResolved"; id: string; allowed: boolean }
	/** Questions the agent waits on; the webview shows an answer card. */
	| { type: "questions"; request: ChatQuestionRequest }
	| { type: "questionsResolved"; id: string }
	| { type: "toolResultFull"; messageId: string; callId: string; text: string }
	| { type: "partTextFull"; messageId: string; index: number; text: string }
	/** Live state of a running subagent; the finished run arrives as a "subagent" part. */
	| { type: "subagent"; messageId: string; run: ChatSubagentRun }
	/** The shown chat's open subagents changed. */
	| { type: "subagents"; sessionId: string; subagents: ChatOpenSubagent[] }
	/** Chats other than the shown one that run, wait for an approval or finished unseen. */
	| { type: "activity"; activity: ChatSessionActivity[] }
	/** Attachments to show in the composer; they are sent with the next message. */
	| { type: "attachmentsAdded"; attachments: ChatAttachment[] }
	/** The shown chat's queue changed. */
	| { type: "queued"; queued: ChatQueuedMessage[] }
	/** Puts messages taken back from the queue into the composer, e.g. after Stop. */
	| { type: "restoreDraft"; text: string; attachments: ChatAttachment[] }
	/** Another view of the shown chat changed its draft; the composer replaces its content. */
	| { type: "draft"; sessionId: string; draft: ChatDraft };

/** Webview → host. */
export type WebviewMessage =
	| { type: "ready" }
	| { type: "send"; text: string; attachments?: ChatAttachment[] }
	/** The composer's unsent text and attachments of a chat; empty ones remove the draft. */
	| { type: "saveDraft"; sessionId: string; text: string; attachments: ChatAttachment[] }
	/** Removes a queued message before it is delivered. */
	| { type: "removeQueued"; id: string }
	/** Opens the attachment picker; the picked files come back as "attachmentsAdded". */
	| { type: "pickAttachments" }
	/** Files dropped on the composer. */
	| { type: "addAttachments"; uris: string[] }
	/** Screenshots and files pasted or dropped from outside VS Code; they come back as "attachmentsAdded". */
	| { type: "pasteFiles"; files: ChatPastedFile[] }
	/** Starts the sign-in of a subscription from the model picker's offers. */
	| { type: "signIn"; provider: string }
	| { type: "openAttachment"; attachment: ChatAttachment }
	/** Opens an image of a tool result in VS Code's image viewer. */
	| { type: "openToolImage"; messageId: string; callId: string; index: number }
	/** Opens a file or folder named by a Markdown link or a path in inline code of a message. */
	| { type: "openFileReference"; target: string }
	/**
	 * Replaces an earlier user message: it and everything after it are dropped, then the text is sent as a new turn.
	 * undoChanges also restores the files the agent changed since that message.
	 * attachments: the attachments to send with the edited text; absent keeps the original ones.
	 */
	| { type: "editMessage"; messageId: string; text: string; undoChanges?: boolean; attachments?: ChatAttachment[] }
	/** Continues the failed answer (messageId): its work stays and a continuation message asks the model to finish. */
	| { type: "retryTurn"; messageId: string }
	/** Closes an open subagent from the panel above the input. */
	| { type: "closeSubagent"; sessionId: string; subagentId: string }
	/** The limit card's checkbox: continue the answer (messageId) by itself once the limit resets. */
	| { type: "setAutoContinue"; sessionId: string; messageId: string; enabled: boolean }
	/** Without ids the whole change set is kept or undone. */
	| { type: "keepChanges"; ids?: string[] }
	| { type: "undoChanges"; ids?: string[] }
	| { type: "openChange"; id: string }
	| { type: "stop" }
	| { type: "selectModel"; modelId: string }
	/** Stars or unstars a model in the model picker. */
	| { type: "setFavoriteModel"; modelId: string; favorite: boolean }
	/** Reasoning level for the selected model; remembered per model. */
	| { type: "selectThinking"; value: string }
	/** Asks the providers for fresh limits and balances, e.g. when the quota popup opens. */
	| { type: "refreshQuota" }
	/** Saves the context popup's sliders and Codex toggle. */
	| { type: "saveContextSettings"; change: ChatContextSettingsChange }
	| { type: "setToolsEnabled"; names: string[]; enabled: boolean }
	| { type: "approve"; id: string; allow: boolean }
	/** Answers to a questions message; answers absent means the user skipped. */
	| { type: "answerQuestions"; id: string; answers?: ChatQuestionAnswer[] }
	| { type: "newChat" }
	| { type: "listSessions" }
	| { type: "openSession"; sessionId: string }
	| { type: "deleteSession"; sessionId: string }
	| { type: "renameSession"; sessionId: string; title: string }
	| { type: "exportSession"; sessionId: string }
	| { type: "loadToolResult"; messageId: string; callId: string }
	| { type: "loadPartText"; messageId: string; index: number }
	/** Asks for the shared memory visible in this project, e.g. when the panel opens. */
	| { type: "listMemory" }
	| { type: "saveMemory"; entry: ChatMemorySaveInput }
	| { type: "deleteMemory"; id: string };

/** Tool results longer than this reach the webview as a preview; the full text is loaded on request. */
export const WEBVIEW_TOOL_RESULT_PREVIEW_CHARS = 600;

/** Thinking longer than this reaches the webview as its tail; the full text is loaded on request. */
export const WEBVIEW_THINKING_PREVIEW_CHARS = 1_000;

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
		case "usage": {
			const message = find(update.messageId);
			if (message) {
				if (update.usage) {
					message.usage = update.usage;
				}
				if (update.totals) {
					message.usageTotals = update.totals;
				}
				if (update.promptCache) {
					message.promptCache = update.promptCache;
				}
			}
			break;
		}
		case "truncated": { const index = messages.findIndex(message => message.id === update.messageId); if (index >= 0) { messages.splice(index); } break; }
		default: break;
	}
}
