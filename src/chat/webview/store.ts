import {
	applyHostUpdate,
	type ChatApprovalRequest,
	type ChatAttachment,
	type ChatChangeSet,
	type ChatMemoryEntry,
	type ChatMessage,
	type ChatModelGroup,
	type ChatProviderQuota,
	type ChatQueuedMessage,
	type ChatQuestionRequest,
	type ChatRunState,
	type ChatSessionActivity,
	type ChatSessionMeta,
	type ChatSubagentRun,
	type ChatTodoItem,
	type ChatToolGroup,
	type ChatUsage,
	type HostMessage,
} from "../shared/protocol";
import { latestTodoList } from "../shared/todo";
import { postMessage } from "./api";

const HOST_MESSAGE_TYPES = new Set([
	"init",
	"changes",
	"models",
	"quota",
	"memory",
	"session",
	"sessions",
	"showSessions",
	"tools",
	"messageAdded",
	"partAdded",
	"textDelta",
	"usage",
	"truncated",
	"run",
	"approval",
	"approvalResolved",
	"questions",
	"questionsResolved",
	"toolResultFull",
	"partTextFull",
	"subagent",
	"activity",
	"attachmentsAdded",
	"queued",
	"restoreDraft",
]);

const MAX_PENDING_ATTACHMENTS = 20;

function attachmentKey(attachment: ChatAttachment): string {
	return `${attachment.uri}:${attachment.startLine ?? ""}:${attachment.endLine ?? ""}`;
}

/** Appends unseen attachments in order, up to the cap; the same array length when nothing was added. */
function mergeAttachments(current: readonly ChatAttachment[], added: readonly ChatAttachment[]): ChatAttachment[] {
	const keys = new Set(current.map(attachmentKey));
	const next = current.slice(0, MAX_PENDING_ATTACHMENTS);
	for (const attachment of added) {
		if (next.length >= MAX_PENDING_ATTACHMENTS) {
			break;
		}
		const key = attachmentKey(attachment);
		if (keys.has(key)) {
			continue;
		}
		keys.add(key);
		next.push(attachment);
	}
	return next;
}

/** Appends attachments with unseen ids in order, up to the cap. */
function mergeAttachmentsById(current: readonly ChatAttachment[], added: readonly ChatAttachment[]): ChatAttachment[] {
	const ids = new Set(current.map(attachment => attachment.id));
	const next = current.slice(0, MAX_PENDING_ATTACHMENTS);
	for (const attachment of added) {
		if (next.length >= MAX_PENDING_ATTACHMENTS) {
			break;
		}
		if (ids.has(attachment.id)) {
			continue;
		}
		ids.add(attachment.id);
		next.push(attachment);
	}
	return next;
}

/** Webview-side chat state shared by the Preact tree; every host update bumps one message version. */
export class ChatStore {
	session: ChatSessionMeta | undefined;
	/** Undefined until the first chat list arrives. */
	sessions: ChatSessionMeta[] | undefined;
	activeSessionId: string | undefined;
	/** Bumped when the host asks the history popup to open. */
	showSessionsRequest = 0;
	messages: ChatMessage[] = [];
	models: ChatModelGroup[] = [];
	tools: ChatToolGroup[] = [];
	approvals: ChatApprovalRequest[] = [];
	/** Question cards the agent waits on. */
	questionRequests: ChatQuestionRequest[] = [];
	/** The newest plan the agent kept with manage_todo_list; undefined until it calls the tool. */
	todoList: ChatTodoItem[] | undefined;
	changes: ChatChangeSet = { files: [], sinceTurn: [] };
	/** Chosen reasoning level of the selected model; absent means the model's default. */
	selectedThinking: string | undefined;
	quota: ChatProviderQuota[] = [];
	/** Shared memory as the panel last saw it; loaded stays false until the host answers. */
	memory: { loaded: boolean; enabled: boolean; projectLabel?: string; entries: ChatMemoryEntry[]; notice?: string } = {
		loaded: false,
		enabled: false,
		entries: [],
	};
	activity: ChatSessionActivity[] = [];
	/** Messages sent while the agent works; they go out after the current tool round. */
	queued: ChatQueuedMessage[] = [];
	/** Text the composer should take over, e.g. what Stop took back from the queue. */
	draftRequest: { text: string; seq: number } | undefined;
	/** Attachments shown in the composer; they are sent with the next message and survive a chat switch. */
	pendingAttachments: ChatAttachment[] = [];
	/** The user message being edited; the composer shows and changes its attachments. */
	editing: { messageId: string; attachments: ChatAttachment[] } | undefined;
	selectedModelId: string | undefined;
	run: ChatRunState = { running: false };
	latestUsage: ChatUsage | undefined;

