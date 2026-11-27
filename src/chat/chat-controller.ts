import { BackgroundSubagents } from "./background-subagents";
import { randomUUID } from "node:crypto";
import * as vscode from "vscode";
import { ToolCallValidationError } from "../tools/tool-call-reliability";
import { runAgentTurn, type AgentTurnSink, type ChatToolExecutor } from "./agent-loop";
import { renderAttachments, type AttachmentContent } from "./attachments";
import { interruptedAnswerDigest } from "./retry-digest";
import type { ChatWebviewBridge } from "./chat-view";
import { compactChatHistory, estimateTextTokens, pickLocalSummaryModel, planChatCompaction, previousModelId, withSummaryTimeout, type ChatCompactionLimits, type ChatSummarizer, type ChatSummaryWriter } from "./compaction";
import { cleaningPaysOff, CONTEXT_CLEANING_REPLAY_RATIO, planContextCleaning, providerTokenScale, staleOnlyCompaction, type ChatCleaningEvent } from "./context-cleaning";
import { chatRequestBreakdown, type ChatRequestBreakdownEvent } from "./request-breakdown";
import { activeCompaction, systemMessage, type ChatCompactionPart } from "./lm-messages";
import { MEMORY_INDEX_ID, type ChatMemoryContext, type ChatMemorySource } from "./memory-context";
import type { ChatMemoryStore } from "./memory-store";
import { CHAT_MAX_REQUESTS, DEFAULT_CHAT_TITLE, titleFromParts, type ChatSessionStore, type StoredSubagent } from "./session-store";
import { chatExportFileName, renderChatMarkdown } from "./chat-export";
import { runChatSubagent } from "./subagent-runner";
import { SubagentFiles } from "./subagent-files";
import { ASK_QUESTIONS_TOOL_NAME, TODO_TOOL_NAME } from "./tools/interaction-tools";
import { CLOSE_SUBAGENT_TOOL_NAME, SUBAGENT_TOOL_NAME, subagentLimitMessage, WAIT_SUBAGENTS_TOOL_NAME } from "./tools/subagent-tool";
import { LIST_TOOLS_TOOL_NAME, MAX_REQUESTED_TOOLS, REQUEST_TOOLS_TOOL_NAME, shortToolDescription, toolsArriveMidTurn } from "./tools/tool-access-tools";
import { groupModels, modelProvider, thinkingOptions } from "./shared/model-groups";
import {
	appendChatText,
	CHAT_MEMORY_CONTENT_MAX_CHARS,
	CHAT_MEMORY_TITLE_MAX_CHARS,
	PASTED_FILE_MAX_BYTES,
	PASTED_FILES_LIMIT,
	WEBVIEW_THINKING_PREVIEW_CHARS,
	WEBVIEW_TOOL_RESULT_PREVIEW_CHARS,
} from "./shared/protocol";
import type {
	ChatApprovalKind,
	ChatApprovalRequest,
	ChatAttachment,
	ChatChangeSet,
	ChatContextSettings,
	ChatContextSettingsChange,
	ChatContinuation,
	ChatDraft,
	ChatMemoryEntry,
	ChatMemorySaveInput,
	ChatMessage,
	ChatOpenSubagent,
	ChatPart,
	ChatPastedFile,
	ChatPromptCache,
	ChatProviderQuota,
	ChatQueuedMessage,
	ChatQuestion,
	ChatQuestionAnswer,
	ChatQuestionRequest,
	ChatRunState,
	ChatSessionActivity,
	ChatSessionActivityState,
	ChatSessionMeta,
	ChatSignInOffer,
	ChatStructuredPart,
	ChatSubagentRun,
	ChatTextKind,
	ChatToolGroup,
	ChatToolImage,
	ChatUsage,
	ChatUsageTotals,
	HostMessage,
	WebviewMessage,
} from "./shared/protocol";
import type { ChatChangeTrackerLike, TurnSnapshot } from "./changes/change-tracker";
import { approvalKindLabel, isAlwaysAllowed, type AlwaysAllowStore } from "./approvals";
import type { ChatToolSource } from "./tool-executor";
import type { ChatChangesDiffRequest, ChatToolConfirmation, ChatToolRequestResult, SubagentModelOption, SubagentRequest, UnavailableSubagentModel } from "./tools/types";

export interface ChatControllerDeps {
	backend: Pick<vscode.LanguageModelChatProvider, "provideLanguageModelChatResponse" | "provideLanguageModelChatInformation"> & {
		/** Characters of one tool result the model's provider forwards uncut; undefined when it does not cut. */
		toolResultCharLimit?(modelId: string): number | undefined;
	};
	onDidChangeModels: vscode.Event<void>;
	store: ChatSessionStore;
	/** Requests a chat keeps; older ones are deleted when it is loaded (default CHAT_MAX_REQUESTS). */
	maxRequests?: number;
	tools: ChatToolSource;
	/** Closes the idle terminals of a chat or subagent run that ended. */
	terminals?: { closeOwner(owner: string): number };
	state: vscode.Memento;
	/** Settings shared by every workspace, such as the starred models; without it they stay in `state`. */
	globalState?: vscode.Memento;
	log?: (event: string, data: Record<string, unknown>) => void;
	/** Records the files each turn changed; without it the chat has no Keep/Undo. */
	changes?: ChatChangeTrackerLike;
	openChange?: (sessionId: string, id: string) => Promise<void>;
	/** Asks where to save an exported chat and writes it; resolves to the saved path or undefined when cancelled. */
	saveExport?: (suggestedName: string, content: string) => Promise<string | undefined>;
	/** Opens an image of a tool result in VS Code; key names the message, call and image uniquely. */
	openImage?: (image: { mimeType: string; data: string; name?: string }, key: string) => Promise<void>;
	/** Opens a file or folder a message links to or names in inline code. */
	openFileReference?: (target: string) => Promise<void>;
	/** System prompt and per-turn host context; without it requests carry only the history. */
	prompt?: ChatPromptProvider;
	/** Summarizes older turns before another model takes over a long chat. */
	compaction?: ChatCompactionDeps;
	/** Tells the providers a chat was left, so a turn stopped during a tool call stops waiting for results. */
	abandonConversation?: (conversationId: string) => Promise<void>;
	/** Modal confirmation for destructive actions; without it they proceed. */
	confirm?: (message: string, action: string) => Promise<boolean>;
	/** Non-modal notice with one action; resolves true when the user picks it. */
	notify?: (message: string, action: string) => Promise<boolean>;
	/** Kinds of actions that run without an approval card; without it every held call asks. */
	alwaysAllow?: AlwaysAllowStore;
	/** Shows an operating-system notification about a chat; the host decides whether the window needs one. */
	osNotify?: (title: string, body: string, sessionId: string) => void;
	/** Clock of auto-continue after a limit; tests replace it. */
	now?: () => number;
	/** Timer of auto-continue after a limit; tests replace it. */
	setTimer?: (callback: () => void, ms: number) => { dispose(): void };
	/** Subscription limits and balances shown next to the model picker. */
	quota?: ChatQuotaSource;
	/** Sign-in offers in the model picker. */
	accounts?: ChatAccountSource;
	/** The working-context settings the context popup shows and changes. */
	contextSettings?: ChatContextSettingsSource;
	/** Editor selections and files the user attaches to a message. */
	attachments?: ChatAttachmentsDeps;
	/** Shared durable memory shown to the model in <memory> blocks before user requests. */
	memory?: ChatMemorySource;
	/** The shared memory list the panel reads and edits. */
	memoryStore?: ChatMemoryStore;
	/** The same model on another subscription when the one an open subagent runs on is used up. */
	subagentStandIn?(modelId: string): string | undefined;
	/** An open subagent's model whose limit is used up with no stand-in; its next task is answered at once. */
	subagentBlocked?(modelId: string): UnavailableSubagentModel | undefined;
	/** Models a new subagent may start with now, for the answer to a blocked one. */
	subagentModels?(): readonly SubagentModelOption[];
}

export interface ChatAttachmentsDeps {
	pick(): Promise<ChatAttachment[]>;
	fromUris(uris: readonly string[]): Promise<ChatAttachment[]>;
	/** Saves pasted screenshots and files and returns them as attachments. */
	savePasted?(files: readonly ChatPastedFile[]): Promise<ChatAttachment[]>;
	read(attachments: readonly ChatAttachment[]): Promise<AttachmentContent[]>;
	open(attachment: ChatAttachment): Promise<void>;
}

export interface ChatContextSettingsSource {
	get(): ChatContextSettings;
	update(change: ChatContextSettingsChange): Promise<void>;
	onDidChange?: vscode.Event<void>;
}

/** Subscriptions that need a sign-in before their models appear. */
export interface ChatAccountSource {
	offers(): ChatSignInOffer[];
	signIn(provider: string): Promise<void>;
	onDidChange?: vscode.Event<void>;
}

export interface ChatQuotaSource {
	snapshot(): ChatProviderQuota[];
	/** Asks the providers for fresh numbers. */
	refresh?(): Promise<void>;
	onDidChange?: vscode.Event<void>;
}

export interface ChatPromptProvider {
	systemPrompt(options?: { subagents?: boolean }): Promise<string>;
	turnContext(): string;
}

export interface ChatCompactionDeps {
	summarize: ChatSummarizer;
	limits(): Omit<ChatCompactionLimits, "fixedTokens">;
	/** The chat context budget in provider tokens; zero turns self-cleaning off. */
	cleaningBudget?(): number;
	/** Told about every finished cleaning. */
	onCleaned?(event: ChatCleaningEvent): void;
	/** Told what the first request of every turn spends its tokens on, after the cleaning. */
	onRequestBreakdown?(event: ChatRequestBreakdownEvent): void;
}

const ACTIVE_SESSION_KEY = "llamacpp.chat.activeSession";
const LAST_MODEL_KEY = "llamacpp.chat.lastModel";
/** Starred model ids; kept in the global state, so every workspace shares them. */
const FAVORITE_MODELS_KEY = "llamacpp.chat.favoriteModels";
const FAVORITE_MODELS_LIMIT = 200;
/** Reasoning level per model id. */
const THINKING_KEY = "llamacpp.chat.thinking";
const SESSION_ID = /^[A-Za-z0-9-]{1,64}$/;
const DELTA_FLUSH_MS = 50;
/** Codex re-announces its status every 200 ms while it streams. */
const QUOTA_COALESCE_MS = 2_000;
const QUOTA_REFRESH_INTERVAL_MS = 30_000;
const MEMORY_COALESCE_MS = 150;
const MEMORY_ID_MAX_CHARS = 80;
const NO_MODEL_NOTICE = "No model is available. Configure a provider first.";
const INTERRUPTED_NOTICE = "This answer was interrupted: VS Code closed or reloaded while it was running.";
const COMPACTING_DETAIL = "Compacting context…";
const CLEANING_DETAIL = "Cleaning context…";
const STOPPING_DETAIL = "Stopping…";
/** Longest file reference a message may ask to open. */
const FILE_REFERENCE_MAX_CHARS = 2048;
const SEND_ATTACHMENT_LIMIT = 20;
const ADD_ATTACHMENT_LIMIT = 50;
/** Unsent composer content per chat id. */
const DRAFTS_KEY = "llamacpp.chat.drafts";
const DRAFT_MAX_CHARS = 100_000;
const DRAFT_LIMIT = 50;
/** Base64 of a pasted file at PASTED_FILE_MAX_BYTES, with room for padding. */
const PASTED_FILE_MAX_BASE64 = Math.ceil(PASTED_FILE_MAX_BYTES / 3) * 4 + 4;
const MAX_QUESTION_ANSWERS = 5;
/**
 * The longest option list a card shows: a request_tools card lists every requested tool,
 * preselected. A lower cap dropped the whole answer and left the card stuck; sanitizeAnswers
 * keeps only the labels the card offered anyway.
 */
const MAX_QUESTION_SELECTED = MAX_REQUESTED_TOOLS;
const MAX_ANSWER_CHARS = 2_000;
/** Auto-continue waits this long after a limit resets, so the provider's window has surely moved on. */
const AUTO_CONTINUE_DELAY_MS = 60_000;
/** Only the 5-hour window is continued; a weekly limit resets days later. */
const AUTO_CONTINUE_HORIZON_MS = 6 * 3_600_000;
/** Continuations in a row that hit the limit again before auto-continue gives up. */
const AUTO_CONTINUE_MAX_ATTEMPTS = 3;
/** A continuation that came due while VS Code was closed, or was switched on late, runs this soon. */
const AUTO_CONTINUE_CATCH_UP_MS = 10_000;
/** A continuation due longer ago than this is dropped: the user has long been back. */
const AUTO_CONTINUE_STALE_MS = 24 * 3_600_000;
const MAX_TIMER_MS = 2_147_483_647;
/** Open subagents one chat may keep; each holds its own context and terminals. */
const MAX_OPEN_SUBAGENTS = 6;
const SUBAGENT_LABEL_MAX_CHARS = 30;
const SUBAGENT_TASK_MAX_CHARS = 200;
const SUBAGENT_REPORT_MAX_CHARS = 300;
const SUBAGENT_ACTIVITY_MAX_CHARS = 120;

interface DeltaBuffer {
	kind: ChatTextKind;
	text: string;
}

interface RunningTurn {
	runtime: SessionRuntime;
	sessionId: string;
	message: ChatMessage;
	model: vscode.LanguageModelChatInformation;
	cts: vscode.CancellationTokenSource;
	/** Parts [0, persistedParts) are already in the session log. */
	persistedParts: number;
	buffer: DeltaBuffer | undefined;
	timer: ReturnType<typeof setTimeout> | undefined;
}

interface SessionRuntime {
	meta: ChatSessionMeta;
	messages: ChatMessage[];
	changes: ChatChangeSet;
	running: RunningTurn | undefined;
	/** A send is being prepared (attachments, memory) before its turn starts; Stop cancels it. */
	preparing: vscode.CancellationTokenSource | undefined;
	/** A turn, edit or keep/undo is under way in this chat. */
	busy: boolean;
	completion: Promise<void>;
	approvals: Map<string, { request: ChatApprovalRequest; settle: (allowed: boolean) => void }>;
	/** Question cards the chat waits on; answers undefined means the user skipped them. */
	questions: Map<string, { request: ChatQuestionRequest; settle: (answers: ChatQuestionAnswer[] | undefined) => void }>;
	/** A turn ended while this chat was not shown. */
	finished: boolean;
	/** Messages sent while the chat worked; each goes out after the current tool round. */
	queued: ChatQueuedMessage[];
	/** Attempts before the auto-continuation now running; undefined while a turn the user started runs. */
	autoAttempt?: number;
	/** Subagents kept open for follow-up tasks, by id; saved beside the chat log. */
	subagents: Map<string, OpenSubagent>;
	subagentPersistence?: Promise<void>;
}

interface OpenSubagent extends StoredSubagent {
	/** It works on a task now; it cannot take another or be closed meanwhile. */
	running?: boolean;
	/** Its current step while it runs. */
	activity?: string;
}

/** One line of at most max characters. */
/** What every request carries besides the history: the system prompt and the tool schemas. */
export function requestFixedTokens(system: string | undefined, tools: readonly vscode.LanguageModelChatTool[]): number {
	const catalog = tools.map(tool => `${tool.name}\n${tool.description}\n${JSON.stringify(tool.inputSchema ?? {})}`).join("\n");
	return (system ? estimateTextTokens(system) : 0) + (catalog ? estimateTextTokens(catalog) : 0);
}

function oneLine(text: string, max: number): string {
	const line = text.replace(/\s+/g, " ").trim();
	return line.length > max ? `${line.slice(0, max - 1)}…` : line;
}

/** The step a running subagent is on, for the open-subagents panel. */
function subagentActivity(run: ChatSubagentRun): string | undefined {
	const step = run.steps.at(-1);
	if (!step) {
		return undefined;
	}
	if (step.kind === "tool") {
		return oneLine(`${step.name} ${step.summary}`, SUBAGENT_ACTIVITY_MAX_CHARS);
	}
	return step.kind === "text" ? "Writing…" : oneLine(step.text, SUBAGENT_ACTIVITY_MAX_CHARS);
}

