import { randomUUID } from "node:crypto";
import * as vscode from "vscode";
import { ToolCallValidationError } from "../tools/tool-call-reliability";
import { runAgentTurn, type AgentTurnSink, type ChatToolExecutor } from "./agent-loop";
import { renderAttachments, type AttachmentContent } from "./attachments";
import type { ChatWebviewBridge } from "./chat-view";
import { compactChatHistory, estimateTextTokens, planChatCompaction, previousModelId, type ChatCompactionLimits, type ChatSummarizer } from "./compaction";
import { activeCompaction } from "./lm-messages";
import { MEMORY_INDEX_ID, type ChatMemoryContext, type ChatMemorySource } from "./memory-context";
import type { ChatMemoryStore } from "./memory-store";
import type { ChatSessionStore } from "./session-store";
import { runChatSubagent } from "./subagent-runner";
import { ASK_QUESTIONS_TOOL_NAME, TODO_TOOL_NAME } from "./tools/interaction-tools";
import { SUBAGENT_TOOL_NAME } from "./tools/subagent-tool";
import { groupModels, thinkingOptions } from "./shared/model-groups";
import {
	appendChatText,
	CHAT_MEMORY_CONTENT_MAX_CHARS,
	CHAT_MEMORY_TITLE_MAX_CHARS,
	WEBVIEW_THINKING_PREVIEW_CHARS,
	WEBVIEW_TOOL_RESULT_PREVIEW_CHARS,
} from "./shared/protocol";
import type {
	ChatApprovalRequest,
	ChatAttachment,
	ChatChangeSet,
	ChatMemoryEntry,
	ChatMemorySaveInput,
	ChatMessage,
	ChatPart,
	ChatProviderQuota,
	ChatQueuedMessage,
	ChatQuestion,
	ChatQuestionAnswer,
	ChatQuestionRequest,
	ChatRunState,
	ChatSessionActivity,
	ChatSessionActivityState,
	ChatSessionMeta,
	ChatStructuredPart,
	ChatTextKind,
	ChatToolGroup,
	ChatUsage,
	ChatUsageTotals,
	HostMessage,
	WebviewMessage,
} from "./shared/protocol";
import type { ChatChangeTrackerLike, TurnSnapshot } from "./changes/change-tracker";
import type { ChatToolSource } from "./tool-executor";
import type { ChatToolConfirmation, SubagentRequest } from "./tools/types";

export interface ChatControllerDeps {
	backend: Pick<vscode.LanguageModelChatProvider, "provideLanguageModelChatResponse" | "provideLanguageModelChatInformation">;
	onDidChangeModels: vscode.Event<void>;
	store: ChatSessionStore;
	tools: ChatToolSource;
	state: vscode.Memento;
	log?: (event: string, data: Record<string, unknown>) => void;
	/** Records the files each turn changed; without it the chat has no Keep/Undo. */
	changes?: ChatChangeTrackerLike;
	openChange?: (sessionId: string, id: string) => Promise<void>;
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
	/** Subscription limits and balances shown next to the model picker. */
	quota?: ChatQuotaSource;
	/** Editor selections and files the user attaches to a message. */
	attachments?: ChatAttachmentsDeps;
	/** Shared durable memory shown to the model in <memory> blocks before user requests. */
	memory?: ChatMemorySource;
	/** The shared memory list the panel reads and edits. */
	memoryStore?: ChatMemoryStore;
}

export interface ChatAttachmentsDeps {
	pick(): Promise<ChatAttachment[]>;
	fromUris(uris: readonly string[]): Promise<ChatAttachment[]>;
	read(attachments: readonly ChatAttachment[]): Promise<AttachmentContent[]>;
	open(attachment: ChatAttachment): Promise<void>;
}

export interface ChatQuotaSource {
	snapshot(): ChatProviderQuota[];
	/** Asks the providers for fresh numbers. */
	refresh?(): Promise<void>;
	onDidChange?: vscode.Event<void>;
}

export interface ChatPromptProvider {
	systemPrompt(): Promise<string>;
	turnContext(): string;
}

export interface ChatCompactionDeps {
	summarize: ChatSummarizer;
	limits(): Omit<ChatCompactionLimits, "fixedTokens">;
}

const ACTIVE_SESSION_KEY = "llamacpp.chat.activeSession";
const LAST_MODEL_KEY = "llamacpp.chat.lastModel";
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
const SEND_ATTACHMENT_LIMIT = 20;
const ADD_ATTACHMENT_LIMIT = 50;
const MAX_QUESTION_ANSWERS = 5;
const MAX_QUESTION_SELECTED = 10;
const MAX_ANSWER_CHARS = 2_000;