	private readonly versions = new Map<string, number>();
	private readonly messageById = new Map<string, ChatMessage>();
	private readonly indexById = new Map<string, number>();
	private readonly liveSubagentRuns = new Map<string, ChatSubagentRun>();
	private readonly pendingToolResults = new Set<string>();
	private readonly pendingPartTexts = new Set<string>();
	private readonly listeners = new Set<() => void>();
	private versionSeq = 0;
	private draftSeq = 0;

	subscribe = (listener: () => void): (() => void) => {
		this.listeners.add(listener);
		return () => {
			this.listeners.delete(listener);
		};
	};

	versionOf = (messageId: string): number => this.versions.get(messageId) ?? 0;

	/** Live state of a running subagent, until its finished part arrives. */
	subagentRun = (callId: string): ChatSubagentRun | undefined => this.liveSubagentRuns.get(callId);

	/** Asks the host for a full tool result; the webview holds only its preview. */
	loadToolResult = (messageId: string, callId: string): void => {
		if (this.pendingToolResults.has(callId)) {
			return;
		}
		this.pendingToolResults.add(callId);
		postMessage({ type: "loadToolResult", messageId, callId });
	};

	toolResultPending = (callId: string): boolean => this.pendingToolResults.has(callId);

	/** Asks the host for the full thinking text; the webview holds only its tail. */
	loadPartText = (messageId: string, index: number): void => {
		const key = `${messageId}:${index}`;
		if (this.pendingPartTexts.has(key)) {
			return;
		}
		this.pendingPartTexts.add(key);
		postMessage({ type: "loadPartText", messageId, index });
	};

	partTextPending = (messageId: string, index: number): boolean => this.pendingPartTexts.has(`${messageId}:${index}`);

	indexOf = (messageId: string): number | undefined => this.indexById.get(messageId);

	/** Files changed at the exact turn, else at the nearest later turn, else 0. */
	filesChangedSince = (turn: number): number => {
		let result = 0;
		let nearest = Number.POSITIVE_INFINITY;
		for (const entry of this.changes.sinceTurn) {
			if (entry.turn === turn) {
				return entry.files;
			}
			if (entry.turn > turn && entry.turn < nearest) {
				nearest = entry.turn;
				result = entry.files;
			}
		}
		return result;
	};

	/** Applies a toggle locally first; the host answers with a fresh tools message. */
	setToolsEnabled = (names: string[], enabled: boolean): void => {
		if (names.length === 0) {
			return;
		}
		const targets = new Set(names);
		let changed = false;
		this.tools = this.tools.map(group => {
			let groupChanged = false;
			const tools = group.tools.map(tool => {
				if (!targets.has(tool.name) || tool.enabled === enabled) {
					return tool;
				}
				groupChanged = true;
				return { ...tool, enabled };
			});
			if (!groupChanged) {
				return group;
			}
			changed = true;
			return { ...group, tools };
		});
		if (changed) {
			this.listeners.forEach(listener => listener());
		}
	};

