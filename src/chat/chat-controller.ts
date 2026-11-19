import { randomUUID } from "node:crypto";
import * as vscode from "vscode";
import { ToolCallValidationError } from "../tools/tool-call-reliability";
import { runAgentTurn, type AgentTurnSink, type ChatToolExecutor } from "./agent-loop";
import type { ChatWebviewBridge } from "./chat-view";
import { compactChatHistory, estimateTextTokens, planChatCompaction, previousModelId, type ChatCompactionLimits, type ChatSummarizer } from "./compaction";
import type { ChatSessionStore } from "./session-store";
import { runChatSubagent } from "./subagent-runner";
import { SUBAGENT_TOOL_NAME } from "./tools/subagent-tool";
import { groupModels } from "./shared/model-groups";
import { appendChatText, WEBVIEW_TOOL_RESULT_PREVIEW_CHARS } from "./shared/protocol";
import type {
	ChatApprovalRequest,
	ChatChangeSet,
	ChatMessage,
	ChatPart,
	ChatRunState,
	ChatSessionMeta,
	ChatStructuredPart,
	ChatTextKind,
	ChatToolGroup,
	ChatUsage,
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
const DELTA_FLUSH_MS = 50;
const NO_MODEL_NOTICE = "No model is available. Configure a provider first.";
const COMPACTING_DETAIL = "Compacting context…";

interface DeltaBuffer {
	kind: ChatTextKind;
	text: string;
}

interface RunningTurn {
	sessionId: string;
	message: ChatMessage;
	cts: vscode.CancellationTokenSource;
	/** Parts [0, persistedParts) are already in the session log. */
	persistedParts: number;
	buffer: DeltaBuffer | undefined;
	timer: ReturnType<typeof setTimeout> | undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

function parseWebviewMessage(value: unknown): WebviewMessage | undefined {
	if (!isRecord(value) || typeof value.type !== "string") {
		return undefined;
	}
	switch (value.type) {
		case "ready": return { type: "ready" };
		case "send": return typeof value.text === "string" ? { type: "send", text: value.text } : undefined;
		case "editMessage":
			return typeof value.messageId === "string" && typeof value.text === "string"
				? { type: "editMessage", messageId: value.messageId, text: value.text, undoChanges: value.undoChanges === true }
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
		case "setToolsEnabled":
			return Array.isArray(value.names) && value.names.every(name => typeof name === "string") && typeof value.enabled === "boolean"
				? { type: "setToolsEnabled", names: value.names as string[], enabled: value.enabled }
				: undefined;
		case "approve":
			return typeof value.id === "string" && typeof value.allow === "boolean" ? { type: "approve", id: value.id, allow: value.allow } : undefined;
		case "newChat": return { type: "newChat" };
		case "loadToolResult":
			return typeof value.messageId === "string" && typeof value.callId === "string"
				? { type: "loadToolResult", messageId: value.messageId, callId: value.callId }
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

/** Copies a part for the webview and cuts long tool results down to a preview. */
function viewPart(part: ChatStructuredPart): ChatStructuredPart;
function viewPart(part: ChatPart): ChatPart;
function viewPart(part: ChatPart): ChatPart {
	if (part.kind === "toolResult" && part.text.length > WEBVIEW_TOOL_RESULT_PREVIEW_CHARS) {
		return { ...part, text: part.text.slice(0, WEBVIEW_TOOL_RESULT_PREVIEW_CHARS), preview: true };
	}
	return { ...part };
}

function viewMessage(message: ChatMessage): ChatMessage {
	return { ...message, parts: message.parts.map(part => viewPart(part)) };
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
	private _session: ChatSessionMeta | undefined;
	private _messages: ChatMessage[] = [];
	private _sessionTask: Promise<void> | undefined;
	private _sessionLoaded = false;
	private _running: RunningTurn | undefined;
	private readonly _approvals = new Map<string, { request: ChatApprovalRequest; settle: (allowed: boolean) => void }>();
	private _changes: ChatChangeSet = emptyChangeSet();
	private _turnActive = false;
	private _turnCompletion: Promise<void> = Promise.resolve();
	private _disposed = false;

	constructor(deps: ChatControllerDeps) {
		this._deps = deps;
		this._modelChangeSubscription = deps.onDidChangeModels(() => { void this._onModelsChanged(); });
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

	async newChat(): Promise<void> {
		this._stop();
		await this._turnCompletion;
		const previous = this._session?.id;
		await this._ensureModels();
		const session = await this._deps.store.create(this._selectedModelId);
		await this._activateSession(session);
		this._broadcast(this._initMessage());
		if (previous && previous !== session.id) {
			await this._abandon(previous);
		}
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
		for (const approval of [...this._approvals.values()]) {
			approval.settle(false);
		}
		this._running?.cts.cancel();
		if (this._running?.timer) {
			clearTimeout(this._running.timer);
			this._running.timer = undefined;
		}
		this._running = undefined;
		this._modelChangeSubscription.dispose();
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
				await this._send(message.text);
				return;
			case "editMessage":
				await this._edit(message.messageId, message.text, message.undoChanges === true);
				return;
			case "keepChanges":
			case "undoChanges":
				await this._resolveChanges(message.type === "keepChanges" ? "keep" : "undo", message.ids);
				return;
			case "openChange":
				await this._ensureSession();
				if (this._session) {
					await this._deps.openChange?.(this._session.id, message.id);
				}
				return;
			case "stop":
				this._stop();
				return;
			case "selectModel":
				await this._selectModel(message.modelId);
				return;
			case "setToolsEnabled":
				await this._deps.tools.setEnabled?.(message.names, message.enabled);
				this._broadcast({ type: "tools", tools: this._toolGroups() });
				return;
			case "approve":
				this._approvals.get(message.id)?.settle(message.allow);
				return;
			case "newChat":
				await this.newChat();
				return;
			case "loadToolResult":
				this._sendFullToolResult(webview, message.messageId, message.callId);
				return;
		}
	}

	private async _send(text: string): Promise<void> {
		if (!text.trim() || this._turnActive) {
			return;
		}
		this._turnActive = true;
		try {
			await this._sendTurn(text);
		} finally {
			this._turnActive = false;
		}
	}

	private async _resolveChanges(action: "keep" | "undo", ids: readonly string[] | undefined): Promise<void> {
		const tracker = this._deps.changes;
		if (!tracker || this._turnActive) {
			return;
		}
		this._turnActive = true;
		try {
			await this._ensureSession();
			const session = this._session;
			if (!session) {
				return;
			}
			try {
				await (action === "keep" ? tracker.keep(session.id, ids) : tracker.undo(session.id, ids));
			} catch (error) {
				this._log("chat.changes.resolve_failed", { action, message: errorMessage(error) });
			}
			await this._refreshChanges(session.id);
		} finally {
			this._turnActive = false;
		}
	}

	private async _refreshChanges(sessionId: string): Promise<void> {
		const changes = await this._loadChanges(sessionId);
		if (this._session?.id === sessionId) {
			this._changes = changes;
			this._broadcast({ type: "changes", changes });
		}
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
	private async _edit(messageId: string, text: string, undoChanges: boolean): Promise<void> {
		if (!text.trim() || this._turnActive) {
			return;
		}
		this._turnActive = true;
		try {
			await this._ensureSession();
			const session = this._session;
			const index = this._messages.findIndex(message => message.id === messageId && message.role === "user");
			if (!session || index < 0) {
				return;
			}
			const tracker = this._deps.changes;
			if (tracker) {
				const turn = this._messages[index].turn;
				try {
					await (undoChanges ? tracker.undoSinceTurn(session.id, turn) : tracker.forgetTurnsFrom(session.id, turn));
				} catch (error) {
					this._log("chat.changes.edit_rollback_failed", { message: errorMessage(error) });
				}
				await this._refreshChanges(session.id);
			}
			try {
				await this._deps.store.truncateFrom(session.id, messageId);
			} catch (error) {
				this._log("chat.persist.truncate_failed", { message: errorMessage(error) });
				return;
			}
			this._messages.splice(index);
			const updated = await this._deps.store.get(session.id).catch(() => undefined);
			if (updated && this._session?.id === session.id) {
				this._session = updated;
			}
			this._broadcast({ type: "truncated", messageId });
			await this._sendTurn(text);
		} finally {
			this._turnActive = false;
		}
	}

	private async _sendTurn(text: string): Promise<void> {
		await this._ensureModels();
		await this._ensureSession();
		const session = this._session;
		if (!session) {
			return;
		}
		const messages = this._messages;
		const modelId = this._selectedModelId;
		const model = modelId === undefined ? undefined : this._models.find(candidate => candidate.id === modelId);
		if (!model) {
			const turn = Math.max(1, maxTurn(messages));
			const notice: ChatStructuredPart = { kind: "notice", level: "error", text: NO_MODEL_NOTICE };
			await this._appendMessage(messages, session.id, { id: randomUUID(), role: "assistant", turn, createdAt: Date.now(), parts: [notice] });
			return;
		}
		const turn = maxTurn(messages) + 1;
		const hostContext = this._turnContext();
		const user: ChatMessage = {
			id: randomUUID(),
			role: "user",
			turn,
			createdAt: Date.now(),
			parts: [{ kind: "text", text }],
			...(hostContext ? { hostContext } : {}),
		};
		await this._appendMessage(messages, session.id, user);
		await this._refreshSessionMeta(session.id);
		const history = messages.slice();
		const assistant: ChatMessage = { id: randomUUID(), role: "assistant", turn, createdAt: Date.now(), modelId: model.id, parts: [] };
		await this._appendMessage(messages, session.id, assistant);
		if (this._session?.id !== session.id) {
			return;
		}
		const running: RunningTurn = {
			sessionId: session.id,
			message: assistant,
			cts: new vscode.CancellationTokenSource(),
			persistedParts: 0,
			buffer: undefined,
			timer: undefined,
		};
		this._running = running;
		this._broadcast({ type: "run", run: { running: true } });
		this._turnCompletion = this._runTurn(running, model, history, turn);
		await this._turnCompletion;
	}

	private async _runTurn(running: RunningTurn, model: vscode.LanguageModelChatInformation, history: ChatMessage[], turn: number): Promise<void> {
		const sink: AgentTurnSink = {
			text: (kind, text) => {
				if (!text) {
					return;
				}
				appendChatText(running.message.parts, kind, text);
				this._queueDelta(running, kind, text);
			},
			part: part => this._addPart(running, part),
			usage: usage => {
				running.message.usage = usage;
				void this._persistUsage(running, usage);
				this._broadcast({ type: "usage", messageId: running.message.id, usage });
			},
		};
		const source = this._deps.tools;
		const tracker = this._deps.changes;
		let begin: Promise<TurnSnapshot | undefined> | undefined;
		const invoke = async (name: string, input: unknown, token: vscode.CancellationToken, callId: string | undefined, nested: boolean) => {
			// The snapshot must exist before the first tool that may write; read-only rounds cost nothing.
			if (tracker && !begin && !source.isReadOnly?.(name)) {
				begin = tracker.beginTurn().catch(error => {
					this._log("chat.changes.begin_failed", { message: errorMessage(error) });
					return undefined;
				});
			}
			await begin;
			return source.invoke(name, input, token, {
				callId,
				approve: confirmation => this._requestApproval(running, name, callId, confirmation, token),
				...(nested ? {} : {
					runSubagent: (request: SubagentRequest, subagentToken: vscode.CancellationToken) =>
						this._runSubagent(running, callId ?? randomUUID(), request, subagentTools, subagentToken),
				}),
			});
		};
		const subagentTools: ChatToolExecutor = {
			get tools() { return source.tools.filter(tool => tool.name !== SUBAGENT_TOOL_NAME); },
			invoke: (name, input, token, callId) => invoke(name, input, token, callId, true),
		};
		const tools: ChatToolExecutor = {
			get tools() { return source.tools; },
			invoke: (name, input, token, callId) => invoke(name, input, token, callId, false),
		};
		try {
			const system = await this._systemPrompt();
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
			});
		} catch (error) {
			this._flushDelta(running);
			const notice: ChatStructuredPart = error instanceof vscode.CancellationError
				? { kind: "notice", level: "info", text: "Stopped." }
				: { kind: "notice", level: "error", text: turnErrorText(error) };
			running.message.parts.push(notice);
			this._broadcast({ type: "partAdded", messageId: running.message.id, part: viewPart(notice) });
		} finally {
			this._flushDelta(running);
			this._persistFinishedParts(running);
			const snapshot = await begin;
			if (tracker && snapshot) {
				try {
					await tracker.endTurn(running.sessionId, turn, snapshot);
				} catch (error) {
					this._log("chat.changes.end_failed", { message: errorMessage(error) });
				}
				await this._refreshChanges(running.sessionId);
			}
			if (this._running === running) {
				this._running = undefined;
			}
			running.cts.dispose();
			this._broadcast({ type: "run", run: { running: false } });
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
			onUpdate: run => this._broadcast({ type: "subagent", messageId: running.message.id, run }),
			onFinish: run => {
				this._log("chat.subagent.finished", { model: model.id, status: run.status, steps: run.steps.length, durationMs: run.durationMs });
				this._addPart(running, { kind: "subagent", ...run });
			},
		});
	}

	/** The first user message names the chat; an edit may rename it. */
	private async _refreshSessionMeta(sessionId: string): Promise<void> {
		const updated = await this._deps.store.get(sessionId).catch(() => undefined);
		if (!updated || this._session?.id !== sessionId) {
			return;
		}
		this._session = updated;
		this._broadcast({ type: "session", session: updated });
	}

	private _addPart(running: RunningTurn, part: ChatStructuredPart): void {
		this._flushDelta(running);
		running.message.parts.push(part);
		this._persistFinishedParts(running);
		this._broadcast({ type: "partAdded", messageId: running.message.id, part: viewPart(part) });
	}

	private _turnContext(): string | undefined {
		try {
			return this._deps.prompt?.turnContext();
		} catch (error) {
			this._log("chat.prompt.context_failed", { message: errorMessage(error) });
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
		this._broadcast({ type: "run", run: { running: true, detail: COMPACTING_DETAIL } });
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
				this._broadcast({ type: "run", run: { running: true } });
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
		this._broadcast({ type: "textDelta", messageId: running.message.id, kind: buffer.kind, text: buffer.text });
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

	private async _persistUsage(running: RunningTurn, usage: ChatUsage): Promise<void> {
		try {
			await this._deps.store.setUsage(running.sessionId, running.message.id, usage);
		} catch (error) {
			this._log("chat.persist.usage_failed", { message: errorMessage(error) });
		}
	}

	private async _appendMessage(messages: ChatMessage[], sessionId: string, message: ChatMessage): Promise<void> {
		try {
			await this._deps.store.appendMessage(sessionId, message);
		} catch (error) {
			this._log("chat.persist.message_failed", { message: errorMessage(error) });
		}
		messages.push(message);
		if (this._session?.id === sessionId) {
			this._broadcast({ type: "messageAdded", message: viewMessage(message) });
		}
	}

	private _stop(): void {
		this._running?.cts.cancel();
	}

	/** Shows an approval card in every attached webview; Stop or a closed controller counts as a denial. */
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
				if (!this._approvals.delete(request.id)) {
					return;
				}
				subscriptions.forEach(subscription => subscription.dispose());
				this._log("chat.tool.approval", { tool: toolName, allowed });
				this._broadcast({ type: "approvalResolved", id: request.id, allowed });
				resolve(allowed);
			};
			this._approvals.set(request.id, { request, settle });
			subscriptions.push(token.onCancellationRequested(() => settle(false)));
			this._broadcast({ type: "approval", request });
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
		const session = this._session;
		if (!session) {
			return;
		}
		try {
			const updated = await this._deps.store.updateMeta(session.id, { modelId });
			if (updated && this._session?.id === session.id) {
				this._session = updated;
			}
		} catch (error) {
			this._log("chat.persist.model_failed", { message: errorMessage(error) });
		}
		await this._deps.state.update(LAST_MODEL_KEY, modelId);
		this._refreshSelection();
		this._broadcastModels();
	}

	private _sendFullToolResult(webview: vscode.Webview, messageId: string, callId: string): void {
		const message = this._messages.find(candidate => candidate.id === messageId);
		const part = message?.parts.find(candidate => candidate.kind === "toolResult" && candidate.callId === callId);
		if (part?.kind === "toolResult") {
			this._post(webview, { type: "toolResultFull", messageId, callId, text: part.text });
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
		const candidates = [this._session?.modelId, remembered];
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
		let session: ChatSessionMeta | undefined;
		if (typeof stored === "string") {
			try {
				session = await this._deps.store.get(stored);
			} catch (error) {
				this._log("chat.session.restore_failed", { message: errorMessage(error) });
			}
		}
		await this._activateSession(session ?? await this._deps.store.create(this._selectedModelId));
	}

	private async _activateSession(session: ChatSessionMeta): Promise<void> {
		const messages = await this._deps.store.load(session.id);
		this._changes = await this._loadChanges(session.id);
		this._session = session;
		this._messages = messages;
		this._sessionLoaded = true;
		this._sessionTask = undefined;
		await this._deps.state.update(ACTIVE_SESSION_KEY, session.id);
		this._refreshSelection();
	}

	private _initMessage(): HostMessage {
		const session = this._session;
		if (!session) {
			throw new Error("The chat session is not loaded.");
		}
		return {
			type: "init",
			session: { ...session },
			messages: this._messages.map(viewMessage),
			models: groupModels(this._models),
			selectedModelId: this._selectedModelId,
			run: this._runState(),
			tools: this._toolGroups(),
			approvals: [...this._approvals.values()].map(approval => approval.request),
			changes: this._changes,
		};
	}

	private _broadcastModels(): void {
		this._broadcast({ type: "models", models: groupModels(this._models), selectedModelId: this._selectedModelId });
	}

	private _runState(): ChatRunState {
		return { running: this._running !== undefined };
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