interface DeltaBuffer {
	kind: ChatTextKind;
	text: string;
}

interface RunningTurn {
	runtime: SessionRuntime;
	sessionId: string;
	message: ChatMessage;
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
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
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
		case "removeQueued": return typeof value.id === "string" ? { type: "removeQueued", id: value.id } : undefined;
		case "pickAttachments": return { type: "pickAttachments" };
		case "addAttachments":
			return Array.isArray(value.uris) && value.uris.length <= ADD_ATTACHMENT_LIMIT && value.uris.every(uri => typeof uri === "string")
				? { type: "addAttachments", uris: value.uris as string[] }
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
		case "selectThinking": return typeof value.value === "string" ? { type: "selectThinking", value: value.value } : undefined;
		case "refreshQuota": return { type: "refreshQuota" };
		case "setToolsEnabled":
			return Array.isArray(value.names) && value.names.every(name => typeof name === "string") && typeof value.enabled === "boolean"
				? { type: "setToolsEnabled", names: value.names as string[], enabled: value.enabled }
				: undefined;
		case "approve":
			return typeof value.id === "string" && typeof value.allow === "boolean" ? { type: "approve", id: value.id, allow: value.allow } : undefined;
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
		case "listSessions": return { type: "listSessions" };
		case "openSession":
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
	private _memoryTimer: ReturnType<typeof setTimeout> | undefined;
	private _lastQuota: string | undefined;
	private _lastActivity: string | undefined;