	removeAttachment = (id: string): void => {
		const next = this.pendingAttachments.filter(attachment => attachment.id !== id);
		if (next.length === this.pendingAttachments.length) {
			return;
		}
		this.pendingAttachments = next;
		this.listeners.forEach(listener => listener());
	};

	/** Opens the editor on a user message, with the attachments it was sent with. */
	startEdit = (messageId: string): void => {
		const message = this.messageById.get(messageId);
		if (!message || message.role !== "user") {
			return;
		}
		this.editing = { messageId, attachments: [...message.attachments ?? []] };
		this.listeners.forEach(listener => listener());
	};

	cancelEdit = (): void => {
		if (!this.editing) {
			return;
		}
		this.editing = undefined;
		this.listeners.forEach(listener => listener());
	};

	removeEditAttachment = (id: string): void => {
		const editing = this.editing;
		if (!editing) {
			return;
		}
		const next = editing.attachments.filter(attachment => attachment.id !== id);
		if (next.length === editing.attachments.length) {
			return;
		}
		this.editing = { ...editing, attachments: next };
		this.listeners.forEach(listener => listener());
	};

	/** Hands the pending attachments to the message that is being sent. */
	takeAttachments = (): ChatAttachment[] => {
		const taken = this.pendingAttachments;
		this.pendingAttachments = [];
		if (taken.length > 0) {
			this.listeners.forEach(listener => listener());
		}
		return taken;
	};

	receive = (event: MessageEvent): void => {
		const update: unknown = event.data;
		if (!update || typeof update !== "object" || !HOST_MESSAGE_TYPES.has((update as { type?: string }).type ?? "")) {
			return;
		}
		this.apply(update as HostMessage);
		this.listeners.forEach(listener => listener());
	};