/** Lists the open subagents for the model with each new request, so it does not lose them after compaction. */
function openSubagentsContext(subagents: Iterable<OpenSubagent>): string | undefined {
	const lines = [...subagents].map(entry => {
		const report = entry.report ? `; last report: ${oneLine(entry.report, 160)}` : "";
		return `- ${entry.id} (${entry.modelName}): ${entry.description}; last task: ${entry.task}${report}`;
	});
	if (lines.length === 0) {
		return undefined;
	}
	return [
		"<open_subagents>",
		"Subagents you kept open in this chat. Send one a follow-up with subagent { subagentId, prompt }; close it with close_subagent once its work is accepted.",
		...lines,
		"</open_subagents>",
	].join("\n");
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

interface StoredDraft extends ChatDraft {
	updatedAt: number;
}

/** Drafts as saved, without entries a newer version or a damaged state could not read. */
function readDrafts(value: unknown): Map<string, StoredDraft> {
	const drafts = new Map<string, StoredDraft>();
	if (!isRecord(value)) {
		return drafts;
	}
	for (const [id, entry] of Object.entries(value)) {
		if (!SESSION_ID.test(id) || !isRecord(entry) || typeof entry.text !== "string" || typeof entry.updatedAt !== "number") {
			continue;
		}
		const attachments = asAttachmentList(entry.attachments ?? [], SEND_ATTACHMENT_LIMIT, true);
		if (attachments) {
			drafts.set(id, { text: entry.text, attachments, updatedAt: entry.updatedAt });
		}
	}
	return drafts;
}

function asAttachment(value: unknown, allowText: boolean): ChatAttachment | undefined {
	if (!isRecord(value) || typeof value.id !== "string" || typeof value.path !== "string" || typeof value.uri !== "string"
		|| (value.kind !== "file" && value.kind !== "selection")) {
		return undefined;
	}
	const attachment: ChatAttachment = { id: value.id, kind: value.kind, path: value.path, uri: value.uri };
	if (value.startLine !== undefined) {
		if (typeof value.startLine !== "number") { return undefined; }
		attachment.startLine = value.startLine;
	}
	if (value.endLine !== undefined) {
		if (typeof value.endLine !== "number") { return undefined; }
		attachment.endLine = value.endLine;
	}
	if (value.languageId !== undefined) {
		if (typeof value.languageId !== "string") { return undefined; }
		attachment.languageId = value.languageId;
	}
	if (allowText && value.text !== undefined) {
		if (typeof value.text !== "string") { return undefined; }
		attachment.text = value.text;
	}
	return attachment;
}

function asAttachmentList(value: unknown, limit: number, allowText: boolean): ChatAttachment[] | undefined {
	if (value === undefined) {
		return undefined;
	}
	if (!Array.isArray(value) || value.length > limit) {
		return undefined;
	}
	const attachments: ChatAttachment[] = [];
	for (const item of value) {
		const attachment = asAttachment(item, allowText);
		if (!attachment) {
			return undefined;
		}
		attachments.push(attachment);
	}
	return attachments;
}

/** Display info only; the text is sent once as part of the rendered block. */
function storedAttachment(attachment: ChatAttachment): ChatAttachment {
	return {
		id: attachment.id,
		kind: attachment.kind,
		path: attachment.path,
		uri: attachment.uri,
		...(attachment.startLine !== undefined ? { startLine: attachment.startLine } : {}),
		...(attachment.endLine !== undefined ? { endLine: attachment.endLine } : {}),
		...(attachment.languageId !== undefined ? { languageId: attachment.languageId } : {}),
		...(attachment.error !== undefined ? { error: attachment.error } : {}),
	};
}

/** The same attachments, in any order, so an edit keeps the rendered block it already sent. */
function sameAttachmentIds(left: readonly ChatAttachment[], right: readonly ChatAttachment[] | undefined): boolean {
	const current = right ?? [];
	if (left.length !== current.length) {
		return false;
	}
	const ids = new Set(current.map(attachment => attachment.id));
	return left.every(attachment => ids.has(attachment.id));
}

/** The queued attachments in order, without repeats, or undefined when there are none. */
function mergeQueuedAttachments(messages: readonly ChatQueuedMessage[]): ChatAttachment[] | undefined {
	const ids = new Set<string>();
	const merged: ChatAttachment[] = [];
	for (const message of messages) {
		for (const attachment of message.attachments ?? []) {
			if (ids.has(attachment.id)) {
				continue;
			}
			ids.add(attachment.id);
			merged.push(attachment);
		}
	}
	return merged.length > 0 ? merged : undefined;
}

/** The question answers a webview sent, or undefined when the shape is malformed. */
function asQuestionAnswers(value: unknown): ChatQuestionAnswer[] | undefined {
	if (!Array.isArray(value) || value.length > MAX_QUESTION_ANSWERS) {
		return undefined;
	}
	const answers: ChatQuestionAnswer[] = [];
	for (const item of value) {
		if (!isRecord(item) || typeof item.header !== "string" || !Array.isArray(item.selected)
			|| item.selected.length > MAX_QUESTION_SELECTED || !item.selected.every(label => typeof label === "string")) {
			return undefined;
		}
		if (item.freeform !== undefined && typeof item.freeform !== "string") {
			return undefined;
		}
		answers.push({
			header: item.header,
			selected: item.selected as string[],
			...(item.freeform === undefined ? {} : { freeform: item.freeform }),
		});
	}
	return answers;
}

/** Keeps only answers that fit the ask_questions call: known headers, offered labels, allowed freeform. */
function sanitizeAnswers(questions: readonly ChatQuestion[], answers: readonly ChatQuestionAnswer[] | undefined): ChatQuestionAnswer[] | undefined {
	if (answers === undefined) {
		return undefined;
	}
	const asked = new Map(questions.map(question => [question.header, question]));
	const seen = new Set<string>();
	const result: ChatQuestionAnswer[] = [];
	for (const answer of answers) {
		const question = asked.get(answer.header);
		if (!question || seen.has(answer.header)) {
			continue;
		}
		seen.add(answer.header);
		const offered = new Set((question.options ?? []).map(option => option.label));
		const selected = [...new Set(answer.selected.filter(label => offered.has(label)))];
		const kept = question.multiSelect === true ? selected : selected.slice(0, 1);
		const freeform = question.allowFreeformInput === false ? "" : answer.freeform?.trim().slice(0, MAX_ANSWER_CHARS) ?? "";
		result.push({ header: question.header, selected: kept, ...(freeform ? { freeform } : {}) });
	}
	return result;
}

/** The entry a memory save may change, or undefined when the shape is malformed. */
function asMemorySaveInput(value: unknown): ChatMemorySaveInput | undefined {
	if (!isRecord(value)
		|| typeof value.title !== "string" || value.title.length > CHAT_MEMORY_TITLE_MAX_CHARS
		|| typeof value.content !== "string" || value.content.length > CHAT_MEMORY_CONTENT_MAX_CHARS
		|| typeof value.kind !== "string"
		|| (value.scope !== "global" && value.scope !== "workspace")
		|| typeof value.pinned !== "boolean") {
		return undefined;
	}
	if (value.id !== undefined && (typeof value.id !== "string" || value.id.length > MEMORY_ID_MAX_CHARS)) {
		return undefined;
	}
	return {
		...(value.id === undefined ? {} : { id: value.id }),
		title: value.title,
		content: value.content,
		kind: value.kind,
		scope: value.scope,
		pinned: value.pinned,
	};
}

function parseWebviewMessage(value: unknown): WebviewMessage | undefined {
	if (!isRecord(value) || typeof value.type !== "string") {
		return undefined;
	}
	switch (value.type) {
		case "ready": return { type: "ready" };
		case "send": {
			if (typeof value.text !== "string") {
				return undefined;
			}
			const attachments = asAttachmentList(value.attachments, SEND_ATTACHMENT_LIMIT, true);
			return attachments ? { type: "send", text: value.text, attachments } : { type: "send", text: value.text };
		}
		case "saveDraft": {
			if (typeof value.sessionId !== "string" || !SESSION_ID.test(value.sessionId) || typeof value.text !== "string") {
				return undefined;
			}
			const attachments = asAttachmentList(value.attachments ?? [], SEND_ATTACHMENT_LIMIT, true);
			return attachments ? { type: "saveDraft", sessionId: value.sessionId, text: value.text.slice(0, DRAFT_MAX_CHARS), attachments } : undefined;
		}
		case "removeQueued": return typeof value.id === "string" ? { type: "removeQueued", id: value.id } : undefined;
		case "pickAttachments": return { type: "pickAttachments", ...(value.target === "draft" || value.target === "edit" ? { target: value.target } : {}) };
		case "addAttachments":
			return Array.isArray(value.uris) && value.uris.length <= ADD_ATTACHMENT_LIMIT && value.uris.every(uri => typeof uri === "string")
				? { type: "addAttachments", uris: value.uris as string[], ...(value.target === "draft" || value.target === "edit" ? { target: value.target } : {}) }
				: undefined;
		case "pasteFiles": {
			if (!Array.isArray(value.files) || value.files.length === 0 || value.files.length > PASTED_FILES_LIMIT) {
				return undefined;
			}
			const files: ChatPastedFile[] = [];
			for (const file of value.files) {
				if (!isRecord(file) || typeof file.name !== "string" || file.name.length > 255
					|| typeof file.mimeType !== "string" || file.mimeType.length > 100
					|| typeof file.data !== "string" || file.data.length > PASTED_FILE_MAX_BASE64) {
					return undefined;
				}
				files.push({ name: file.name, mimeType: file.mimeType, data: file.data });
			}
			return { type: "pasteFiles", files, ...(value.target === "draft" || value.target === "edit" ? { target: value.target } : {}) };
		}
		case "openToolImage":
			return typeof value.messageId === "string" && typeof value.callId === "string"
				&& typeof value.index === "number" && Number.isInteger(value.index) && value.index >= 0
				? { type: "openToolImage", messageId: value.messageId, callId: value.callId, index: value.index }
				: undefined;
		case "openFileReference":
			return typeof value.target === "string" && value.target.length > 0 && value.target.length <= FILE_REFERENCE_MAX_CHARS
				? { type: "openFileReference", target: value.target }
				: undefined;
		case "openAttachment": {
			const attachment = asAttachment(value.attachment, true);
			return attachment ? { type: "openAttachment", attachment } : undefined;
		}
		case "editMessage": {
			if (typeof value.messageId !== "string" || typeof value.text !== "string") {
				return undefined;
			}
			const provided = Array.isArray(value.attachments) ? value.attachments : undefined;
			const attachments = provided === undefined
				? undefined
				: provided.slice(0, SEND_ATTACHMENT_LIMIT).flatMap(item => asAttachment(item, true) ?? []);
			return {
				type: "editMessage",
				messageId: value.messageId,
				text: value.text,
				undoChanges: value.undoChanges === true,
				...(attachments ? { attachments } : {}),
			};
		}
		case "retryTurn": return typeof value.messageId === "string" ? { type: "retryTurn", messageId: value.messageId } : undefined;
		case "continueOnModel":
			return typeof value.messageId === "string" && typeof value.modelId === "string" && value.modelId.length > 0 && value.modelId.length <= 512
				? { type: "continueOnModel", messageId: value.messageId, modelId: value.modelId }
				: undefined;
		case "closeSubagent":
			return typeof value.sessionId === "string" && typeof value.subagentId === "string"
				? { type: "closeSubagent", sessionId: value.sessionId, subagentId: value.subagentId }
				: undefined;
		case "setAutoContinue":
			return typeof value.sessionId === "string" && SESSION_ID.test(value.sessionId)
				&& typeof value.messageId === "string" && typeof value.enabled === "boolean"
				? { type: "setAutoContinue", sessionId: value.sessionId, messageId: value.messageId, enabled: value.enabled }
				: undefined;
		case "keepChanges":
		case "undoChanges": {
			if (value.ids === undefined) {
				return { type: value.type };
			}
			return Array.isArray(value.ids) && value.ids.every(id => typeof id === "string") ? { type: value.type, ids: value.ids as string[] } : undefined;
		}
		case "openChange": return typeof value.id === "string" ? { type: "openChange", id: value.id } : undefined;
		case "stop": return { type: "stop" };
		case "selectModel": return typeof value.modelId === "string" ? { type: "selectModel", modelId: value.modelId } : undefined;
		case "setFavoriteModel":
			return typeof value.modelId === "string" && value.modelId.length > 0 && value.modelId.length <= 512 && typeof value.favorite === "boolean"
				? { type: "setFavoriteModel", modelId: value.modelId, favorite: value.favorite }
				: undefined;
		case "selectThinking": return typeof value.value === "string" ? { type: "selectThinking", value: value.value } : undefined;
		case "refreshQuota": return { type: "refreshQuota" };
		case "saveContextSettings": {
			const change = isRecord(value.change) ? value.change : undefined;
			if (!change) {
				return undefined;
			}
			const tokens = (field: unknown) => typeof field === "number" && Number.isSafeInteger(field) && field > 0 ? field : undefined;
			const shared = tokens(change.shared), switchTokens = tokens(change.switchTokens);
			return {
				type: "saveContextSettings",
				change: {
					...(shared === undefined ? {} : { shared }),
					...(typeof change.followCodex === "boolean" ? { followCodex: change.followCodex } : {}),
					...(switchTokens === undefined ? {} : { switchTokens }),
				},
			};
		}
		case "setToolsEnabled":
			return Array.isArray(value.names) && value.names.every(name => typeof name === "string") && typeof value.enabled === "boolean"
				? { type: "setToolsEnabled", names: value.names as string[], enabled: value.enabled }
				: undefined;
		case "approve":
			return typeof value.id === "string" && typeof value.allow === "boolean"
				? { type: "approve", id: value.id, allow: value.allow, ...(value.always === true ? { always: true } : {}) }
				: undefined;
		case "revokeAlwaysAllow":
			return typeof value.key === "string" && value.key ? { type: "revokeAlwaysAllow", key: value.key } : undefined;
		case "answerQuestions": {
			if (typeof value.id !== "string") {
				return undefined;
			}
			if (value.answers === undefined) {
				return { type: "answerQuestions", id: value.id };
			}
			const answers = asQuestionAnswers(value.answers);
			return answers ? { type: "answerQuestions", id: value.id, answers } : undefined;
		}
		case "newChat": return { type: "newChat" };
		case "signIn":
			return typeof value.provider === "string" && /^[a-z][a-z0-9_:-]{0,47}$/.test(value.provider) ? { type: "signIn", provider: value.provider } : undefined;
		case "listSessions": return { type: "listSessions" };
		case "renameSession":
			return typeof value.sessionId === "string" && SESSION_ID.test(value.sessionId) && typeof value.title === "string" && value.title.length <= 500
				? { type: "renameSession", sessionId: value.sessionId, title: value.title } : undefined;
		case "openSession":
		case "exportSession":
		case "deleteSession":
			return typeof value.sessionId === "string" && SESSION_ID.test(value.sessionId)
				? { type: value.type, sessionId: value.sessionId }
				: undefined;
		case "loadToolResult":
			return typeof value.messageId === "string" && typeof value.callId === "string"
				? { type: "loadToolResult", messageId: value.messageId, callId: value.callId }
				: undefined;
		case "loadPartText":
			return typeof value.messageId === "string" && typeof value.index === "number" && Number.isInteger(value.index) && value.index >= 0
				? { type: "loadPartText", messageId: value.messageId, index: value.index }
				: undefined;
		case "listMemory": return { type: "listMemory" };
		case "saveMemory": {
			const entry = asMemorySaveInput(value.entry);
			return entry ? { type: "saveMemory", entry } : undefined;
		}
		case "deleteMemory":
			return typeof value.id === "string" && value.id.length > 0 && value.id.length <= MEMORY_ID_MAX_CHARS
				? { type: "deleteMemory", id: value.id }
				: undefined;
		default: return undefined;
	}
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

function turnErrorText(error: unknown): string {
	if (error instanceof ToolCallValidationError) {
		const tool = error.toolName ? ` to ${error.toolName}` : "";
		return `The provider rejected the model's call${tool} before it ran (${error.message}), so the turn stopped. Send the message again or rephrase it.`;
	}
	return errorMessage(error);
}

const NOTIFICATION_LINE_MAX_CHARS = 120;

/** The system notification text for a finished turn: how it ended, then the first line of its last text. */
export function turnEndNotification(parts: readonly ChatPart[]): string {
	const last = parts.at(-1);
	const summary = last?.kind === "notice" && last.limit
		? "The agent hit a usage limit."
		: last?.kind === "notice" && last.level === "error"
			? "The agent stopped with an error."
			: "The agent finished.";
	const text = parts.findLast(part => part.kind === "text");
	const line = text?.kind === "text" ? text.text.split(/\r?\n/).find(candidate => candidate.trim() !== "")?.trim() : undefined;
	return line ? `${summary}\n${line.slice(0, NOTIFICATION_LINE_MAX_CHARS)}` : summary;
}

/** Longest error a continuation repeats to the model and keeps for its marker. */
const CONTINUATION_ERROR_MAX_CHARS = 1_000;

/** What Retry sends the model: the failed answer stays in the history, so the model continues it instead of starting over. */
export function continuationRequest(error?: string, digest?: string): string {
	const reason = error ? ` with this error:\n${error}\n` : ". ";
	return `The previous answer stopped before it finished${reason}The user pressed Retry: continue the same task from where it stopped. `
		+ "Everything that answer already did is kept, file changes included. Check the current state where needed instead of repeating finished steps."
		+ (digest ? `\n\n${digest}` : "");
}

function emptyChangeSet(): ChatChangeSet {
	return { files: [], sinceTurn: [] };
}

function maxTurn(messages: readonly ChatMessage[]): number {
	let max = 0;
	for (const message of messages) {
		if (message.turn > max) {
			max = message.turn;
		}
	}
	return max;
}

/** Copies a part for the webview and cuts long tool results and thinking down to a preview; keepFull keeps both. */
function viewPart(part: ChatStructuredPart, keepFull?: boolean): ChatStructuredPart;
function viewPart(part: ChatPart, keepFull?: boolean): ChatPart;
function viewPart(part: ChatPart, keepFull?: boolean): ChatPart {
	const view: ChatPart = part.kind === "toolResult" && part.images
		? { ...part, images: part.images.map(image => ({ mimeType: image.mimeType, byteLength: image.byteLength, ...(image.name === undefined ? {} : { name: image.name }) })) }
		: { ...part };
	if (!keepFull && view.kind === "toolResult" && view.text.length > WEBVIEW_TOOL_RESULT_PREVIEW_CHARS) {
		return { ...view, text: view.text.slice(0, WEBVIEW_TOOL_RESULT_PREVIEW_CHARS), preview: true, fullLength: view.text.length };
	}
	if (!keepFull && view.kind === "thinking" && view.text.length > WEBVIEW_THINKING_PREVIEW_CHARS) {
		return { ...view, text: view.text.slice(-WEBVIEW_THINKING_PREVIEW_CHARS), preview: true };
	}
	return view;
}

function viewMessage(message: ChatMessage, keepFull = false): ChatMessage {
	const view: ChatMessage = { ...message, parts: message.parts.map(part => viewPart(part, keepFull)) };
	// The chips under the message name the images; their bytes stay in the host.
	delete view.images;
	delete view.attachmentContext;
	delete view.memoryContext;
	delete view.memoryRevisions;
	return view;
}

function defaultModelId(models: readonly vscode.LanguageModelChatInformation[]): string | undefined {
	return groupModels(models)[0]?.models[0]?.id;
}

export class ChatController implements ChatWebviewBridge, vscode.Disposable {
	private readonly _deps: ChatControllerDeps;
	private readonly _attachments = new Map<vscode.Webview, vscode.Disposable>();
	private readonly _modelChangeSubscription: vscode.Disposable;
	private _models: vscode.LanguageModelChatInformation[] = [];
	private _modelsLoaded = false;
	private _selectedModelId: string | undefined;
	private readonly _runtimes = new Map<string, SessionRuntime>();
	private _activeId: string | undefined;
	private _sessionTask: Promise<void> | undefined;
	private _sessionLoaded = false;
	private _sessionSwitch: Promise<void> = Promise.resolve();
	private _disposed = false;
	private readonly _quotaSubscription: vscode.Disposable | undefined;
	private _quotaTimer: ReturnType<typeof setTimeout> | undefined;
	private _quotaRefreshedAt = 0;
	private readonly _memorySubscription: vscode.Disposable | undefined;
	private readonly _accountSubscription: vscode.Disposable | undefined;
	private readonly _contextSettingsSubscription: vscode.Disposable | undefined;
	private readonly _alwaysAllowSubscription: vscode.Disposable | undefined;
	private _memoryTimer: ReturnType<typeof setTimeout> | undefined;
	private _lastQuota: string | undefined;
	private _lastActivity: string | undefined;
	/** Read once; changed synchronously so a chat switch right after a save sees the draft. */
	private _draftCache: Map<string, StoredDraft> | undefined;
	/** Auto-continue timers per chat id. */
	private readonly _autoTimers = new Map<string, { dispose(): void }>();

	constructor(deps: ChatControllerDeps) {
		this._deps = deps;
		this._modelChangeSubscription = deps.onDidChangeModels(() => { void this._onModelsChanged(); });
		this._quotaSubscription = deps.quota?.onDidChange?.(() => this._scheduleQuotaBroadcast());
		this._memorySubscription = deps.memoryStore?.onDidChange?.(() => this._scheduleMemoryBroadcast());
		this._accountSubscription = deps.accounts?.onDidChange?.(() => {
			if (this._modelsLoaded) {
				this._broadcastModels();
			}
		});
		this._contextSettingsSubscription = deps.contextSettings?.onDidChange?.(() => this._broadcastContextSettings());
		// Settings edited by hand or in another window reach the Tools list and settle cards that no longer need asking.
		this._alwaysAllowSubscription = deps.alwaysAllow?.onDidChange?.(() => this._onAlwaysAllowChanged());
		// Continuations that were pending when VS Code closed come back without the chat view being opened.
		void this._restoreAutoContinue().catch(error => {
			this._log("chat.auto_continue.restore_failed", { message: errorMessage(error) });
		});
	}

	attach(webview: vscode.Webview): vscode.Disposable {
		if (this._disposed) {
			return new vscode.Disposable(() => undefined);
		}
		this._attachments.get(webview)?.dispose();
		const subscription = webview.onDidReceiveMessage((message: unknown) => {
			const parsed = parseWebviewMessage(message);
			if (!parsed) {
				return;
			}
			void this._handle(webview, parsed).catch(error => {
				this._log("chat.webview_handler_failed", { type: parsed.type, message: errorMessage(error) });
			});
		});
		const attachment = new vscode.Disposable(() => {
			subscription.dispose();
			this._attachments.delete(webview);
		});
		this._attachments.set(webview, attachment);
		return attachment;
	}

	newChat(): Promise<void> {
		return this._switchSession(async () => {
			const previous = this._active();
			await this._ensureModels();
			const runtime = await this._runtime(await this._deps.store.create(this._selectedModelId));
			if (runtime.running) {
				this._flushDelta(runtime.running);
			}
			await this._activate(runtime);
			this._broadcast(this._initMessage());
			this._broadcastActivity();
			if (previous && previous.meta.id !== runtime.meta.id) {
				await this._leave(previous);
			}
		});
	}

	showSessions(): void {
		this._broadcast({ type: "showSessions" });
	}

	/** Adds attachments from an editor or explorer command; they go with the next message. */
	addAttachments(attachments: ChatAttachment[]): void {
		if (attachments.length === 0) {
			return;
		}
		this._broadcast({ type: "attachmentsAdded", attachments });
	}

	openSession(sessionId: string): Promise<void> {
		return this._switchSession(() => this._openSession(sessionId));
	}

	deleteSession(sessionId: string): Promise<void> {
		return this._switchSession(() => this._deleteSession(sessionId));
	}

	/** Switches run one at a time so quick clicks in the history cannot interleave. */
	private _switchSession(task: () => Promise<void>): Promise<void> {
		const result = this._sessionSwitch.then(task, task);
		this._sessionSwitch = result.catch(() => undefined);
		return result;
	}

	private async _openSession(sessionId: string): Promise<void> {
		await this._ensureModels();
		await this._ensureSession();
		if (this._activeId === sessionId) {
			return;
		}
		const target = await this._deps.store.get(sessionId);
		if (!target) {
			this._broadcast(await this._sessionsMessage());
			return;
		}
		const previous = this._active();
		const runtime = await this._runtime(target);
		if (runtime.running) {
			this._flushDelta(runtime.running);
		}
		await this._activate(runtime);
		this._broadcast(this._initMessage());
		this._broadcastActivity();
		if (previous && previous.meta.id !== runtime.meta.id) {
			await this._leave(previous);
		}
	}

	/** A chosen title stays through new messages and edits; an empty one brings the automatic title back. */
	private async _renameSession(sessionId: string, title: string): Promise<void> {
		if (!await this._deps.store.get(sessionId)) {
			return;
		}
		const normalized = title.replace(/\s+/g, " ").trim().slice(0, 120);
		let automatic: string | undefined;
		if (!normalized) {
			const first = (await this._deps.store.load(sessionId)).find(message => message.role === "user" && !message.continuation);
			automatic = (first ? titleFromParts(first.parts) : undefined) ?? DEFAULT_CHAT_TITLE;
		}
		const meta = await this._deps.store.updateMeta(sessionId, { title: normalized || automatic, customTitle: normalized.length > 0 });
		if (!meta) {
			return;
		}
		const runtime = this._runtimes.get(sessionId);
		if (runtime) {
			runtime.meta = meta;
			this._emit(runtime, { type: "session", session: meta });
		}
		this._broadcast(await this._sessionsMessage());
	}

	private async _exportSession(sessionId: string): Promise<void> {
		try {
			const meta = await this._deps.store.get(sessionId);
			if (!meta) {
				return;
			}
			const messages = await this._deps.store.load(sessionId);
			await this._deps.saveExport?.(chatExportFileName(meta.title), renderChatMarkdown(meta, messages));
		} catch (error) {
			this._log("chat.export.failed", { message: errorMessage(error) });
		}
	}

	private async _deleteSession(sessionId: string): Promise<void> {
		await this._ensureSession();
		const meta = await this._deps.store.get(sessionId);
		if (!meta) {
			this._broadcast(await this._sessionsMessage());
			return;
		}
		const confirmed = this._deps.confirm
			? await this._deps.confirm(`Delete the chat "${meta.title}"? Files the agent changed stay as they are.`, "Delete")
			: true;
		if (!confirmed) {
			return;
		}
		const active = this._activeId === sessionId;
		const runtime = this._runtimes.get(sessionId);
		if (runtime) {
			runtime.preparing?.cancel();
			runtime.running?.cts.cancel();
			for (const approval of [...runtime.approvals.values()]) {
				approval.settle(false);
			}
			for (const question of [...runtime.questions.values()]) {
				question.settle(undefined);
			}
			await runtime.completion.catch(() => undefined);
			this._runtimes.delete(sessionId);
		}
		await this._deps.store.delete(sessionId);
		this._clearAutoTimer(sessionId);
		this._closeTerminals(`chat:${sessionId}`);
		for (const subagentId of runtime?.subagents.keys() ?? []) {
			this._closeTerminals(this._subagentOwner(sessionId, subagentId));
		}
		await this._clearDraft(sessionId);
		try {
			await this._deps.changes?.forgetSession?.(sessionId);
		} catch (error) {
			this._log("chat.session.cleanup_failed", { message: errorMessage(error) });
		}
		await this._abandon(sessionId);
		if (active) {
			await this._ensureModels();
			const next = (await this._deps.store.list()).find(candidate => candidate.messageCount > 0);
			const opened = await this._runtime(next ?? await this._deps.store.create(this._selectedModelId));
			if (opened.running) {
				this._flushDelta(opened.running);
			}
			await this._activate(opened);
			this._broadcast(this._initMessage());
		}
		this._broadcast(await this._sessionsMessage());
		this._broadcastActivity();
	}

	private async _sessionsMessage(): Promise<HostMessage> {
		const listed = await this._deps.store.list();
		const drafts = this._drafts();
		const sessions = listed.filter(meta => meta.messageCount > 0 || meta.id === this._activeId || drafts.has(meta.id));
		// Drafts of chats that no longer exist would only take up the limit.
		const known = new Set(listed.map(meta => meta.id));
		const stale = [...drafts.keys()].filter(id => !known.has(id) && !this._runtimes.has(id));
		if (stale.length > 0) {
			for (const id of stale) {
				drafts.delete(id);
			}
			await this._persistDrafts();
		}
		return { type: "sessions", sessions, activeId: this._activeId ?? "" };
	}

	private _drafts(): Map<string, StoredDraft> {
		this._draftCache ??= readDrafts(this._deps.state.get<unknown>(DRAFTS_KEY));
		return this._draftCache;
	}

	private _draft(sessionId: string): ChatDraft | undefined {
		const draft = this._drafts().get(sessionId);
		return draft ? { text: draft.text, attachments: [...draft.attachments] } : undefined;
	}

	private async _persistDrafts(): Promise<void> {
		const drafts = this._drafts();
		try {
			await this._deps.state.update(DRAFTS_KEY, drafts.size > 0 ? Object.fromEntries(drafts) : undefined);
		} catch (error) {
			this._log("chat.draft.persist_failed", { message: errorMessage(error) });
		}
	}

	/** Returns unsent content to the shown composer or merges it into the stored draft. */
	private async _returnToDraft(runtime: SessionRuntime, text: string, attachments: readonly ChatAttachment[]): Promise<void> {
		const id = runtime.meta.id;
		if (id === this._activeId) {
			this._emit(runtime, { type: "restoreDraft", text, attachments: [...attachments] });
			return;
		}
		const draft = this._draft(id);
		const mergedText = [draft?.text, text].filter(part => part).join("\n\n");
		const mergedAttachments = [...new Map([...(draft?.attachments ?? []), ...attachments].map(attachment => [attachment.id, attachment])).values()];
		await this._saveDraft(undefined, id, mergedText, mergedAttachments);
	}

	/** Keeps a chat's unsent composer content; other views of the shown chat take it over. */
	private async _saveDraft(sender: vscode.Webview | undefined, sessionId: string, text: string, attachments: ChatAttachment[]): Promise<void> {
		// A late save of a chat that was deleted meanwhile must not bring its draft back.
		if (!this._runtimes.has(sessionId)) {
			return;
		}
		const drafts = this._drafts();
		const empty = !text.trim() && attachments.length === 0;
		if (empty && !drafts.has(sessionId)) {
			return;
		}
		if (empty) {
			drafts.delete(sessionId);
		} else {
			drafts.delete(sessionId);
			drafts.set(sessionId, { text: text.slice(0, DRAFT_MAX_CHARS), attachments: attachments.slice(0, SEND_ATTACHMENT_LIMIT), updatedAt: Date.now() });
			const oldest = [...drafts.entries()].sort(([, left], [, right]) => left.updatedAt - right.updatedAt);
			for (const [id] of oldest.slice(0, Math.max(0, drafts.size - DRAFT_LIMIT))) {
				drafts.delete(id);
			}
		}
		if (sessionId === this._activeId) {
			const draft: ChatDraft = { text: empty ? "" : text, attachments: empty ? [] : attachments };
			for (const webview of this._attachments.keys()) {
				if (webview !== sender) {
					this._post(webview, { type: "draft", sessionId, draft });
				}
			}
		}
		await this._persistDrafts();
	}

	private async _clearDraft(sessionId: string): Promise<void> {
		if (this._drafts().delete(sessionId)) {
			await this._persistDrafts();
		}
	}

	/** A chat that still works stays in memory; an idle untouched one would only clutter the history. */
	private async _leave(runtime: SessionRuntime): Promise<void> {
		if (runtime.running || runtime.busy || runtime.approvals.size > 0 || runtime.questions.size > 0 || runtime.queued.length > 0) {
			return;
		}
		const sessionId = runtime.meta.id;
		await this._abandon(sessionId);
		try {
			const meta = await this._deps.store.get(sessionId);
			// An untouched chat goes; one with unsent text stays in the history.
			if (meta && meta.messageCount === 0 && !this._drafts().has(sessionId)) {
				await this._deps.store.delete(sessionId);
				await this._deps.changes?.forgetSession?.(sessionId);
			}
		} catch (error) {
			this._log("chat.session.cleanup_failed", { message: errorMessage(error) });
		}
		this._runtimes.delete(sessionId);
	}

	private async _abandon(sessionId: string): Promise<void> {
		try {
			await this._deps.abandonConversation?.(sessionId);
		} catch (error) {
			this._log("chat.abandon_failed", { message: errorMessage(error) });
		}
	}

	dispose(): void {
		if (this._disposed) {
			return;
		}
		this._disposed = true;
		for (const timer of this._autoTimers.values()) {
			timer.dispose();
		}
		this._autoTimers.clear();
		for (const runtime of this._runtimes.values()) {
			runtime.preparing?.cancel();
			runtime.preparing = undefined;
			for (const approval of [...runtime.approvals.values()]) {
				approval.settle(false);
			}
			for (const question of [...runtime.questions.values()]) {
				question.settle(undefined);
			}
			const running = runtime.running;
			running?.cts.cancel();
			if (running?.timer) {
				clearTimeout(running.timer);
				running.timer = undefined;
			}
			runtime.running = undefined;
			runtime.queued = [];
		}
		this._modelChangeSubscription.dispose();
		this._quotaSubscription?.dispose();
		this._accountSubscription?.dispose();
		this._contextSettingsSubscription?.dispose();
		this._alwaysAllowSubscription?.dispose();
		if (this._quotaTimer) {
			clearTimeout(this._quotaTimer);
			this._quotaTimer = undefined;
		}
		this._memorySubscription?.dispose();
		if (this._memoryTimer) {
			clearTimeout(this._memoryTimer);
			this._memoryTimer = undefined;
		}
		for (const attachment of [...this._attachments.values()]) {
			attachment.dispose();
		}
		this._attachments.clear();
	}

	private async _handle(webview: vscode.Webview, message: WebviewMessage): Promise<void> {
		switch (message.type) {
			case "ready":
				await this._ensureModels();
				await this._ensureSession();
				this._post(webview, this._initMessage());
				return;
			case "send":
				await this._send(message.text, message.attachments);
				return;
			case "saveDraft":
				await this._saveDraft(webview, message.sessionId, message.text, message.attachments);
				return;
			case "removeQueued": {
				const runtime = this._active();
				const queued = runtime?.queued.filter(entry => entry.id !== message.id);
				if (runtime && queued && queued.length !== runtime.queued.length) {
					runtime.queued = queued;
					this._emit(runtime, { type: "queued", queued: [...runtime.queued] });
				}
				return;
			}
			case "pickAttachments": {
				const picked = await this._deps.attachments?.pick() ?? [];
				if (picked.length) {
					this._post(webview, { type: "attachmentsAdded", attachments: picked, ...(message.target ? { target: message.target } : {}) });
				}
				return;
			}
			case "addAttachments": {
				const added = await this._deps.attachments?.fromUris(message.uris) ?? [];
				if (added.length) {
					this._post(webview, { type: "attachmentsAdded", attachments: added, ...(message.target ? { target: message.target } : {}) });
				}
				return;
			}
			case "pasteFiles": {
				const added = await this._deps.attachments?.savePasted?.(message.files) ?? [];
				if (added.length) {
					this._post(webview, { type: "attachmentsAdded", attachments: added, ...(message.target ? { target: message.target } : {}) });
				}
				return;
			}
			case "openToolImage": {
				const chatMessage = this._active()?.messages.find(item => item.id === message.messageId);
				const part = chatMessage?.parts.find(item => item.kind === "toolResult" && item.callId === message.callId);
				const image = part?.kind === "toolResult" ? part.images?.[message.index] : undefined;
				if (image?.data) {
					const key = `${message.messageId}-${message.callId}-${message.index}`;
					try {
						await this._deps.openImage?.({ mimeType: image.mimeType, data: image.data, ...(image.name === undefined ? {} : { name: image.name }) }, key);
					} catch (error) {
						this._log("chat.image.open_failed", { message: errorMessage(error) });
					}
				}
				return;
			}
			case "openAttachment":
				await this._deps.attachments?.open(message.attachment);
				return;
			case "openFileReference":
				try {
					await this._deps.openFileReference?.(message.target);
				} catch (error) {
					this._log("chat.file_reference.open_failed", { message: errorMessage(error) });
				}
				return;
			case "editMessage":
				await this._edit(message.messageId, message.text, message.undoChanges === true, message.attachments);
				return;
			case "retryTurn":
				await this._retryTurn(message.messageId);
				return;
			case "continueOnModel":
				await this._continueOnModel(message.messageId, message.modelId);
				return;
			case "setAutoContinue":
				await this._setAutoContinueEnabled(message.sessionId, message.messageId, message.enabled);
				return;
			case "closeSubagent": {
				const runtime = this._runtimes.get(message.sessionId);
				if (runtime) {
					await this._closeSubagent(runtime, message.subagentId).catch(error => {
						this._log("chat.subagent.close_failed", { message: errorMessage(error) });
					});
				}
				return;
			}
			case "keepChanges":
			case "undoChanges":
				await this._resolveChanges(message.type === "keepChanges" ? "keep" : "undo", message.ids);
				return;
			case "openChange": {
				await this._ensureSession();
				const runtime = this._active();
				if (runtime) {
					await this._deps.openChange?.(runtime.meta.id, message.id);
				}
				return;
			}
			case "stop":
				this._stop();
				return;
			case "selectModel":
				await this._selectModel(message.modelId);
				return;
			case "setFavoriteModel":
				await this._setFavoriteModel(message.modelId, message.favorite);
				return;
			case "selectThinking":
				await this._selectThinking(message.value);
				return;
			case "refreshQuota":
				await this._refreshQuota();
				return;
			case "saveContextSettings":
				try {
					await this._deps.contextSettings?.update(message.change);
				} catch (error) {
					this._log("chat.context_settings.save_failed", { message: errorMessage(error) });
				}
				// The source's change event may lag the write; the webview gets the stored values now.
				this._broadcastContextSettings();
				return;
			case "listMemory":
				this._post(webview, this._memoryMessage());
				return;
			case "saveMemory":
				await this._saveMemory(message.entry);
				return;
			case "deleteMemory":
				await this._deleteMemory(message.id);
				return;
			case "setToolsEnabled":
				await this._deps.tools.setEnabled?.(message.names, message.enabled);
				this._broadcast({ type: "tools", tools: this._toolGroups() });
				return;
			case "approve":
				for (const runtime of this._runtimes.values()) {
					const approval = runtime.approvals.get(message.id);
					if (approval) {
						const kinds = approval.request.kinds ?? [];
						if (message.allow && message.always && kinds.length > 0 && this._deps.alwaysAllow) {
							this._log("chat.tool.always_allow", { tool: approval.request.toolName, kinds: kinds.map(kind => kind.key) });
							// Saved before the call runs, so the agent's next call of this kind already finds it.
							try {
								await this._deps.alwaysAllow.add(kinds.map(kind => kind.key));
							} catch (error) {
								// The call still runs once: the user allowed it.
								this._log("chat.always_allow.save_failed", { message: errorMessage(error) });
								void this._deps.notify?.(`Always allow was not saved, so this action will ask again: ${errorMessage(error)}`, "Open Settings").then(open => {
									if (open) {
										void vscode.commands.executeCommand("workbench.action.openSettings", "llamacpp.chat.alwaysAllow");
									}
								}, () => undefined);
							}
							approval.settle(true);
							this._onAlwaysAllowChanged();
						} else {
							approval.settle(message.allow);
						}
						break;
					}
				}
				return;
			case "revokeAlwaysAllow":
				if (this._deps.alwaysAllow) {
					this._log("chat.tool.always_allow_revoked", { kind: message.key });
					await this._deps.alwaysAllow.remove(message.key);
					this._onAlwaysAllowChanged();
				}
				return;
			case "answerQuestions":
				for (const runtime of this._runtimes.values()) {
					const question = runtime.questions.get(message.id);
					if (question) {
						question.settle(sanitizeAnswers(question.request.questions, message.answers));
						break;
					}
				}
				return;
			case "newChat":
				await this.newChat();
				return;
			case "signIn":
				if (this._deps.accounts?.offers().some(offer => offer.provider === message.provider)) {
					await this._deps.accounts.signIn(message.provider);
					this._broadcastModels();
				}
				return;
			case "listSessions":
				await this._ensureSession();
				this._post(webview, await this._sessionsMessage());
				return;
			case "openSession":
				await this.openSession(message.sessionId);
				return;
			case "renameSession":
				await this._renameSession(message.sessionId, message.title);
				break;
			case "exportSession":
				await this._exportSession(message.sessionId);
				break;
			case "deleteSession":
				await this.deleteSession(message.sessionId);
				return;
			case "loadPartText":
				this._sendFullPartText(webview, message.messageId, message.index);
				return;
			case "loadToolResult":
				this._sendFullToolResult(webview, message.messageId, message.callId);
				return;
		}
	}

	private async _send(text: string, attachments?: ChatAttachment[]): Promise<void> {
		if (!text.trim()) {
			return;
		}
		await this._ensureSession();
		const runtime = this._active();
		if (!runtime) {
			return;
		}
		// Without a model nothing is sent, so the composer gets the text back instead of losing it.
		if (!await this._hasModel()) {
			this._emit(runtime, { type: "restoreDraft", text, attachments: attachments ?? [] });
			await this._appendErrorNotice(runtime);
			return;
		}
		await this._clearDraft(runtime.meta.id);
		await this._sendTo(runtime, text, attachments);
	}

	/** A message sent while the chat works waits for the current tool round instead of starting a turn. */
	private async _sendTo(runtime: SessionRuntime, text: string, attachments?: ChatAttachment[]): Promise<void> {
		if (runtime.busy || runtime.running) {
			runtime.queued.push({ id: randomUUID(), text, ...(attachments?.length ? { attachments } : {}) });
			this._emit(runtime, { type: "queued", queued: [...runtime.queued] });
			// An open question would hold the round, and with it the message, until someone answers it.
			for (const question of [...runtime.questions.values()]) {
				question.settle(undefined);
			}
			return;
		}
		runtime.busy = true;
		try {
			await this._sendTurn(runtime, text, attachments);
		} finally {
			runtime.busy = false;
			this._deliverQueued(runtime);
		}
	}

	/** Sends what was queued during the turn just gone; the chat may be working in the background. */
	private _deliverQueued(runtime: SessionRuntime): void {
		if (this._disposed || runtime.busy || runtime.running || runtime.queued.length === 0) {
			return;
		}
		if (this._runtimes.get(runtime.meta.id) !== runtime) {
			return;
		}
		const taken = runtime.queued;
		runtime.queued = [];
		this._emit(runtime, { type: "queued", queued: [] });
		const text = taken.map(message => message.text).join("\n\n");
		const attachments = mergeQueuedAttachments(taken) ?? [];
		const before = runtime.messages.length;
		void (async () => {
			try {
				if (!await this._hasModel()) {
					await this._returnToDraft(runtime, text, attachments);
					await this._appendErrorNotice(runtime);
					return;
				}
				await this._sendTo(runtime, text, attachments);
			} catch (error) {
				this._log("chat.queue.deliver_failed", { message: errorMessage(error) });
				if (this._runtimes.get(runtime.meta.id) === runtime && runtime.messages.length === before) {
					await this._returnToDraft(runtime, text, attachments);
					await this._appendErrorNotice(runtime, `The queued message was not sent: ${errorMessage(error)}. It is back in the input.`);
				}
			}
		})().catch(error => this._log("chat.queue.deliver_failed", { message: errorMessage(error) }));
	}

	private async _resolveChanges(action: "keep" | "undo", ids: readonly string[] | undefined): Promise<void> {
		const tracker = this._deps.changes;
		if (!tracker) {
			return;
		}
		await this._ensureSession();
		const runtime = this._active();
		if (!runtime || runtime.busy) {
			return;
		}
		runtime.busy = true;
		try {
			try {
				await (action === "keep" ? tracker.keep(runtime.meta.id, ids) : tracker.undo(runtime.meta.id, ids));
			} catch (error) {
				this._log("chat.changes.resolve_failed", { action, message: errorMessage(error) });
			}
			await this._refreshChanges(runtime.meta.id);
		} finally {
			runtime.busy = false;
			this._deliverQueued(runtime);
		}
	}

	private async _refreshChanges(sessionId: string): Promise<void> {
		const runtime = this._runtimes.get(sessionId);
		if (!runtime) {
			return;
		}
		runtime.changes = await this._loadChanges(sessionId);
		this._emit(runtime, { type: "changes", changes: runtime.changes });
	}

	private async _loadChanges(sessionId: string): Promise<ChatChangeSet> {
		if (!this._deps.changes) {
			return emptyChangeSet();
		}
		try {
			return await this._deps.changes.changeSet(sessionId);
		} catch (error) {
			this._log("chat.changes.load_failed", { message: errorMessage(error) });
			return emptyChangeSet();
		}
	}

	/** Drops the edited user message and everything after it, then sends the new text as a fresh turn. */
	private async _edit(messageId: string, text: string, undoChanges: boolean, attachments?: ChatAttachment[]): Promise<void> {
		if (!text.trim()) {
			return;
		}
		await this._ensureSession();
		const runtime = this._active();
		if (!runtime || runtime.busy) {
			return;
		}
		if (!await this._hasModel()) {
			await this._appendErrorNotice(runtime);
			return;
		}
		runtime.busy = true;
		try {
			const index = runtime.messages.findIndex(message => message.id === messageId && message.role === "user" && !message.continuation);
			if (index < 0) {
				return;
			}
			const edited = runtime.messages[index];
			const tracker = this._deps.changes;
			if (tracker) {
				const turn = runtime.messages[index].turn;
				try {
					await (undoChanges ? tracker.undoSinceTurn(runtime.meta.id, turn) : tracker.forgetTurnsFrom(runtime.meta.id, turn));
				} catch (error) {
					this._log("chat.changes.edit_rollback_failed", { message: errorMessage(error) });
					// Files that were not restored must not lose the messages that explain them.
					if (undoChanges) {
						await this._appendErrorNotice(runtime, `Could not undo the file changes, so the message was not edited: ${errorMessage(error)}`);
						return;
					}
				}
				await this._refreshChanges(runtime.meta.id);
			}
			try {
				await this._deps.store.truncateFrom(runtime.meta.id, messageId);
			} catch (error) {
				this._log("chat.persist.truncate_failed", { message: errorMessage(error) });
				return;
			}
			runtime.messages.splice(index);
			const updated = await this._deps.store.get(runtime.meta.id).catch(() => undefined);
			if (updated) {
				runtime.meta = updated;
			}
			this._emit(runtime, { type: "truncated", messageId });
			if (attachments === undefined || sameAttachmentIds(attachments, edited.attachments)) {
				await this._sendTurn(runtime, text, undefined, { attachments: edited.attachments, attachmentContext: edited.attachmentContext, images: edited.images });
			} else {
				await this._sendTurn(runtime, text, attachments);
			}
		} finally {
			runtime.busy = false;
			this._deliverQueued(runtime);
		}
	}

	/**
	 * Continues a failed or interrupted answer: its text, tool results and file changes stay, and a continuation
	 * message asks the model to finish the task. Coco continues its saved native session with that new message.
	 */
	private async _retryTurn(messageId: string): Promise<void> {
		await this._ensureSession();
		const runtime = this._active();
		if (!runtime || runtime.busy || runtime.running) {
			return;
		}
		if (!await this._hasModel()) {
			await this._appendErrorNotice(runtime);
			return;
		}
		await this._continueAnswer(runtime, messageId);
	}

	/**
	 * The limit card's "Continue on Claude 2": the chat takes the same model of the other subscription
	 * for this and later turns and continues the stopped answer there, like Retry.
	 */
	private async _continueOnModel(messageId: string, modelId: string): Promise<void> {
		await this._ensureSession();
		const runtime = this._active();
		if (!runtime || runtime.busy || runtime.running || runtime.messages.at(-1)?.id !== messageId) {
			return;
		}
		await this._ensureModels();
		if (!this._models.some(model => model.id === modelId)) {
			this._log("chat.limit.continue_on_skipped", { reason: "no-model" });
			return;
		}
		await this._selectModel(modelId);
		this._log("chat.limit.continue_on", { model: modelId });
		await this._continueAnswer(runtime, messageId, modelId);
	}

	/** Sends the continuation of the chat's last answer; the chat may be in the background. */
	private async _continueAnswer(runtime: SessionRuntime, messageId: string, modelId?: string): Promise<void> {
		const failed = runtime.messages.at(-1);
		if (runtime.busy || runtime.running || !failed || failed.id !== messageId || failed.role !== "assistant") {
			return;
		}
		const notice = failed.parts.findLast(part => part.kind === "notice" && part.retryable);
		const error = notice?.kind === "notice" ? notice.text.slice(0, CONTINUATION_ERROR_MAX_CHARS) : undefined;
		runtime.busy = true;
		try {
			await this._sendTurn(runtime, continuationRequest(error, interruptedAnswerDigest(failed)), undefined, undefined, error ? { error } : {}, modelId);
		} finally {
			runtime.busy = false;
			this._deliverQueued(runtime);
		}
	}

	private async _hasModel(): Promise<boolean> {
		await this._ensureModels();
		return this._selectedModelId !== undefined && this._models.some(model => model.id === this._selectedModelId);
	}

	/** Shows an error as an answer of its own, outside any turn the model ran. */
	private async _appendErrorNotice(runtime: SessionRuntime, text = NO_MODEL_NOTICE): Promise<void> {
		const turn = Math.max(1, maxTurn(runtime.messages));
		const answer: ChatMessage = { id: randomUUID(), role: "assistant", turn, createdAt: Date.now(), parts: [{ kind: "notice", level: "error", text }] };
		await this._appendMessage(runtime, answer);
		// Without the end marker the next load would take this notice for an interrupted answer.
		await this._deps.store.endMessage(runtime.meta.id, answer.id).catch(error => {
			this._log("chat.persist.end_failed", { message: errorMessage(error) });
		});
	}

	private async _sendTurn(
		runtime: SessionRuntime,
		text: string,
		attachments?: ChatAttachment[],
		preserved?: { attachments?: ChatAttachment[]; attachmentContext?: string; images?: ChatToolImage[] },
		continuation?: ChatContinuation,
		/** A model other than the selected one; auto-continue keeps the model that hit the limit. */
		modelOverride?: string,
	): Promise<void> {
		await this._ensureModels();
		const messages = runtime.messages;
		const modelId = modelOverride ?? this._selectedModelId;
		const model = modelId === undefined ? undefined : this._models.find(candidate => candidate.id === modelId);
		if (!model) {
			await this._appendErrorNotice(runtime);
			return;
		}
		const cts = new vscode.CancellationTokenSource();
		runtime.preparing = cts;
		this._emit(runtime, { type: "run", run: { running: true } });
		this._broadcastActivity();
		let started = false;
		try {
			const turn = maxTurn(messages) + 1;
			const hostContext = [this._turnContext(), openSubagentsContext(runtime.subagents.values())].filter(Boolean).join("\n\n") || undefined;
			let display: ChatAttachment[] | undefined;
			let attachmentContext = "";
			let images: ChatToolImage[] = [];
			if (preserved) {
				display = preserved.attachments;
				attachmentContext = preserved.attachmentContext ?? "";
				images = preserved.images ?? [];
			} else if (attachments && attachments.length > 0 && this._deps.attachments) {
				let contents: readonly AttachmentContent[];
				try {
					contents = await this._deps.attachments.read(attachments);
				} catch (error) {
					this._log("chat.attachments.read_failed", { message: errorMessage(error) });
					// The model still learns which files are missing.
					contents = attachments.map(attachment => ({ attachment, error: `could not be read: ${errorMessage(error)}` }));
				}
				// The chips show the user what the model did not get.
				const errors = new Map(contents.flatMap(content => content.error ? [[content.attachment.id, content.error] as const] : []));
				display = attachments.map(attachment => {
					const error = errors.get(attachment.id);
					return error ? { ...attachment, error } : attachment;
				});
				attachmentContext = renderAttachments(contents);
				images = contents.flatMap(content => content.image ? [content.image] : []);
			}
			// A continuation repeats no request of its own; the memory of the request it continues is already shown.
			const memory = continuation ? undefined : await this._memoryContext(text, messages);
			if (cts.token.isCancellationRequested || this._runtimes.get(runtime.meta.id) !== runtime) {
				if (this._runtimes.get(runtime.meta.id) === runtime && !continuation) {
					await this._returnToDraft(runtime, text, preserved?.attachments ?? attachments ?? []);
				}
				return;
			}
			const user: ChatMessage = {
				id: randomUUID(),
				role: "user",
				turn,
				createdAt: Date.now(),
				parts: [{ kind: "text", text }],
				...(hostContext ? { hostContext } : {}),
				...(memory ? { memoryContext: memory.text, memoryRevisions: memory.revisions.map(revision => ({ ...revision })) } : {}),
				...(attachmentContext ? { attachmentContext } : {}),
				...(display && display.length > 0 ? { attachments: display.map(storedAttachment) } : {}),
				...(images.length > 0 ? { images } : {}),
				...(continuation ? { continuation: { ...continuation } } : {}),
			};
			await this._appendMessage(runtime, user);
			await this._refreshSessionMeta(runtime);
			const history = messages.slice();
			const assistant: ChatMessage = { id: randomUUID(), role: "assistant", turn, createdAt: Date.now(), modelId: model.id, parts: [] };
			await this._appendMessage(runtime, assistant);
			// A chat deleted while its messages were being saved must not start a turn nobody can stop.
			if (this._runtimes.get(runtime.meta.id) !== runtime) {
				return;
			}
			const running: RunningTurn = {
				runtime,
				sessionId: runtime.meta.id,
				message: assistant,
				model,
				cts,
				persistedParts: 0,
				buffer: undefined,
				timer: undefined,
			};
			runtime.running = running;
			runtime.preparing = undefined;
			started = true;
			runtime.completion = this._runTurn(running, model, history, turn);
			await runtime.completion;
		} finally {
			if (!started) {
				if (runtime.preparing === cts) {
					runtime.preparing = undefined;
				}
				cts.dispose();
				if (this._runtimes.get(runtime.meta.id) === runtime) {
					this._emit(runtime, { type: "run", run: { running: false } });
					this._broadcastActivity();
				}
			}
		}
	}

	private async _runTurn(running: RunningTurn, model: vscode.LanguageModelChatInformation, history: ChatMessage[], turn: number): Promise<void> {
		const runtime = running.runtime;
		const sink: AgentTurnSink = {
			text: (kind, text) => {
				if (!text) {
					return;
				}
				appendChatText(running.message.parts, kind, text);
				this._queueDelta(running, kind, text);
			},
			part: part => this._addPart(running, part),
			usage: (usage, totals) => {
				running.message.usage = usage;
				running.message.usageTotals = totals;
				void this._persistUsage(running, usage, totals, running.message.promptCache);
				this._emit(runtime, {
					type: "usage", messageId: running.message.id, usage, totals,
					...(running.message.promptCache ? { promptCache: running.message.promptCache } : {}),
				});
			},
			promptCache: (promptCache, totals) => {
				running.message.promptCache = promptCache;
				running.message.usageTotals = totals;
				void this._persistUsage(running, running.message.usage, totals, promptCache);
				this._emit(runtime, {
					type: "usage", messageId: running.message.id,
					...(running.message.usage ? { usage: running.message.usage } : {}),
					totals, promptCache,
				});
			},
		};
		const source = this._deps.tools;
		const background = new BackgroundSubagents();
		const tracker = this._deps.changes;
		let begin: Promise<TurnSnapshot | undefined> | undefined;
		const claimed = new Set<string>();
		const readDiff = tracker?.diff?.bind(tracker);
		// The agent and its reviewer subagents see this turn's changes as the Keep/Undo list will show them.
		const changesDiff = readDiff
			? { changesDiff: async (options: ChatChangesDiffRequest) => readDiff(running.sessionId, begin ? await begin : undefined, [...claimed], options) }
			: {};
		let liveRun: Promise<void> | undefined;
		let liveQueued = false;
		let finalizing = false;
		// One live refresh at a time; tool calls that finish during it queue a single follow-up.
		const refreshLive = (): void => {
			if (!tracker?.liveChangeSet || !begin || finalizing || running.cts.token.isCancellationRequested) {
				return;
			}
			if (liveRun) {
				liveQueued = true;
				return;
			}
			const readLive = tracker.liveChangeSet.bind(tracker);
			const run = async (): Promise<void> => {
				do {
					liveQueued = false;
					const snapshot = await begin;
					if (!snapshot) {
						return;
					}
					try {
						const changes = await readLive(runtime.meta.id, turn, snapshot, [...claimed]);
						if (runtime.running === running) {
							runtime.changes = changes;
							this._emit(runtime, { type: "changes", changes });
						}
					} catch (error) {
						this._log("chat.changes.live_failed", { message: errorMessage(error) });
					}
				} while (liveQueued && !finalizing && !running.cts.token.isCancellationRequested);
			};
			liveRun = run().finally(() => {
				liveRun = undefined;
				if (liveQueued) {
					refreshLive();
				}
			}).catch(() => undefined);
		};
		const invoke = async (name: string, input: unknown, token: vscode.CancellationToken, callId: string | undefined, nested: boolean, terminalOwner: { id: string; label: string }, resultChars: number | undefined) => {
			const readOnly = source.isReadOnly?.(name) ?? false;
			// The snapshot must exist before the first tool that may write; read-only rounds cost nothing.
			if (tracker && !begin && !readOnly) {
				begin = (async () => {
					const snapshot = await tracker.beginTurn().catch(error => {
						this._log("chat.changes.begin_failed", { message: errorMessage(error) });
						return undefined;
					});
					if (snapshot) {
						try {
							await tracker.markOpen?.(running.sessionId, turn);
						} catch (error) {
							this._log("chat.changes.mark_failed", { message: errorMessage(error) });
						}
					}
					return snapshot;
				})();
			}
			await begin;
			if (token.isCancellationRequested) {
				throw new vscode.CancellationError();
			}
			for (const file of source.writtenPaths?.(name, input) ?? []) {
				claimed.add(file);
			}
			try {
				const result = await source.invoke(name, input, token, {
					callId,
					terminalOwner,
					resultChars,
					...changesDiff,
					approve: confirmation => this._requestApproval(running, name, callId, confirmation, token),
					...(nested ? {} : {
						runSubagent: (request: SubagentRequest, subagentToken: vscode.CancellationToken) => {
							if (!request.background) {
								return this._runSubagent(running, callId ?? randomUUID(), request, subagentTools, subagentToken);
							}
							const result = background.start(() => {
								const prepared = this._subagentFor(runtime, request);
								return {
									id: prepared.entry?.id,
									description: prepared.entry?.description ?? request.description,
									run: () => this._runSubagent(running, callId ?? randomUUID(), request, subagentTools, running.cts.token, prepared),
								};
							}, running.cts.token);
							return Promise.resolve(result);
						},
						waitSubagents: (ids, timeout, waitToken) => background.wait(ids, timeout, waitToken),
						closeSubagent: (subagentId: string) => this._closeSubagent(running.runtime, subagentId),
						askQuestions: (questions: ChatQuestion[], questionToken: vscode.CancellationToken) =>
							this._askQuestions(running, callId, questions, questionToken),
						listTools: () => this._toolGroups(),
						requestTools: (names: string[], reason: string, requestToken: vscode.CancellationToken) =>
							this._requestTools(running, callId, names, reason, requestToken),
					}),
				}).catch(error => ({ text: errorMessage(error), isError: true }));
				if (!nested) {
					const notes = background.takeFinishedNotes();
					if (notes) {
						result.text += `\n${notes}`;
					}
				}
				return result;
			} finally {
				if (!readOnly) {
					refreshLive();
				}
			}
		};
		const subagentTools = (owner: { id: string; label: string }, modelId: string): ChatToolExecutor => ({
			get tools() {
				return source.tools.filter(tool => tool.name !== SUBAGENT_TOOL_NAME
					&& tool.name !== CLOSE_SUBAGENT_TOOL_NAME
					&& tool.name !== WAIT_SUBAGENTS_TOOL_NAME
					&& tool.name !== TODO_TOOL_NAME
					&& tool.name !== ASK_QUESTIONS_TOOL_NAME
					&& tool.name !== LIST_TOOLS_TOOL_NAME
					&& tool.name !== REQUEST_TOOLS_TOOL_NAME);
			},
			invoke: (name, input, token, callId) => invoke(name, input, token, callId, true, owner, this._resultChars(modelId)),
		});
		const tools: ChatToolExecutor = {
			get tools() { return source.tools; },
			invoke: (name, input, token, callId) => invoke(name, input, token, callId, false, { id: `chat:${running.sessionId}`, label: "Chat" }, this._resultChars(model.id)),
		};
		let stopped = false;
		try {
			// Subagents get the prompt without the delegation guide: they cannot start subagents.
			const system = await this._systemPrompt({ subagents: source.tools.some(tool => tool.name === SUBAGENT_TOOL_NAME) });
			const thinking = this._thinkingFor(model.id);
			const fixedTokens = requestFixedTokens(system, source.tools);
			const cleaned = await this._cleanContext(running, model, history, fixedTokens);
			// A model switch compacts the cleaned history, and only when it is still over the switch limit.
			const current: ChatMessage = { id: running.message.id, role: "assistant", turn, createdAt: running.message.createdAt, parts: [...cleaned] };
			const initialParts = [...cleaned, ...await this._compactForModel(running, model, cleaned.length > 0 ? [...history, current] : history, fixedTokens)];
			this._recordBreakdown(running, model, history, initialParts.length > 0 ? [...history, { ...current, parts: [...initialParts] }] : history, system, source.tools, fixedTokens);
			await runAgentTurn({
				backend: this._deps.backend,
				model,
				history,
				conversationId: running.sessionId,
				turn,
				tools,
				sink,
				token: running.cts.token,
				system,
				initialParts,
				// Memory arrives in the history as <memory> blocks, so the HTTP provider must not add its own overlay.
				modelOptions: { ...(thinking ? { reasoningEffort: thinking } : {}), _aabSkipSharedMemory: true, _aabStrictTools: true },
				shouldYield: () => runtime.queued.length > 0,
			});
		} catch (error) {
			stopped = error instanceof vscode.CancellationError || running.cts.token.isCancellationRequested;
			if (!stopped) {
				this._addPart(running, { kind: "notice", level: "error", text: turnErrorText(error), retryable: true });
			}
		} finally {
			// The answer is complete; show its tail while the turn waits for its background subagents.
			this._flushDelta(running);
			await background.settled();
			if (!running.cts.token.isCancellationRequested) {
				const reports = background.undelivered();
				if (reports.length) {
					runtime.queued.push({ id: randomUUID(), text: `Background subagent reports:\n\n${reports}` });
					this._emit(runtime, { type: "queued", queued: [...runtime.queued] });
				}
			}
			this._flushDelta(running);
			this._persistFinishedParts(running);
			// The final snapshot supersedes queued live refreshes.
			finalizing = true;
			liveQueued = false;
			const snapshot = await begin;
			await liveRun;
			if (tracker && snapshot) {
				try {
					await tracker.endTurn(runtime.meta.id, turn, snapshot, [...claimed]);
				} catch (error) {
					this._log("chat.changes.end_failed", { message: errorMessage(error) });
				}
				await this._refreshChanges(runtime.meta.id);
			}
			if (runtime.running === running) {
				runtime.running = undefined;
			}
			stopped ||= running.cts.token.isCancellationRequested;
			running.cts.dispose();
			this._emit(runtime, { type: "run", run: { running: false } });
			if (stopped) {
				this._addPart(running, { kind: "notice", level: "info", text: "Stopped." });
			}
			void this._persistEnd(running);
			// A queued message starts the next turn at once, so only the last turn of a run notifies.
			if (!stopped && runtime.queued.length === 0) {
				this._osNotify(runtime, turnEndNotification(running.message.parts));
			}
			void this._updateAutoContinue(runtime, running.message).catch(error => {
				this._log("chat.auto_continue.failed", { message: errorMessage(error) });
			});
			if (runtime.meta.id !== this._activeId) {
				runtime.finished = true;
			}
			this._broadcastActivity();
			// A finished request moves the subscription windows; providers report them without an event.
			this._scheduleQuotaBroadcast();
		}
	}

	/**
	 * Runs a subagent task. A one-off subagent ends with its report; one started with keepOpen, or continued with
	 * subagentId, keeps its conversation and terminals until close_subagent or the panel closes it.
	 */
	/** Characters of one tool result the model's provider forwards uncut, so tools that page fit it. */
	private _resultChars(modelId: string): number | undefined {
		try {
			const limit = this._deps.backend.toolResultCharLimit?.(modelId);
			return typeof limit === "number" && Number.isFinite(limit) && limit > 0 ? limit : undefined;
		} catch {
			return undefined;
		}
	}

	private async _runSubagent(
		running: RunningTurn,
		callId: string,
		request: SubagentRequest,
		toolsFor: (owner: { id: string; label: string }, modelId: string) => ChatToolExecutor,
		token: vscode.CancellationToken,
		prepared?: { entry?: OpenSubagent; model: vscode.LanguageModelChatInformation },
	): Promise<string> {
		const runtime = running.runtime;
		const { entry, model } = prepared ?? this._subagentFor(runtime, request);
		const description = entry?.description ?? request.description;
		const owner = {
			id: entry ? this._subagentOwner(runtime.meta.id, entry.id) : `subagent:${callId}`,
			label: `Subagent: ${oneLine(description, SUBAGENT_LABEL_MAX_CHARS)}`,
		};
		let history: ChatMessage[] | undefined;
		if (entry) {
			entry.running = true;
			entry.task = oneLine(request.prompt, SUBAGENT_TASK_MAX_CHARS);
			entry.activity = undefined;
			entry.updatedAt = Date.now();
			this._emitSubagents(runtime);
		}
		const withId = (run: ChatSubagentRun): ChatSubagentRun => entry ? { ...run, subagentId: entry.id } : run;
		const files = new SubagentFiles();
		const executor = toolsFor(owner, model.id);
		const source = this._deps.tools;
		const wrapped: ChatToolExecutor = {
			get tools() { return executor.tools; },
			invoke: async (name, input, toolToken, toolCallId) => {
				// Terminal commands do not expose their written paths.
				if (!source.isReadOnly?.(name)) {
					await files.capture(source.writtenPaths?.(name, input) ?? []);
				}
				return executor.invoke(name, input, toolToken, toolCallId);
			},
		};
		const fileReport = () => files.report(vscode.workspace.workspaceFolders?.map(folder => folder.uri.fsPath) ?? []);
		try {
			const memory = await this._memoryContext(request.prompt, entry?.history ?? []);
			const result = await runChatSubagent({
				backend: this._deps.backend,
				model,
				request: { ...request, description },
				callId,
				conversationId: running.sessionId,
				tools: wrapped,
				token,
				system: await this._systemPrompt(),
				hostContext: this._turnContext(),
				...(memory ? { memory } : {}),
				...(entry ? { history: entry.history, invocationId: `chat-subagent-${runtime.meta.id}-${entry.id}` } : {}),
				cleaningBudget: this._deps.compaction?.cleaningBudget?.() ?? 0,
				onHistory: value => {
					history = value;
				},
				onUpdate: run => {
					this._emit(runtime, { type: "subagent", messageId: running.message.id, run: withId(run) });
					if (entry) {
						entry.activity = subagentActivity(run);
						this._emitSubagents(runtime);
					}
				},
				onFinish: run => {
					this._log("chat.subagent.finished", { model: model.id, status: run.status, steps: run.steps.length, durationMs: run.durationMs, open: entry !== undefined });
					this._addPart(running, { kind: "subagent", ...withId(run) });
				},
			});
			const report = result.report + await fileReport();
			if (!entry) {
				return report;
			}
			entry.report = report.slice(0, SUBAGENT_REPORT_MAX_CHARS);
			return `${report}\n\n[Subagent ${entry.id} is still open with its context. Send it a follow-up with subagent { subagentId: "${entry.id}", prompt }, or close it with close_subagent once its work is accepted.]`;
		} catch (error) {
			const report = await fileReport();
			if (error instanceof vscode.CancellationError || token.isCancellationRequested) {
				if (error instanceof Error) { error.message += report; }
				throw error;
			}
			const suffix = entry ? ` Subagent ${entry.id} is still open; send it a follow-up or close it with close_subagent.` : "";
			throw new Error(`${errorMessage(error)}${suffix}${report}`, { cause: error });
		} finally {
			if (entry) {
				entry.running = false;
				entry.activity = undefined;
				entry.updatedAt = Date.now();
				if (history) {
					entry.history = history;
				}
				await this._persistSubagents(runtime);
				this._emitSubagents(runtime);
			} else {
				// Its running commands (servers, builds) stay; idle and hung terminals go with the run.
				this._closeTerminals(owner.id);
			}
		}
	}

	/** The open subagent a request continues or opens, and the model it runs on; throws what the model should fix. */
	private _subagentFor(runtime: SessionRuntime, request: SubagentRequest): { entry?: OpenSubagent; model: vscode.LanguageModelChatInformation } {
		if (request.subagentId) {
			const entry = runtime.subagents.get(request.subagentId);
			if (!entry) {
				const open = [...runtime.subagents.keys()].join(", ");
				throw new Error(`No open subagent "${request.subagentId}". ${open ? `Open subagents: ${open}.` : "No subagent is open in this chat."}`);
			}
			if (entry.running) {
				throw new Error(`Subagent ${entry.id} is still working on a task; wait for its report.`);
			}
			// No run is started that the provider would only stop at its limit.
			const blocked = this._deps.subagentBlocked?.(entry.modelId);
			if (blocked) {
				throw new Error(`${subagentLimitMessage(blocked, this._deps.subagentModels?.() ?? [])} Subagent ${entry.id} stays open; send it the task again after the reset, or close it.`);
			}
			// Its history is ours, so it carries over to another subscription of the same model.
			const standIn = this._deps.subagentStandIn?.(entry.modelId);
			const moved = standIn ? this._models.find(candidate => candidate.id === standIn) : undefined;
			if (moved) {
				this._log("chat.subagent.moved", { from: entry.modelId, to: moved.id });
				entry.modelId = moved.id;
				entry.modelName = moved.name;
			}
			const model = this._models.find(candidate => candidate.id === entry.modelId);
			if (!model) {
				throw new Error(`${entry.modelName} is not available right now; close ${entry.id} and start a new subagent.`);
			}
			return { entry, model };
		}
		const wanted = request.model;
		const model = wanted ? this._models.find(candidate => candidate.id === wanted.id) : undefined;
		if (!model) {
			throw new Error(`${wanted?.label ?? "The subagent model"} is not available right now; choose another subagent model.`);
		}
		if (!request.keepOpen) {
			return { model };
		}
		if (runtime.subagents.size >= MAX_OPEN_SUBAGENTS) {
			const open = [...runtime.subagents.values()].map(entry => `${entry.id} (${entry.description})`).join(", ");
			throw new Error(`This chat already keeps ${MAX_OPEN_SUBAGENTS} subagents open: ${open}. Close one with close_subagent first.`);
		}
		let id: string;
		do {
			id = `sa-${randomUUID().slice(0, 4)}`;
		} while (runtime.subagents.has(id));
		const now = Date.now();
		const entry: OpenSubagent = { id, description: request.description, modelId: model.id, modelName: model.name, createdAt: now, updatedAt: now, task: "", history: [] };
		runtime.subagents.set(id, entry);
		this._log("chat.subagent.opened", { model: model.id });
		return { entry, model };
	}

	/** Terminal owner of an open subagent; chat ids keep the short subagent ids of different chats apart. */
	private _subagentOwner(sessionId: string, subagentId: string): string {
		return `subagent:${sessionId}/${subagentId}`;
	}

	/** Closes an open subagent of a chat: its context and idle terminals go. Throws when it cannot be closed. */
	private async _closeSubagent(runtime: SessionRuntime, subagentId: string): Promise<string> {
		const entry = runtime.subagents.get(subagentId);
		if (!entry) {
			throw new Error(`No open subagent "${subagentId}".`);
		}
		if (entry.running) {
			throw new Error(`Subagent ${subagentId} is still working; close it after its report.`);
		}
		runtime.subagents.delete(subagentId);
		this._closeTerminals(this._subagentOwner(runtime.meta.id, subagentId));
		await this._persistSubagents(runtime);
		this._emitSubagents(runtime);
		this._log("chat.subagent.closed", { tasks: entry.history.filter(message => message.role === "user").length });
		return `Closed subagent ${subagentId}.`;
	}

	private async _loadSubagents(sessionId: string): Promise<OpenSubagent[]> {
		try {
			return await this._deps.store.loadSubagents(sessionId);
		} catch (error) {
			this._log("chat.subagent.load_failed", { message: errorMessage(error) });
			return [];
		}
	}

	private async _persistSubagents(runtime: SessionRuntime): Promise<void> {
		const stored: StoredSubagent[] = [...runtime.subagents.values()].map(({ running: _running, activity: _activity, ...entry }) => ({ ...entry }));
		const save = async (): Promise<void> => {
			try {
				await this._deps.store.saveSubagents(runtime.meta.id, stored);
			} catch (error) {
				this._log("chat.subagent.persist_failed", { message: errorMessage(error) });
			}
		};
		runtime.subagentPersistence = (runtime.subagentPersistence ?? Promise.resolve()).then(save);
		await runtime.subagentPersistence;
	}

	private _subagentViews(runtime: SessionRuntime): ChatOpenSubagent[] {
		return [...runtime.subagents.values()].map(entry => ({
			id: entry.id,
			description: entry.description,
			modelName: entry.modelName,
			status: entry.running ? "running" : "idle",
			task: entry.task,
			...(entry.activity ? { activity: entry.activity } : {}),
			...(entry.report ? { report: oneLine(entry.report, SUBAGENT_ACTIVITY_MAX_CHARS) } : {}),
			updatedAt: entry.updatedAt,
		}));
	}

	private _emitSubagents(runtime: SessionRuntime): void {
		this._emit(runtime, { type: "subagents", sessionId: runtime.meta.id, subagents: this._subagentViews(runtime) });
	}

	private _now(): number {
		return this._deps.now?.() ?? Date.now();
	}

	private _setTimer(callback: () => void, ms: number): { dispose(): void } {
		if (this._deps.setTimer) {
			return this._deps.setTimer(callback, ms);
		}
		const handle = setTimeout(callback, ms);
		return { dispose: () => clearTimeout(handle) };
	}

	/** After a turn: a 5-hour limit schedules the continuation of its answer, any other ending clears it. */
	private async _updateAutoContinue(runtime: SessionRuntime, answer: ChatMessage): Promise<void> {
		const previous = runtime.autoAttempt;
		runtime.autoAttempt = undefined;
		const sessionId = runtime.meta.id;
		const last = answer.parts.at(-1);
		const resetAt = last?.kind === "notice" && last.limit?.kind === "limit" ? last.limit.resetAt : undefined;
		const now = this._now();
		if (resetAt === undefined) {
			this._clearAutoTimer(sessionId);
			if (runtime.meta.autoContinue) {
				await this._storeAutoContinue(sessionId, null);
			}
			return;
		}
		const attempts = previous === undefined ? 0 : Math.min(previous + 1, AUTO_CONTINUE_MAX_ATTEMPTS);
		// A reset within hours continues on its own; a weekly one days away waits until the user ticks the box.
		const soon = resetAt - now <= AUTO_CONTINUE_HORIZON_MS;
		const enabled = soon && attempts < AUTO_CONTINUE_MAX_ATTEMPTS;
		const entry = { messageId: answer.id, at: Math.max(resetAt, now) + AUTO_CONTINUE_DELAY_MS, enabled, attempts };
		await this._storeAutoContinue(sessionId, entry);
		if (enabled) {
			this._scheduleAutoContinue(sessionId, entry.at);
			this._log("chat.auto_continue.scheduled", { at: entry.at, attempts });
		} else {
			this._clearAutoTimer(sessionId);
			this._log("chat.auto_continue.cancelled", { reason: soon ? "attempts" : "far-reset", attempts, at: entry.at });
		}
	}

	private async _storeAutoContinue(sessionId: string, value: ChatSessionMeta["autoContinue"] | null): Promise<void> {
		const meta = await this._deps.store.updateMeta(sessionId, { autoContinue: value }).catch(error => {
			this._log("chat.auto_continue.persist_failed", { message: errorMessage(error) });
			return undefined;
		});
		const runtime = this._runtimes.get(sessionId);
		if (meta && runtime) {
			runtime.meta = meta;
			this._emit(runtime, { type: "session", session: meta });
		}
	}

	private _scheduleAutoContinue(sessionId: string, at: number): void {
		this._clearAutoTimer(sessionId);
		if (this._disposed) {
			return;
		}
		const delay = Math.min(MAX_TIMER_MS, Math.max(0, at - this._now()));
		this._autoTimers.set(sessionId, this._setTimer(() => {
			this._autoTimers.delete(sessionId);
			void this._fireAutoContinue(sessionId).catch(error => {
				this._log("chat.auto_continue.failed", { message: errorMessage(error) });
			});
		}, delay));
	}

	private _clearAutoTimer(sessionId: string): void {
		this._autoTimers.get(sessionId)?.dispose();
		this._autoTimers.delete(sessionId);
	}

	/** Continues the limited answer once its window reset, like Retry, also in a chat that is not shown. */
	private async _fireAutoContinue(sessionId: string): Promise<void> {
		if (this._disposed) {
			return;
		}
		const meta = await this._deps.store.get(sessionId);
		const entry = meta?.autoContinue;
		if (!meta || !entry?.enabled) {
			this._log("chat.auto_continue.skipped", { reason: "off" });
			return;
		}
		if (entry.at - this._now() > AUTO_CONTINUE_CATCH_UP_MS) {
			// The timer was clamped or fired early; wait for the rest.
			this._scheduleAutoContinue(sessionId, entry.at);
			return;
		}
		let runtime: SessionRuntime | undefined;
		// Serialized with chat switches, so opening this chat meanwhile cannot load it twice.
		await this._switchSession(async () => {
			runtime = await this._runtime(meta);
		});
		if (!runtime || this._disposed) {
			return;
		}
		const answer = runtime.messages.at(-1);
		if (runtime.busy || runtime.running || runtime.preparing || answer?.id !== entry.messageId) {
			this._log("chat.auto_continue.skipped", { reason: "chat-changed" });
			await this._storeAutoContinue(sessionId, null);
			return;
		}
		await this._ensureModels();
		// The chat's model, so a model the user picked for this chat meanwhile goes on with the task.
		const modelId = [runtime.meta.modelId, answer.modelId, this._selectedModelId]
			.find((id): id is string => id !== undefined && this._models.some(model => model.id === id));
		if (!modelId) {
			this._log("chat.auto_continue.skipped", { reason: "no-model" });
			return;
		}
		await this._storeAutoContinue(sessionId, null);
		this._log("chat.auto_continue.started", { model: modelId, attempts: entry.attempts, active: sessionId === this._activeId });
		runtime.autoAttempt = entry.attempts;
		try {
			await this._continueAnswer(runtime, entry.messageId, modelId);
		} finally {
			runtime.autoAttempt = undefined;
		}
	}

	/** The limit card's checkbox; switching it back on also resets the attempts. */
	private async _setAutoContinueEnabled(sessionId: string, messageId: string, enabled: boolean): Promise<void> {
		const entry = (await this._deps.store.get(sessionId))?.autoContinue;
		if (!entry || entry.messageId !== messageId || entry.enabled === enabled) {
			return;
		}
		if (!enabled) {
			this._clearAutoTimer(sessionId);
			await this._storeAutoContinue(sessionId, { ...entry, enabled: false });
			this._log("chat.auto_continue.cancelled", { reason: "unchecked" });
			return;
		}
		const next = { ...entry, enabled: true, attempts: 0, at: Math.max(entry.at, this._now() + AUTO_CONTINUE_CATCH_UP_MS) };
		await this._storeAutoContinue(sessionId, next);
		this._scheduleAutoContinue(sessionId, next.at);
		this._log("chat.auto_continue.scheduled", { at: next.at, attempts: 0 });
	}

	/** Schedules the continuations stored before a reload; ones due over a day ago are dropped. */
	private async _restoreAutoContinue(): Promise<void> {
		for (const meta of await this._deps.store.list()) {
			const entry = meta.autoContinue;
			if (this._disposed) {
				return;
			}
			if (!entry?.enabled || this._autoTimers.has(meta.id)) {
				continue;
			}
			const now = this._now();
			if (entry.at < now - AUTO_CONTINUE_STALE_MS) {
				await this._storeAutoContinue(meta.id, null);
				this._log("chat.auto_continue.cancelled", { reason: "stale" });
				continue;
			}
			this._scheduleAutoContinue(meta.id, Math.max(entry.at, now + AUTO_CONTINUE_CATCH_UP_MS));
			this._log("chat.auto_continue.scheduled", { at: entry.at, attempts: entry.attempts, restored: true });
		}
	}

	private _closeTerminals(owner: string): void {
		try {
			this._deps.terminals?.closeOwner(owner);
		} catch (error) {
			this._log("chat.terminals.close_failed", { owner, message: errorMessage(error) });
		}
	}

	/** The first user message names the chat; an edit may rename it. */
	private async _refreshSessionMeta(runtime: SessionRuntime): Promise<void> {
		const updated = await this._deps.store.get(runtime.meta.id).catch(() => undefined);
		if (!updated) {
			return;
		}
		runtime.meta = updated;
		this._emit(runtime, { type: "session", session: updated });
	}

	private _addPart(running: RunningTurn, part: ChatStructuredPart): void {
		this._flushDelta(running);
		running.message.parts.push(part);
		this._persistFinishedParts(running);
		this._emit(running.runtime, { type: "partAdded", messageId: running.message.id, part: viewPart(part, true) });
	}

	private _turnContext(): string | undefined {
		try {
			return this._deps.prompt?.turnContext();
		} catch (error) {
			this._log("chat.prompt.context_failed", { message: errorMessage(error) });
			return undefined;
		}
	}

	/** Retrieves memory the earlier messages do not show yet; a failure leaves the turn without memory. */
	private async _memoryContext(text: string, messages: readonly ChatMessage[]): Promise<ChatMemoryContext | undefined> {
		const memory = this._deps.memory;
		if (!memory) {
			return undefined;
		}
		const start = activeCompaction(messages)?.start ?? 0;
		const known = new Map<string, string>();
		for (const message of messages.slice(start)) {
			for (const revision of message.memoryRevisions ?? []) {
				known.set(revision.id, revision.revision);
			}
		}
		try {
			const context = await memory.context(text, known);
			if (context) {
				const entries = context.revisions.filter(revision => revision.id !== MEMORY_INDEX_ID).length;
				this._log("chat.memory.context", { entries, index: context.revisions.length > entries, chars: context.text.length });
			}
			return context;
		} catch (error) {
			this._log("chat.memory.context_failed", { message: errorMessage(error) });
			return undefined;
		}
	}

	private async _systemPrompt(options?: { subagents?: boolean }): Promise<string | undefined> {
		try {
			return await this._deps.prompt?.systemPrompt(options);
		} catch (error) {
			this._log("chat.prompt.system_failed", { message: errorMessage(error) });
			return undefined;
		}
	}

	/** What the turn's first request spends its tokens on, for Session Quality and the log; never fails the turn. */
	private _recordBreakdown(
		running: RunningTurn,
		model: vscode.LanguageModelChatInformation,
		history: readonly ChatMessage[],
		sent: readonly ChatMessage[],
		system: string | undefined,
		tools: readonly vscode.LanguageModelChatTool[],
		fixedTokens: number,
	): void {
		try {
			const event = chatRequestBreakdown(sent, system, tools, {
				conversationId: running.sessionId,
				modelId: model.id,
				imageInput: model.capabilities?.imageInput === true,
				// The last report covers the history before this turn's cleaning.
				scale: providerTokenScale(history, fixedTokens),
			});
			this._log("chat.request.breakdown", {
				model: model.id,
				total: event.total,
				...event.tokens,
				scale: event.scale,
				messages: event.messages,
				stubbedResults: event.stubbedResults,
				shortenedArguments: event.shortenedArguments,
			});
			this._deps.compaction?.onRequestBreakdown?.(event);
		} catch (error) {
			this._log("chat.request.breakdown_failed", { message: errorMessage(error) });
		}
	}

	/**
	 * A new request over the chat context budget first cleans the history: stale tool results become stubs, then
	 * older turns are summarized until the chat is at CONTEXT_CLEANING_TARGET_RATIO of the budget. The next request
	 * starts the provider's session again from the cleaned history, so the cache is rebuilt once per cleaning.
	 */
	private async _cleanContext(
		running: RunningTurn,
		model: vscode.LanguageModelChatInformation,
		history: readonly ChatMessage[],
		fixedTokens: number,
	): Promise<ChatPart[]> {
		const compaction = this._deps.compaction;
		const budget = compaction?.cleaningBudget?.() ?? 0;
		if (!compaction || budget <= 0) {
			return [];
		}
		// The first request after a cleaning replays the history into a new session, within the switch limit.
		const replayTokens = Math.floor(compaction.limits().triggerTokens * CONTEXT_CLEANING_REPLAY_RATIO);
		const plan = planContextCleaning(history, { budgetTokens: budget, fixedTokens, replayTokens });
		if (!plan) {
			return [];
		}
		const token = running.cts.token;
		const startedAt = Date.now();
		const scaled = (tokens: number): number => Math.round(tokens * plan.scale);
		let part: ChatCompactionPart | undefined;
		if (plan.tokensAfterStubs > plan.targetTokens) {
			const limits: ChatCompactionLimits = { triggerTokens: plan.targetTokens, targetTokens: plan.targetTokens, fixedTokens };
			const summaryPlan = planChatCompaction(plan.stubbed, limits);
			if (summaryPlan) {
				this._emit(running.runtime, { type: "run", run: { running: true, detail: CLEANING_DETAIL } });
				try {
					const summary = await compactChatHistory(plan.stubbed, {
						limits, summarize: compaction.summarize, token, plan: summaryPlan,
						writer: this._summaryWriters(model),
						transcriptPath: this._deps.store.logPath(running.sessionId),
						staleResults: plan.staleResults,
						staleArguments: plan.staleArguments,
					});
					if (summary) {
						const before = activeCompaction(history)?.part.summarizedMessages ?? 0;
						const fresh = new Set(plan.freshResults);
						const freshArguments = new Set(plan.freshArguments);
						const shortened = (summary.staleArguments ?? []).filter(callId => freshArguments.has(callId)).length;
						part = {
							...summary,
							tokensBefore: scaled(plan.tokensBefore),
							tokensAfter: scaled(summary.tokensAfter),
							// Results of the summarized messages reach the model as the summary, not as stubs.
							cleaning: {
								staleResults: (summary.staleResults ?? []).filter(callId => fresh.has(callId)).length,
								...(shortened > 0 ? { staleArguments: shortened } : {}),
								summary: true, summarizedMessages: Math.max(0, summary.summarizedMessages - before), budgetTokens: budget,
							},
						};
					}
				} catch (error) {
					if (error instanceof vscode.CancellationError || token.isCancellationRequested) {
						throw error instanceof vscode.CancellationError ? error : new vscode.CancellationError();
					}
					this._log("chat.cleaning.summary_failed", { message: errorMessage(error) });
				} finally {
					if (!token.isCancellationRequested) {
						this._emit(running.runtime, { type: "run", run: { running: true } });
					}
				}
			}
		}
		part ??= plan.newStale > 0 || plan.newStaleMemoryIndex > 0 || plan.freshArguments.length > 0 ? staleOnlyCompaction(history, plan) : undefined;
		if (!part || !cleaningPaysOff(part, budget)) {
			this._log("chat.cleaning.skipped", {
				reason: part ? "small_saving" : "nothing_to_clean",
				budget,
				tokensBefore: scaled(plan.tokensBefore),
				...(part ? { tokensAfter: part.tokensAfter } : {}),
				staleResults: plan.newStale,
				staleArguments: plan.freshArguments.length,
			});
			return [];
		}
		this._log("chat.cleaning.done", {
			model: model.id,
			budget,
			scale: Number(plan.scale.toFixed(3)),
			tokensBefore: part.tokensBefore,
			tokensAfter: part.tokensAfter,
			estimateBefore: plan.tokensBefore,
			estimateAfterStubs: plan.tokensAfterStubs,
			staleResults: part.cleaning?.staleResults ?? 0,
			stubbedTotal: part.staleResults?.length ?? 0,
			staleArguments: part.cleaning?.staleArguments ?? 0,
			shortenedTotal: part.staleArguments?.length ?? 0,
			staleMemoryIndex: part.staleMemoryIndex?.length ?? 0,
			summary: part.cleaning?.summary ?? false,
			summarizedMessages: part.cleaning?.summarizedMessages ?? 0,
			trimmedRounds: part.cleaning?.summary ? part.trimmedTurn?.rounds ?? 0 : 0,
			method: part.method,
			durationMs: Date.now() - startedAt,
			...(part.fallbackReason && part.cleaning?.summary ? { fallbackReason: part.fallbackReason } : {}),
		});
		try {
			compaction.onCleaned?.({
				conversationId: running.sessionId,
				modelId: model.id,
				budgetTokens: budget,
				tokensBefore: part.tokensBefore,
				tokensAfter: part.tokensAfter,
				staleResults: part.cleaning?.staleResults ?? 0,
				...(part.cleaning?.staleArguments ? { staleArguments: part.cleaning.staleArguments } : {}),
				summary: part.cleaning?.summary ?? false,
				summarizedMessages: part.cleaning?.summarizedMessages ?? 0,
				durationMs: Date.now() - startedAt,
				at: Date.now(),
			});
		} catch (error) {
			this._log("chat.cleaning.metrics_failed", { message: errorMessage(error) });
		}
		this._addPart(running, part);
		return [part];
	}

	/**
	 * When another model takes over a chat that is over the switch limit, older turns are summarized first,
	 * so the new model starts from a compact history instead of a cut one.
	 */
	private async _compactForModel(
		running: RunningTurn,
		model: vscode.LanguageModelChatInformation,
		history: readonly ChatMessage[],
		fixedTokens: number,
	): Promise<ChatPart[]> {
		const compaction = this._deps.compaction;
		const previous = previousModelId(history);
		if (!compaction || !previous || previous === model.id) {
			return [];
		}
		const limits: ChatCompactionLimits = { ...compaction.limits(), fixedTokens };
		const plan = planChatCompaction(history, limits);
		if (!plan) {
			return [];
		}
		const token = running.cts.token;
		if (token.isCancellationRequested) {
			throw new vscode.CancellationError();
		}
		this._emit(running.runtime, { type: "run", run: { running: true, detail: COMPACTING_DETAIL } });
		const startedAt = Date.now();
		try {
			const part = await compactChatHistory(history, {
				limits, summarize: compaction.summarize, token, plan,
				writer: this._summaryWriters(model),
				transcriptPath: this._deps.store.logPath(running.sessionId),
			});
			if (!part) {
				return [];
			}
			this._log("chat.compaction.done", {
				from: previous,
				to: model.id,
				method: part.method,
				summarizedMessages: part.summarizedMessages,
				trimmedRounds: part.trimmedTurn?.rounds ?? 0,
				abbreviated: Boolean(part.abbreviatedUntil),
				tokensBefore: part.tokensBefore,
				tokensAfter: part.tokensAfter,
				durationMs: Date.now() - startedAt,
				...(part.fallbackReason ? { fallbackReason: part.fallbackReason } : {}),
			});
			this._addPart(running, part);
			return [part];
		} catch (error) {
			if (error instanceof vscode.CancellationError || token.isCancellationRequested) {
				throw error instanceof vscode.CancellationError ? error : new vscode.CancellationError();
			}
			this._log("chat.compaction.failed", { message: errorMessage(error) });
			this._addPart(running, { kind: "notice", level: "warning", text: `Context compaction failed: ${errorMessage(error)}. The model receives the history without a summary.` });
			return [];
		} finally {
			if (!token.isCancellationRequested) {
				this._emit(running.runtime, { type: "run", run: { running: true } });
			}
		}
	}

	/** The writers of this chat's summary in order: a local llama.cpp model with room for the evidence, then the model taking the chat over. */
	private _summaryWriters(model: vscode.LanguageModelChatInformation): ChatSummaryWriter[] {
		const local = pickLocalSummaryModel(this._models, model.id);
		return [
			...(local ? [withSummaryTimeout(this._summaryWriter(local))] : []),
			this._summaryWriter(model),
		];
	}

	/** A model as a summary writer: it gets the compaction prompt, no tools and no history. */
	private _summaryWriter(model: vscode.LanguageModelChatInformation): ChatSummaryWriter {
		return {
			name: model.name,
			write: async (prompt, token) => {
				let text = "";
				await this._deps.backend.provideLanguageModelChatResponse(
					model,
					[systemMessage(prompt.system), vscode.LanguageModelChatMessage.User(prompt.transcript)],
					{ toolMode: vscode.LanguageModelChatToolMode.Auto, tools: [], modelOptions: { _aabSkipSharedMemory: true } },
					{ report: part => { if (part instanceof vscode.LanguageModelTextPart) { text += part.value; } } },
					token,
				);
				return text;
			},
		};
	}

	private _queueDelta(running: RunningTurn, kind: ChatTextKind, text: string): void {
		const buffer = running.buffer;
		if (buffer && buffer.kind === kind) {
			buffer.text += text;
		} else {
			this._flushDelta(running);
			running.buffer = { kind, text };
		}
		if (!running.timer) {
			running.timer = setTimeout(() => this._flushDelta(running), DELTA_FLUSH_MS);
		}
	}

	private _flushDelta(running: RunningTurn): void {
		if (running.timer) {
			clearTimeout(running.timer);
			running.timer = undefined;
		}
		const buffer = running.buffer;
		if (!buffer) {
			return;
		}
		running.buffer = undefined;
		this._emit(running.runtime, { type: "textDelta", messageId: running.message.id, kind: buffer.kind, text: buffer.text });
	}

	/** A trailing text part may still grow, so only everything up to the last structured part is final. */
	private _persistFinishedParts(running: RunningTurn): void {
		const end = running.message.parts.length;
		if (end <= running.persistedParts) {
			return;
		}
		const parts = running.message.parts.slice(running.persistedParts, end);
		running.persistedParts = end;
		for (const part of parts) {
			void this._persistPart(running, part);
		}
	}

	private async _persistPart(running: RunningTurn, part: ChatPart): Promise<void> {
		try {
			await this._deps.store.appendPart(running.sessionId, running.message.id, part);
		} catch (error) {
			this._log("chat.persist.part_failed", { message: errorMessage(error) });
		}
	}

	private async _persistEnd(running: RunningTurn): Promise<void> {
		try {
			await this._deps.store.endMessage(running.sessionId, running.message.id);
		} catch (error) {
			this._log("chat.persist.end_failed", { message: errorMessage(error) });
		}
	}

	private async _persistUsage(running: RunningTurn, usage: ChatUsage | undefined, totals: ChatUsageTotals, promptCache?: ChatPromptCache): Promise<void> {
		try {
			await this._deps.store.setUsage(running.sessionId, running.message.id, usage, totals, promptCache);
		} catch (error) {
			this._log("chat.persist.usage_failed", { message: errorMessage(error) });
		}
	}

	private async _appendMessage(runtime: SessionRuntime, message: ChatMessage): Promise<void> {
		try {
			await this._deps.store.appendMessage(runtime.meta.id, message);
		} catch (error) {
			this._log("chat.persist.message_failed", { message: errorMessage(error) });
		}
		runtime.messages.push(message);
		this._emit(runtime, { type: "messageAdded", message: viewMessage(message) });
	}

	private _stop(): void {
		const runtime = this._active();
		if (!runtime) {
			return;
		}
		runtime.preparing?.cancel();
		const running = runtime.running;
		if (running) {
			if (running.timer) {
				clearTimeout(running.timer);
				running.timer = undefined;
			}
			running.cts.cancel();
		}
		if (running || runtime.preparing) {
			this._emit(runtime, { type: "run", run: this._runState(runtime) });
		}
		if (runtime.queued.length > 0) {
			const taken = runtime.queued;
			runtime.queued = [];
			this._emit(runtime, { type: "queued", queued: [] });
			this._emit(runtime, {
				type: "restoreDraft",
				text: taken.map(message => message.text).join("\n\n"),
				attachments: mergeQueuedAttachments(taken) ?? [],
			});
		}
	}

	private _osNotify(runtime: SessionRuntime, body: string): void {
		try {
			this._deps.osNotify?.(runtime.meta.title, body, runtime.meta.id);
		} catch (error) {
			this._log("chat.os_notification.failed", { message: errorMessage(error) });
		}
	}

	/** Shows an approval card in the chat's webviews; Stop or a closed controller counts as a denial. */
	private _requestApproval(
		running: RunningTurn,
		toolName: string,
		callId: string | undefined,
		confirmation: ChatToolConfirmation,
		token: vscode.CancellationToken,
	): Promise<boolean> {
		if (token.isCancellationRequested || this._disposed) {
			return Promise.resolve(false);
		}
		if (isAlwaysAllowed(confirmation.kinds, this._alwaysAllowedKeys())) {
			this._log("chat.tool.approval", { tool: toolName, allowed: true, always: true });
			return Promise.resolve(true);
		}
		this._flushDelta(running);
		const runtime = running.runtime;
		const request: ChatApprovalRequest = {
			id: randomUUID(),
			messageId: running.message.id,
			callId: callId ?? "",
			toolName,
			title: confirmation.title,
			detail: confirmation.detail,
			reason: confirmation.reason,
			...(confirmation.kinds && confirmation.kinds.length > 0 ? { kinds: confirmation.kinds.map(kind => ({ ...kind })) } : {}),
		};
		return new Promise<boolean>(resolve => {
			const subscriptions: vscode.Disposable[] = [];
			const settle = (allowed: boolean): void => {
				if (!runtime.approvals.delete(request.id)) {
					return;
				}
				subscriptions.forEach(subscription => subscription.dispose());
				this._log("chat.tool.approval", { tool: toolName, allowed });
				this._emit(runtime, { type: "approvalResolved", id: request.id, allowed });
				this._broadcastActivity();
				resolve(allowed);
			};
			runtime.approvals.set(request.id, { request, settle });
			subscriptions.push(token.onCancellationRequested(() => settle(false)));
			this._emit(runtime, { type: "approval", request });
			this._osNotify(runtime, `Waiting for your approval: ${confirmation.title}`);
			this._broadcastActivity();
			if (runtime.meta.id !== this._activeId) {
				const notice = this._deps.notify?.(`"${runtime.meta.title}" is waiting for your approval.`, "Open Chat");
				if (notice) {
					void notice.then(open => {
						if (open) {
							void this.openSession(runtime.meta.id);
						}
					}, () => undefined);
				}
			}
		});
	}

	/** Shows question cards in the chat's webviews; Stop or a closed controller counts as a skip. */
	private _askQuestions(
		running: RunningTurn,
		callId: string | undefined,
		questions: ChatQuestion[],
		token: vscode.CancellationToken,
		options?: { title?: string; submitLabel?: string; skipLabel?: string },
	): Promise<ChatQuestionAnswer[] | undefined> {
		if (token.isCancellationRequested || this._disposed) {
			return Promise.resolve(undefined);
		}
		this._flushDelta(running);
		const runtime = running.runtime;
		const request: ChatQuestionRequest = {
			id: randomUUID(),
			messageId: running.message.id,
			callId: callId ?? "",
			questions,
			...(options?.title === undefined ? {} : { title: options.title }),
			...(options?.submitLabel === undefined ? {} : { submitLabel: options.submitLabel }),
			...(options?.skipLabel === undefined ? {} : { skipLabel: options.skipLabel }),
		};
		return new Promise<ChatQuestionAnswer[] | undefined>(resolve => {
			const subscriptions: vscode.Disposable[] = [];
			const settle = (answers: ChatQuestionAnswer[] | undefined): void => {
				if (!runtime.questions.delete(request.id)) {
					return;
				}
				subscriptions.forEach(subscription => subscription.dispose());
				this._log("chat.tool.questions", { count: request.questions.length, answered: answers !== undefined });
				this._emit(runtime, { type: "questionsResolved", id: request.id });
				this._broadcastActivity();
				resolve(answers);
			};
			runtime.questions.set(request.id, { request, settle });
			subscriptions.push(token.onCancellationRequested(() => settle(undefined)));
			this._emit(runtime, { type: "questions", request });
			const question = questions[0]?.question.slice(0, 120);
			this._osNotify(runtime, "The agent has a question for you." + (question ? `\n${question}` : ""));
			this._broadcastActivity();
			if (runtime.meta.id !== this._activeId) {
				const notice = this._deps.notify?.(`"${runtime.meta.title}" has a question for you.`, "Open Chat");
				if (notice) {
					void notice.then(open => {
						if (open) {
							void this.openSession(runtime.meta.id);
						}
					}, () => undefined);
				}
			}
		});
	}

	private _toolGroups(): ChatToolGroup[] {
		return this._deps.tools.groups?.() ?? [];
	}

	/** Asks the user to enable tools the agent requested; only candidates reach the card. */
	private async _requestTools(
		running: RunningTurn,
		callId: string | undefined,
		names: readonly string[],
		reason: string,
		token: vscode.CancellationToken,
	): Promise<ChatToolRequestResult> {
		const availableFrom = toolsArriveMidTurn(modelProvider(running.model)) ? "nextRequest" : "nextMessage";
		const known = new Map<string, { label: string; note?: string; description: string; enabled: boolean }>();
		for (const group of this._toolGroups()) {
			for (const tool of group.tools) {
				if (!known.has(tool.name)) {
					known.set(tool.name, {
						label: group.label,
						...(group.note === undefined ? {} : { note: group.note }),
						description: tool.description,
						enabled: tool.enabled,
					});
				}
			}
		}
		const unknown: string[] = [];
		const alreadyEnabled: string[] = [];
		const candidates: string[] = [];
		for (const name of new Set(names)) {
			const tool = known.get(name);
			if (!tool) {
				unknown.push(name);
			} else if (tool.enabled) {
				alreadyEnabled.push(name);
			} else {
				candidates.push(name);
			}
		}
		if (candidates.length === 0) {
			return { enabled: [], declined: [], alreadyEnabled, unknown, dismissed: false, availableFrom };
		}
		const notes = [...new Set(candidates.flatMap(name => known.get(name)?.note === undefined ? [] : [known.get(name)!.note!]))];
		const count = candidates.length;
		const answers = await this._askQuestions(running, callId, [{
			header: "Tools",
			question: `Enable ${count} tool${count === 1 ? "" : "s"} for this chat?`,
			message: [`Reason: ${reason}`, notes.join(" ")].filter(line => line.length > 0).join("\n"),
			options: candidates.map(name => {
				const tool = known.get(name)!;
				return { label: name, description: `${tool.label}: ${shortToolDescription(tool.description)}`, checked: true };
			}),
			multiSelect: true,
			allowFreeformInput: false,
		}], token, { title: "The agent asks to enable tools", submitLabel: "Enable", skipLabel: "Deny" });
		if (answers === undefined) {
			return { enabled: [], declined: candidates, alreadyEnabled, unknown, dismissed: true, availableFrom };
		}
		const selected = answers.find(answer => answer.header === "Tools")?.selected ?? [];
		const chosen = selected.filter((name, index) => candidates.includes(name) && selected.indexOf(name) === index);
		let enabled = chosen;
		if (chosen.length > 0) {
			try {
				await this._deps.tools.setEnabled?.(chosen, true);
			} catch (error) {
				this._log("chat.tools.enable_failed", { message: errorMessage(error) });
				enabled = [];
			}
		}
		this._broadcast({ type: "tools", tools: this._toolGroups() });
		this._log("chat.tool.request_tools", { requested: names.length, enabled: enabled.length });
		return { enabled, declined: candidates.filter(name => !chosen.includes(name)), alreadyEnabled, unknown, dismissed: false, availableFrom };
	}

	private async _selectModel(modelId: string): Promise<void> {
		await this._ensureModels();
		if (!this._models.some(model => model.id === modelId)) {
			return;
		}
		await this._ensureSession();
		const runtime = this._active();
		if (!runtime) {
			return;
		}
		try {
			const updated = await this._deps.store.updateMeta(runtime.meta.id, { modelId });
			if (updated) {
				runtime.meta = updated;
			}
		} catch (error) {
			this._log("chat.persist.model_failed", { message: errorMessage(error) });
		}
		await this._deps.state.update(LAST_MODEL_KEY, modelId);
		this._refreshSelection();
		this._broadcastModels();
		void this._refreshQuota();
	}

	/** Starred models, oldest first; a model that is gone for now (signed out, offline) keeps its star. */
	private _favoriteModels(): string[] {
		const stored = (this._deps.globalState ?? this._deps.state).get<unknown>(FAVORITE_MODELS_KEY);
		return Array.isArray(stored) ? stored.filter((id): id is string => typeof id === "string").slice(-FAVORITE_MODELS_LIMIT) : [];
	}

	private async _setFavoriteModel(modelId: string, favorite: boolean): Promise<void> {
		const current = this._favoriteModels();
		if (current.includes(modelId) === favorite) {
			return;
		}
		const next = favorite ? [...current, modelId].slice(-FAVORITE_MODELS_LIMIT) : current.filter(id => id !== modelId);
		try {
			await (this._deps.globalState ?? this._deps.state).update(FAVORITE_MODELS_KEY, next);
		} catch (error) {
			this._log("chat.favorites.save_failed", { message: errorMessage(error) });
		}
		this._broadcastModels();
	}

	/** The remembered level when the model still offers it; otherwise the provider's default applies. */
	private _thinkingFor(modelId: string | undefined): string | undefined {
		const model = modelId === undefined ? undefined : this._models.find(candidate => candidate.id === modelId);
		const stored = model ? this._deps.state.get<Record<string, unknown>>(THINKING_KEY)?.[model.id] : undefined;
		return typeof stored === "string" && thinkingOptions(model!)?.levels.some(level => level.value === stored) ? stored : undefined;
	}

	private async _selectThinking(value: string): Promise<void> {
		await this._ensureModels();
		const model = this._models.find(candidate => candidate.id === this._selectedModelId);
		if (!model || !thinkingOptions(model)?.levels.some(level => level.value === value)) {
			return;
		}
		const stored = this._deps.state.get<Record<string, unknown>>(THINKING_KEY);
		await this._deps.state.update(THINKING_KEY, { ...(typeof stored === "object" && stored !== null ? stored : {}), [model.id]: value });
		this._broadcastModels();
	}

	private _quota(): ChatProviderQuota[] {
		try {
			return this._deps.quota?.snapshot() ?? [];
		} catch (error) {
			this._log("chat.quota.snapshot_failed", { message: errorMessage(error) });
			return [];
		}
	}

	private _scheduleQuotaBroadcast(): void {
		if (this._disposed || this._quotaTimer) {
			return;
		}
		this._quotaTimer = setTimeout(() => {
			this._quotaTimer = undefined;
			this._broadcastQuota(false);
		}, QUOTA_COALESCE_MS);
	}

	private _broadcastQuota(force: boolean): void {
		const quota = this._quota();
		const serialized = JSON.stringify(quota);
		if (!force && serialized === this._lastQuota) {
			return;
		}
		this._lastQuota = serialized;
		this._broadcast({ type: "quota", quota });
	}

	/** Opening the quota popup asks the providers again, at most every QUOTA_REFRESH_INTERVAL_MS. */
	private async _refreshQuota(): Promise<void> {
		const source = this._deps.quota;
		if (source?.refresh && Date.now() - this._quotaRefreshedAt >= QUOTA_REFRESH_INTERVAL_MS) {
			this._quotaRefreshedAt = Date.now();
			try {
				await source.refresh();
			} catch (error) {
				this._log("chat.quota.refresh_failed", { message: errorMessage(error) });
			}
		}
		this._broadcastQuota(true);
	}

	private async _saveMemory(entry: ChatMemorySaveInput): Promise<void> {
		const store = this._deps.memoryStore;
		if (!store) {
			this._broadcast(this._memoryMessage("Shared memory is not available."));
			return;
		}
		try {
			await store.save(entry);
		} catch (error) {
			this._log("chat.memory.save_failed", { message: errorMessage(error) });
			this._broadcast(this._memoryMessage(errorMessage(error)));
			return;
		}
		this._broadcastMemory();
	}

	private async _deleteMemory(id: string): Promise<void> {
		const store = this._deps.memoryStore;
		if (!store) {
			this._broadcast(this._memoryMessage("Shared memory is not available."));
			return;
		}
		let removed: boolean;
		try {
			removed = await store.remove(id);
		} catch (error) {
			this._log("chat.memory.delete_failed", { message: errorMessage(error) });
			this._broadcast(this._memoryMessage(errorMessage(error)));
			return;
		}
		if (!removed) {
			this._broadcast(this._memoryMessage("This entry is not visible in this project."));
			return;
		}
		this._broadcastMemory();
	}

	private _scheduleMemoryBroadcast(): void {
		if (this._disposed || this._memoryTimer) {
			return;
		}
		this._memoryTimer = setTimeout(() => {
			this._memoryTimer = undefined;
			this._broadcastMemory();
		}, MEMORY_COALESCE_MS);
	}

	private _broadcastMemory(): void {
		this._broadcast(this._memoryMessage());
	}

	private _memoryMessage(notice?: string): HostMessage {
		const store = this._deps.memoryStore;
		let entries: ChatMemoryEntry[] = [];
		let failure = notice;
		if (store) {
			try {
				entries = store.list();
			} catch (error) {
				failure = errorMessage(error);
			}
		}
		const projectLabel = store?.projectLabel();
		return {
			type: "memory",
			enabled: store?.enabled() ?? false,
			...(projectLabel === undefined ? {} : { projectLabel }),
			entries,
			...(failure === undefined ? {} : { notice: failure }),
		};
	}

	private _sendFullToolResult(webview: vscode.Webview, messageId: string, callId: string): void {
		const message = this._active()?.messages.find(candidate => candidate.id === messageId);
		const part = message?.parts.find(candidate => candidate.kind === "toolResult" && candidate.callId === callId);
		if (part?.kind === "toolResult") {
			this._post(webview, { type: "toolResultFull", messageId, callId, text: part.text });
		}
	}

	private _sendFullPartText(webview: vscode.Webview, messageId: string, index: number): void {
		const part = this._active()?.messages.find(candidate => candidate.id === messageId)?.parts[index];
		if (part?.kind === "thinking") {
			this._post(webview, { type: "partTextFull", messageId, index, text: part.text });
		}
	}

	private async _ensureModels(): Promise<void> {
		if (this._modelsLoaded) {
			return;
		}
		try {
			this._models = await this._fetchModels();
			this._modelsLoaded = true;
			this._refreshSelection();
		} catch (error) {
			this._log("chat.models.load_failed", { message: errorMessage(error) });
		}
	}

	private async _onModelsChanged(): Promise<void> {
		try {
			this._models = await this._fetchModels();
			this._modelsLoaded = true;
			this._refreshSelection();
			this._broadcastModels();
		} catch (error) {
			this._log("chat.models.refresh_failed", { message: errorMessage(error) });
		}
	}

	private async _fetchModels(): Promise<vscode.LanguageModelChatInformation[]> {
		const source = new vscode.CancellationTokenSource();
		try {
			return (await this._deps.backend.provideLanguageModelChatInformation({ silent: true }, source.token)) ?? [];
		} finally {
			source.dispose();
		}
	}

	private _refreshSelection(): void {
		const available = new Set(this._models.map(model => model.id));
		const remembered = this._deps.state.get<string>(LAST_MODEL_KEY);
		const candidates = [this._active()?.meta.modelId, remembered];
		const selected = candidates.find((id): id is string => typeof id === "string" && available.has(id)) ?? defaultModelId(this._models);
		this._selectedModelId = selected;
	}

	private async _ensureSession(): Promise<void> {
		if (this._sessionLoaded) {
			return;
		}
		if (!this._sessionTask) {
			this._sessionTask = this._openActiveSession().catch(error => {
				this._sessionTask = undefined;
				throw error;
			});
		}
		await this._sessionTask;
	}

	private async _openActiveSession(): Promise<void> {
		const stored = this._deps.state.get<string>(ACTIVE_SESSION_KEY);
		let meta: ChatSessionMeta | undefined;
		if (typeof stored === "string") {
			try {
				meta = await this._deps.store.get(stored);
			} catch (error) {
				this._log("chat.session.restore_failed", { message: errorMessage(error) });
			}
		}
		await this._activate(await this._runtime(meta ?? await this._deps.store.create(this._selectedModelId)));
	}

	private async _runtime(meta: ChatSessionMeta): Promise<SessionRuntime> {
		const existing = this._runtimes.get(meta.id);
		if (existing) {
			existing.meta = meta;
			return existing;
		}
		const loaded = await this._deps.store.loadSession(meta.id, { maxRequests: this._deps.maxRequests ?? CHAT_MAX_REQUESTS });
		if (loaded.messages.length < meta.messageCount) {
			this._log("chat.session.trimmed", { removed: meta.messageCount - loaded.messages.length });
			meta = await this._deps.store.get(meta.id) ?? meta;
		}
		await this._markInterrupted(meta.id, loaded.messages, loaded.interruptedMessageId);
		try {
			await this._deps.changes?.recoverInterrupted?.(meta.id);
		} catch (error) {
			this._log("chat.changes.recover_failed", { message: errorMessage(error) });
		}
		const runtime: SessionRuntime = {
			meta,
			messages: loaded.messages,
			changes: await this._loadChanges(meta.id),
			running: undefined,
			preparing: undefined,
			busy: false,
			completion: Promise.resolve(),
			approvals: new Map(),
			questions: new Map(),
			finished: false,
			queued: [],
			subagents: new Map((await this._loadSubagents(meta.id)).map(entry => [entry.id, entry])),
		};
		this._runtimes.set(meta.id, runtime);
		return runtime;
	}

	/** Adds the warning once: the end marker that follows keeps the next load from flagging it again. */
	private async _markInterrupted(sessionId: string, messages: ChatMessage[], messageId: string | undefined): Promise<void> {
		const message = messageId === undefined ? undefined : messages.find(candidate => candidate.id === messageId);
		if (!message) {
			return;
		}
		const notice: ChatStructuredPart = { kind: "notice", level: "warning", text: INTERRUPTED_NOTICE, retryable: true };
		message.parts.push(notice);
		try {
			await this._deps.store.appendPart(sessionId, message.id, notice);
			await this._deps.store.endMessage(sessionId, message.id);
		} catch (error) {
			this._log("chat.persist.interrupted_failed", { message: errorMessage(error) });
		}
	}

	private async _activate(runtime: SessionRuntime): Promise<void> {
		this._activeId = runtime.meta.id;
		runtime.finished = false;
		this._sessionLoaded = true;
		this._sessionTask = undefined;
		await this._deps.state.update(ACTIVE_SESSION_KEY, runtime.meta.id);
		this._refreshSelection();
	}

	private _initMessage(): HostMessage {
		const runtime = this._active();
		if (!runtime) {
			throw new Error("The chat session is not loaded.");
		}
		const draft = this._draft(runtime.meta.id);
		const contextSettings = this._contextSettings();
		return {
			type: "init",
			session: { ...runtime.meta },
			messages: runtime.messages.map(message => viewMessage(message, runtime.running?.message === message)),
			models: groupModels(this._models),
			selectedModelId: this._selectedModelId,
			run: this._runState(),
			tools: this._toolGroups(),
			approvals: [...runtime.approvals.values()].map(approval => approval.request),
			questions: [...runtime.questions.values()].map(question => question.request),
			changes: runtime.changes,
			selectedThinking: this._thinkingFor(this._selectedModelId),
			quota: this._quota(),
			activity: this._activity(),
			queued: [...runtime.queued],
			...(draft ? { draft } : {}),
			signIn: this._signInOffers(),
			...(contextSettings ? { contextSettings } : {}),
			favoriteModels: this._favoriteModels(),
			subagents: this._subagentViews(runtime),
			alwaysAllowed: this._alwaysAllowedKinds(),
		};
	}

	private _alwaysAllowedKeys(): ReadonlySet<string> {
		try {
			return new Set(this._deps.alwaysAllow?.keys() ?? []);
		} catch (error) {
			this._log("chat.always_allow.read_failed", { message: errorMessage(error) });
			return new Set();
		}
	}

	private _alwaysAllowedKinds(): ChatApprovalKind[] {
		return [...this._alwaysAllowedKeys()].map(key => ({ key, label: approvalKindLabel(key) }));
	}

	/** Updates the Tools list and lets through every waiting call whose kinds are now all allowed, in every chat. */
	private _onAlwaysAllowChanged(): void {
		if (this._disposed) {
			return;
		}
		const allowed = this._alwaysAllowedKeys();
		for (const runtime of this._runtimes.values()) {
			for (const approval of [...runtime.approvals.values()]) {
				if (isAlwaysAllowed(approval.request.kinds, allowed)) {
					approval.settle(true);
				}
			}
		}
		this._broadcast({ type: "alwaysAllowed", kinds: this._alwaysAllowedKinds() });
	}

	private _contextSettings(): ChatContextSettings | undefined {
		try {
			return this._deps.contextSettings?.get();
		} catch (error) {
			this._log("chat.context_settings.read_failed", { message: errorMessage(error) });
			return undefined;
		}
	}

	private _broadcastContextSettings(): void {
		const settings = this._contextSettings();
		if (settings) {
			this._broadcast({ type: "contextSettings", settings });
		}
	}

	private _signInOffers(): ChatSignInOffer[] {
		try {
			return this._deps.accounts?.offers() ?? [];
		} catch (error) {
			this._log("chat.accounts.offers_failed", { message: errorMessage(error) });
			return [];
		}
	}

	private _broadcastModels(): void {
		this._broadcast({
			type: "models",
			models: groupModels(this._models),
			selectedModelId: this._selectedModelId,
			selectedThinking: this._thinkingFor(this._selectedModelId),
			signIn: this._signInOffers(),
			favoriteModels: this._favoriteModels(),
		});
	}

	private _runState(runtime = this._active()): ChatRunState {
		const token = (runtime?.running?.cts ?? runtime?.preparing)?.token;
		return token?.isCancellationRequested
			? { running: true, stopping: true, detail: STOPPING_DETAIL }
			: { running: token !== undefined };
	}

	private _active(): SessionRuntime | undefined {
		return this._activeId === undefined ? undefined : this._runtimes.get(this._activeId);
	}

	/** Session updates reach the webviews only while the update's chat is the shown one. */
	private _emit(runtime: SessionRuntime, message: HostMessage): void {
		if (runtime.meta.id === this._activeId) {
			this._broadcast(message);
		}
	}

	private _activity(): ChatSessionActivity[] {
		const activity: ChatSessionActivity[] = [];
		for (const runtime of this._runtimes.values()) {
			if (runtime.meta.id === this._activeId) {
				continue;
			}
			const state: ChatSessionActivityState | undefined = runtime.approvals.size > 0 || runtime.questions.size > 0 ? "approval" : runtime.running || runtime.preparing ? "running" : runtime.finished ? "finished" : undefined;
			if (state) {
				activity.push({ id: runtime.meta.id, title: runtime.meta.title, state });
			}
		}
		return activity;
	}

	private _broadcastActivity(): void {
		const activity = this._activity();
		const serialized = JSON.stringify(activity);
		if (serialized === this._lastActivity) {
			return;
		}
		this._lastActivity = serialized;
		this._broadcast({ type: "activity", activity });
	}

	private _broadcast(message: HostMessage): void {
		for (const webview of this._attachments.keys()) {
			this._post(webview, message);
		}
	}

	private _post(webview: vscode.Webview, message: HostMessage): void {
		try {
			void webview.postMessage(message).then(undefined, () => undefined);
		} catch {
			// The webview was disposed between the check and the post.
		}
	}

	private _log(event: string, data: Record<string, unknown>): void {
		this._deps.log?.(event, data);
	}
}