	constructor(deps: ChatControllerDeps) {
		this._deps = deps;
		this._modelChangeSubscription = deps.onDidChangeModels(() => { void this._onModelsChanged(); });
		this._quotaSubscription = deps.quota?.onDidChange?.(() => this._scheduleQuotaBroadcast());
		this._memorySubscription = deps.memoryStore?.onDidChange?.(() => this._scheduleMemoryBroadcast());
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
		const sessions = listed.filter(meta => meta.messageCount > 0 || meta.id === this._activeId);
		return { type: "sessions", sessions, activeId: this._activeId ?? "" };
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
			if (meta && meta.messageCount === 0) {
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
		for (const runtime of this._runtimes.values()) {
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
					this._post(webview, { type: "attachmentsAdded", attachments: picked });
				}
				return;
			}
			case "addAttachments": {
				const added = await this._deps.attachments?.fromUris(message.uris) ?? [];
				if (added.length) {
					this._post(webview, { type: "attachmentsAdded", attachments: added });
				}
				return;
			}
			case "openAttachment":
				await this._deps.attachments?.open(message.attachment);
				return;
			case "editMessage":
				await this._edit(message.messageId, message.text, message.undoChanges === true, message.attachments);
				return;
			case "retryTurn":
				await this._retryTurn(message.messageId);
				return;
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
			case "selectThinking":
				await this._selectThinking(message.value);
				return;
			case "refreshQuota":
				await this._refreshQuota();
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
						approval.settle(message.allow);
						break;
					}
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
			case "listSessions":
				await this._ensureSession();
				this._post(webview, await this._sessionsMessage());
				return;
			case "openSession":
				await this.openSession(message.sessionId);
				return;
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
		void this._sendTo(runtime, text, mergeQueuedAttachments(taken)).catch(error => {
			this._log("chat.queue.deliver_failed", { message: errorMessage(error) });
		});
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
		runtime.busy = true;
		try {
			const index = runtime.messages.findIndex(message => message.id === messageId && message.role === "user");
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
				await this._sendTurn(runtime, text, undefined, { attachments: edited.attachments, attachmentContext: edited.attachmentContext });
			} else {
				await this._sendTurn(runtime, text, attachments);
			}
		} finally {
			runtime.busy = false;
			this._deliverQueued(runtime);
		}
	}

	/** Sends the user message of the failed answer again, keeping its attachments and rendered context. */
	private async _retryTurn(messageId: string): Promise<void> {
		await this._ensureSession();
		const runtime = this._active();
		if (!runtime || runtime.busy || runtime.running) {
			return;
		}
		const index = runtime.messages.findIndex(message => message.id === messageId && message.role === "assistant");
		if (index < 0) {
			return;
		}
		let user: ChatMessage | undefined;
		for (let earlier = index - 1; earlier >= 0; earlier -= 1) {
			if (runtime.messages[earlier].role === "user") {
				user = runtime.messages[earlier];
				break;
			}
		}
		if (!user) {
			return;
		}
		const text = user.parts.flatMap(part => part.kind === "text" ? [part.text] : []).join("\n\n");
		await this._edit(user.id, text, false);
	}

	private async _sendTurn(
		runtime: SessionRuntime,
		text: string,
		attachments?: ChatAttachment[],
		preserved?: { attachments?: ChatAttachment[]; attachmentContext?: string },
	): Promise<void> {
		await this._ensureModels();
		const messages = runtime.messages;
		const modelId = this._selectedModelId;
		const model = modelId === undefined ? undefined : this._models.find(candidate => candidate.id === modelId);
		if (!model) {
			const turn = Math.max(1, maxTurn(messages));
			const notice: ChatStructuredPart = { kind: "notice", level: "error", text: NO_MODEL_NOTICE };
			const answer: ChatMessage = { id: randomUUID(), role: "assistant", turn, createdAt: Date.now(), parts: [notice] };
			await this._appendMessage(runtime, answer);
			// Without the end marker the next load would take this notice for an interrupted answer.
			await this._deps.store.endMessage(runtime.meta.id, answer.id).catch(error => {
				this._log("chat.persist.end_failed", { message: errorMessage(error) });
			});
			return;
		}
		const turn = maxTurn(messages) + 1;
		const hostContext = this._turnContext();
		let display: ChatAttachment[] | undefined;
		let attachmentContext = "";
		if (preserved) {
			display = preserved.attachments;
			attachmentContext = preserved.attachmentContext ?? "";
		} else if (attachments && attachments.length > 0 && this._deps.attachments) {
			display = attachments;
			try {
				attachmentContext = renderAttachments(await this._deps.attachments.read(attachments));
			} catch (error) {
				this._log("chat.attachments.read_failed", { message: errorMessage(error) });
			}
		}
		const memory = await this._memoryContext(text, messages);
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
			cts: new vscode.CancellationTokenSource(),
			persistedParts: 0,
			buffer: undefined,
			timer: undefined,
		};
		runtime.running = running;
		this._emit(runtime, { type: "run", run: { running: true } });
		runtime.completion = this._runTurn(running, model, history, turn);
		await runtime.completion;
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
				void this._persistUsage(running, usage, totals);
				this._emit(runtime, { type: "usage", messageId: running.message.id, usage, totals });
			},
		};
		const source = this._deps.tools;
		const tracker = this._deps.changes;
		let begin: Promise<TurnSnapshot | undefined> | undefined;
		const claimed = new Set<string>();
		let liveRun: Promise<void> | undefined;
		let liveQueued = false;
		// One live refresh at a time; tool calls that finish during it queue a single follow-up.
		const refreshLive = (): void => {
			if (!tracker?.liveChangeSet || !begin) {
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
				} while (liveQueued);
			};
			liveRun = run().finally(() => {
				liveRun = undefined;
				if (liveQueued) {
					refreshLive();
				}
			}).catch(() => undefined);
		};
		const invoke = async (name: string, input: unknown, token: vscode.CancellationToken, callId: string | undefined, nested: boolean) => {
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
			for (const file of source.writtenPaths?.(name, input) ?? []) {
				claimed.add(file);
			}
			try {
				return await source.invoke(name, input, token, {
					callId,
					approve: confirmation => this._requestApproval(running, name, callId, confirmation, token),
					...(nested ? {} : {
						runSubagent: (request: SubagentRequest, subagentToken: vscode.CancellationToken) =>
							this._runSubagent(running, callId ?? randomUUID(), request, subagentTools, subagentToken),
						askQuestions: (questions: ChatQuestion[], questionToken: vscode.CancellationToken) =>
							this._askQuestions(running, callId, questions, questionToken),
					}),
				});
			} finally {
				if (!readOnly) {
					refreshLive();
				}
			}
		};
		const subagentTools: ChatToolExecutor = {
			get tools() {
				return source.tools.filter(tool => tool.name !== SUBAGENT_TOOL_NAME && tool.name !== TODO_TOOL_NAME && tool.name !== ASK_QUESTIONS_TOOL_NAME);
			},
			invoke: (name, input, token, callId) => invoke(name, input, token, callId, true),
		};
		const tools: ChatToolExecutor = {
			get tools() { return source.tools; },
			invoke: (name, input, token, callId) => invoke(name, input, token, callId, false),
		};
		try {
			const system = await this._systemPrompt();
			const thinking = this._thinkingFor(model.id);
			const initialParts = await this._compactForModel(running, model, history, system);
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
				modelOptions: { ...(thinking ? { reasoningEffort: thinking } : {}), _aabSkipSharedMemory: true },
				shouldYield: () => runtime.queued.length > 0,
			});
		} catch (error) {
			this._flushDelta(running);
			const notice: ChatStructuredPart = error instanceof vscode.CancellationError
				? { kind: "notice", level: "info", text: "Stopped." }
				: { kind: "notice", level: "error", text: turnErrorText(error), retryable: true };
			running.message.parts.push(notice);
			this._emit(runtime, { type: "partAdded", messageId: running.message.id, part: viewPart(notice) });
		} finally {
			this._flushDelta(running);
			this._persistFinishedParts(running);
			void this._persistEnd(running);
			const snapshot = await begin;
			// A live result must not land after the final list.
			while (liveRun) {
				await liveRun;
			}
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
			running.cts.dispose();
			this._emit(runtime, { type: "run", run: { running: false } });
			if (runtime.meta.id !== this._activeId) {
				runtime.finished = true;
			}
			this._broadcastActivity();
			// A finished request moves the subscription windows; providers report them without an event.
			this._scheduleQuotaBroadcast();
		}
	}

	private async _runSubagent(
		running: RunningTurn,
		callId: string,
		request: SubagentRequest,
		tools: ChatToolExecutor,
		token: vscode.CancellationToken,
	): Promise<string> {
		const model = this._models.find(candidate => candidate.id === request.model.id);
		if (!model) {
			throw new Error(`${request.model.label} is not available right now; choose another subagent model.`);
		}
		return runChatSubagent({
			backend: this._deps.backend,
			model,
			request,
			callId,
			conversationId: running.sessionId,
			tools,
			token,
			system: await this._systemPrompt(),
			hostContext: this._turnContext(),
			onUpdate: run => this._emit(running.runtime, { type: "subagent", messageId: running.message.id, run }),
			onFinish: run => {
				this._log("chat.subagent.finished", { model: model.id, status: run.status, steps: run.steps.length, durationMs: run.durationMs });
				this._addPart(running, { kind: "subagent", ...run });
			},
		});
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

	private async _systemPrompt(): Promise<string | undefined> {
		try {
			return await this._deps.prompt?.systemPrompt();
		} catch (error) {
			this._log("chat.prompt.system_failed", { message: errorMessage(error) });
			return undefined;
		}
	}

	/**
	 * When another model takes over a chat that is over the switch limit, older turns are summarized first,
	 * so the new model starts from a compact history instead of a cut one.
	 */
	private async _compactForModel(
		running: RunningTurn,
		model: vscode.LanguageModelChatInformation,
		history: readonly ChatMessage[],
		system: string | undefined,
	): Promise<ChatPart[]> {
		const compaction = this._deps.compaction;
		const previous = previousModelId(history);
		if (!compaction || !previous || previous === model.id) {
			return [];
		}
		const limits: ChatCompactionLimits = { ...compaction.limits(), fixedTokens: system ? estimateTextTokens(system) : 0 };
		const plan = planChatCompaction(history, limits);
		if (!plan) {
			return [];
		}
		const token = running.cts.token;
		this._emit(running.runtime, { type: "run", run: { running: true, detail: COMPACTING_DETAIL } });
		const startedAt = Date.now();
		try {
			const part = await compactChatHistory(history, { limits, summarize: compaction.summarize, token, plan });
			if (!part) {
				return [];
			}
			this._log("chat.compaction.done", {
				from: previous,
				to: model.id,
				method: part.method,
				summarizedMessages: part.summarizedMessages,
				tokensBefore: part.tokensBefore,
				tokensAfter: part.tokensAfter,
				durationMs: Date.now() - startedAt,
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

	private async _persistUsage(running: RunningTurn, usage: ChatUsage, totals: ChatUsageTotals): Promise<void> {
		try {
			await this._deps.store.setUsage(running.sessionId, running.message.id, usage, totals);
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
		const running = runtime.running;
		if (running) {
			if (running.timer) {
				clearTimeout(running.timer);
				running.timer = undefined;
			}
			running.cts.cancel();
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
		const loaded = await this._deps.store.loadSession(meta.id);
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
			busy: false,
			completion: Promise.resolve(),
			approvals: new Map(),
			questions: new Map(),
			finished: false,
			queued: [],
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
		};
	}

	private _broadcastModels(): void {
		this._broadcast({
			type: "models",
			models: groupModels(this._models),
			selectedModelId: this._selectedModelId,
			selectedThinking: this._thinkingFor(this._selectedModelId),
		});
	}

	private _runState(): ChatRunState {
		return { running: this._active()?.running !== undefined };
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
			const state: ChatSessionActivityState | undefined = runtime.approvals.size > 0 || runtime.questions.size > 0 ? "approval" : runtime.running ? "running" : runtime.finished ? "finished" : undefined;
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