	private apply(update: HostMessage): void {
		switch (update.type) {
			case "init":
				this.session = update.session;
				this.activeSessionId = update.session.id;
				this.messages = update.messages;
				this.models = update.models;
				this.tools = update.tools;
				this.selectedThinking = update.selectedThinking;
				this.quota = update.quota;
				this.activity = update.activity;
				this.approvals = update.approvals;
				this.questionRequests = update.questions ?? [];
				this.changes = update.changes;
				this.selectedModelId = update.selectedModelId;
				this.run = update.run;
				this.queued = update.queued ?? [];
				this.editing = undefined;
				this.liveSubagentRuns.clear();
				this.rebuildIndexes();
				return;
			case "changes":
				this.changes = update.changes;
				return;
			case "models":
				this.models = update.models;
				if (update.selectedModelId !== undefined) {
					this.selectedModelId = update.selectedModelId;
				}
				this.selectedThinking = update.selectedThinking;
				return;
			case "quota":
				this.quota = update.quota;
				return;
			case "memory":
				this.memory = {
					loaded: true,
					enabled: update.enabled,
					...(update.projectLabel === undefined ? {} : { projectLabel: update.projectLabel }),
					entries: update.entries,
					...(update.notice === undefined ? {} : { notice: update.notice }),
				};
				return;
			case "activity":
				this.activity = update.activity;
				return;
			case "queued":
				this.queued = update.queued;
				return;
			case "restoreDraft":
				this.pendingAttachments = mergeAttachmentsById(this.pendingAttachments, update.attachments);
				this.draftSeq += 1;
				this.draftRequest = { text: update.text, seq: this.draftSeq };
				return;
			case "session":
				this.session = update.session;
				return;
			case "sessions":
				this.sessions = update.sessions;
				this.activeSessionId = update.activeId;
				return;
			case "showSessions":
				this.showSessionsRequest += 1;
				return;
			case "tools":
				this.tools = update.tools;
				return;
			case "approval":
				if (!this.approvals.some(request => request.id === update.request.id)) {
					this.approvals = [...this.approvals, update.request];
				}
				return;
			case "approvalResolved":
				this.approvals = this.approvals.filter(request => request.id !== update.id);
				return;
			case "questions":
				if (!this.questionRequests.some(request => request.id === update.request.id)) {
					this.questionRequests = [...this.questionRequests, update.request];
				}
				return;
			case "questionsResolved":
				this.questionRequests = this.questionRequests.filter(request => request.id !== update.id);
				return;
			case "truncated": {
				const removed = this.indexOf(update.messageId);
				const edited = this.editing ? this.indexOf(this.editing.messageId) : undefined;
				if (removed !== undefined && (edited === undefined || edited >= removed)) {
					this.editing = undefined;
				}
				applyHostUpdate(this.messages, update);
				this.liveSubagentRuns.clear();
				this.rebuildIndexes();
				return;
			}
			case "run":
				this.run = update.run;
				return;
			case "toolResultFull": {
				const message = this.messageById.get(update.messageId);
				const part = message?.parts.find(candidate => candidate.kind === "toolResult" && candidate.callId === update.callId);
				if (part && part.kind === "toolResult") {
					part.text = update.text;
					part.preview = false;
					delete part.fullLength;
					this.pendingToolResults.delete(update.callId);
					this.bump(update.messageId);
				}
				return;
			}
			case "partTextFull": {
				const part = this.messageById.get(update.messageId)?.parts[update.index];
				if (part && (part.kind === "text" || part.kind === "thinking")) {
					part.text = update.text;
					part.preview = false;
					this.pendingPartTexts.delete(`${update.messageId}:${update.index}`);
					this.bump(update.messageId);
				}
				return;
			}
			case "partAdded":
				applyHostUpdate(this.messages, update);
				if (update.part.kind === "subagent") {
					this.liveSubagentRuns.delete(update.part.callId);
				}
				if (update.part.kind === "toolResult") {
					this.todoList = latestTodoList(this.messages);
				}
				this.bump(update.messageId);
				return;
			case "subagent":
				this.liveSubagentRuns.set(update.run.callId, update.run);
				this.bump(update.messageId);
				return;
			case "attachmentsAdded":
				this.addPendingAttachments(update.attachments);
				return;
			default:
				applyHostUpdate(this.messages, update);
				if (update.type === "messageAdded") {
					this.messageById.set(update.message.id, update.message);
					this.indexById.set(update.message.id, this.messages.length - 1);
					this.versions.set(update.message.id, this.nextVersion());
					this.todoList = latestTodoList(this.messages);
				} else {
					if (update.type === "usage" && update.usage) {
						this.latestUsage = update.usage;
					}
					this.bump(update.messageId);
				}
		}
	}

	private addPendingAttachments(attachments: readonly ChatAttachment[]): void {
		const target = this.editing ? this.editing.attachments : this.pendingAttachments;
		const next = mergeAttachments(target, attachments);
		if (next.length === target.length) {
			return;
		}
		if (this.editing) {
			this.editing = { ...this.editing, attachments: next };
		} else {
			this.pendingAttachments = next;
		}
	}

	private rebuildIndexes(): void {
		this.messageById.clear();
		this.indexById.clear();
		this.versions.clear();
		this.pendingToolResults.clear();
		this.pendingPartTexts.clear();
		this.messages.forEach((message, index) => {
			this.messageById.set(message.id, message);
			this.indexById.set(message.id, index);
			this.versions.set(message.id, this.nextVersion());
		});
		let latest: ChatUsage | undefined;
		for (let index = this.messages.length - 1; index >= 0; index -= 1) {
			const message = this.messages[index];
			if (message.role === "assistant" && message.usage) {
				latest = message.usage;
				break;
			}
		}
		this.latestUsage = latest;
		this.todoList = latestTodoList(this.messages);
	}

	private bump(messageId: string): void {
		this.versions.set(messageId, this.nextVersion());
	}

	private nextVersion(): number {
		this.versionSeq += 1;
		return this.versionSeq;
	}
}
