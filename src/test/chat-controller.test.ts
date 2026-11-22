import * as assert from "node:assert";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import * as vscode from "vscode";
import { renderAttachments, type AttachmentContent } from "../chat/attachments";
import type { ChatChangeTrackerLike, TurnSnapshot } from "../chat/changes/change-tracker";
import { ChatController, continuationRequest, type ChatAccountSource, type ChatAttachmentsDeps, type ChatControllerDeps, type ChatQuotaSource } from "../chat/chat-controller";
import { createChatSummarizer, type ChatCompactionPlan } from "../chat/compaction";
import { compactionSummaryText } from "../chat/lm-messages";
import type { ChatMemoryContext, ChatMemorySource } from "../chat/memory-context";
import type { ChatMemoryStore } from "../chat/memory-store";
import { ChatSessionStore } from "../chat/session-store";
import { groupModels } from "../chat/shared/model-groups";
import {
	applyHostUpdate,
	CHAT_MEMORY_CONTENT_MAX_CHARS,
	CHAT_MEMORY_TITLE_MAX_CHARS,
	WEBVIEW_THINKING_PREVIEW_CHARS,
	WEBVIEW_TOOL_RESULT_PREVIEW_CHARS,
	type ChatAttachment,
	type ChatChangeSet,
	type ChatContextSettings,
	type ChatContextSettingsChange,
	type ChatMemoryEntry,
	type ChatMemorySaveInput,
	type ChatMessage,
	type ChatPastedFile,
	type ChatProviderQuota,
	type ChatSignInOffer,
	type ChatToolGroup,
	type ChatToolImage,
	type HostMessage,
} from "../chat/shared/protocol";
import { createChatToolSource, DENIED_TOOL_RESULT, type ChatToolSource } from "../chat/tool-executor";
import { ASK_QUESTIONS_TOOL_NAME, createAskQuestionsTool, createTodoTool, TODO_TOOL_NAME } from "../chat/tools/interaction-tools";
import { createCloseSubagentTool, createSubagentTool, SUBAGENT_TOOL_NAME } from "../chat/tools/subagent-tool";
import { createToolAccessTools, LIST_TOOLS_TOOL_NAME, REQUEST_TOOLS_TOOL_NAME } from "../chat/tools/tool-access-tools";
import type { ChatTool } from "../chat/tools/types";
import { promptCacheSignalPart } from "../providers/prompt-cache-signal";
import { limitSignalPart } from "../providers/limit-signal";

function withThinking(
	model: vscode.LanguageModelChatInformation,
	values: string[],
	labels: string[],
	descriptions: string[],
	defaultValue: string,
): vscode.LanguageModelChatInformation {
	return Object.assign(model, {
		configurationSchema: {
			type: "object",
			properties: {
				reasoningEffort: { type: "string", title: "Reasoning effort", enum: values, enumItemLabels: labels, enumDescriptions: descriptions, default: defaultValue },
			},
		},
	});
}

const MODELS: vscode.LanguageModelChatInformation[] = [
	withThinking(
		{ id: "codex::fast", name: "Fast (Codex)", family: "codex", version: "1", maxInputTokens: 100_000, maxOutputTokens: 4_000, capabilities: { toolCalling: true } },
		["low", "medium", "high", "xhigh"],
		["Low", "Medium", "High", "Extra high"],
		["Quick answer.", "Balanced.", "More deliberation.", "Deepest reasoning."],
		"medium",
	),
	withThinking(
		{ id: "claude::smart", name: "Smart (Claude)", family: "claude", version: "1", maxInputTokens: 200_000, maxOutputTokens: 8_000, capabilities: { toolCalling: true } },
		["low", "high"],
		["Low", "High"],
		["Quick answer.", "Deepest reasoning."],
		"low",
	),
];

const NEVER_FIRES: vscode.Event<void> = () => new vscode.Disposable(() => undefined);
const ACTIVE_SESSION_KEY = "llamacpp.chat.activeSession";
const LAST_MODEL_KEY = "llamacpp.chat.lastModel";
const THINKING_KEY = "llamacpp.chat.thinking";
const DRAFTS_KEY = "llamacpp.chat.drafts";
const INTERRUPTED_TEXT = "This answer was interrupted: VS Code closed or reloaded while it was running.";

type Round = (progress: vscode.Progress<vscode.LanguageModelResponsePart>, token: vscode.CancellationToken) => void | Promise<void>;

class FakeBackend implements Pick<vscode.LanguageModelChatProvider, "provideLanguageModelChatResponse" | "provideLanguageModelChatInformation"> {
	readonly requests: Array<{ messages: readonly vscode.LanguageModelChatRequestMessage[]; options: vscode.ProvideLanguageModelChatResponseOptions }> = [];
	modelInfoRequests = 0;
	private readonly _rounds: Round[];
	private readonly _models: vscode.LanguageModelChatInformation[];

	constructor(rounds: Round[] = [], models: vscode.LanguageModelChatInformation[] = MODELS) {
		this._rounds = [...rounds];
		this._models = models;
	}

	provideLanguageModelChatInformation(): Promise<vscode.LanguageModelChatInformation[]> {
		this.modelInfoRequests += 1;
		return Promise.resolve(this._models);
	}

	async provideLanguageModelChatResponse(
		_model: vscode.LanguageModelChatInformation,
		messages: readonly vscode.LanguageModelChatRequestMessage[],
		options: vscode.ProvideLanguageModelChatResponseOptions,
		progress: vscode.Progress<vscode.LanguageModelResponsePart>,
		token: vscode.CancellationToken,
	): Promise<void> {
		this.requests.push({ messages, options });
		const round = this._rounds.shift();
		if (!round) {
			throw new Error("unexpected extra round");
		}
		await round(progress, token);
	}
}

class FakeMemento implements vscode.Memento {
	private readonly _values = new Map<string, unknown>();

	get<T>(key: string): T | undefined;
	get<T>(key: string, defaultValue: T): T;
	get<T>(key: string, defaultValue?: T): T | undefined {
		return this._values.has(key) ? this._values.get(key) as T : defaultValue;
	}

	update(key: string, value: unknown): Thenable<void> {
		this._values.set(key, value);
		return Promise.resolve();
	}

	keys(): readonly string[] {
		return [...this._values.keys()];
	}
}

interface FakeQuota {
	source: ChatQuotaSource;
	readonly refreshes: number;
	current: ChatProviderQuota[];
	set(next: ChatProviderQuota[]): void;
	fire(): void;
	dispose(): void;
}

function fakeQuota(initial: ChatProviderQuota[]): FakeQuota {
	const emitter = new vscode.EventEmitter<void>();
	let refreshes = 0;
	const fake: FakeQuota = {
		current: initial,
		get refreshes(): number {
			return refreshes;
		},
		source: {
			snapshot: () => fake.current,
			refresh: async () => {
				refreshes += 1;
			},
			onDidChange: emitter.event,
		},
		set(next) {
			fake.current = next;
		},
		fire() {
			emitter.fire();
		},
		dispose() {
			emitter.dispose();
		},
	};
	return fake;
}

interface FakeAccounts {
	source: ChatAccountSource;
	current: ChatSignInOffer[];
	readonly signIns: string[];
	/** Runs inside signIn, e.g. to drop the offer the way a finished sign-in does. */
	onSignIn?: (provider: string) => void;
	fire(): void;
	dispose(): void;
}

function fakeAccounts(initial: ChatSignInOffer[]): FakeAccounts {
	const emitter = new vscode.EventEmitter<void>();
	const fake: FakeAccounts = {
		current: initial,
		signIns: [],
		source: {
			offers: () => fake.current,
			signIn: async provider => {
				fake.signIns.push(provider);
				fake.onSignIn?.(provider);
			},
			onDidChange: emitter.event,
		},
		fire() {
			emitter.fire();
		},
		dispose() {
			emitter.dispose();
		},
	};
	return fake;
}

const CODEX_OFFER: ChatSignInOffer = { provider: "codex", label: "Sign in to Codex", detail: "ChatGPT subscription" };
const CLAUDE_OFFER: ChatSignInOffer = { provider: "claude", label: "Sign in to Claude" };

class FakeAttachments implements ChatAttachmentsDeps {
	readonly reads: ChatAttachment[][] = [];
	readonly opened: ChatAttachment[] = [];
	readonly fromUriCalls: string[][] = [];
	picked: ChatAttachment[] = [];
	contents: AttachmentContent[] = [];
	from: ChatAttachment[] = [];

	async pick(): Promise<ChatAttachment[]> {
		return this.picked;
	}

	async fromUris(uris: readonly string[]): Promise<ChatAttachment[]> {
		this.fromUriCalls.push([...uris]);
		return this.from;
	}

	async read(attachments: readonly ChatAttachment[]): Promise<AttachmentContent[]> {
		this.reads.push([...attachments]);
		return this.contents;
	}

	async open(attachment: ChatAttachment): Promise<void> {
		this.opened.push(attachment);
	}

	readonly pastes: ChatPastedFile[][] = [];
	pasted: ChatAttachment[] = [];

	async savePasted(files: readonly ChatPastedFile[]): Promise<ChatAttachment[]> {
		this.pastes.push([...files]);
		return this.pasted;
	}
}

class FakeMemory implements ChatMemorySource {
	readonly calls: Array<{ query: string; known: Map<string, string> }> = [];
	current: ChatMemoryContext | undefined;
	enabledValue = true;

	enabled(): boolean {
		return this.enabledValue;
	}

	async context(query: string, known: ReadonlyMap<string, string>): Promise<ChatMemoryContext | undefined> {
		this.calls.push({ query, known: new Map(known) });
		return this.current;
	}
}

class FakeMemoryStore implements ChatMemoryStore {
	enabledValue = true;
	projectLabelValue: string | undefined = "Project A";
	entries: ChatMemoryEntry[] = [];
	readonly saved: ChatMemorySaveInput[] = [];
	readonly removed: string[] = [];
	fail: string | undefined;
	removeResult = true;
	private readonly emitter = new vscode.EventEmitter<void>();
	readonly onDidChange = this.emitter.event;

	enabled(): boolean {
		return this.enabledValue;
	}

	projectLabel(): string | undefined {
		return this.projectLabelValue;
	}

	list(): ChatMemoryEntry[] {
		return this.entries;
	}

	async save(input: ChatMemorySaveInput): Promise<ChatMemoryEntry> {
		if (this.fail) {
			throw new Error(this.fail);
		}
		this.saved.push(input);
		const entry: ChatMemoryEntry = {
			id: input.id ?? `mem-${this.saved.length}`,
			title: input.title,
			content: input.content,
			kind: input.kind,
			scope: input.scope,
			pinned: input.pinned,
			tags: [],
			updatedAt: Date.now(),
			expired: false,
		};
		this.entries = [...this.entries.filter(candidate => candidate.id !== entry.id), entry];
		return entry;
	}

	async remove(id: string): Promise<boolean> {
		this.removed.push(id);
		if (!this.removeResult) {
			return false;
		}
		this.entries = this.entries.filter(entry => entry.id !== id);
		return true;
	}

	fire(): void {
		this.emitter.fire();
	}

	dispose(): void {
		this.emitter.dispose();
	}
}

const ATTACHMENT: ChatAttachment = {
	id: "att-1",
	kind: "selection",
	path: "src/a.ts",
	uri: "file:///src/a.ts",
	startLine: 1,
	endLine: 2,
	text: "const a = 1;",
	languageId: "typescript",
};

const STORED_ATTACHMENT: ChatAttachment = {
	id: "att-1",
	kind: "selection",
	path: "src/a.ts",
	uri: "file:///src/a.ts",
	startLine: 1,
	endLine: 2,
	languageId: "typescript",
};

const FILE_ATTACHMENT: ChatAttachment = {
	id: "att-2",
	kind: "file",
	path: "src/b.ts",
	uri: "file:///src/b.ts",
};

class FakeWebview {
	readonly messages: HostMessage[] = [];
	private readonly _emitter = new vscode.EventEmitter<unknown>();
	readonly onDidReceiveMessage = this._emitter.event;

	postMessage(message: unknown): Thenable<boolean> {
		this.messages.push(message as HostMessage);
		return Promise.resolve(true);
	}

	receive(message: unknown): void {
		this._emitter.fire(message);
	}

	ofType<T extends HostMessage["type"]>(type: T): Array<Extract<HostMessage, { type: T }>> {
		return this.messages.filter((message): message is Extract<HostMessage, { type: T }> => message.type === type);
	}

	asWebview(): vscode.Webview {
		return this as unknown as vscode.Webview;
	}

	dispose(): void {
		this._emitter.dispose();
	}
}

interface Harness {
	controller: ChatController;
	webview: FakeWebview;
	state: FakeMemento;
	store: ChatSessionStore;
}

function fakeTools(handler: (name: string, input: unknown) => { text: string; isError: boolean; images?: ChatToolImage[] }): { executor: ChatToolSource; invocations: Array<{ name: string; input: unknown }> } {
	const invocations: Array<{ name: string; input: unknown }> = [];
	return {
		invocations,
		executor: {
			tools: [],
			invoke: async (name, input) => {
				invocations.push({ name, input });
				return handler(name, input);
			},
		},
	};
}

/** A one-tool catalog whose `guarded` tool always asks for approval. */
function guardedCatalog(): { source: ChatToolSource; runs: unknown[]; toggles: Array<{ names: readonly string[]; enabled: boolean }> } {
	const runs: unknown[] = [];
	const toggles: Array<{ names: readonly string[]; enabled: boolean }> = [];
	const tool: ChatTool = {
		name: "guarded",
		description: "Needs approval.",
		inputSchema: { type: "object", properties: {} },
		group: "terminal",
		needsConfirmation: () => ({ title: "Run a dangerous command", detail: "git push --force", reason: "Matches a rule." }),
		invoke: async input => {
			runs.push(input);
			return "ran";
		},
	};
	let enabled = true;
	const groups = (): ChatToolGroup[] => [{ id: "terminal", label: "Terminal", tools: [{ name: tool.name, description: tool.description, enabled }] }];
	const source = createChatToolSource({
		enabledTools: () => enabled ? [tool] : [],
		groups,
		setEnabled: async (names, value) => {
			toggles.push({ names, enabled: value });
			enabled = value;
		},
	});
	return { source, runs, toggles };
}

interface PlanningCatalog {
	source: ChatToolSource;
	toggles: Array<{ names: readonly string[]; enabled: boolean }>;
}

/** The planning and tool-access tools plus disabled external tools (`mcp_probe`, then `mcp_extra_1`…), which the controller wires to the chat. */
function planningCatalog(extraTools = 0): PlanningCatalog {
	const toggles: Array<{ names: readonly string[]; enabled: boolean }> = [];
	let externalEnabled = false;
	const extraNames = Array.from({ length: extraTools }, (_, index) => `mcp_extra_${index + 1}`);
	const extraEnabled = new Set<string>();
	const external: ChatTool = {
		name: "mcp_probe",
		description: "Reads a probe from an MCP server. Requires the server.",
		inputSchema: { type: "object", properties: {} },
		group: "ext:mcp",
		readOnly: true,
		invoke: async () => "probed",
	};
	const planning: ChatTool[] = [createTodoTool(), createAskQuestionsTool(), ...createToolAccessTools()];
	const groups = (): ChatToolGroup[] => [
		{
			id: "planning",
			label: "Planning and questions",
			tools: planning.map(tool => ({ name: tool.name, description: tool.description, enabled: true })),
		},
		{
			id: "ext:mcp",
			label: "MCP servers",
			note: "Run through VS Code, which may ask for confirmation in a dialog.",
			tools: [
				{ name: external.name, description: external.description, enabled: externalEnabled },
				...extraNames.map(name => ({ name, description: `Extra tool ${name}`, enabled: extraEnabled.has(name) })),
			],
		},
	];
	return {
		toggles,
		source: createChatToolSource({
			enabledTools: () => [...planning, ...(externalEnabled ? [external] : [])],
			groups,
			setEnabled: async (names, enabled) => {
				toggles.push({ names, enabled });
				if (names.includes(external.name)) {
					externalEnabled = enabled;
				}
				for (const name of names.filter(candidate => extraNames.includes(candidate))) {
					if (enabled) {
						extraEnabled.add(name);
					} else {
						extraEnabled.delete(name);
					}
				}
			},
		}),
	};
}

/** Records the controller's calls in one log shared with the tools, so the order is visible. */
class FakeTracker implements ChatChangeTrackerLike {
	set: ChatChangeSet = { files: [], sinceTurn: [] };
	constructor(readonly calls: string[]) {}
	async beginTurn(): Promise<TurnSnapshot | undefined> {
		this.calls.push("begin");
		return new Map([["root", { tree: "tree-before", ignoredLimitReached: false }]]);
	}
	async endTurn(_sessionId: string, turn: number, begin: TurnSnapshot): Promise<void> {
		this.calls.push(`end:${turn}:${begin.get("root")?.tree}`);
		this.set = { files: [{ id: "f1", path: "a.txt", status: "modified" }], sinceTurn: [{ turn, files: 1 }] };
	}
	async changeSet(): Promise<ChatChangeSet> {
		return this.set;
	}
	async keep(_sessionId: string, ids?: readonly string[]): Promise<void> {
		this.calls.push(`keep:${ids?.join(",") ?? "all"}`);
		this.set = { files: [], sinceTurn: [], notice: "Kept 1 file." };
	}
	async undo(_sessionId: string, ids?: readonly string[]): Promise<void> {
		this.calls.push(`undo:${ids?.join(",") ?? "all"}`);
		this.set = { files: [], sinceTurn: [], notice: "Undid 1 file." };
	}
	async undoSinceTurn(_sessionId: string, turn: number): Promise<void> {
		this.calls.push(`undoSince:${turn}`);
	}
	async forgetTurnsFrom(_sessionId: string, turn: number): Promise<void> {
		this.calls.push(`forget:${turn}`);
	}
	async original(): Promise<undefined> {
		return undefined;
	}
}

class FakeForgettingTracker extends FakeTracker {
	readonly forgotten: string[] = [];
	async forgetSession(sessionId: string): Promise<void> {
		this.forgotten.push(sessionId);
	}
}

/** A tracker that answers live snapshots while the turn is still running. */
class FakeLiveTracker extends FakeTracker {
	readonly liveTurns: number[] = [];
	async liveChangeSet(_sessionId: string, turn: number): Promise<ChatChangeSet> {
		this.liveTurns.push(turn);
		return { files: [{ id: "live-f1", path: "live.txt", status: "added" }], sinceTurn: [{ turn, files: 1 }] };
	}
}

class FakeRecoveringTracker extends FakeTracker {
	readonly recovered: string[] = [];
	async markOpen(_sessionId: string, turn: number): Promise<void> {
		this.calls.push(`markOpen:${turn}`);
	}
	async recoverInterrupted(sessionId: string): Promise<void> {
		this.recovered.push(sessionId);
	}
}

/** A writer and a read-only reader that log their runs into the shared call list. */
function loggingTools(calls: string[]): ChatToolSource {
	return {
		tools: [],
		invoke: async name => {
			calls.push(`tool:${name}`);
			return { text: "ok", isError: false };
		},
		isReadOnly: name => name === "reader",
	};
}

function createHarness(
	root: string,
	backend: FakeBackend,
	tools?: ChatToolSource,
	changes?: ChatChangeTrackerLike,
	extra?: Pick<ChatControllerDeps, "prompt" | "compaction" | "abandonConversation" | "quota" | "accounts" | "log" | "confirm" | "notify" | "osNotify" | "attachments" | "memory" | "memoryStore" | "contextSettings" | "globalState" | "saveExport" | "openImage" | "openFileReference" | "terminals" | "now" | "setTimer" | "maxRequests">,
): Harness {
	const store = new ChatSessionStore(root);
	const state = new FakeMemento();
	const controller = new ChatController({
		backend,
		onDidChangeModels: NEVER_FIRES,
		store,
		tools: tools ?? fakeTools(() => ({ text: "", isError: false })).executor,
		state,
		changes,
		...extra,
	});
	const webview = new FakeWebview();
	controller.attach(webview.asWebview());
	return { controller, webview, state, store };
}

async function waitFor(condition: () => boolean, what: string): Promise<void> {
	const deadline = Date.now() + 5_000;
	while (!condition()) {
		if (Date.now() > deadline) {
			throw new Error(`Timed out waiting for ${what}`);
		}
		await new Promise<void>(resolve => setTimeout(resolve, 10));
	}
}

async function waitForAsync(condition: () => Promise<boolean>, what: string): Promise<void> {
	const deadline = Date.now() + 5_000;
	while (!(await condition())) {
		if (Date.now() > deadline) {
			throw new Error(`Timed out waiting for ${what}`);
		}
		await new Promise<void>(resolve => setTimeout(resolve, 10));
	}
}

function deferred(): { promise: Promise<void>; resolve: () => void } {
	let release = (): void => undefined;
	const promise = new Promise<void>(resolve => {
		release = resolve;
	});
	return { promise, resolve: () => release() };
}

function messageText(message: vscode.LanguageModelChatRequestMessage): string {
	return message.content
		.filter((part): part is vscode.LanguageModelTextPart => part instanceof vscode.LanguageModelTextPart)
		.map(part => part.value)
		.join("");
}

function assistantText(messages: readonly ChatMessage[]): string {
	return messages
		.filter(message => message.role === "assistant")
		.flatMap(message => message.parts)
		.filter(part => part.kind === "text")
		.map(part => part.kind === "text" ? part.text : "")
		.join("");
}

suite("chat controller", () => {
	let root = "";
	let harness: Harness | undefined;

	setup(async () => {
		root = await fs.mkdtemp(path.join(os.tmpdir(), "chat-controller-"));
	});

	teardown(async () => {
		harness?.controller.dispose();
		harness?.webview.dispose();
		await harness?.store.flush();
		harness = undefined;
		// A cancelled turn may still write its end marker after the flush.
		await fs.rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
	});

	function autoClock(): { timers: Array<{ callback: () => void; ms: number; disposed: boolean }>; now: () => number; setTimer: NonNullable<ChatControllerDeps["setTimer"]>; advance: (value: number) => void } {
		let clock = 1_800_000_000_000;
		const timers: Array<{ callback: () => void; ms: number; disposed: boolean }> = [];
		return {
			timers,
			now: () => clock,
			advance: value => { clock = value; },
			setTimer: (callback, ms) => {
				const entry = { callback, ms, disposed: false };
				timers.push(entry);
				return { dispose: () => { entry.disposed = true; } };
			},
		};
	}

	function limitRound(resetAt: number): Round {
		return progress => progress.report(limitSignalPart({ kind: "limit", provider: "Codex", text: "Codex limit reached.", window: "5-hour", resetAt }));
	}

	async function startLimited(current: Harness): Promise<string> {
		current.webview.receive({ type: "send", text: "Question" });
		await waitFor(() => current.webview.ofType("run").some(message => !message.run.running), "limited turn");
		const sessionId = current.state.get<string>(ACTIVE_SESSION_KEY);
		assert.ok(sessionId);
		return sessionId;
	}

	test("auto-continue stores a limit and schedules its reset", async () => {
		const clock = autoClock();
		const resetAt = clock.now() + 5 * 3_600_000;
		const current = createHarness(root, new FakeBackend([limitRound(resetAt)]), undefined, undefined, clock);
		harness = current;
		const id = await startLimited(current);
		await waitFor(() => clock.timers.length === 1, "timer");
		const answer = (await current.store.load(id)).at(-1);
		assert.deepStrictEqual((await current.store.get(id))?.autoContinue, { messageId: answer?.id, at: resetAt + 60_000, enabled: true, attempts: 0 });
		assert.strictEqual(clock.timers[0].ms, resetAt + 60_000 - clock.now());
	});

	test("auto-continue continues a background chat", async () => {
		const clock = autoClock();
		const resetAt = clock.now() + 3_600_000;
		const backend = new FakeBackend([limitRound(resetAt), progress => progress.report(new vscode.LanguageModelTextPart("Done"))]);
		const current = createHarness(root, backend, undefined, undefined, clock);
		harness = current;
		const id = await startLimited(current);
		await waitFor(() => clock.timers.length === 1, "timer");
		await current.controller.newChat();
		clock.advance(resetAt + 60_000);
		clock.timers[0].callback();
		await waitFor(() => backend.requests.length === 2, "background request");
		await waitForAsync(async () => (await current.store.load(id)).length === 4 && !(await current.store.get(id))?.autoContinue, "background continuation");
		assert.ok((await current.store.load(id)).some(message => message.role === "user" && message.continuation));
	});

	test("auto-continue can be disabled and enabled", async () => {
		const clock = autoClock();
		const backend = new FakeBackend([limitRound(clock.now() + 3_600_000)]);
		const events: string[] = [];
		const current = createHarness(root, backend, undefined, undefined, { ...clock, log: event => events.push(event) });
		harness = current;
		const id = await startLimited(current);
		await waitFor(() => clock.timers.length === 1, "timer");
		const entry = (await current.store.get(id))!.autoContinue!;
		current.webview.receive({ type: "setAutoContinue", sessionId: id, messageId: entry.messageId, enabled: false });
		await waitForAsync(async () => (await current.store.get(id))?.autoContinue?.enabled === false, "disabled");
		assert.strictEqual(clock.timers[0].disposed, true);
		clock.timers[0].callback();
		await waitFor(() => events.includes("chat.auto_continue.skipped"), "old callback");
		assert.strictEqual(backend.requests.length, 1);
		clock.advance(entry.at + 1);
		current.webview.receive({ type: "setAutoContinue", sessionId: id, messageId: entry.messageId, enabled: true });
		await waitFor(() => clock.timers.length === 2, "new timer");
		assert.deepStrictEqual((await current.store.get(id))?.autoContinue, { ...entry, enabled: true, attempts: 0, at: clock.now() + 10_000 });
		assert.strictEqual(clock.timers[1].ms, 10_000);
	});

	test("auto-continue is cleared by a normal new turn", async () => {
		const clock = autoClock();
		const current = createHarness(root, new FakeBackend([limitRound(clock.now() + 3_600_000), progress => progress.report(new vscode.LanguageModelTextPart("Done"))]), undefined, undefined, clock);
		harness = current;
		const id = await startLimited(current);
		await waitFor(() => clock.timers.length === 1, "timer");
		current.webview.receive({ type: "send", text: "Another question" });
		await waitFor(() => current.webview.ofType("run").filter(message => !message.run.running).length === 2, "normal turn");
		await waitForAsync(async () => !(await current.store.get(id))?.autoContinue, "cleared schedule");
		assert.strictEqual(clock.timers[0].disposed, true);
	});

	test("auto-continue ignores distant limits and balance signals", async () => {
		const clock = autoClock();
		const current = createHarness(root, new FakeBackend([
			limitRound(clock.now() + 3 * 24 * 3_600_000),
			progress => progress.report(limitSignalPart({ kind: "balance", provider: "Codex", text: "Balance exhausted." })),
		]), undefined, undefined, clock);
		harness = current;
		const id = await startLimited(current);
		assert.strictEqual((await current.store.get(id))?.autoContinue, undefined);
		current.webview.receive({ type: "send", text: "Again" });
		await waitFor(() => current.webview.ofType("run").filter(message => !message.run.running).length === 2, "balance turn");
		assert.strictEqual((await current.store.get(id))?.autoContinue, undefined);
		assert.strictEqual(clock.timers.length, 0);
	});

	test("auto-continue stops after three limited continuations", async () => {
		const clock = autoClock();
		const resetAt = clock.now() + 3_600_000;
		const current = createHarness(root, new FakeBackend(Array.from({ length: 4 }, () => limitRound(resetAt))), undefined, undefined, clock);
		harness = current;
		const id = await startLimited(current);
		for (let i = 0; i < 3; i++) {
			await waitFor(() => clock.timers.length === i + 1, "continuation timer");
			clock.advance(resetAt + (i + 1) * 60_000);
			clock.timers[i].callback();
			await waitForAsync(async () => (await current.store.get(id))?.autoContinue?.attempts === i + 1, "continuation attempt");
		}
		const entry = (await current.store.get(id))?.autoContinue;
		assert.strictEqual(entry?.enabled, false);
		assert.strictEqual(entry?.attempts, 3);
		assert.strictEqual(clock.timers.length, 3);
	});

	test("auto-continue restores recent schedules and clears stale ones", async () => {
		const clock = autoClock();
		const store = new ChatSessionStore(root);
		const recent = await store.create("codex::fast");
		const stale = await store.create("codex::fast");
		for (const meta of [recent, stale]) {
			await store.appendMessage(meta.id, { id: "u1", role: "user", turn: 1, createdAt: 1, parts: [{ kind: "text", text: "Question" }] });
			await store.appendMessage(meta.id, { id: "a1", role: "assistant", turn: 1, createdAt: 1, parts: [{ kind: "text", text: "Answer" }] });
			await store.endMessage(meta.id, "a1");
			await store.updateMeta(meta.id, { autoContinue: { messageId: "a1", at: clock.now() - (meta.id === recent.id ? 3_600_000 : 25 * 3_600_000), enabled: true, attempts: 0 } });
		}
		await store.flush();
		const current = createHarness(root, new FakeBackend(), undefined, undefined, clock);
		harness = current;
		await waitFor(() => clock.timers.length === 1, "restored timer");
		await waitForAsync(async () => !(await current.store.get(stale.id))?.autoContinue, "stale schedule cleared");
		assert.strictEqual(clock.timers[0].ms, 10_000);
		assert.ok((await current.store.get(recent.id))?.autoContinue);
	});

	test("sends init with grouped models and a selected model when the webview is ready", async () => {
		const backend = new FakeBackend();
		const current = createHarness(root, backend);
		harness = current;
		current.webview.receive({ type: "ready" });
		await waitFor(() => current.webview.ofType("init").length === 1, "init");

		const init = current.webview.ofType("init")[0];
		assert.deepStrictEqual(init.models, groupModels(MODELS));
		assert.strictEqual(init.selectedModelId, "codex::fast");
		assert.strictEqual(init.selectedThinking, undefined);
		assert.deepStrictEqual(init.quota, []);
		assert.strictEqual(init.session.modelId, "codex::fast");
		assert.deepStrictEqual(init.messages, []);
		assert.deepStrictEqual(init.run, { running: false });
		assert.deepStrictEqual(init.activity, []);
		assert.deepStrictEqual(init.signIn, []);
		assert.strictEqual(backend.modelInfoRequests, 1);
		assert.strictEqual(current.state.get<string>(ACTIVE_SESSION_KEY), init.session.id);
	});

	test("streams a turn, persists it and replays the same messages from a new store", async () => {
		const tools = fakeTools(() => ({ text: "tool body", isError: false }));
		const backend = new FakeBackend([
			progress => {
				progress.report(new vscode.LanguageModelTextPart("Checking."));
				progress.report(new vscode.LanguageModelToolCallPart("call-1", "llamacpp_probe", { path: "a.txt" }));
			},
			progress => {
				progress.report(new vscode.LanguageModelTextPart("All done."));
				progress.report(new vscode.LanguageModelDataPart(new TextEncoder().encode(JSON.stringify({
					prompt_tokens: 10,
					completion_tokens: 5,
					total_tokens: 15,
				})), "usage"));
			},
		]);
		const current = createHarness(root, backend, tools.executor);
		harness = current;
		current.webview.receive({ type: "send", text: "Inspect the file" });
		const isRunning = (): boolean => current.webview.ofType("run").map(message => message.run.running).at(-1) === false;
		await waitFor(() => current.webview.ofType("run").length >= 2 && isRunning(), "turn end");

		const added = current.webview.ofType("messageAdded");
		assert.strictEqual(added.length, 2);
		assert.strictEqual(added[0].message.role, "user");
		assert.strictEqual(added[0].message.turn, 1);
		assert.deepStrictEqual(added[0].message.parts, [{ kind: "text", text: "Inspect the file" }]);
		assert.strictEqual(added[1].message.role, "assistant");
		assert.strictEqual(added[1].message.turn, 1);
		assert.strictEqual(added[1].message.modelId, "codex::fast");

		const parts = current.webview.ofType("partAdded");
		assert.deepStrictEqual(parts.map(message => message.part.kind), ["toolCall", "toolResult"]);
		assert.deepStrictEqual(tools.invocations, [{ name: "llamacpp_probe", input: { path: "a.txt" } }]);
		const toolResult = parts[1].part;
		if (toolResult.kind !== "toolResult") {
			throw new Error("expected a tool result");
		}
		assert.strictEqual(toolResult.text, "tool body");
		assert.strictEqual(toolResult.isError, false);

		const deltas = current.webview.ofType("textDelta");
		assert.strictEqual(deltas.map(delta => delta.text).join(""), "Checking.All done.");
		assert.deepStrictEqual(current.webview.ofType("usage").map(message => message.usage), [
			{ promptTokens: 10, completionTokens: 5, totalTokens: 15 },
		]);
		const totals = { requests: 1, promptTokens: 10, cachedTokens: 0, completionTokens: 5, cacheReported: 0, cachedPromptTokens: 0 };
		assert.deepStrictEqual(current.webview.ofType("usage").map(message => message.totals), [totals]);
		assert.deepStrictEqual(current.webview.ofType("run").map(message => message.run.running), [true, false]);

		await current.store.flush();
		const sessionId = current.state.get<string>(ACTIVE_SESSION_KEY);
		if (!sessionId) {
			throw new Error("no active session");
		}
		const persisted = await new ChatSessionStore(root).load(sessionId);
		const persistedAssistant = persisted.find(message => message.role === "assistant");
		assert.deepStrictEqual(persistedAssistant?.usageTotals, totals);
		const replayed: ChatMessage[] = [];
		for (const message of current.webview.messages) {
			applyHostUpdate(replayed, message);
		}
		assert.deepStrictEqual(replayed, persisted);
	});

	test("keeps context usage apart and persists the prompt-cache counters", async () => {
		const backend = new FakeBackend([progress => {
			progress.report(new vscode.LanguageModelDataPart(new TextEncoder().encode(JSON.stringify({
				prompt_tokens: 1000,
				total_tokens: 1000,
			})), "usage"));
			progress.report(promptCacheSignalPart({ promptTokens: 900, cachedTokens: 700, cacheWriteTokens: 100, completionTokens: 50, requests: 1 }));
			progress.report(new vscode.LanguageModelTextPart("Done."));
		}]);
		const current = createHarness(root, backend);
		harness = current;
		current.webview.receive({ type: "send", text: "Cache check" });
		await waitFor(() => current.webview.ofType("run").some(message => !message.run.running), "turn end");

		const updates = current.webview.ofType("usage");
		assert.deepStrictEqual(updates.map(update => update.usage), [
			{ promptTokens: 1000, totalTokens: 1000 },
			{ promptTokens: 1000, totalTokens: 1000 },
		]);
		const promptCache = { promptTokens: 900, cachedTokens: 700, cacheWriteTokens: 100, completionTokens: 50, requests: 1 };
		const totals = { requests: 2, promptTokens: 1900, cachedTokens: 700, completionTokens: 50, cacheReported: 1, cachedPromptTokens: 900 };
		assert.deepStrictEqual(updates.at(-1)?.promptCache, promptCache);
		assert.deepStrictEqual(updates.at(-1)?.totals, totals);
		assert.deepStrictEqual(updates.at(-1)?.usage, { promptTokens: 1000, totalTokens: 1000 });
		const replayed: ChatMessage[] = [];
		for (const message of current.webview.messages) {
			applyHostUpdate(replayed, message);
		}
		const assistant = replayed.find(message => message.role === "assistant");
		assert.deepStrictEqual(assistant?.usage, { promptTokens: 1000, totalTokens: 1000 });
		assert.deepStrictEqual(assistant?.usageTotals, totals);
		assert.deepStrictEqual(assistant?.promptCache, promptCache);

		await current.store.flush();
		const sessionId = current.state.get<string>(ACTIVE_SESSION_KEY);
		if (!sessionId) {
			throw new Error("no active session");
		}
		const persisted = (await new ChatSessionStore(root).load(sessionId)).find(message => message.role === "assistant");
		assert.deepStrictEqual(persisted?.usageTotals, totals);
		assert.deepStrictEqual(persisted?.promptCache, promptCache);
	});

	test("osNotify reports a finished turn", async () => {
		const notifications: Array<[string, string]> = [];
		const current = createHarness(root, new FakeBackend([() => undefined]), undefined, undefined, { osNotify: (title, body) => notifications.push([title, body]) });
		harness = current;
		current.webview.receive({ type: "send", text: "Finish" });
		await waitFor(() => current.webview.ofType("run").some(message => !message.run.running), "turn end");
		const id = current.state.get<string>(ACTIVE_SESSION_KEY)!;
		assert.deepStrictEqual(notifications, [[(await current.store.get(id))?.title, "The agent finished."]]);
	});

	test("stops a running turn with an info notice", async () => {
		const backend = new FakeBackend([
			async (progress, token) => {
				progress.report(new vscode.LanguageModelTextPart("Working"));
				await new Promise<void>(resolve => token.onCancellationRequested(() => resolve()));
				throw new vscode.CancellationError();
			},
		]);
		const notifications: string[] = [];
		const current = createHarness(root, backend, undefined, undefined, { osNotify: (_title, body) => notifications.push(body) });
		harness = current;
		current.webview.receive({ type: "send", text: "Long job" });
		await waitFor(() => backend.requests.length === 1, "run start");
		current.webview.receive({ type: "stop" });
		await waitFor(() => current.webview.ofType("run").some(message => !message.run.running), "run stop");

		const notices = current.webview.ofType("partAdded").filter(message => message.part.kind === "notice");
		assert.strictEqual(notices.length, 1);
		const notice = notices[0].part;
		if (notice.kind !== "notice") {
			throw new Error("expected a notice");
		}
		assert.strictEqual(notice.level, "info");
		assert.strictEqual(notice.text, "Stopped.");
		assert.deepStrictEqual(notifications, []);
		assert.strictEqual(current.webview.ofType("run").at(-1)?.run.running, false);
	});

	test("Stop cancels a writing tool still waiting for the initial snapshot", async () => {
		const calls: string[] = [];
		const snapshot = deferred();
		const tracker = new class extends FakeTracker {
			override async beginTurn(): Promise<TurnSnapshot | undefined> {
				calls.push("snapshot");
				await snapshot.promise;
				return super.beginTurn();
			}
		}(calls);
		const backend = new FakeBackend([
			progress => progress.report(new vscode.LanguageModelToolCallPart("write", "writer", {})),
		]);
		const current = createHarness(root, backend, loggingTools(calls), tracker);
		harness = current;
		current.webview.receive({ type: "send", text: "Edit a file" });
		try {
			await waitFor(() => calls.includes("snapshot"), "initial snapshot");
			current.webview.receive({ type: "stop" });
			await waitFor(() => current.webview.ofType("run").at(-1)?.run.stopping === true, "stop request");
		} finally {
			snapshot.resolve();
		}
		await waitFor(() => current.webview.ofType("run").some(message => !message.run.running), "turn end");
		assert.ok(!calls.includes("tool:writer"));
		assert.strictEqual(backend.requests.length, 1);
	});

	test("a stopped turn unlocks Keep as soon as it reports Stopped", async () => {
		const calls: string[] = [];
		const finishing = deferred();
		const tracker = new class extends FakeTracker {
			override async endTurn(sessionId: string, turn: number, snapshot: TurnSnapshot): Promise<void> {
				calls.push("finishing");
				await finishing.promise;
				await super.endTurn(sessionId, turn, snapshot);
			}
		}(calls);
		const backend = new FakeBackend([
			progress => progress.report(new vscode.LanguageModelToolCallPart("write", "writer", {})),
			async (_progress, token) => {
				await new Promise<void>(resolve => token.onCancellationRequested(() => resolve()));
				throw new vscode.CancellationError();
			},
		]);
		const current = createHarness(root, backend, loggingTools(calls), tracker);
		harness = current;
		current.webview.receive({ type: "send", text: "Edit a file" });
		await waitFor(() => backend.requests.length === 2, "writing tool");
		current.webview.receive({ type: "stop" });

		const stopped = () => current.webview.ofType("partAdded").find(message => message.part.kind === "notice" && message.part.text === "Stopped.");
		try {
			await waitFor(() => calls.includes("finishing"), "final change snapshot");
			assert.deepStrictEqual(current.webview.ofType("run").at(-1)?.run, { running: true, stopping: true, detail: "Stopping…" });
			assert.strictEqual(stopped(), undefined);
		} finally {
			finishing.resolve();
		}
		await waitFor(() => stopped() !== undefined, "stop notice");
		assert.strictEqual(current.webview.ofType("run").at(-1)?.run.running, false);
		assert.deepStrictEqual(current.webview.ofType("changes").at(-1)?.changes.files.map(file => file.path), ["a.txt"]);
		current.webview.receive({ type: "keepChanges", ids: ["f1"] });
		await waitFor(() => calls.includes("keep:f1"), "keep after stop");
	});

	test("a message sent while a turn runs waits for the round and starts the next turn", async () => {
		const gate = deferred();
		const backend = new FakeBackend([
			async progress => {
				progress.report(new vscode.LanguageModelToolCallPart("call-1", "llamacpp_probe", {}));
				await gate.promise;
			},
			progress => progress.report(new vscode.LanguageModelTextPart("answer to the queued message")),
			progress => progress.report(new vscode.LanguageModelTextPart("unexpected extra answer")),
		]);
		const current = createHarness(root, backend, fakeTools(() => ({ text: "tool body", isError: false })).executor);
		harness = current;
		current.webview.receive({ type: "send", text: "first" });
		await waitFor(() => current.webview.ofType("partAdded").some(message => message.part.kind === "toolCall"), "tool call");
		current.webview.receive({ type: "send", text: "follow up" });
		await waitFor(() => current.webview.ofType("queued").some(message => message.queued.length === 1), "queued message");
		assert.deepStrictEqual(current.webview.ofType("queued").at(-1)?.queued.map(message => message.text), ["follow up"]);
		assert.strictEqual(current.webview.ofType("messageAdded").filter(message => message.message.role === "user").length, 1);
		assert.strictEqual(backend.requests.length, 1);

		gate.resolve();
		await waitFor(() => current.webview.ofType("run").filter(message => !message.run.running).length === 2, "both turns");
		assert.strictEqual(backend.requests.length, 2);
		const users = current.webview.ofType("messageAdded").map(message => message.message).filter(message => message.role === "user");
		assert.deepStrictEqual(users.map(message => message.parts), [
			[{ kind: "text", text: "first" }],
			[{ kind: "text", text: "follow up" }],
		]);
		const lastRequest = backend.requests.at(-1);
		assert.ok(lastRequest);
		assert.strictEqual(lastRequest.messages.length, 4);
		assert.strictEqual(messageText(lastRequest.messages[3]), "follow up");
	});

	test("a queued message whose delivery fails comes back to the input", async () => {
		const gate = deferred();
		const models = [...MODELS];
		const backend = new FakeBackend([async () => { await gate.promise; }], models);
		const current = createHarness(root, backend);
		harness = current;
		current.webview.receive({ type: "send", text: "first" });
		await waitFor(() => backend.requests.length === 1, "first request");
		current.webview.receive({ type: "send", text: "queued text" });
		await waitFor(() => current.webview.ofType("queued").some(message => message.queued.length === 1), "queued");
		models.splice(0);
		gate.resolve();
		await waitFor(() => current.webview.ofType("restoreDraft").some(message => message.text === "queued text"), "restored queue");
		await waitFor(() => current.webview.ofType("messageAdded").some(message => message.message.parts.some(part => part.kind === "notice" && part.level === "error")), "error notice");
		assert.strictEqual(backend.requests.length, 1);
	});

	test("Stop while a turn is being prepared sends nothing and returns the text", async () => {
		const gate = deferred();
		const fake = new FakeAttachments();
		let reading = false;
		fake.read = async () => { reading = true; await gate.promise; return []; };
		const backend = new FakeBackend();
		const current = createHarness(root, backend, undefined, undefined, { attachments: fake });
		harness = current;
		current.webview.receive({ type: "send", text: "Explain", attachments: [ATTACHMENT] });
		await waitFor(() => reading && current.webview.ofType("run").some(message => message.run.running), "preparing");
		current.webview.receive({ type: "stop" });
		gate.resolve();
		await waitFor(() => current.webview.ofType("run").at(-1)?.run.running === false, "preparation stopped");
		assert.strictEqual(backend.requests.length, 0);
		assert.ok(current.webview.ofType("restoreDraft").some(message => message.text === "Explain"));
		assert.ok(!current.webview.ofType("messageAdded").some(message => message.message.role === "user"));
	});

	test("deleting a chat while its turn is prepared starts no turn", async () => {
		const gate = deferred();
		const fake = new FakeAttachments();
		let reading = false;
		fake.read = async () => { reading = true; await gate.promise; return []; };
		const backend = new FakeBackend();
		const current = createHarness(root, backend, undefined, undefined, { attachments: fake });
		harness = current;
		current.webview.receive({ type: "ready" });
		await waitFor(() => current.webview.ofType("init").length === 1, "init");
		const id = current.webview.ofType("init")[0].session.id;
		current.webview.receive({ type: "send", text: "Explain", attachments: [ATTACHMENT] });
		await waitFor(() => reading, "preparing");
		current.webview.receive({ type: "deleteSession", sessionId: id });
		await waitFor(() => current.webview.ofType("init").length === 2, "deleted");
		gate.resolve();
		await new Promise<void>(resolve => setTimeout(resolve, 50));
		assert.strictEqual(backend.requests.length, 0);
	});

	test("two queued messages are delivered as one user message", async () => {
		const gate = deferred();
		const backend = new FakeBackend([
			async progress => {
				progress.report(new vscode.LanguageModelToolCallPart("call-1", "llamacpp_probe", {}));
				await gate.promise;
			},
			progress => progress.report(new vscode.LanguageModelTextPart("combined answer")),
		]);
		const current = createHarness(root, backend, fakeTools(() => ({ text: "tool body", isError: false })).executor);
		harness = current;
		current.webview.receive({ type: "send", text: "first" });
		await waitFor(() => current.webview.ofType("partAdded").some(message => message.part.kind === "toolCall"), "tool call");
		current.webview.receive({ type: "send", text: "one" });
		current.webview.receive({ type: "send", text: "two" });
		await waitFor(() => current.webview.ofType("queued").some(message => message.queued.length === 2), "two queued messages");
		gate.resolve();
		await waitFor(() => current.webview.ofType("run").filter(message => !message.run.running).length === 2, "both turns");

		const users = current.webview.ofType("messageAdded").map(message => message.message).filter(message => message.role === "user");
		assert.deepStrictEqual(users.map(message => message.parts), [
			[{ kind: "text", text: "first" }],
			[{ kind: "text", text: "one\n\ntwo" }],
		]);
		const lastRequest = backend.requests.at(-1);
		assert.ok(lastRequest);
		assert.strictEqual(lastRequest.messages.length, 4);
		assert.strictEqual(messageText(lastRequest.messages[3]), "one\n\ntwo");
	});

	test("a removed queued message is not delivered", async () => {
		const gate = deferred();
		const backend = new FakeBackend([
			async progress => {
				progress.report(new vscode.LanguageModelToolCallPart("call-1", "llamacpp_probe", {}));
				await gate.promise;
			},
			progress => progress.report(new vscode.LanguageModelTextPart("done without the queued text")),
		]);
		const current = createHarness(root, backend, fakeTools(() => ({ text: "tool body", isError: false })).executor);
		harness = current;
		current.webview.receive({ type: "send", text: "first" });
		await waitFor(() => current.webview.ofType("partAdded").some(message => message.part.kind === "toolCall"), "tool call");
		current.webview.receive({ type: "send", text: "never mind" });
		await waitFor(() => current.webview.ofType("queued").some(message => message.queued.length === 1), "queued message");
		const queued = current.webview.ofType("queued").at(-1)?.queued[0];
		assert.ok(queued);
		current.webview.receive({ type: "removeQueued", id: queued.id });
		await waitFor(() => current.webview.ofType("queued").at(-1)?.queued.length === 0, "empty queue");
		gate.resolve();
		await waitFor(() => current.webview.ofType("run").some(message => !message.run.running), "turn end");

		assert.strictEqual(backend.requests.length, 2);
		const users = current.webview.ofType("messageAdded").map(message => message.message).filter(message => message.role === "user");
		assert.deepStrictEqual(users.map(message => message.parts), [[{ kind: "text", text: "first" }]]);
	});

	test("stop takes queued messages back into the draft and cancels the turn", async () => {
		const backend = new FakeBackend([
			async (progress, token) => {
				progress.report(new vscode.LanguageModelTextPart("Working"));
				await new Promise<void>(resolve => token.onCancellationRequested(() => resolve()));
				throw new vscode.CancellationError();
			},
		]);
		const current = createHarness(root, backend);
		harness = current;
		current.webview.receive({ type: "send", text: "first" });
		await waitFor(() => backend.requests.length === 1, "run start");
		current.webview.receive({ type: "send", text: "queued text", attachments: [ATTACHMENT] });
		await waitFor(() => current.webview.ofType("queued").some(message => message.queued.length === 1), "queued message");
		current.webview.receive({ type: "stop" });
		await waitFor(() => current.webview.ofType("run").some(message => !message.run.running), "run stop");

		assert.deepStrictEqual(current.webview.ofType("queued").at(-1)?.queued, []);
		const restore = current.webview.ofType("restoreDraft");
		assert.strictEqual(restore.length, 1);
		assert.strictEqual(restore[0].text, "queued text");
		assert.deepStrictEqual(restore[0].attachments, [ATTACHMENT]);
		assert.strictEqual(backend.requests.length, 1);
		const users = current.webview.ofType("messageAdded").map(message => message.message).filter(message => message.role === "user");
		assert.deepStrictEqual(users.map(message => message.parts), [[{ kind: "text", text: "first" }]]);
	});

	test("init carries the queued messages", async () => {
		const gate = deferred();
		const backend = new FakeBackend([
			async progress => {
				progress.report(new vscode.LanguageModelToolCallPart("call-1", "llamacpp_probe", {}));
				await gate.promise;
			},
			progress => progress.report(new vscode.LanguageModelTextPart("answer")),
		]);
		const current = createHarness(root, backend, fakeTools(() => ({ text: "tool body", isError: false })).executor);
		harness = current;
		current.webview.receive({ type: "ready" });
		await waitFor(() => current.webview.ofType("init").length === 1, "init");
		current.webview.receive({ type: "send", text: "first" });
		await waitFor(() => current.webview.ofType("partAdded").some(message => message.part.kind === "toolCall"), "tool call");
		current.webview.receive({ type: "send", text: "queued text" });
		await waitFor(() => current.webview.ofType("queued").some(message => message.queued.length === 1), "queued message");
		current.webview.receive({ type: "ready" });
		await waitFor(() => current.webview.ofType("init").length === 2, "second init");
		assert.deepStrictEqual(current.webview.ofType("init")[1].queued?.map(message => message.text), ["queued text"]);

		current.webview.receive({ type: "stop" });
		gate.resolve();
		await waitFor(() => current.webview.ofType("run").some(message => !message.run.running), "run stop");
	});

	test("a running turn keeps tool results full and the finished message gets a preview", async () => {
		const full = "x".repeat(WEBVIEW_TOOL_RESULT_PREVIEW_CHARS + 500);
		const gate = deferred();
		const backend = new FakeBackend([
			progress => progress.report(new vscode.LanguageModelToolCallPart("call-big", "llamacpp_read", {})),
			async progress => {
				progress.report(new vscode.LanguageModelTextPart("Done."));
				await gate.promise;
			},
		]);
		const current = createHarness(root, backend, fakeTools(() => ({ text: full, isError: false })).executor);
		harness = current;
		current.webview.receive({ type: "send", text: "Read everything" });
		await waitFor(() => current.webview.ofType("partAdded").some(message => message.part.kind === "toolResult"), "tool result broadcast");

		const broadcast = current.webview.ofType("partAdded").find(message => message.part.kind === "toolResult");
		if (!broadcast || broadcast.part.kind !== "toolResult") {
			throw new Error("expected a tool result");
		}
		assert.strictEqual(broadcast.part.preview, undefined);
		assert.strictEqual(broadcast.part.text, full);

		current.webview.receive({ type: "ready" });
		await waitFor(() => current.webview.ofType("init").length === 1, "running init");
		const runningResult = current.webview.ofType("init")[0].messages.flatMap(message => message.parts).find(part => part.kind === "toolResult");
		if (runningResult?.kind !== "toolResult") {
			throw new Error("expected a tool result in the running init");
		}
		assert.strictEqual(runningResult.preview, undefined);
		assert.strictEqual(runningResult.text, full);

		gate.resolve();
		await waitFor(() => current.webview.ofType("run").some(message => !message.run.running), "turn end");
		current.webview.receive({ type: "ready" });
		await waitFor(() => current.webview.ofType("init").length === 2, "finished init");
		const initResult = current.webview.ofType("init")[1].messages.flatMap(message => message.parts).find(part => part.kind === "toolResult");
		if (initResult?.kind !== "toolResult") {
			throw new Error("expected a tool result in init");
		}
		assert.strictEqual(initResult.preview, true);
		assert.strictEqual(initResult.text.length, WEBVIEW_TOOL_RESULT_PREVIEW_CHARS);
		assert.ok(full.startsWith(initResult.text));
		assert.strictEqual(initResult.fullLength, full.length);

		current.webview.receive({ type: "loadToolResult", messageId: broadcast.messageId, callId: "call-big" });
		await waitFor(() => current.webview.ofType("toolResultFull").length === 1, "full tool result");
		const loaded = current.webview.ofType("toolResultFull")[0];
		assert.strictEqual(loaded.messageId, broadcast.messageId);
		assert.strictEqual(loaded.callId, "call-big");
		assert.strictEqual(loaded.text, full);

		await current.store.flush();
		const sessionId = current.state.get<string>(ACTIVE_SESSION_KEY);
		if (!sessionId) {
			throw new Error("no active session");
		}
		const persisted = await new ChatSessionStore(root).load(sessionId);
		const persistedResult = persisted.flatMap(message => message.parts).find(part => part.kind === "toolResult");
		if (persistedResult?.kind !== "toolResult") {
			throw new Error("expected a persisted tool result");
		}
		assert.strictEqual(persistedResult.text, full);
		assert.strictEqual(persistedResult.preview, undefined);
	});

	test("webview views of a tool result keep image labels but never the base64", async () => {
		const backend = new FakeBackend([
			progress => progress.report(new vscode.LanguageModelToolCallPart("call-img", "llamacpp_view", {})),
			progress => progress.report(new vscode.LanguageModelTextPart("Seen.")),
		]);
		const data = Buffer.from([1, 2, 3]).toString("base64");
		const current = createHarness(root, backend, fakeTools(() => ({
			text: "Image a.png",
			isError: false,
			images: [{ mimeType: "image/png", data, byteLength: 3, name: "a.png" }],
		})).executor);
		harness = current;
		current.webview.receive({ type: "send", text: "Look" });
		await waitFor(() => current.webview.ofType("partAdded").some(message => message.part.kind === "toolResult"), "tool result broadcast");
		const broadcast = current.webview.ofType("partAdded").map(message => message.part).find(part => part.kind === "toolResult");
		if (!broadcast || broadcast.kind !== "toolResult") {
			throw new Error("expected a tool result");
		}
		assert.deepStrictEqual(broadcast.images, [{ mimeType: "image/png", byteLength: 3, name: "a.png" }]);

		current.webview.receive({ type: "ready" });
		await waitFor(() => current.webview.ofType("init").length === 1, "running init");
		const initResult = current.webview.ofType("init")[0].messages.flatMap(message => message.parts).find(part => part.kind === "toolResult");
		if (initResult?.kind !== "toolResult") {
			throw new Error("expected a tool result in init");
		}
		assert.deepStrictEqual(initResult.images, [{ mimeType: "image/png", byteLength: 3, name: "a.png" }]);

		await waitFor(() => backend.requests.length === 2, "second request");
		const sent = backend.requests[1].messages.flatMap(message => message.content).find(part => part instanceof vscode.LanguageModelToolResultPart);
		assert.ok(sent instanceof vscode.LanguageModelToolResultPart);
		assert.strictEqual(sent.content.length, 2);
		const image = sent.content[1];
		assert.ok(image instanceof vscode.LanguageModelDataPart);
		assert.strictEqual(image.mimeType, "image/png");
	});

	test("openToolImage opens only a matching image and survives failures", async () => {
		const backend = new FakeBackend([
			progress => progress.report(new vscode.LanguageModelToolCallPart("call-img", "llamacpp_view", {})),
			progress => progress.report(new vscode.LanguageModelTextPart("Seen.")),
		]);
		const data = Buffer.from([1, 2, 3]).toString("base64");
		const calls: Array<{ image: { mimeType: string; data: string; name?: string }; key: string }> = [];
		const logs: string[] = [];
		let fail = false;
		const current = createHarness(root, backend, fakeTools(() => ({ text: "Image", isError: false, images: [{ mimeType: "image/png", data, byteLength: 3, name: "a.png" }] })).executor, undefined, {
			openImage: async (image, key) => {
				calls.push({ image, key });
				if (fail) {
					throw new Error("viewer failed");
				}
			},
			log: event => { logs.push(event); },
		});
		harness = current;
		current.webview.receive({ type: "send", text: "Look" });
		await waitFor(() => current.webview.ofType("partAdded").some(item => item.part.kind === "toolResult"), "tool result");
		const result = current.webview.ofType("partAdded").find(item => item.part.kind === "toolResult");
		if (!result) {
			throw new Error("expected tool result");
		}
		const messageId = result.messageId;
		current.webview.receive({ type: "openToolImage", messageId: "unknown", callId: "call-img", index: 0 });
		current.webview.receive({ type: "openToolImage", messageId, callId: "unknown", index: 0 });
		current.webview.receive({ type: "openToolImage", messageId, callId: "call-img", index: 1 });
		current.webview.receive({ type: "openToolImage", messageId, callId: "call-img", index: 0 });
		await waitFor(() => calls.length === 1, "image opened");
		assert.deepStrictEqual(calls, [{ image: { mimeType: "image/png", data, name: "a.png" }, key: `${messageId}-call-img-0` }]);
		fail = true;
		current.webview.receive({ type: "openToolImage", messageId, callId: "call-img", index: 0 });
		await waitFor(() => logs.includes("chat.image.open_failed"), "open failure logged");
		current.webview.receive({ type: "ready" });
		await waitFor(() => current.webview.ofType("init").length === 1, "controller still responds");
		assert.strictEqual(calls.length, 2);
	});

	test("openFileReference passes a valid target to the opener and survives failures", async () => {
		const targets: string[] = [];
		const logs: string[] = [];
		const current = createHarness(root, new FakeBackend(), undefined, undefined, {
			openFileReference: async target => {
				targets.push(target);
				if (target === "broken.md") {
					throw new Error("open failed");
				}
			},
			log: event => { logs.push(event); },
		});
		harness = current;
		current.webview.receive({ type: "openFileReference", target: 42 });
		current.webview.receive({ type: "openFileReference", target: "" });
		current.webview.receive({ type: "openFileReference", target: "x".repeat(2049) });
		current.webview.receive({ type: "openFileReference", target: "docs/CHAT.md#L12" });
		current.webview.receive({ type: "openFileReference", target: "broken.md" });
		await waitFor(() => logs.includes("chat.file_reference.open_failed"), "open failure logged");
		assert.deepStrictEqual(targets, ["docs/CHAT.md#L12", "broken.md"]);
		current.webview.receive({ type: "ready" });
		await waitFor(() => current.webview.ofType("init").length === 1, "controller still responds");
	});

	test("init loads only the newest requests", async () => {
		const store = new ChatSessionStore(root);
		const meta = await store.create();
		for (let i = 1; i <= 4; i++) {
			await store.appendMessage(meta.id, { id: `u${i}`, role: "user", turn: i, createdAt: i, parts: [] });
			await store.appendMessage(meta.id, { id: `a${i}`, role: "assistant", turn: i, createdAt: i, parts: [] });
			await store.endMessage(meta.id, `a${i}`);
		}
		const current = createHarness(root, new FakeBackend(), undefined, undefined, { maxRequests: 2 });
		harness = current;
		await current.state.update(ACTIVE_SESSION_KEY, meta.id);
		current.webview.receive({ type: "ready" });
		await waitFor(() => current.webview.ofType("init").length === 1, "init");
		assert.deepStrictEqual(current.webview.ofType("init")[0].messages.map(message => message.id), ["u3", "a3", "u4", "a4"]);
	});

	test("init trims long thinking to its tail and loads the full text on request", async () => {
		const current = createHarness(root, new FakeBackend());
		harness = current;
		const meta = await current.store.create("codex::fast");
		const thinking = `Start of the reasoning. ${"checked one more message height. ".repeat(80)}Final tail line.`;
		assert.ok(thinking.length > WEBVIEW_THINKING_PREVIEW_CHARS);
		await current.store.appendMessage(meta.id, {
			id: "thinking-message",
			role: "assistant",
			turn: 1,
			createdAt: 1,
			modelId: "codex::fast",
			parts: [{ kind: "thinking", text: thinking }, { kind: "text", text: "Done." }],
		});
		await current.store.flush();
		await current.state.update(ACTIVE_SESSION_KEY, meta.id);
		current.webview.receive({ type: "ready" });
		await waitFor(() => current.webview.ofType("init").length === 1, "init");

		const part = current.webview.ofType("init")[0].messages[0].parts[0];
		if (part.kind !== "thinking") {
			throw new Error("expected a thinking part");
		}
		assert.strictEqual(part.preview, true);
		assert.strictEqual(part.text.length, WEBVIEW_THINKING_PREVIEW_CHARS);
		assert.strictEqual(part.text, thinking.slice(-WEBVIEW_THINKING_PREVIEW_CHARS));
		assert.ok(part.text.endsWith("Final tail line."));

		current.webview.receive({ type: "loadPartText", messageId: "thinking-message", index: 0 });
		await waitFor(() => current.webview.ofType("partTextFull").length === 1, "full thinking");
		const loaded = current.webview.ofType("partTextFull")[0];
		assert.strictEqual(loaded.messageId, "thinking-message");
		assert.strictEqual(loaded.index, 0);
		assert.strictEqual(loaded.text, thinking);
	});

	test("the running turn's thinking is not trimmed when switching back to it", async () => {
		const ThinkingPart = (vscode as unknown as Record<string, unknown>)["LanguageModelThinkingPart"] as
			(new (value: string) => vscode.LanguageModelResponsePart) | undefined;
		if (!ThinkingPart) {
			return;
		}
		const gate = deferred();
		const thinking = `${"checked one more message height. ".repeat(120)}last thought`;
		const backend = new FakeBackend([
			async progress => {
				progress.report(new ThinkingPart(thinking));
				await gate.promise;
				progress.report(new vscode.LanguageModelTextPart("Done."));
			},
		]);
		const current = createHarness(root, backend);
		harness = current;
		current.webview.receive({ type: "ready" });
		await waitFor(() => current.webview.ofType("init").length === 1, "init");
		current.webview.receive({ type: "send", text: "Think it through" });
		await waitFor(() => current.webview.ofType("textDelta").some(message => message.kind === "thinking"), "thinking delta");
		const first = current.state.get<string>(ACTIVE_SESSION_KEY);
		assert.ok(first);
		current.webview.receive({ type: "newChat" });
		await waitFor(() => current.webview.ofType("init").length === 2, "second init");
		current.webview.receive({ type: "openSession", sessionId: first });
		await waitFor(() => current.webview.ofType("init").length === 3, "third init");

		const assistant = current.webview.ofType("init")[2].messages.find(message => message.role === "assistant");
		assert.ok(assistant);
		const part = assistant.parts.find(candidate => candidate.kind === "thinking");
		if (part?.kind !== "thinking") {
			throw new Error("expected a thinking part");
		}
		assert.strictEqual(part.text, thinking);
		assert.strictEqual(part.preview, undefined);

		gate.resolve();
		await waitFor(() => current.webview.ofType("run").some(message => !message.run.running), "turn end");
	});

	test("a long chat's init stays small", async function () {
		this.timeout(60_000);
		const current = createHarness(root, new FakeBackend());
		harness = current;
		const meta = await current.store.create("codex::fast");
		const full = "x".repeat(20_000);
		for (let turn = 1; turn <= 1_000; turn += 1) {
			await current.store.appendMessage(meta.id, {
				id: `u${turn}`,
				role: "user",
				turn,
				createdAt: turn,
				parts: [{ kind: "text", text: `Question ${turn}` }],
			});
			await current.store.appendMessage(meta.id, {
				id: `a${turn}`,
				role: "assistant",
				turn,
				createdAt: turn,
				modelId: "codex::fast",
				parts: [1, 2, 3].flatMap(index => [
					{ kind: "toolCall" as const, callId: `c${turn}-${index}`, name: "read_file", input: { filePath: `src/file-${turn}-${index}.ts` } },
					{ kind: "toolResult" as const, callId: `c${turn}-${index}`, text: full },
				]),
			});
		}
		await current.store.flush();
		await current.state.update(ACTIVE_SESSION_KEY, meta.id);
		current.webview.receive({ type: "ready" });
		await waitFor(() => current.webview.ofType("init").length === 1, "init");

		const init = current.webview.ofType("init")[0];
		const size = JSON.stringify(init).length;
		assert.ok(size < 3 * 1024 * 1024, `init was ${size} chars`);
		const results = init.messages.flatMap(message => message.parts).filter((part): part is Extract<ChatMessage["parts"][number], { kind: "toolResult" }> => part.kind === "toolResult");
		assert.strictEqual(results.length, 3_000);
		assert.ok(results.every(part => part.preview === true && part.text.length === WEBVIEW_TOOL_RESULT_PREVIEW_CHARS && part.fullLength === full.length));
	});

	test("persists a selected model on the session and the workspace state", async () => {
		const current = createHarness(root, new FakeBackend());
		harness = current;
		current.webview.receive({ type: "ready" });
		await waitFor(() => current.webview.ofType("init").length === 1, "init");

		current.webview.receive({ type: "selectModel", modelId: "claude::smart" });
		await waitFor(() => current.webview.ofType("models").some(message => message.selectedModelId === "claude::smart"), "model selection");
		await current.store.flush();
		const sessionId = current.state.get<string>(ACTIVE_SESSION_KEY);
		if (!sessionId) {
			throw new Error("no active session");
		}
		assert.strictEqual((await new ChatSessionStore(root).get(sessionId))?.modelId, "claude::smart");
		assert.strictEqual(current.state.get<string>(LAST_MODEL_KEY), "claude::smart");

		current.webview.receive({ type: "selectModel", modelId: "missing::model" });
		await new Promise<void>(resolve => setTimeout(resolve, 30));
		assert.strictEqual(current.webview.ofType("models").length, 1);
	});

	test("remembers a reasoning level per model and sends it with the next request", async () => {
		const backend = new FakeBackend([
			progress => progress.report(new vscode.LanguageModelTextPart("first answer")),
			progress => progress.report(new vscode.LanguageModelTextPart("second answer")),
		]);
		const current = createHarness(root, backend);
		harness = current;
		const finished = (): number => current.webview.ofType("run").filter(message => !message.run.running).length;
		current.webview.receive({ type: "ready" });
		await waitFor(() => current.webview.ofType("init").length === 1, "init");
		const init = current.webview.ofType("init")[0];
		assert.ok(init.models.flatMap(group => group.models).every(model => model.thinking !== undefined));

		current.webview.receive({ type: "send", text: "first" });
		await waitFor(() => finished() === 1, "first turn");
		assert.strictEqual(backend.requests.at(-1)?.options.modelOptions?.reasoningEffort, undefined);

		current.webview.receive({ type: "selectThinking", value: "high" });
		await waitFor(() => current.webview.ofType("models").some(message => message.selectedThinking === "high"), "thinking selection");
		assert.deepStrictEqual(current.state.get<Record<string, unknown>>(THINKING_KEY), { "codex::fast": "high" });

		current.webview.receive({ type: "selectThinking", value: "ultra" });
		await new Promise<void>(resolve => setTimeout(resolve, 30));
		assert.strictEqual(current.webview.ofType("models").length, 1);
		assert.deepStrictEqual(current.state.get<Record<string, unknown>>(THINKING_KEY), { "codex::fast": "high" });

		current.webview.receive({ type: "send", text: "second" });
		await waitFor(() => finished() === 2, "second turn");
		assert.strictEqual(backend.requests.at(-1)?.options.modelOptions?.reasoningEffort, "high");
	});

	test("reports each model's own stored reasoning level when the selection changes", async () => {
		const current = createHarness(root, new FakeBackend());
		harness = current;
		current.webview.receive({ type: "ready" });
		await waitFor(() => current.webview.ofType("init").length === 1, "init");
		const lastModels = () => current.webview.ofType("models").at(-1);

		current.webview.receive({ type: "selectThinking", value: "high" });
		await waitFor(() => lastModels()?.selectedThinking === "high", "codex level");

		current.webview.receive({ type: "selectModel", modelId: "claude::smart" });
		await waitFor(() => lastModels()?.selectedModelId === "claude::smart", "claude selection");
		assert.strictEqual(lastModels()?.selectedThinking, undefined);

		current.webview.receive({ type: "selectThinking", value: "low" });
		await waitFor(() => lastModels()?.selectedThinking === "low", "claude level");

		current.webview.receive({ type: "selectModel", modelId: "codex::fast" });
		await waitFor(() => lastModels()?.selectedModelId === "codex::fast", "codex selection again");
		assert.strictEqual(lastModels()?.selectedThinking, "high");
	});

	test("carries the quota snapshot in init and refreshes it at most once every 30 seconds", async () => {
		const initial: ChatProviderQuota[] = [
			{ provider: "Codex", plan: "Pro", windows: [{ label: "5h", percent: 42 }, { label: "Week", percent: 12 }] },
			{ provider: "DeepSeek", windows: [], balance: "$12.30" },
		];
		const quota = fakeQuota(initial.map(entry => ({ ...entry, windows: entry.windows.map(window => ({ ...window })) })));
		try {
			const current = createHarness(root, new FakeBackend(), undefined, undefined, { quota: quota.source });
			harness = current;
			current.webview.receive({ type: "ready" });
			await waitFor(() => current.webview.ofType("init").length === 1, "init");
			assert.deepStrictEqual(current.webview.ofType("init")[0].quota, initial);

			current.webview.receive({ type: "refreshQuota" });
			await waitFor(() => current.webview.ofType("quota").length === 1, "first quota broadcast");
			current.webview.receive({ type: "refreshQuota" });
			await waitFor(() => current.webview.ofType("quota").length === 2, "second quota broadcast");
			assert.strictEqual(quota.refreshes, 1);
			assert.deepStrictEqual(current.webview.ofType("quota").map(message => message.quota), [initial, initial]);
		} finally {
			quota.dispose();
		}
	});

	test("broadcasts a changed quota once per burst and skips an unchanged snapshot", async () => {
		const initial: ChatProviderQuota[] = [{ provider: "Codex", windows: [{ label: "5h", percent: 42 }] }];
		const changed: ChatProviderQuota[] = [{ provider: "Codex", windows: [{ label: "5h", percent: 75 }] }];
		const quota = fakeQuota(initial);
		try {
			const current = createHarness(root, new FakeBackend(), undefined, undefined, { quota: quota.source });
			harness = current;
			current.webview.receive({ type: "ready" });
			await waitFor(() => current.webview.ofType("init").length === 1, "init");

			quota.set(changed);
			quota.fire();
			quota.fire();
			quota.fire();
			await waitFor(() => current.webview.ofType("quota").length === 1, "coalesced quota broadcast");
			assert.deepStrictEqual(current.webview.ofType("quota")[0].quota, changed);

			quota.fire();
			await new Promise<void>(resolve => setTimeout(resolve, 2_300));
			assert.strictEqual(current.webview.ofType("quota").length, 1);
		} finally {
			quota.dispose();
		}
	});

	test("refreshes provider limits after a model selection, at most once per interval", async () => {
		const quota = fakeQuota([{ provider: "Codex", windows: [{ label: "5h", percent: 42 }] }]);
		try {
			const current = createHarness(root, new FakeBackend(), undefined, undefined, { quota: quota.source });
			harness = current;
			current.webview.receive({ type: "ready" });
			await waitFor(() => current.webview.ofType("init").length === 1, "init");
			assert.strictEqual(quota.refreshes, 0);

			current.webview.receive({ type: "selectModel", modelId: "claude::smart" });
			await waitFor(() => quota.refreshes === 1, "the refresh after the first selection");
			await waitFor(() => current.webview.ofType("models").at(-1)?.selectedModelId === "claude::smart", "the first selection");

			current.webview.receive({ type: "selectModel", modelId: "codex::fast" });
			await waitFor(() => current.webview.ofType("models").at(-1)?.selectedModelId === "codex::fast", "the second selection");
			await new Promise<void>(resolve => setTimeout(resolve, 50));
			assert.strictEqual(quota.refreshes, 1);
		} finally {
			quota.dispose();
		}
	});

	test("init carries the sign-in offers", async () => {
		const accounts = fakeAccounts([CODEX_OFFER, CLAUDE_OFFER]);
		try {
			const current = createHarness(root, new FakeBackend(), undefined, undefined, { accounts: accounts.source });
			harness = current;
			current.webview.receive({ type: "ready" });
			await waitFor(() => current.webview.ofType("init").length === 1, "init");
			assert.deepStrictEqual(current.webview.ofType("init")[0].signIn, [CODEX_OFFER, CLAUDE_OFFER]);
		} finally {
			accounts.dispose();
		}
	});

	test("signIn starts an offered sign-in and then re-sends the models with the offers left", async () => {
		const accounts = fakeAccounts([CODEX_OFFER, CLAUDE_OFFER]);
		accounts.onSignIn = provider => {
			accounts.current = accounts.current.filter(offer => offer.provider !== provider);
		};
		try {
			const current = createHarness(root, new FakeBackend(), undefined, undefined, { accounts: accounts.source });
			harness = current;
			current.webview.receive({ type: "ready" });
			await waitFor(() => current.webview.ofType("init").length === 1, "init");
			const before = current.webview.ofType("models").length;

			current.webview.receive({ type: "signIn", provider: "codex" });
			await waitFor(() => current.webview.ofType("models").length > before, "models after the sign-in");
			assert.deepStrictEqual(accounts.signIns, ["codex"]);
			assert.deepStrictEqual(current.webview.ofType("models").at(-1)?.signIn, [CLAUDE_OFFER]);
		} finally {
			accounts.dispose();
		}
	});

	test("signIn accepts an offered named Codex account", async () => {
		const accounts = fakeAccounts([{ ...CODEX_OFFER, provider: "codex:work" }]);
		try {
			const current = createHarness(root, new FakeBackend(), undefined, undefined, { accounts: accounts.source });
			harness = current;
			current.webview.receive({ type: "ready" });
			await waitFor(() => current.webview.ofType("init").length === 1, "init");
			current.webview.receive({ type: "signIn", provider: "codex:work" });
			await waitFor(() => accounts.signIns.length === 1, "sign-in");
			assert.deepStrictEqual(accounts.signIns, ["codex:work"]);
		} finally {
			accounts.dispose();
		}
	});

	test("signIn ignores providers that are not offered or not valid ids", async () => {
		const accounts = fakeAccounts([CODEX_OFFER]);
		try {
			const current = createHarness(root, new FakeBackend(), undefined, undefined, { accounts: accounts.source });
			harness = current;
			current.webview.receive({ type: "ready" });
			await waitFor(() => current.webview.ofType("init").length === 1, "init");
			const before = current.webview.ofType("models").length;

			current.webview.receive({ type: "signIn", provider: "claude" });
			current.webview.receive({ type: "signIn", provider: "Bad Provider!" });
			current.webview.receive({ type: "signIn" });
			await new Promise<void>(resolve => setTimeout(resolve, 50));
			assert.deepStrictEqual(accounts.signIns, []);
			assert.strictEqual(current.webview.ofType("models").length, before);
		} finally {
			accounts.dispose();
		}
	});

	test("a change of the account source re-sends the models with the new offers", async () => {
		const accounts = fakeAccounts([]);
		try {
			const current = createHarness(root, new FakeBackend(), undefined, undefined, { accounts: accounts.source });
			harness = current;
			current.webview.receive({ type: "ready" });
			await waitFor(() => current.webview.ofType("init").length === 1, "init");
			assert.deepStrictEqual(current.webview.ofType("init")[0].signIn, []);

			accounts.current = [CLAUDE_OFFER];
			accounts.fire();
			await waitFor(() => current.webview.ofType("models").some(message => message.signIn?.length === 1), "models with the new offer");
			assert.deepStrictEqual(current.webview.ofType("models").at(-1)?.signIn, [CLAUDE_OFFER]);
		} finally {
			accounts.dispose();
		}
	});

	test("failing offers are logged and leave init without offers", async () => {
		const events: Array<{ event: string; data: Record<string, unknown> }> = [];
		const accounts: ChatAccountSource = {
			offers: () => {
				throw new Error("status check failed");
			},
			signIn: async () => undefined,
		};
		const current = createHarness(root, new FakeBackend(), undefined, undefined, { accounts, log: (event, data) => events.push({ event, data }) });
		harness = current;
		current.webview.receive({ type: "ready" });
		await waitFor(() => current.webview.ofType("init").length === 1, "init");
		const init = current.webview.ofType("init")[0];
		assert.deepStrictEqual(init.signIn, []);
		assert.deepStrictEqual(init.models, groupModels(MODELS));
		assert.ok(events.some(entry => entry.event === "chat.accounts.offers_failed" && entry.data.message === "status check failed"));
	});

	test("newChat creates another session and sends init", async () => {
		const current = createHarness(root, new FakeBackend());
		harness = current;
		current.webview.receive({ type: "ready" });
		await waitFor(() => current.webview.ofType("init").length === 1, "init");
		const first = current.webview.ofType("init")[0].session.id;

		current.webview.receive({ type: "newChat" });
		await waitFor(() => current.webview.ofType("init").length === 2, "second init");
		const second = current.webview.ofType("init")[1];
		assert.notStrictEqual(second.session.id, first);
		assert.strictEqual(current.state.get<string>(ACTIVE_SESSION_KEY), second.session.id);
		assert.strictEqual(second.session.modelId, "codex::fast");
		assert.deepStrictEqual(second.messages, []);
		assert.deepStrictEqual(second.run, { running: false });
		await waitForAsync(async () => (await current.store.get(first)) === undefined, "the empty first chat to be deleted");
		assert.strictEqual((await current.store.list()).length, 1);
	});

	test("newChat abandons the previous session", async () => {
		const abandoned: string[] = [];
		const current = createHarness(root, new FakeBackend(), undefined, undefined, {
			abandonConversation: async conversationId => { abandoned.push(conversationId); },
		});
		harness = current;
		current.webview.receive({ type: "ready" });
		await waitFor(() => current.webview.ofType("init").length === 1, "init");
		const previous = current.webview.ofType("init")[0].session.id;

		current.webview.receive({ type: "newChat" });
		await waitFor(() => current.webview.ofType("init").length === 2, "second init");
		assert.deepStrictEqual(abandoned, [previous]);
	});

	test("a failing abandonConversation does not break newChat", async () => {
		const current = createHarness(root, new FakeBackend(), undefined, undefined, {
			abandonConversation: async () => { throw new Error("cannot abandon"); },
		});
		harness = current;
		current.webview.receive({ type: "ready" });
		await waitFor(() => current.webview.ofType("init").length === 1, "init");

		current.webview.receive({ type: "newChat" });
		await waitFor(() => current.webview.ofType("init").length === 2, "second init");
		assert.strictEqual(current.webview.ofType("init").length, 2);
	});

	test("listSessions sends the chats newest first without empty ones", async () => {
		const backend = new FakeBackend([
			progress => progress.report(new vscode.LanguageModelTextPart("one")),
			progress => progress.report(new vscode.LanguageModelTextPart("two")),
		]);
		const current = createHarness(root, backend);
		harness = current;
		const finishedTurns = (): number => current.webview.ofType("run").filter(message => !message.run.running).length;
		current.webview.receive({ type: "ready" });
		await waitFor(() => current.webview.ofType("init").length === 1, "init");
		const first = current.webview.ofType("init")[0].session.id;
		current.webview.receive({ type: "send", text: "first chat" });
		await waitFor(() => finishedTurns() === 1, "first turn");
		current.webview.receive({ type: "newChat" });
		await waitFor(() => current.webview.ofType("init").length === 2, "second init");
		const second = current.webview.ofType("init")[1].session.id;
		current.webview.receive({ type: "send", text: "second chat" });
		await waitFor(() => finishedTurns() === 2, "second turn");
		await current.store.create("codex::fast");

		current.webview.receive({ type: "listSessions" });
		await waitFor(() => current.webview.ofType("sessions").length === 1, "sessions message");
		const listed = current.webview.ofType("sessions")[0];
		assert.deepStrictEqual(listed.sessions.map(meta => meta.id), [second, first]);
		assert.strictEqual(listed.activeId, second);
	});

	test("openSession switches to another chat and abandons the previous one", async () => {
		const abandoned: string[] = [];
		const backend = new FakeBackend([
			progress => progress.report(new vscode.LanguageModelTextPart("one")),
			progress => progress.report(new vscode.LanguageModelTextPart("two")),
		]);
		const current = createHarness(root, backend, undefined, undefined, {
			abandonConversation: async conversationId => { abandoned.push(conversationId); },
		});
		harness = current;
		const finishedTurns = (): number => current.webview.ofType("run").filter(message => !message.run.running).length;
		current.webview.receive({ type: "ready" });
		await waitFor(() => current.webview.ofType("init").length === 1, "init");
		const first = current.webview.ofType("init")[0].session.id;
		current.webview.receive({ type: "send", text: "in A" });
		await waitFor(() => finishedTurns() === 1, "first turn");
		current.webview.receive({ type: "newChat" });
		await waitFor(() => current.webview.ofType("init").length === 2, "second init");
		const second = current.webview.ofType("init")[1].session.id;
		current.webview.receive({ type: "send", text: "in B" });
		await waitFor(() => finishedTurns() === 2, "second turn");

		current.webview.receive({ type: "openSession", sessionId: first });
		await waitFor(() => current.webview.ofType("init").length === 3, "third init");
		const opened = current.webview.ofType("init")[2];
		assert.strictEqual(opened.session.id, first);
		assert.deepStrictEqual(opened.messages.map(message => message.role), ["user", "assistant"]);
		assert.strictEqual(current.state.get<string>(ACTIVE_SESSION_KEY), first);
		await waitForAsync(async () => abandoned.at(-1) === second, "the previous chat to be abandoned");
		assert.strictEqual((await current.store.get(second))?.messageCount, 2);
	});

	test("openSession of the active chat does nothing", async () => {
		const current = createHarness(root, new FakeBackend());
		harness = current;
		current.webview.receive({ type: "ready" });
		await waitFor(() => current.webview.ofType("init").length === 1, "init");
		const active = current.webview.ofType("init")[0].session.id;

		current.webview.receive({ type: "openSession", sessionId: active });
		await new Promise<void>(resolve => setTimeout(resolve, 50));
		assert.strictEqual(current.webview.ofType("init").length, 1);
	});

	test("openSession of an unknown chat re-sends the list", async () => {
		const current = createHarness(root, new FakeBackend());
		harness = current;
		current.webview.receive({ type: "ready" });
		await waitFor(() => current.webview.ofType("init").length === 1, "init");
		const active = current.webview.ofType("init")[0].session.id;

		current.webview.receive({ type: "openSession", sessionId: "missing-chat" });
		await waitFor(() => current.webview.ofType("sessions").length === 1, "sessions message");
		assert.strictEqual(current.webview.ofType("sessions")[0].activeId, active);
		assert.strictEqual(current.webview.ofType("init").length, 1);
	});

	test("leaving an empty chat deletes it", async () => {
		const backend = new FakeBackend([progress => progress.report(new vscode.LanguageModelTextPart("answer"))]);
		const current = createHarness(root, backend);
		harness = current;
		current.webview.receive({ type: "ready" });
		await waitFor(() => current.webview.ofType("init").length === 1, "init");
		const first = current.webview.ofType("init")[0].session.id;

		current.webview.receive({ type: "newChat" });
		await waitFor(() => current.webview.ofType("init").length === 2, "second init");
		await waitForAsync(async () => (await current.store.get(first)) === undefined, "the empty first chat to be deleted");

		const second = current.webview.ofType("init")[1].session.id;
		current.webview.receive({ type: "send", text: "keep me" });
		await waitFor(() => current.webview.ofType("run").some(message => !message.run.running), "turn");
		current.webview.receive({ type: "newChat" });
		await waitFor(() => current.webview.ofType("init").length === 3, "third init");
		await new Promise<void>(resolve => setTimeout(resolve, 50));
		assert.strictEqual((await current.store.get(second))?.messageCount, 2);
	});

	test("deleteSession asks first and keeps the chat when declined", async () => {
		const answers: Array<{ message: string; action: string }> = [];
		const backend = new FakeBackend([progress => progress.report(new vscode.LanguageModelTextPart("answer"))]);
		const current = createHarness(root, backend, undefined, undefined, {
			confirm: async (message, action) => {
				answers.push({ message, action });
				return false;
			},
		});
		harness = current;
		current.webview.receive({ type: "ready" });
		await waitFor(() => current.webview.ofType("init").length === 1, "init");
		const id = current.webview.ofType("init")[0].session.id;
		current.webview.receive({ type: "send", text: "Keep this one" });
		await waitFor(() => current.webview.ofType("run").some(message => !message.run.running), "turn");
		await current.store.flush();
		const meta = await current.store.get(id);
		assert.ok(meta);

		current.webview.receive({ type: "deleteSession", sessionId: id });
		await waitFor(() => answers.length === 1, "confirmation");
		assert.strictEqual(answers[0].action, "Delete");
		assert.ok(answers[0].message.includes(meta.title));
		assert.ok(await current.store.get(id));
		assert.strictEqual(current.webview.ofType("sessions").length, 0);
	});

	test("deleteSession removes another chat, forgets its changes and abandons it", async () => {
		const closed: string[] = [];
		const abandoned: string[] = [];
		const tracker = new FakeForgettingTracker([]);
		const backend = new FakeBackend([
			progress => progress.report(new vscode.LanguageModelTextPart("one")),
			progress => progress.report(new vscode.LanguageModelTextPart("two")),
		]);
		const current = createHarness(root, backend, undefined, tracker, {
			abandonConversation: async conversationId => { abandoned.push(conversationId); },
			terminals: { closeOwner: owner => { closed.push(owner); return 0; } },
			confirm: async () => true,
		});
		harness = current;
		const finishedTurns = (): number => current.webview.ofType("run").filter(message => !message.run.running).length;
		current.webview.receive({ type: "ready" });
		await waitFor(() => current.webview.ofType("init").length === 1, "init");
		const first = current.webview.ofType("init")[0].session.id;
		current.webview.receive({ type: "send", text: "in A" });
		await waitFor(() => finishedTurns() === 1, "first turn");
		current.webview.receive({ type: "newChat" });
		await waitFor(() => current.webview.ofType("init").length === 2, "second init");
		const second = current.webview.ofType("init")[1].session.id;
		current.webview.receive({ type: "send", text: "in B" });
		await waitFor(() => finishedTurns() === 2, "second turn");

		current.webview.receive({ type: "deleteSession", sessionId: first });
		await waitFor(() => current.webview.ofType("sessions").length === 1, "sessions message");
		assert.strictEqual(await current.store.get(first), undefined);
		assert.deepStrictEqual(closed, [`chat:${first}`]);
		assert.deepStrictEqual(tracker.forgotten, [first]);
		assert.strictEqual(abandoned.at(-1), first);
		const listed = current.webview.ofType("sessions")[0];
		assert.deepStrictEqual(listed.sessions.map(meta => meta.id), [second]);
		assert.strictEqual(listed.activeId, second);
	});

	test("deleting the active chat opens the newest remaining one", async () => {
		const backend = new FakeBackend([
			progress => progress.report(new vscode.LanguageModelTextPart("one")),
			progress => progress.report(new vscode.LanguageModelTextPart("two")),
		]);
		const current = createHarness(root, backend, undefined, undefined, { confirm: async () => true });
		harness = current;
		const finishedTurns = (): number => current.webview.ofType("run").filter(message => !message.run.running).length;
		current.webview.receive({ type: "ready" });
		await waitFor(() => current.webview.ofType("init").length === 1, "init");
		const first = current.webview.ofType("init")[0].session.id;
		current.webview.receive({ type: "send", text: "in A" });
		await waitFor(() => finishedTurns() === 1, "first turn");
		current.webview.receive({ type: "newChat" });
		await waitFor(() => current.webview.ofType("init").length === 2, "second init");
		const second = current.webview.ofType("init")[1].session.id;
		current.webview.receive({ type: "send", text: "in B" });
		await waitFor(() => finishedTurns() === 2, "second turn");

		current.webview.receive({ type: "deleteSession", sessionId: second });
		await waitFor(() => current.webview.ofType("init").length === 3, "third init");
		const opened = current.webview.ofType("init")[2];
		assert.strictEqual(opened.session.id, first);
		assert.deepStrictEqual(opened.messages.map(message => message.role), ["user", "assistant"]);

		current.webview.receive({ type: "deleteSession", sessionId: first });
		await waitFor(() => current.webview.ofType("init").length === 4, "fourth init");
		const fresh = current.webview.ofType("init")[3];
		assert.notStrictEqual(fresh.session.id, first);
		assert.notStrictEqual(fresh.session.id, second);
		assert.deepStrictEqual(fresh.messages, []);
	});

	test("a running chat keeps going after newChat and its updates stay hidden", async () => {
		const gate = deferred();
		const backend = new FakeBackend([
			async progress => {
				progress.report(new vscode.LanguageModelTextPart("Hello "));
				await gate.promise;
				progress.report(new vscode.LanguageModelTextPart("world"));
			},
		]);
		const current = createHarness(root, backend);
		harness = current;
		current.webview.receive({ type: "ready" });
		await waitFor(() => current.webview.ofType("init").length === 1, "init");
		current.webview.receive({ type: "send", text: "Long story" });
		// The model request marks a started turn; the run flag already shows while the turn is prepared.
		await waitFor(() => backend.requests.length === 1, "run start");
		const first = current.state.get<string>(ACTIVE_SESSION_KEY);
		const assistant = current.webview.ofType("messageAdded").map(message => message.message).find(message => message.role === "assistant");
		assert.ok(first && assistant);

		current.webview.receive({ type: "newChat" });
		await waitFor(() => current.webview.ofType("init").length === 2, "second init");
		const switchedAt = current.webview.messages.length;
		gate.resolve();
		await waitFor(() => current.webview.ofType("activity").some(message => message.activity.some(entry => entry.id === first && entry.state === "finished")), "finished activity");
		await current.store.flush();
		assert.strictEqual(assistantText(await new ChatSessionStore(root).load(first)), "Hello world");

		const late = current.webview.messages.slice(switchedAt).filter(message => message.type === "textDelta" || message.type === "partAdded" || message.type === "run");
		assert.deepStrictEqual(late, []);
		assert.deepStrictEqual(current.webview.ofType("activity").at(-1)?.activity.map(entry => [entry.id, entry.state]), [[first, "finished"]]);
	});

	test("two chats run turns at the same time", async () => {
		const gate = deferred();
		const backend = new FakeBackend([
			async progress => {
				progress.report(new vscode.LanguageModelTextPart("Hello "));
				await gate.promise;
				progress.report(new vscode.LanguageModelTextPart("world"));
			},
			progress => progress.report(new vscode.LanguageModelTextPart("B answer")),
		]);
		const current = createHarness(root, backend);
		harness = current;
		current.webview.receive({ type: "ready" });
		await waitFor(() => current.webview.ofType("init").length === 1, "init");
		current.webview.receive({ type: "send", text: "A question" });
		await waitFor(() => backend.requests.length === 1, "A start");
		const first = current.state.get<string>(ACTIVE_SESSION_KEY);
		assert.ok(first);
		current.webview.receive({ type: "newChat" });
		await waitFor(() => current.webview.ofType("init").length === 2, "second init");
		const second = current.webview.ofType("init")[1].session.id;

		current.webview.receive({ type: "send", text: "B question" });
		await waitFor(() => current.webview.ofType("run").filter(message => !message.run.running).length === 1, "B finished");
		assert.deepStrictEqual(current.webview.ofType("run").map(message => message.run.running), [true, true, false]);
		assert.ok(current.webview.ofType("activity").some(message => message.activity.some(entry => entry.id === first && entry.state === "running")));

		gate.resolve();
		await waitFor(() => current.webview.ofType("activity").some(message => message.activity.some(entry => entry.id === first && entry.state === "finished")), "A finished");
		await current.store.flush();
		assert.strictEqual(assistantText(await new ChatSessionStore(root).load(first)), "Hello world");
		assert.strictEqual(assistantText(await new ChatSessionStore(root).load(second)), "B answer");
	});

	test("returning to a running chat shows the text so far and keeps streaming", async () => {
		const gate = deferred();
		const backend = new FakeBackend([
			async progress => {
				progress.report(new vscode.LanguageModelTextPart("Hello "));
				await gate.promise;
				progress.report(new vscode.LanguageModelTextPart("world"));
			},
		]);
		const current = createHarness(root, backend);
		harness = current;
		current.webview.receive({ type: "ready" });
		await waitFor(() => current.webview.ofType("init").length === 1, "init");
		current.webview.receive({ type: "send", text: "Long story" });
		await waitFor(() => current.webview.ofType("textDelta").some(message => message.text.includes("Hello")), "first delta");
		const first = current.state.get<string>(ACTIVE_SESSION_KEY);
		assert.ok(first);
		current.webview.receive({ type: "newChat" });
		await waitFor(() => current.webview.ofType("init").length === 2, "second init");
		current.webview.receive({ type: "openSession", sessionId: first });
		await waitFor(() => current.webview.ofType("init").length === 3, "third init");
		const opened = current.webview.ofType("init")[2];
		assert.strictEqual(opened.run.running, true);
		const assistant = opened.messages.find(message => message.role === "assistant");
		assert.ok(assistant);
		assert.strictEqual(assistantText(opened.messages), "Hello ");
		const afterInit = current.webview.messages.length;

		gate.resolve();
		await waitFor(() => current.webview.ofType("textDelta").some(message => message.messageId === assistant.id && message.text.includes("world")), "second delta");
		const late = current.webview.messages.slice(afterInit).filter(message => message.type === "textDelta");
		assert.ok(late.every(message => !message.text.includes("Hello")));
	});

	test("a background approval shows in activity, notifies, and can be approved after switching back", async () => {
		const catalog = guardedCatalog();
		const gate = deferred();
		const notifications: Array<{ message: string; action: string }> = [];
		const osNotifications: Array<[string, string]> = [];
		const backend = new FakeBackend([
			async progress => {
				progress.report(new vscode.LanguageModelTextPart("Checking."));
				await gate.promise;
				progress.report(new vscode.LanguageModelToolCallPart("call-g", "guarded", { force: true }));
			},
			progress => progress.report(new vscode.LanguageModelTextPart("pushed")),
		]);
		const current = createHarness(root, backend, catalog.source, undefined, {
			osNotify: (title, body) => osNotifications.push([title, body]),
			notify: async (message, action) => {
				notifications.push({ message, action });
				return false;
			},
		});
		harness = current;
		current.webview.receive({ type: "ready" });
		await waitFor(() => current.webview.ofType("init").length === 1, "init");
		current.webview.receive({ type: "send", text: "push it" });
		await waitFor(() => backend.requests.length === 1, "run start");
		const first = current.state.get<string>(ACTIVE_SESSION_KEY);
		assert.ok(first);
		const title = (await current.store.get(first))?.title ?? "";
		current.webview.receive({ type: "newChat" });
		await waitFor(() => current.webview.ofType("init").length === 2, "second init");

		gate.resolve();
		await waitFor(() => current.webview.ofType("activity").some(message => message.activity.some(entry => entry.id === first && entry.state === "approval")), "approval activity");
		assert.strictEqual(notifications.length, 1);
		assert.strictEqual(notifications[0].action, "Open Chat");
		assert.ok(notifications[0].message.includes(title));

		current.webview.receive({ type: "openSession", sessionId: first });
		await waitFor(() => current.webview.ofType("init").length === 3, "third init");
		const opened = current.webview.ofType("init")[2];
		assert.strictEqual(opened.approvals.length, 1);
		assert.deepStrictEqual(osNotifications, [[title, `Waiting for your approval: ${opened.approvals[0].title}`]]);
		current.webview.receive({ type: "approve", id: opened.approvals[0].id, allow: true });
		await waitFor(() => current.webview.ofType("run").filter(message => !message.run.running).length === 1, "turn end");
		assert.deepStrictEqual(catalog.runs, [{ force: true }]);
		assert.deepStrictEqual(current.webview.ofType("activity").at(-1)?.activity, []);
	});

	test("stop only stops the shown chat", async () => {
		const gate = deferred();
		const backend = new FakeBackend([
			async progress => {
				progress.report(new vscode.LanguageModelTextPart("A working"));
				await gate.promise;
				progress.report(new vscode.LanguageModelTextPart("A done"));
			},
			async (progress, token) => {
				progress.report(new vscode.LanguageModelTextPart("B working"));
				await new Promise<void>(resolve => token.onCancellationRequested(() => resolve()));
				throw new vscode.CancellationError();
			},
		]);
		const current = createHarness(root, backend);
		harness = current;
		current.webview.receive({ type: "ready" });
		await waitFor(() => current.webview.ofType("init").length === 1, "init");
		current.webview.receive({ type: "send", text: "A question" });
		await waitFor(() => backend.requests.length === 1, "A start");
		const first = current.state.get<string>(ACTIVE_SESSION_KEY);
		assert.ok(first);
		current.webview.receive({ type: "newChat" });
		await waitFor(() => current.webview.ofType("init").length === 2, "second init");
		current.webview.receive({ type: "send", text: "B question" });
		await waitFor(() => current.webview.ofType("run").filter(message => message.run.running).length === 2, "B start");

		current.webview.receive({ type: "stop" });
		await waitFor(() => current.webview.ofType("run").filter(message => !message.run.running).length === 1, "B stopped");
		const notice = current.webview.ofType("partAdded").map(message => message.part).find(part => part.kind === "notice");
		assert.deepStrictEqual(notice, { kind: "notice", level: "info", text: "Stopped." });
		assert.ok(current.webview.ofType("activity").some(message => message.activity.some(entry => entry.id === first && entry.state === "running")));

		gate.resolve();
		await waitFor(() => current.webview.ofType("activity").some(message => message.activity.some(entry => entry.id === first && entry.state === "finished")), "A finished");
		await current.store.flush();
		assert.strictEqual(assistantText(await new ChatSessionStore(root).load(first)), "A workingA done");
	});

	test("deleting a running background chat cancels it", async () => {
		let cancelled = false;
		const backend = new FakeBackend([
			async (progress, token) => {
				progress.report(new vscode.LanguageModelTextPart("A working"));
				await new Promise<void>(resolve => token.onCancellationRequested(() => {
					cancelled = true;
					resolve();
				}));
				throw new vscode.CancellationError();
			},
		]);
		const current = createHarness(root, backend, undefined, undefined, { confirm: async () => true });
		harness = current;
		current.webview.receive({ type: "ready" });
		await waitFor(() => current.webview.ofType("init").length === 1, "init");
		current.webview.receive({ type: "send", text: "A question" });
		await waitFor(() => backend.requests.length === 1, "A start");
		const first = current.state.get<string>(ACTIVE_SESSION_KEY);
		assert.ok(first);
		current.webview.receive({ type: "newChat" });
		await waitFor(() => current.webview.ofType("init").length === 2, "second init");
		const second = current.webview.ofType("init")[1].session.id;

		current.webview.receive({ type: "deleteSession", sessionId: first });
		await waitForAsync(async () => (await current.store.get(first)) === undefined, "the chat to be deleted");
		await waitFor(() => current.webview.ofType("activity").some(message => message.activity.every(entry => entry.id !== first)), "activity without the deleted chat");
		assert.strictEqual(cancelled, true);
		assert.strictEqual(current.state.get<string>(ACTIVE_SESSION_KEY), second);
	});

	test("opening a finished background chat clears it from activity", async () => {
		const gate = deferred();
		const backend = new FakeBackend([
			async progress => {
				progress.report(new vscode.LanguageModelTextPart("Hello "));
				await gate.promise;
				progress.report(new vscode.LanguageModelTextPart("world"));
			},
		]);
		const current = createHarness(root, backend);
		harness = current;
		current.webview.receive({ type: "ready" });
		await waitFor(() => current.webview.ofType("init").length === 1, "init");
		current.webview.receive({ type: "send", text: "Long story" });
		await waitFor(() => backend.requests.length === 1, "run start");
		const first = current.state.get<string>(ACTIVE_SESSION_KEY);
		assert.ok(first);
		current.webview.receive({ type: "newChat" });
		await waitFor(() => current.webview.ofType("init").length === 2, "second init");
		gate.resolve();
		await waitFor(() => current.webview.ofType("activity").some(message => message.activity.some(entry => entry.id === first && entry.state === "finished")), "finished activity");

		current.webview.receive({ type: "openSession", sessionId: first });
		await waitFor(() => current.webview.ofType("init").length === 3, "third init");
		await waitFor(() => current.webview.ofType("activity").some(message => message.activity.every(entry => entry.id !== first)), "activity without the opened chat");
	});

	test("rejects session ids that are not store ids", async () => {
		const current = createHarness(root, new FakeBackend());
		harness = current;
		current.webview.receive({ type: "ready" });
		await waitFor(() => current.webview.ofType("init").length === 1, "init");

		current.webview.receive({ type: "openSession", sessionId: "../x" });
		current.webview.receive({ type: "deleteSession", sessionId: "../x" });
		await new Promise<void>(resolve => setTimeout(resolve, 50));
		assert.strictEqual(current.webview.ofType("init").length, 1);
		assert.strictEqual(current.webview.ofType("sessions").length, 0);
	});

	test("broadcasts updates to every attached webview", async () => {
		const current = createHarness(root, new FakeBackend());
		harness = current;
		const second = new FakeWebview();
		current.controller.attach(second.asWebview());
		current.webview.receive({ type: "ready" });
		second.receive({ type: "ready" });
		await waitFor(() => current.webview.ofType("init").length === 1 && second.ofType("init").length === 1, "both inits");

		current.webview.receive({ type: "selectModel", modelId: "claude::smart" });
		await waitFor(() => second.ofType("models").length === 1, "models broadcast");
		assert.strictEqual(second.ofType("models")[0].selectedModelId, "claude::smart");
		second.dispose();
	});

	test("listMemory posts the visible entries to the requesting webview", async () => {
		const memoryStore = new FakeMemoryStore();
		memoryStore.entries = [{
			id: "m1",
			title: "Keep CRLF",
			content: "Source files use CRLF.",
			kind: "preference",
			scope: "global",
			pinned: true,
			tags: ["style"],
			updatedAt: 1_700_000_000_000,
			expired: false,
		}];
		const current = createHarness(root, new FakeBackend(), undefined, undefined, { memoryStore });
		harness = current;
		const second = new FakeWebview();
		current.controller.attach(second.asWebview());

		current.webview.receive({ type: "listMemory" });
		await waitFor(() => current.webview.ofType("memory").length === 1, "memory message");
		const message = current.webview.ofType("memory")[0];
		assert.strictEqual(message.enabled, true);
		assert.strictEqual(message.projectLabel, "Project A");
		assert.deepStrictEqual(message.entries, memoryStore.entries);
		assert.strictEqual(message.notice, undefined);
		assert.deepStrictEqual(second.ofType("memory"), []);
		second.dispose();
	});

	test("listMemory without a store reports memory as disabled", async () => {
		const current = createHarness(root, new FakeBackend());
		harness = current;
		current.webview.receive({ type: "listMemory" });
		await waitFor(() => current.webview.ofType("memory").length === 1, "memory message");
		const message = current.webview.ofType("memory")[0];
		assert.strictEqual(message.enabled, false);
		assert.strictEqual(message.projectLabel, undefined);
		assert.deepStrictEqual(message.entries, []);
	});

	test("saveMemory saves and broadcasts the refreshed list", async () => {
		const memoryStore = new FakeMemoryStore();
		const current = createHarness(root, new FakeBackend(), undefined, undefined, { memoryStore });
		harness = current;

		current.webview.receive({
			type: "saveMemory",
			entry: { title: "Build", content: "npm run compile", kind: "workflow", scope: "workspace", pinned: true },
		});
		await waitFor(() => current.webview.ofType("memory").length === 1, "memory broadcast");
		assert.deepStrictEqual(memoryStore.saved, [
			{ title: "Build", content: "npm run compile", kind: "workflow", scope: "workspace", pinned: true },
		]);
		assert.deepStrictEqual(current.webview.ofType("memory")[0].entries.map(entry => entry.title), ["Build"]);
		assert.strictEqual(current.webview.ofType("memory")[0].notice, undefined);
	});

	test("a failing save broadcasts the notice", async () => {
		const memoryStore = new FakeMemoryStore();
		memoryStore.fail = "Memory content is too long (5000 chars, limit 4096).";
		const current = createHarness(root, new FakeBackend(), undefined, undefined, { memoryStore });
		harness = current;

		current.webview.receive({
			type: "saveMemory",
			entry: { title: "Long", content: "x".repeat(5_000), kind: "other", scope: "global", pinned: false },
		});
		await waitFor(() => current.webview.ofType("memory").length === 1, "notice broadcast");
		assert.strictEqual(current.webview.ofType("memory")[0].notice, memoryStore.fail);
		assert.deepStrictEqual(memoryStore.saved, []);
	});

	test("deleteMemory removes an entry and broadcasts the result", async () => {
		const memoryStore = new FakeMemoryStore();
		memoryStore.entries = [{
			id: "m1",
			title: "Remove me",
			content: "Gone.",
			kind: "other",
			scope: "global",
			pinned: false,
			tags: [],
			updatedAt: 1,
			expired: false,
		}];
		const current = createHarness(root, new FakeBackend(), undefined, undefined, { memoryStore });
		harness = current;

		current.webview.receive({ type: "deleteMemory", id: "m1" });
		await waitFor(() => current.webview.ofType("memory").length === 1, "memory broadcast");
		assert.deepStrictEqual(memoryStore.removed, ["m1"]);
		assert.deepStrictEqual(current.webview.ofType("memory")[0].entries, []);
	});

	test("a hidden delete reports the entry as not visible", async () => {
		const memoryStore = new FakeMemoryStore();
		memoryStore.removeResult = false;
		const current = createHarness(root, new FakeBackend(), undefined, undefined, { memoryStore });
		harness = current;

		current.webview.receive({ type: "deleteMemory", id: "other-project" });
		await waitFor(() => current.webview.ofType("memory").length === 1, "memory notice");
		assert.strictEqual(current.webview.ofType("memory")[0].notice, "This entry is not visible in this project.");
	});

	test("a store change broadcasts once after coalescing", async () => {
		const memoryStore = new FakeMemoryStore();
		const current = createHarness(root, new FakeBackend(), undefined, undefined, { memoryStore });
		harness = current;

		memoryStore.fire();
		memoryStore.fire();
		memoryStore.fire();
		await waitFor(() => current.webview.ofType("memory").length === 1, "coalesced memory broadcast");
		await new Promise<void>(resolve => setTimeout(resolve, 200));
		assert.strictEqual(current.webview.ofType("memory").length, 1);

		memoryStore.fire();
		await waitFor(() => current.webview.ofType("memory").length === 2, "next memory broadcast");
	});

	test("answers with an error notice instead of starting a turn when no model is available", async () => {
		const current = createHarness(root, new FakeBackend([], []));
		harness = current;
		current.webview.receive({ type: "send", text: "Hello", attachments: [FILE_ATTACHMENT] });
		await waitFor(() => current.webview.ofType("messageAdded").length === 1, "notice message");

		const added = current.webview.ofType("messageAdded")[0];
		assert.strictEqual(added.message.role, "assistant");
		assert.strictEqual(added.message.modelId, undefined);
		assert.deepStrictEqual(added.message.parts, [{ kind: "notice", level: "error", text: "No model is available. Configure a provider first." }]);
		assert.deepStrictEqual(current.webview.ofType("run"), []);
		// Nothing was sent, so the composer gets the text and attachments back.
		const restore = current.webview.ofType("restoreDraft");
		assert.strictEqual(restore.length, 1);
		assert.strictEqual(restore[0].text, "Hello");
		assert.deepStrictEqual(restore[0].attachments, [FILE_ATTACHMENT]);
	});

	test("ignores malformed and empty webview messages", async () => {
		const current = createHarness(root, new FakeBackend());
		harness = current;
		const malformed: unknown[] = [
			undefined,
			null,
			"hello",
			42,
			{},
			{ type: "unknown" },
			{ type: "send" },
			{ type: "send", text: 7 },
			{ type: "send", text: "   " },
			{ type: "selectModel" },
			{ type: "loadToolResult", messageId: "m1" },
			{ type: "loadPartText", messageId: "m1" },
			{ type: "loadPartText", messageId: "m1", index: -1 },
			{ type: "loadPartText", messageId: "m1", index: 1.5 },
			{ type: "loadPartText", messageId: 7, index: 0 },
			{ type: "answerQuestions" },
			{ type: "answerQuestions", id: 7 },
			{ type: "answerQuestions", id: "q1", answers: "nope" },
			{ type: "answerQuestions", id: "q1", answers: [{ header: "A" }] },
			{ type: "answerQuestions", id: "q1", answers: [{ header: "A", selected: ["x"], freeform: 7 }] },
			{ type: "answerQuestions", id: "q1", answers: Array.from({ length: 6 }, () => ({ header: "A", selected: [] })) },
			{ type: "saveMemory" },
			{ type: "saveMemory", entry: [] },
			{ type: "saveMemory", entry: { title: "T", content: "C", kind: "other", scope: "device", pinned: false } },
			{ type: "saveMemory", entry: { title: "T", content: "C", kind: "other", scope: "global", pinned: "yes" } },
			{ type: "saveMemory", entry: { title: "T", content: "C", kind: 7, scope: "global", pinned: false } },
			{ type: "saveMemory", entry: { title: "x".repeat(CHAT_MEMORY_TITLE_MAX_CHARS + 1), content: "C", kind: "other", scope: "global", pinned: false } },
			{ type: "saveMemory", entry: { title: "T", content: "x".repeat(CHAT_MEMORY_CONTENT_MAX_CHARS + 1), kind: "other", scope: "global", pinned: false } },
			{ type: "saveMemory", entry: { id: 7, title: "T", content: "C", kind: "other", scope: "global", pinned: false } },
			{ type: "deleteMemory" },
			{ type: "deleteMemory", id: 7 },
			{ type: "deleteMemory", id: "" },
		];
		for (const message of malformed) {
			current.webview.receive(message);
		}
		await new Promise<void>(resolve => setTimeout(resolve, 50));
		assert.deepStrictEqual(current.webview.messages, []);

		current.webview.receive({ type: "ready" });
		await waitFor(() => current.webview.ofType("init").length === 1, "init after malformed messages");
	});

	test("renaming a chat keeps the title through new messages and edits", async () => {
		const backend = new FakeBackend(Array.from({ length: 3 }, () => progress => progress.report(new vscode.LanguageModelTextPart("ok"))));
		const current = createHarness(root, backend);
		harness = current;
		const finished = () => current.webview.ofType("run").filter(message => !message.run.running).length;
		current.webview.receive({ type: "ready" });
		await waitFor(() => current.webview.ofType("init").length === 1, "init");
		const id = current.webview.ofType("init")[0].session.id;
		current.webview.receive({ type: "send", text: "First message" });
		await waitFor(() => finished() === 1, "first turn");
		const first = current.webview.ofType("messageAdded").map(message => message.message).find(message => message.role === "user");
		assert.ok(first);
		current.webview.receive({ type: "renameSession", sessionId: id, title: "My title" });
		await waitFor(() => current.webview.ofType("sessions").some(message => message.sessions.some(session => session.id === id && session.title === "My title")), "renamed list");
		current.webview.receive({ type: "send", text: "Second message" });
		await waitFor(() => finished() === 2, "second turn");
		current.webview.receive({ type: "editMessage", messageId: first.id, text: "Edited first" });
		await waitFor(() => finished() === 3, "edited turn");
		assert.strictEqual((await current.store.get(id))?.title, "My title");
		current.webview.receive({ type: "renameSession", sessionId: id, title: "  " });
		await waitForAsync(async () => (await current.store.get(id))?.title === "Edited first", "automatic title");
	});

	test("exporting a chat saves its Markdown", async () => {
		let saved: { name: string; content: string } | undefined;
		const current = createHarness(root, new FakeBackend([progress => progress.report(new vscode.LanguageModelTextPart("ok"))]), undefined, undefined, {
			saveExport: async (name, content) => { saved = { name, content }; return name; },
		});
		harness = current;
		current.webview.receive({ type: "ready" });
		await waitFor(() => current.webview.ofType("init").length === 1, "init");
		const id = current.webview.ofType("init")[0].session.id;
		current.webview.receive({ type: "send", text: "Hello" });
		await waitFor(() => current.webview.ofType("run").some(message => !message.run.running), "turn");
		current.webview.receive({ type: "exportSession", sessionId: id });
		await waitFor(() => saved !== undefined, "export");
		assert.ok(saved?.name.endsWith(".md"));
		assert.ok(saved?.content.startsWith("# "));
		assert.ok(saved?.content.includes("## You"));
	});

	test("editing an earlier message drops it and the rest, then sends the new text", async () => {
		const backend = new FakeBackend([
			progress => progress.report(new vscode.LanguageModelTextPart("first answer")),
			progress => progress.report(new vscode.LanguageModelTextPart("second answer")),
			progress => progress.report(new vscode.LanguageModelTextPart("edited answer")),
		]);
		const current = createHarness(root, backend);
		harness = current;
		const finishedTurns = (): number => current.webview.ofType("run").filter(message => !message.run.running).length;
		current.webview.receive({ type: "send", text: "one" });
		await waitFor(() => finishedTurns() === 1, "first turn");
		current.webview.receive({ type: "send", text: "two" });
		await waitFor(() => finishedTurns() === 2, "second turn");
		const second = current.webview.ofType("messageAdded").map(message => message.message).find(message => message.role === "user" && message.turn === 2);
		assert.ok(second);

		current.webview.receive({ type: "editMessage", messageId: second.id, text: "two, edited" });
		await waitFor(() => finishedTurns() === 3, "edited turn");

		assert.deepStrictEqual(current.webview.ofType("truncated").map(message => message.messageId), [second.id]);
		const replayed: ChatMessage[] = [];
		for (const message of current.webview.messages) {
			applyHostUpdate(replayed, message);
		}
		const texts = replayed.map(message => `${message.role}:${message.parts.map(part => part.kind === "text" ? part.text : "").join("")}`);
		assert.deepStrictEqual(texts, ["user:one", "assistant:first answer", "user:two, edited", "assistant:edited answer"]);
		assert.deepStrictEqual(replayed.map(message => message.turn), [1, 1, 2, 2]);
		const lastRequest = backend.requests.at(-1);
		assert.strictEqual(lastRequest?.messages.length, 3);

		await current.store.flush();
		const sessionId = current.state.get<string>(ACTIVE_SESSION_KEY);
		assert.ok(sessionId);
		assert.deepStrictEqual(await new ChatSessionStore(root).load(sessionId), replayed);
		assert.strictEqual((await new ChatSessionStore(root).get(sessionId))?.messageCount, 4);
	});

	test("holds a guarded tool call until the user allows it", async () => {
		const catalog = guardedCatalog();
		const backend = new FakeBackend([
			progress => progress.report(new vscode.LanguageModelToolCallPart("call-g", "guarded", { force: true })),
			progress => progress.report(new vscode.LanguageModelTextPart("pushed")),
		]);
		const current = createHarness(root, backend, catalog.source);
		harness = current;
		current.webview.receive({ type: "send", text: "push it" });
		await waitFor(() => current.webview.ofType("approval").length === 1, "approval request");
		const request = current.webview.ofType("approval")[0].request;
		assert.strictEqual(request.toolName, "guarded");
		assert.strictEqual(request.callId, "call-g");
		assert.strictEqual(request.detail, "git push --force");
		assert.deepStrictEqual(catalog.runs, []);

		current.webview.receive({ type: "ready" });
		await waitFor(() => current.webview.ofType("init").length === 1, "init with pending approval");
		assert.deepStrictEqual(current.webview.ofType("init")[0].approvals.map(approval => approval.id), [request.id]);

		current.webview.receive({ type: "approve", id: request.id, allow: true });
		await waitFor(() => current.webview.ofType("run").some(message => !message.run.running), "turn end");
		assert.deepStrictEqual(current.webview.ofType("approvalResolved"), [{ type: "approvalResolved", id: request.id, allowed: true }]);
		assert.deepStrictEqual(catalog.runs, [{ force: true }]);
		const result = current.webview.ofType("partAdded").map(message => message.part).find(part => part.kind === "toolResult");
		assert.deepStrictEqual(result, { kind: "toolResult", callId: "call-g", text: "ran", isError: false });
	});

	test("a denied or stopped approval never runs the tool", async () => {
		const catalog = guardedCatalog();
		const backend = new FakeBackend([
			progress => progress.report(new vscode.LanguageModelToolCallPart("call-1", "guarded", {})),
			progress => progress.report(new vscode.LanguageModelTextPart("ok, not pushing")),
			progress => progress.report(new vscode.LanguageModelToolCallPart("call-2", "guarded", {})),
		]);
		const current = createHarness(root, backend, catalog.source);
		harness = current;
		current.webview.receive({ type: "send", text: "push" });
		await waitFor(() => current.webview.ofType("approval").length === 1, "first approval");
		current.webview.receive({ type: "approve", id: current.webview.ofType("approval")[0].request.id, allow: false });
		await waitFor(() => current.webview.ofType("run").some(message => !message.run.running), "first turn end");
		const denied = current.webview.ofType("partAdded").map(message => message.part).find(part => part.kind === "toolResult");
		assert.deepStrictEqual(denied, { kind: "toolResult", callId: "call-1", text: DENIED_TOOL_RESULT, isError: true });

		current.webview.receive({ type: "send", text: "push again" });
		await waitFor(() => current.webview.ofType("approval").length === 2, "second approval");
		current.webview.receive({ type: "stop" });
		await waitFor(() => current.webview.ofType("run").filter(message => !message.run.running).length === 2, "stopped turn");
		assert.strictEqual(current.webview.ofType("approvalResolved").at(-1)?.allowed, false);
		assert.deepStrictEqual(catalog.runs, []);
	});

	test("ask_questions posts the request and answers the tool with the sanitised answers", async () => {
		const askInput = {
			questions: [
				{ header: "Approach", question: "Which one?", options: [{ label: "Refactor" }, { label: "Rewrite" }], allowFreeformInput: true },
				{ header: "Name", question: "Which name?", options: [{ label: "keep" }], allowFreeformInput: false },
			],
		};
		const backend = new FakeBackend([
			progress => progress.report(new vscode.LanguageModelToolCallPart("call-q", ASK_QUESTIONS_TOOL_NAME, askInput)),
			progress => progress.report(new vscode.LanguageModelTextPart("Done")),
		]);
		const notifications: Array<[string, string]> = [];
		const current = createHarness(root, backend, planningCatalog().source, undefined, { osNotify: (title, body) => notifications.push([title, body]) });
		harness = current;
		current.webview.receive({ type: "send", text: "Plan it" });
		await waitFor(() => current.webview.ofType("questions").length === 1, "question request");
		const request = current.webview.ofType("questions")[0].request;
		const id = current.state.get<string>(ACTIVE_SESSION_KEY)!;
		assert.deepStrictEqual(notifications, [[(await current.store.get(id))?.title, "The agent has a question for you.\nWhich one?"]]);
		assert.strictEqual(request.callId, "call-q");
		assert.deepStrictEqual(request.questions.map(question => question.header), ["Approach", "Name"]);

		current.webview.receive({
			type: "answerQuestions",
			id: request.id,
			answers: [
				{ header: "Approach", selected: ["Rewrite", "Unknown", "Refactor"], freeform: "  small  " },
				{ header: "Name", selected: ["keep", "bogus"], freeform: "typed" },
			],
		});
		await waitFor(() => current.webview.ofType("run").some(message => !message.run.running), "turn end");
		assert.deepStrictEqual(current.webview.ofType("questionsResolved"), [{ type: "questionsResolved", id: request.id }]);
		const result = current.webview.ofType("partAdded").map(message => message.part).find(part => part.kind === "toolResult" && part.callId === "call-q");
		if (result?.kind !== "toolResult") {
			throw new Error("expected a tool result");
		}
		assert.strictEqual(result.isError, false);
		assert.strictEqual(result.text, "Approach: Rewrite; \"small\"\nName: keep");
	});

	test("skipping the questions gives the tool the dismissed text", async () => {
		const backend = new FakeBackend([
			progress => progress.report(new vscode.LanguageModelToolCallPart("call-q", ASK_QUESTIONS_TOOL_NAME, {
				questions: [{ header: "Approach", question: "Which one?", options: [{ label: "Refactor" }] }],
			})),
			progress => progress.report(new vscode.LanguageModelTextPart("Done")),
		]);
		const current = createHarness(root, backend, planningCatalog().source);
		harness = current;
		current.webview.receive({ type: "send", text: "Plan it" });
		await waitFor(() => current.webview.ofType("questions").length === 1, "question request");
		current.webview.receive({ type: "answerQuestions", id: current.webview.ofType("questions")[0].request.id });
		await waitFor(() => current.webview.ofType("run").some(message => !message.run.running), "turn end");
		const result = current.webview.ofType("partAdded").map(message => message.part).find(part => part.kind === "toolResult" && part.callId === "call-q");
		if (result?.kind !== "toolResult") {
			throw new Error("expected a tool result");
		}
		assert.strictEqual(result.text, "The user dismissed the questions without answering. Continue with your best judgement, or ask in your reply.");
	});

	test("a message sent while questions are open dismisses them and reaches the agent next", async () => {
		const backend = new FakeBackend([
			progress => progress.report(new vscode.LanguageModelToolCallPart("call-q", ASK_QUESTIONS_TOOL_NAME, {
				questions: [{ header: "Approach", question: "Which one?" }],
			})),
			progress => progress.report(new vscode.LanguageModelTextPart("Using the typed hint")),
		]);
		const current = createHarness(root, backend, planningCatalog().source);
		harness = current;
		current.webview.receive({ type: "send", text: "Plan it" });
		await waitFor(() => current.webview.ofType("questions").length === 1, "question request");
		const request = current.webview.ofType("questions")[0].request;
		current.webview.receive({ type: "send", text: "Just refactor it" });
		await waitFor(() => current.webview.ofType("run").filter(message => !message.run.running).length === 2, "both turns");
		assert.deepStrictEqual(current.webview.ofType("questionsResolved"), [{ type: "questionsResolved", id: request.id }]);
		assert.strictEqual(backend.requests.length, 2);
		const lastRequest = backend.requests.at(-1);
		assert.ok(lastRequest);
		assert.strictEqual(messageText(lastRequest.messages.at(-1)!), "Just refactor it");
	});

	test("stopping while the agent waits for answers resolves the questions and ends the turn", async () => {
		const backend = new FakeBackend([
			progress => progress.report(new vscode.LanguageModelToolCallPart("call-q", ASK_QUESTIONS_TOOL_NAME, {
				questions: [{ header: "Approach", question: "Which one?" }],
			})),
		]);
		const current = createHarness(root, backend, planningCatalog().source);
		harness = current;
		current.webview.receive({ type: "send", text: "Plan it" });
		await waitFor(() => current.webview.ofType("questions").length === 1, "question request");
		const request = current.webview.ofType("questions")[0].request;
		current.webview.receive({ type: "stop" });
		await waitFor(() => current.webview.ofType("run").some(message => !message.run.running), "turn end");
		assert.deepStrictEqual(current.webview.ofType("questionsResolved"), [{ type: "questionsResolved", id: request.id }]);
		const notice = current.webview.ofType("partAdded").map(message => message.part).find(part => part.kind === "notice" && part.text === "Stopped.");
		assert.ok(notice);
	});

	test("init carries pending questions", async () => {
		const backend = new FakeBackend([
			progress => progress.report(new vscode.LanguageModelToolCallPart("call-q", ASK_QUESTIONS_TOOL_NAME, {
				questions: [{ header: "Approach", question: "Which one?" }],
			})),
		]);
		const current = createHarness(root, backend, planningCatalog().source);
		harness = current;
		current.webview.receive({ type: "send", text: "Plan it" });
		await waitFor(() => current.webview.ofType("questions").length === 1, "question request");
		const request = current.webview.ofType("questions")[0].request;
		current.webview.receive({ type: "ready" });
		await waitFor(() => current.webview.ofType("init").length === 1, "init with pending questions");
		assert.deepStrictEqual(current.webview.ofType("init")[0].questions?.map(question => question.id), [request.id]);
	});

	test("request_tools asks for a disabled tool and enables it for the next request", async () => {
		const backend = new FakeBackend([
			progress => progress.report(new vscode.LanguageModelToolCallPart("call-r", REQUEST_TOOLS_TOOL_NAME, {
				names: ["mcp_probe", "mcp_missing"],
				reason: "Need the probe",
			})),
			progress => progress.report(new vscode.LanguageModelTextPart("Done")),
		]);
		const catalog = planningCatalog();
		const current = createHarness(root, backend, catalog.source);
		harness = current;
		current.webview.receive({ type: "send", text: "Look deeper" });
		await waitFor(() => current.webview.ofType("questions").length === 1, "tool request");
		const request = current.webview.ofType("questions")[0].request;
		assert.strictEqual(request.title, "The agent asks to enable tools");
		assert.strictEqual(request.submitLabel, "Enable");
		assert.strictEqual(request.skipLabel, "Deny");
		assert.deepStrictEqual(request.questions.map(question => question.header), ["Tools"]);
		const question = request.questions[0];
		assert.strictEqual(question.question, "Enable 1 tool for this chat?");
		assert.ok(question.message?.startsWith("Reason: Need the probe"));
		assert.ok(question.message?.includes("Run through VS Code, which may ask for confirmation in a dialog."));
		assert.strictEqual(question.multiSelect, true);
		assert.strictEqual(question.allowFreeformInput, false);
		assert.deepStrictEqual(question.options, [{
			label: "mcp_probe",
			description: "MCP servers: Reads a probe from an MCP server",
			checked: true,
		}]);

		current.webview.receive({ type: "answerQuestions", id: request.id, answers: [{ header: "Tools", selected: ["mcp_probe"] }] });
		await waitFor(() => current.webview.ofType("run").some(message => !message.run.running), "turn end");
		assert.deepStrictEqual(catalog.toggles, [{ names: ["mcp_probe"], enabled: true }]);
		assert.ok(current.webview.ofType("tools").some(message => message.tools.some(group => group.id === "ext:mcp" && group.tools[0].enabled === true)));
		const result = current.webview.ofType("partAdded").map(message => message.part).find(part => part.kind === "toolResult" && part.callId === "call-r");
		if (result?.kind !== "toolResult") {
			throw new Error("expected a tool result");
		}
		assert.strictEqual(result.isError, false);
		assert.strictEqual(result.text, "Enabled: mcp_probe. They are available from your next request.\nUnknown tools (check list_tools): mcp_missing.");
		const names = (backend.requests[1].options.tools ?? []).map(tool => tool.name);
		assert.ok(names.includes("mcp_probe"), "the next request of the same turn offers the enabled tool");
		assert.strictEqual(backend.requests[0].options.modelOptions?._aabStrictTools, true);
		assert.strictEqual(backend.requests[1].options.modelOptions?._aabStrictTools, true);
	});

	test("request_tools tells a Claude turn its new tools wait for the next user message", async () => {
		const backend = new FakeBackend([
			progress => progress.report(new vscode.LanguageModelToolCallPart("call-r", REQUEST_TOOLS_TOOL_NAME, {
				names: ["mcp_probe"],
				reason: "Need the probe",
			})),
			progress => progress.report(new vscode.LanguageModelTextPart("Done")),
		]);
		const catalog = planningCatalog();
		const current = createHarness(root, backend, catalog.source);
		harness = current;
		current.webview.receive({ type: "ready" });
		await waitFor(() => current.webview.ofType("init").length === 1, "init");
		current.webview.receive({ type: "selectModel", modelId: "claude::smart" });
		await waitFor(() => current.webview.ofType("models").some(message => message.selectedModelId === "claude::smart"), "model selection");
		current.webview.receive({ type: "send", text: "Look deeper" });
		await waitFor(() => current.webview.ofType("questions").length === 1, "tool request");
		current.webview.receive({ type: "answerQuestions", id: current.webview.ofType("questions")[0].request.id, answers: [{ header: "Tools", selected: ["mcp_probe"] }] });
		await waitFor(() => current.webview.ofType("run").some(message => !message.run.running), "turn end");
		const result = current.webview.ofType("partAdded").map(message => message.part).find(part => part.kind === "toolResult" && part.callId === "call-r");
		if (result?.kind !== "toolResult") {
			throw new Error("expected a tool result");
		}
		assert.strictEqual(result.text, "Enabled: mcp_probe. This model keeps its tool list for the current answer, so they become available with the user's next message; finish what you can now and say which step needs them.");
		assert.strictEqual(backend.requests[1].options.modelOptions?._aabStrictTools, true);
	});

	test("request_tools takes an answer that keeps more than ten preselected tools", async () => {
		const names = Array.from({ length: 12 }, (_, index) => `mcp_extra_${index + 1}`);
		const backend = new FakeBackend([
			progress => progress.report(new vscode.LanguageModelToolCallPart("call-r", REQUEST_TOOLS_TOOL_NAME, { names, reason: "Visual checks" })),
			progress => progress.report(new vscode.LanguageModelTextPart("Done")),
		]);
		const catalog = planningCatalog(12);
		const current = createHarness(root, backend, catalog.source);
		harness = current;
		current.webview.receive({ type: "send", text: "Check the layout" });
		await waitFor(() => current.webview.ofType("questions").length === 1, "tool request");
		const request = current.webview.ofType("questions")[0].request;
		assert.strictEqual(request.questions[0].options?.length, 12);
		// The card sends every preselected tool; a cap of ten used to drop the answer and leave the card stuck.
		current.webview.receive({ type: "answerQuestions", id: request.id, answers: [{ header: "Tools", selected: names }] });
		await waitFor(() => current.webview.ofType("run").some(message => !message.run.running), "turn end");
		assert.deepStrictEqual(catalog.toggles, [{ names, enabled: true }]);
		const result = current.webview.ofType("partAdded").map(message => message.part).find(part => part.kind === "toolResult" && part.callId === "call-r");
		if (result?.kind !== "toolResult") {
			throw new Error("expected a tool result");
		}
		assert.ok(result.text.startsWith(`Enabled: ${names.join(", ")}.`), result.text);
	});

	test("denying request_tools leaves the tools off and tells the agent so", async () => {
		const backend = new FakeBackend([
			progress => progress.report(new vscode.LanguageModelToolCallPart("call-r", REQUEST_TOOLS_TOOL_NAME, {
				names: ["mcp_probe"],
				reason: "Need the probe",
			})),
			progress => progress.report(new vscode.LanguageModelTextPart("Done")),
		]);
		const catalog = planningCatalog();
		const current = createHarness(root, backend, catalog.source);
		harness = current;
		current.webview.receive({ type: "send", text: "Look deeper" });
		await waitFor(() => current.webview.ofType("questions").length === 1, "tool request");
		current.webview.receive({ type: "answerQuestions", id: current.webview.ofType("questions")[0].request.id });
		await waitFor(() => current.webview.ofType("run").some(message => !message.run.running), "turn end");
		assert.deepStrictEqual(catalog.toggles, []);
		assert.deepStrictEqual(current.webview.ofType("tools"), []);
		const result = current.webview.ofType("partAdded").map(message => message.part).find(part => part.kind === "toolResult" && part.callId === "call-r");
		if (result?.kind !== "toolResult") {
			throw new Error("expected a tool result");
		}
		assert.strictEqual(result.text, "The user denied the request. Continue with the enabled tools, or explain in your reply what you need.\nDeclined by the user: mcp_probe.");
	});

	test("request_tools for an enabled tool asks nothing", async () => {
		const backend = new FakeBackend([
			progress => progress.report(new vscode.LanguageModelToolCallPart("call-r", REQUEST_TOOLS_TOOL_NAME, {
				names: ["ask_questions"],
				reason: "Ask the user",
			})),
			progress => progress.report(new vscode.LanguageModelTextPart("Done")),
		]);
		const catalog = planningCatalog();
		const current = createHarness(root, backend, catalog.source);
		harness = current;
		current.webview.receive({ type: "send", text: "Ask" });
		await waitFor(() => current.webview.ofType("run").some(message => !message.run.running), "turn end");
		assert.deepStrictEqual(current.webview.ofType("questions"), []);
		assert.deepStrictEqual(catalog.toggles, []);
		const result = current.webview.ofType("partAdded").map(message => message.part).find(part => part.kind === "toolResult" && part.callId === "call-r");
		if (result?.kind !== "toolResult") {
			throw new Error("expected a tool result");
		}
		assert.strictEqual(result.text, "Already enabled: ask_questions.");
	});

	test("a subagent gets neither planning nor tool-access tools", async () => {
		const subagent = createSubagentTool({ models: () => [{ id: "claude::smart", label: "Smart (Claude)", useWhen: "tests" }] });
		const source = createChatToolSource({
			enabledTools: () => [subagent, createTodoTool(), createAskQuestionsTool(), ...createToolAccessTools()],
			groups: () => [],
			setEnabled: async () => undefined,
		});
		const backend = new FakeBackend([
			progress => progress.report(new vscode.LanguageModelToolCallPart("call-sub", SUBAGENT_TOOL_NAME, { description: "Check", prompt: "Inspect", model: "Smart (Claude)" })),
			progress => progress.report(new vscode.LanguageModelTextPart("REPORT")),
			progress => progress.report(new vscode.LanguageModelTextPart("Done")),
		]);
		const current = createHarness(root, backend, source);
		harness = current;
		current.webview.receive({ type: "send", text: "Delegate" });
		await waitFor(() => current.webview.ofType("run").some(message => !message.run.running), "turn end");
		const names = (backend.requests[1].options.tools ?? []).map(tool => tool.name);
		assert.ok(!names.includes(SUBAGENT_TOOL_NAME));
		assert.ok(!names.includes(TODO_TOOL_NAME));
		assert.ok(!names.includes(ASK_QUESTIONS_TOOL_NAME));
		assert.ok(!names.includes(LIST_TOOLS_TOOL_NAME));
		assert.ok(!names.includes(REQUEST_TOOLS_TOOL_NAME));
		assert.ok(backend.requests.every(request => request.options.modelOptions?._aabStrictTools === true), "main, subagent and continuation turns carry the marker");
	});

	test("only the main agent gets the subagent guide in its system prompt", async () => {
		const subagent = createSubagentTool({ models: () => [{ id: "claude::smart", label: "Smart (Claude)", useWhen: "tests" }] });
		const source = createChatToolSource({ enabledTools: () => [subagent], groups: () => [], setEnabled: async () => undefined });
		const backend = new FakeBackend([
			progress => progress.report(new vscode.LanguageModelToolCallPart("call-sub", SUBAGENT_TOOL_NAME, { description: "Check", prompt: "Inspect", model: "Smart (Claude)" })),
			progress => progress.report(new vscode.LanguageModelTextPart("REPORT")),
			progress => progress.report(new vscode.LanguageModelTextPart("Done")),
		]);
		const asked: Array<{ subagents?: boolean } | undefined> = [];
		const current = createHarness(root, backend, source, undefined, {
			prompt: {
				systemPrompt: async options => { asked.push(options); return options?.subagents ? "SYSTEM+GUIDE" : "SYSTEM"; },
				turnContext: () => "<context>\nhost\n</context>",
			},
		});
		harness = current;
		current.webview.receive({ type: "send", text: "Delegate" });
		await waitFor(() => current.webview.ofType("run").some(message => !message.run.running), "turn end");
		assert.deepStrictEqual(asked, [{ subagents: true }, undefined]);
		assert.strictEqual(messageText(backend.requests[0].messages[0]), "SYSTEM+GUIDE");
		// The subagent runner appends its own <subagent> role block to the plain prompt.
		assert.ok(messageText(backend.requests[1].messages[0]).startsWith("SYSTEM\n\n<subagent>"));
	});

	test("a turn without the subagent tool gets no subagent guide", async () => {
		const asked: Array<{ subagents?: boolean } | undefined> = [];
		const backend = new FakeBackend([progress => progress.report(new vscode.LanguageModelTextPart("Hi"))]);
		const current = createHarness(root, backend, createChatToolSource({ enabledTools: () => [], groups: () => [], setEnabled: async () => undefined }), undefined, {
			prompt: { systemPrompt: async options => { asked.push(options); return "SYSTEM"; }, turnContext: () => "<context>\nhost\n</context>" },
		});
		harness = current;
		current.webview.receive({ type: "send", text: "Hello" });
		await waitFor(() => current.webview.ofType("run").some(message => !message.run.running), "turn end");
		assert.deepStrictEqual(asked, [{ subagents: false }]);
	});

	test("tool toggles reach the catalog and every webview gets the new groups", async () => {
		const catalog = guardedCatalog();
		const current = createHarness(root, new FakeBackend(), catalog.source);
		harness = current;
		current.webview.receive({ type: "ready" });
		await waitFor(() => current.webview.ofType("init").length === 1, "init");
		assert.strictEqual(current.webview.ofType("init")[0].tools[0].tools[0].enabled, true);

		current.webview.receive({ type: "setToolsEnabled", names: ["guarded"], enabled: false });
		await waitFor(() => current.webview.ofType("tools").length === 1, "tools update");
		assert.deepStrictEqual(catalog.toggles, [{ names: ["guarded"], enabled: false }]);
		assert.strictEqual(current.webview.ofType("tools")[0].tools[0].tools[0].enabled, false);
		assert.deepStrictEqual(catalog.source.tools, []);
	});

	test("snapshots before the first writing tool and publishes the turn's changes before the run ends", async () => {
		const calls: string[] = [];
		const tracker = new FakeTracker(calls);
		const backend = new FakeBackend([
			progress => progress.report(new vscode.LanguageModelToolCallPart("call-r", "reader", {})),
			progress => {
				progress.report(new vscode.LanguageModelToolCallPart("call-w1", "writer", {}));
				progress.report(new vscode.LanguageModelToolCallPart("call-w2", "writer", {}));
			},
			progress => progress.report(new vscode.LanguageModelTextPart("done")),
		]);
		const current = createHarness(root, backend, loggingTools(calls), tracker);
		harness = current;
		current.webview.receive({ type: "send", text: "edit a file" });
		await waitFor(() => current.webview.ofType("run").some(message => !message.run.running), "turn end");
		assert.deepStrictEqual(calls, ["tool:reader", "begin", "tool:writer", "tool:writer", "end:1:tree-before"]);
		const types = current.webview.messages.map(message => message.type);
		assert.ok(types.lastIndexOf("changes") < types.lastIndexOf("run"), "changes arrive before the run ends");
		assert.deepStrictEqual(current.webview.ofType("changes").at(-1)?.changes.files.map(entry => entry.path), ["a.txt"]);
	});

	test("a turn with only read-only tools takes no snapshot", async () => {
		const calls: string[] = [];
		const backend = new FakeBackend([
			progress => progress.report(new vscode.LanguageModelToolCallPart("call-r", "reader", {})),
			progress => progress.report(new vscode.LanguageModelTextPart("done")),
		]);
		const current = createHarness(root, backend, loggingTools(calls), new FakeTracker(calls));
		harness = current;
		current.webview.receive({ type: "send", text: "just read" });
		await waitFor(() => current.webview.ofType("run").some(message => !message.run.running), "turn end");
		assert.deepStrictEqual(calls, ["tool:reader"]);
		assert.deepStrictEqual(current.webview.ofType("changes"), []);
	});

	test("a writing tool publishes live changes before the run ends", async () => {
		const calls: string[] = [];
		const tracker = new FakeLiveTracker(calls);
		const backend = new FakeBackend([
			progress => progress.report(new vscode.LanguageModelToolCallPart("call-r", "reader", {})),
			progress => progress.report(new vscode.LanguageModelToolCallPart("call-w", "writer", {})),
			progress => progress.report(new vscode.LanguageModelTextPart("done")),
		]);
		const current = createHarness(root, backend, loggingTools(calls), tracker);
		harness = current;
		current.webview.receive({ type: "send", text: "edit a file" });
		await waitFor(() => current.webview.ofType("run").some(message => !message.run.running), "turn end");

		const changes = current.webview.ofType("changes");
		assert.deepStrictEqual(changes[0]?.changes.files.map(entry => entry.path), ["live.txt"]);
		assert.deepStrictEqual(changes.at(-1)?.changes.files.map(entry => entry.path), ["a.txt"]);
		const types = current.webview.messages.map(message => message.type);
		assert.ok(types.indexOf("changes") < types.lastIndexOf("run"), "the live changes arrive before the run ends");
		assert.deepStrictEqual(tracker.liveTurns, [1]);
	});

	test("read-only tools do not publish live changes", async () => {
		const calls: string[] = [];
		const tracker = new FakeLiveTracker(calls);
		const backend = new FakeBackend([
			progress => progress.report(new vscode.LanguageModelToolCallPart("call-r", "reader", {})),
			progress => progress.report(new vscode.LanguageModelTextPart("done")),
		]);
		const current = createHarness(root, backend, loggingTools(calls), tracker);
		harness = current;
		current.webview.receive({ type: "send", text: "just read" });
		await waitFor(() => current.webview.ofType("run").some(message => !message.run.running), "turn end");

		assert.deepStrictEqual(current.webview.ofType("changes"), []);
		assert.deepStrictEqual(tracker.liveTurns, []);
	});

	test("keep, undo and message edits reach the change tracker", async () => {
		const calls: string[] = [];
		const tracker = new FakeTracker(calls);
		const backend = new FakeBackend([
			progress => progress.report(new vscode.LanguageModelTextPart("one")),
			progress => progress.report(new vscode.LanguageModelTextPart("two")),
			progress => progress.report(new vscode.LanguageModelTextPart("two again")),
			progress => progress.report(new vscode.LanguageModelTextPart("two once more")),
		]);
		const current = createHarness(root, backend, loggingTools(calls), tracker);
		harness = current;
		const finished = (): number => current.webview.ofType("run").filter(message => !message.run.running).length;
		current.webview.receive({ type: "ready" });
		await waitFor(() => current.webview.ofType("init").length === 1, "init");
		assert.deepStrictEqual(current.webview.ofType("init")[0].changes, { files: [], sinceTurn: [] });

		current.webview.receive({ type: "keepChanges", ids: ["f1"] });
		await waitFor(() => current.webview.ofType("changes").length === 1, "keep result");
		current.webview.receive({ type: "undoChanges" });
		await waitFor(() => current.webview.ofType("changes").length === 2, "undo result");
		assert.strictEqual(current.webview.ofType("changes")[1].changes.notice, "Undid 1 file.");

		current.webview.receive({ type: "send", text: "first" });
		await waitFor(() => finished() === 1, "first turn");
		current.webview.receive({ type: "send", text: "second" });
		await waitFor(() => finished() === 2, "second turn");
		const second = () => current.webview.ofType("messageAdded").map(message => message.message).filter(message => message.role === "user").at(-1);
		current.webview.receive({ type: "editMessage", messageId: second()!.id, text: "second, edited", undoChanges: true });
		await waitFor(() => finished() === 3, "edited turn");
		current.webview.receive({ type: "editMessage", messageId: second()!.id, text: "second, again" });
		await waitFor(() => finished() === 4, "edited again");
		assert.deepStrictEqual(calls, ["keep:f1", "undo:all", "undoSince:2", "forget:2"]);
	});

	test("an edit whose file undo fails keeps the chat and sends nothing", async () => {
		const calls: string[] = [];
		const tracker = new FakeTracker(calls);
		tracker.undoSinceTurn = async () => {
			throw new Error("disk is busy");
		};
		const backend = new FakeBackend([progress => progress.report(new vscode.LanguageModelTextPart("one"))]);
		const current = createHarness(root, backend, loggingTools(calls), tracker);
		harness = current;
		current.webview.receive({ type: "send", text: "first" });
		await waitFor(() => current.webview.ofType("run").some(message => !message.run.running), "first turn");
		const user = current.webview.ofType("messageAdded").map(message => message.message).find(message => message.role === "user");
		assert.ok(user);

		current.webview.receive({ type: "editMessage", messageId: user.id, text: "first, edited", undoChanges: true });
		await waitFor(() => current.webview.ofType("messageAdded").length === 3, "error notice");
		assert.deepStrictEqual(current.webview.ofType("messageAdded")[2].message.parts, [
			{ kind: "notice", level: "error", text: "Could not undo the file changes, so the message was not edited: disk is busy" },
		]);
		assert.deepStrictEqual(current.webview.ofType("truncated"), []);
		assert.strictEqual(backend.requests.length, 1);
		assert.ok(!calls.some(call => call.startsWith("forget:")));
	});

	test("sends the system prompt and keeps each user message's host context", async () => {
		const backend = new FakeBackend([
			progress => progress.report(new vscode.LanguageModelTextPart("first reply")),
			progress => progress.report(new vscode.LanguageModelTextPart("second reply")),
		]);
		let turn = 0;
		const current = createHarness(root, backend, undefined, undefined, {
			prompt: {
				systemPrompt: async () => "SYSTEM",
				turnContext: () => `<context>\nturn ${++turn}\n</context>`,
			},
		});
		harness = current;
		const finished = (): number => current.webview.ofType("run").filter(message => !message.run.running).length;
		current.webview.receive({ type: "send", text: "Hello" });
		await waitFor(() => finished() === 1, "first turn");
		current.webview.receive({ type: "send", text: "Again" });
		await waitFor(() => finished() === 2, "second turn");

		const first = backend.requests[0].messages;
		assert.strictEqual(first[0].role as number, 3);
		assert.strictEqual(messageText(first[0]), "SYSTEM");
		assert.strictEqual(first[1].role as number, vscode.LanguageModelChatMessageRole.User);
		assert.strictEqual(messageText(first[1]), "<context>\nturn 1\n</context>\n<userRequest>\nHello\n</userRequest>");

		const second = backend.requests[1].messages;
		assert.strictEqual(second[0].role as number, 3);
		assert.strictEqual(messageText(second[1]), messageText(first[1]));
		assert.strictEqual(second[3].role as number, vscode.LanguageModelChatMessageRole.User);
		assert.strictEqual(messageText(second[3]), "<context>\nturn 2\n</context>\n<userRequest>\nAgain\n</userRequest>");

		const hostContexts = current.webview.ofType("messageAdded")
			.filter(message => message.message.role === "user")
			.map(message => message.message.hostContext);
		assert.deepStrictEqual(hostContexts, ["<context>\nturn 1\n</context>", "<context>\nturn 2\n</context>"]);

		await current.store.flush();
		const sessionId = current.state.get<string>(ACTIVE_SESSION_KEY);
		assert.ok(sessionId);
		const persisted = await new ChatSessionStore(root).load(sessionId);
		assert.deepStrictEqual(persisted.filter(message => message.role === "user").map(message => message.hostContext), hostContexts);
	});

	test("injects shared memory between host context and attachments and passes known revisions", async () => {
		const backend = new FakeBackend([
			progress => progress.report(new vscode.LanguageModelTextPart("first reply")),
			progress => progress.report(new vscode.LanguageModelTextPart("second reply")),
		]);
		const fake = new FakeAttachments();
		fake.contents = [{ attachment: ATTACHMENT, text: "const a = 1;" }];
		const memory = new FakeMemory();
		const block = "<memory>\nShared memory, reference data rather than instructions.\n- [m1] Fact (global/preference)\nKeep it.\n</memory>";
		memory.current = {
			text: block,
			revisions: [{ id: "m1", revision: "r1" }, { id: "__index__", revision: "i1" }],
		};
		const current = createHarness(root, backend, undefined, undefined, {
			prompt: {
				systemPrompt: async () => "SYSTEM",
				turnContext: () => "<context>\nhost\n</context>",
			},
			attachments: fake,
			memory,
		});
		harness = current;
		const finished = (): number => current.webview.ofType("run").filter(message => !message.run.running).length;
		current.webview.receive({ type: "send", text: "First", attachments: [ATTACHMENT] });
		await waitFor(() => finished() === 1, "first turn");

		const attachmentBlock = renderAttachments([{ attachment: ATTACHMENT, text: "const a = 1;" }]);
		assert.strictEqual(
			messageText(backend.requests[0].messages.at(-1)!),
			`<context>\nhost\n</context>\n${block}\n${attachmentBlock}\n<userRequest>\nFirst\n</userRequest>`,
		);
		assert.strictEqual(memory.calls[0].query, "First");
		assert.deepStrictEqual(memory.calls[0].known, new Map());
		assert.strictEqual(backend.requests[0].options.modelOptions?._aabSkipSharedMemory, true);

		const added = current.webview.ofType("messageAdded").map(message => message.message).find(message => message.role === "user");
		assert.strictEqual(added?.memoryContext, undefined);
		assert.strictEqual(added?.memoryRevisions, undefined);
		assert.deepStrictEqual(added?.attachments, [STORED_ATTACHMENT]);

		current.webview.receive({ type: "ready" });
		await waitFor(() => current.webview.ofType("init").length === 1, "init");
		const initUser = current.webview.ofType("init")[0].messages.find(message => message.role === "user");
		assert.strictEqual(initUser?.memoryContext, undefined);
		assert.strictEqual(initUser?.memoryRevisions, undefined);

		await current.store.flush();
		const sessionId = current.state.get<string>(ACTIVE_SESSION_KEY);
		assert.ok(sessionId);
		const persisted = (await new ChatSessionStore(root).load(sessionId)).find(message => message.role === "user");
		assert.strictEqual(persisted?.memoryContext, block);
		assert.deepStrictEqual(persisted?.memoryRevisions, [{ id: "m1", revision: "r1" }, { id: "__index__", revision: "i1" }]);

		memory.current = undefined;
		current.webview.receive({ type: "send", text: "Second" });
		await waitFor(() => finished() === 2, "second turn");
		assert.deepStrictEqual(memory.calls[1].known, new Map([["m1", "r1"], ["__index__", "i1"]]));
		assert.strictEqual(
			messageText(backend.requests[1].messages.at(-1)!),
			"<context>\nhost\n</context>\n<userRequest>\nSecond\n</userRequest>",
		);
		assert.strictEqual(backend.requests[1].options.modelOptions?._aabSkipSharedMemory, true);
	});

	test("broadcasts the session title after the first message", async () => {
		const backend = new FakeBackend([progress => progress.report(new vscode.LanguageModelTextPart("ok"))]);
		const current = createHarness(root, backend);
		harness = current;
		current.webview.receive({ type: "send", text: "Name this chat" });
		await waitFor(() => current.webview.ofType("session").length > 0, "session update");

		const session = current.webview.ofType("session").at(-1);
		assert.ok(session?.session.title.startsWith("Name this chat"));
	});

	test("sends the context settings with init and saves only valid changes from the popup", async () => {
		let settings: ChatContextSettings = {
			shared: 258_400, sharedMin: 131_072, sharedMax: 1_048_576, followCodex: false,
			switchTokens: 250_000, switchMin: 32_768, switchMax: 1_048_576,
		};
		const updates: ChatContextSettingsChange[] = [];
		const changed = new vscode.EventEmitter<void>();
		const current = createHarness(root, new FakeBackend(), undefined, undefined, {
			contextSettings: {
				get: () => settings,
				update: async change => {
					updates.push(change);
					settings = { ...settings, ...change };
				},
				onDidChange: changed.event,
			},
		});
		harness = current;
		current.webview.receive({ type: "ready" });
		await waitFor(() => current.webview.ofType("init").length === 1, "init");
		assert.deepStrictEqual(current.webview.ofType("init")[0].contextSettings, settings);

		current.webview.receive({ type: "saveContextSettings", change: { shared: 400_000, followCodex: true, switchTokens: "x", extra: 1 } });
		await waitFor(() => current.webview.ofType("contextSettings").length === 1, "saved settings");
		assert.deepStrictEqual(updates, [{ shared: 400_000, followCodex: true }]);
		assert.deepStrictEqual(current.webview.ofType("contextSettings")[0].settings, { ...settings, shared: 400_000, followCodex: true });

		current.webview.receive({ type: "saveContextSettings", change: { shared: -5, switchTokens: 1.5 } });
		await waitFor(() => current.webview.ofType("contextSettings").length === 2, "ignored values");
		assert.deepStrictEqual(updates.at(-1), {}, "negative and fractional token counts are dropped");
		current.webview.receive({ type: "saveContextSettings" });

		settings = { ...settings, codexModel: "gpt-5.5", codexWindow: 475_000 };
		changed.fire();
		await waitFor(() => current.webview.ofType("contextSettings").length === 3, "followed window");
		assert.strictEqual(current.webview.ofType("contextSettings")[2].settings.codexWindow, 475_000);
		assert.strictEqual(updates.length, 2, "a message without a change is not parsed");
		changed.dispose();
	});

	test("stars models in the global state and sends the stars with the model list", async () => {
		const globalState = new FakeMemento();
		const current = createHarness(root, new FakeBackend(), undefined, undefined, { globalState });
		harness = current;
		current.webview.receive({ type: "ready" });
		await waitFor(() => current.webview.ofType("init").length === 1, "init");
		assert.deepStrictEqual(current.webview.ofType("init")[0].favoriteModels, []);
		const [first, second] = MODELS;
		const favorites = (): string[] | undefined => current.webview.ofType("models").at(-1)?.favoriteModels;

		current.webview.receive({ type: "setFavoriteModel", modelId: first.id, favorite: true });
		await waitFor(() => favorites()?.length === 1, "first star");
		current.webview.receive({ type: "setFavoriteModel", modelId: second.id, favorite: true });
		await waitFor(() => favorites()?.length === 2, "second star");
		current.webview.receive({ type: "setFavoriteModel", modelId: first.id, favorite: false });
		await waitFor(() => favorites()?.length === 1, "unstar");
		assert.deepStrictEqual(favorites(), [second.id]);
		current.webview.receive({ type: "setFavoriteModel", modelId: 5, favorite: true });
		current.webview.receive({ type: "setFavoriteModel", modelId: second.id });
		await new Promise<void>(resolve => setTimeout(resolve, 30));
		assert.deepStrictEqual(favorites(), [second.id], "malformed messages change nothing");
		assert.deepStrictEqual(globalState.get("llamacpp.chat.favoriteModels"), [second.id]);
		assert.strictEqual(current.state.get("llamacpp.chat.favoriteModels"), undefined, "stars are shared by every workspace");
	});

	test("compacts a long chat before another model takes over", async () => {
		const longReply = "x".repeat(2_000);
		const backend = new FakeBackend([
			progress => progress.report(new vscode.LanguageModelTextPart(longReply)),
			progress => progress.report(new vscode.LanguageModelTextPart("second reply")),
		]);
		const plans: ChatCompactionPlan[] = [];
		const current = createHarness(root, backend, undefined, undefined, {
			compaction: {
				summarize: async plan => {
					plans.push(plan);
					return { summary: "SUMMARY", method: "deepseek" };
				},
				limits: () => ({ triggerTokens: 50, targetTokens: 100 }),
			},
		});
		harness = current;
		const finished = (): number => current.webview.ofType("run").filter(message => !message.run.running).length;
		current.webview.receive({ type: "send", text: "First question" });
		await waitFor(() => finished() === 1, "first turn");
		current.webview.receive({ type: "selectModel", modelId: "claude::smart" });
		await waitFor(() => current.webview.ofType("models").some(message => message.selectedModelId === "claude::smart"), "model selection");
		current.webview.receive({ type: "send", text: "Second question" });
		await waitFor(() => finished() === 2, "second turn");

		const added = current.webview.ofType("messageAdded").map(message => message.message);
		const user1 = added.find(message => message.role === "user" && message.turn === 1);
		const assistant1 = added.find(message => message.role === "assistant" && message.turn === 1);
		const user2 = added.find(message => message.role === "user" && message.turn === 2);
		const assistant2 = added.find(message => message.role === "assistant" && message.turn === 2);
		assert.ok(user1 && assistant1 && user2 && assistant2);

		assert.strictEqual(plans.length, 1);
		assert.deepStrictEqual(plans[0].dropped.map(message => message.id), [user1.id, assistant1.id]);
		assert.ok(current.webview.ofType("run").some(message => message.run.detail === "Compacting context…"));

		const parts = current.webview.ofType("partAdded").filter(message => message.messageId === assistant2.id).map(message => message.part);
		assert.strictEqual(parts[0]?.kind, "compaction");
		const compaction = parts[0];
		if (compaction.kind !== "compaction") {
			throw new Error("expected a compaction part");
		}
		assert.strictEqual(compaction.summary, "SUMMARY");
		assert.strictEqual(compaction.keepFromMessageId, user2.id);

		const secondRequest = backend.requests[1].messages;
		assert.strictEqual(secondRequest.length, 2);
		assert.strictEqual(secondRequest[0].role as number, vscode.LanguageModelChatMessageRole.User);
		assert.strictEqual(messageText(secondRequest[0]), compactionSummaryText(compaction));
		assert.strictEqual(secondRequest[1].role as number, vscode.LanguageModelChatMessageRole.User);
		assert.strictEqual(messageText(secondRequest[1]), "Second question");
		assert.ok(!secondRequest.some(message => messageText(message).includes(longReply)));

		await current.store.flush();
		const sessionId = current.state.get<string>(ACTIVE_SESSION_KEY);
		assert.ok(sessionId);
		const persisted = await new ChatSessionStore(root).load(sessionId);
		const savedAssistant = persisted.find(message => message.id === assistant2.id);
		assert.ok(savedAssistant);
		assert.strictEqual(savedAssistant.parts[0].kind, "compaction");
	});

	test("lets the model taking over write the summary without DeepSeek and names the chat log", async () => {
		const longReply = "x".repeat(2_000);
		const written = [
			"## Objective", "Answer both questions.", "## Completed", "- Answered the first question.", "## Decisions", "(none)",
			"## Files and symbols", "(none)", "## Verification", "(none)", "## Failed approaches", "(none)", "## Constraints", "(none)",
			"## Open work", "- Answer the second question.",
		].join("\n");
		const backend = new FakeBackend([
			progress => progress.report(new vscode.LanguageModelTextPart(longReply)),
			progress => progress.report(new vscode.LanguageModelTextPart(written)),
			progress => progress.report(new vscode.LanguageModelTextPart("second reply")),
		]);
		const current = createHarness(root, backend, undefined, undefined, {
			compaction: {
				summarize: createChatSummarizer({ apiKey: async () => undefined, userAgent: "test-agent" }),
				limits: () => ({ triggerTokens: 50, targetTokens: 100 }),
			},
		});
		harness = current;
		const finished = (): number => current.webview.ofType("run").filter(message => !message.run.running).length;
		current.webview.receive({ type: "send", text: "First question" });
		await waitFor(() => finished() === 1, "first turn");
		current.webview.receive({ type: "selectModel", modelId: "claude::smart" });
		await waitFor(() => current.webview.ofType("models").some(message => message.selectedModelId === "claude::smart"), "model selection");
		current.webview.receive({ type: "send", text: "Second question" });
		await waitFor(() => finished() === 2, "second turn");

		assert.strictEqual(backend.requests.length, 3, "the first answer, the summary and the second answer");
		const writer = backend.requests[1];
		assert.deepStrictEqual(writer.options.tools, [], "the summary writer gets no tools");
		assert.strictEqual(writer.messages[0].role as number, 3);
		assert.match(messageText(writer.messages[0]), /durable engineering-task summary/);
		assert.match(messageText(writer.messages[0]), /under 32000 characters/);
		assert.match(messageText(writer.messages[1]), /First question/);

		const assistant2 = current.webview.ofType("messageAdded").map(message => message.message).find(message => message.role === "assistant" && message.turn === 2);
		assert.ok(assistant2);
		const compaction = current.webview.ofType("partAdded").filter(message => message.messageId === assistant2.id).map(message => message.part)[0];
		if (compaction?.kind !== "compaction") {
			throw new Error("expected a compaction part");
		}
		const sessionId = current.state.get<string>(ACTIVE_SESSION_KEY);
		assert.ok(sessionId);
		assert.strictEqual(compaction.method, "model");
		assert.strictEqual(compaction.summaryModel, "Smart (Claude)");
		assert.strictEqual(compaction.fallbackReason, "No DeepSeek API key is set.");
		assert.match(compaction.summary, /Answered the first question/);
		assert.deepStrictEqual(compaction.requests, ["First question"]);
		assert.strictEqual(compaction.transcriptPath, current.store.logPath(sessionId));
		const summaryText = messageText(backend.requests[2].messages[0]);
		assert.ok(summaryText.includes(JSON.stringify(current.store.logPath(sessionId))), "the summary names the chat log");
		assert.match(summaryText, /verbatim[^\n]*\n\[1\] First question/);
	});

	test("does not compact when the same model continues", async () => {
		const longReply = "x".repeat(2_000);
		const backend = new FakeBackend([
			progress => progress.report(new vscode.LanguageModelTextPart(longReply)),
			progress => progress.report(new vscode.LanguageModelTextPart("second reply")),
		]);
		const plans: ChatCompactionPlan[] = [];
		const current = createHarness(root, backend, undefined, undefined, {
			compaction: {
				summarize: async plan => {
					plans.push(plan);
					return { summary: "SUMMARY", method: "deepseek" };
				},
				limits: () => ({ triggerTokens: 50, targetTokens: 100 }),
			},
		});
		harness = current;
		const finished = (): number => current.webview.ofType("run").filter(message => !message.run.running).length;
		current.webview.receive({ type: "send", text: "First question" });
		await waitFor(() => finished() === 1, "first turn");
		current.webview.receive({ type: "send", text: "Second question" });
		await waitFor(() => finished() === 2, "second turn");

		assert.deepStrictEqual(plans, []);
		assert.deepStrictEqual(backend.requests[1].messages.map(messageText), ["First question", longReply, "Second question"]);
	});

	test("open subagent persists its report and can be continued", async () => {
		const subagent = createSubagentTool({ models: () => [{ id: "claude::smart", label: "Smart (Claude)", useWhen: "tests" }] });
		const source = createChatToolSource({ enabledTools: () => [subagent], groups: () => [], setEnabled: async () => undefined });
		let id = "";
		const gate = deferred();
		const backend = new FakeBackend([
			progress => progress.report(new vscode.LanguageModelToolCallPart("open", SUBAGENT_TOOL_NAME, { description: "Check", prompt: "First task", model: "Smart (Claude)", keepOpen: true })),
			progress => progress.report(new vscode.LanguageModelTextPart("First answer")),
			progress => progress.report(new vscode.LanguageModelTextPart("Done")),
			progress => progress.report(new vscode.LanguageModelToolCallPart("follow", SUBAGENT_TOOL_NAME, { subagentId: id, prompt: "Second task" })),
			async progress => { await gate.promise; progress.report(new vscode.LanguageModelTextPart("Second answer")); },
			progress => progress.report(new vscode.LanguageModelTextPart("Done again")),
		]);
		const current = createHarness(root, backend, source);
		harness = current;
		current.webview.receive({ type: "send", text: "Delegate" });
		await waitFor(() => current.webview.ofType("run").filter(message => !message.run.running).length === 1, "first turn");
		const idle = current.webview.ofType("subagents").find(message => message.subagents.some(agent => agent.status === "idle"));
		assert.ok(idle);
		assert.strictEqual(idle.subagents[0].description, "Check");
		assert.strictEqual(idle.subagents[0].modelName, "Smart (Claude)");
		id = idle.subagents[0].id;
		const sessionId = current.state.get<string>(ACTIVE_SESSION_KEY);
		assert.ok(sessionId);
		assert.strictEqual((await current.store.loadSubagents(sessionId))[0].history.length, 2);
		assert.ok(current.webview.ofType("partAdded").some(message => message.part.kind === "toolResult" && message.part.text.includes("is still open")));
		current.webview.receive({ type: "send", text: "Continue" });
		await waitFor(() => backend.requests.length >= 5, "continued subagent");
		try {
			assert.ok(current.webview.ofType("subagents").some(message => message.subagents.some(agent => agent.id === id && agent.status === "running")));
			assert.ok(backend.requests[3].messages.some(message => messageText(message).includes("<open_subagents>") && messageText(message).includes(id)));
			assert.ok(backend.requests[4].messages.some(message => messageText(message).includes("First task")));
			assert.ok(backend.requests[4].messages.some(message => messageText(message).includes("First answer")));
		} finally {
			gate.resolve();
		}
		await waitFor(() => current.webview.ofType("run").filter(message => !message.run.running).length === 2, "second turn");
		assert.strictEqual((await current.store.loadSubagents(sessionId))[0].history.length, 4);
		await current.store.flush();
		current.controller.dispose();
		current.webview.dispose();
		const reloaded = createHarness(root, new FakeBackend(), source);
		harness = reloaded;
		await reloaded.state.update(ACTIVE_SESSION_KEY, sessionId);
		reloaded.webview.receive({ type: "ready" });
		await waitFor(() => reloaded.webview.ofType("init").length > 0, "reloaded init");
		assert.ok(reloaded.webview.ofType("init").some(message => message.subagents?.some(agent => agent.id === id)));
	});

	for (const method of ["tool", "webview"] as const) {
		test(`open subagent closes through ${method}`, async () => {
			const options = { models: () => [{ id: "claude::smart", label: "Smart (Claude)", useWhen: "tests" }] };
			const source = createChatToolSource({ enabledTools: () => [createSubagentTool(options), createCloseSubagentTool(options)], groups: () => [], setEnabled: async () => undefined });
			const closed: string[] = [];
			let id = "";
			const backend = new FakeBackend([
				progress => progress.report(new vscode.LanguageModelToolCallPart("open", SUBAGENT_TOOL_NAME, { prompt: "Task", model: "Smart (Claude)", keepOpen: true })),
				progress => progress.report(new vscode.LanguageModelTextPart("Report")),
				progress => progress.report(new vscode.LanguageModelTextPart("Done")),
				progress => progress.report(new vscode.LanguageModelToolCallPart("close", "close_subagent", { subagentId: id })),
				progress => progress.report(new vscode.LanguageModelTextPart("Closed")),
			]);
			const current = createHarness(root, backend, source, undefined, { terminals: { closeOwner: owner => { closed.push(owner); return 0; } } });
			harness = current;
			current.webview.receive({ type: "send", text: "Delegate" });
			await waitFor(() => current.webview.ofType("run").some(message => !message.run.running), "open turn");
			id = current.webview.ofType("subagents").find(message => message.subagents.some(agent => agent.status === "idle"))!.subagents[0].id;
			const sessionId = current.state.get<string>(ACTIVE_SESSION_KEY);
			assert.ok(sessionId);
			if (method === "tool") {
				current.webview.receive({ type: "send", text: "Close it" });
				await waitFor(() => current.webview.ofType("run").filter(message => !message.run.running).length === 2, "close turn");
				assert.ok(current.webview.ofType("partAdded").some(message => message.part.kind === "toolResult" && message.part.text.includes(`Closed subagent ${id}`)));
			} else {
				current.webview.receive({ type: "closeSubagent", sessionId, subagentId: id });
				await waitFor(() => closed.length > 0, "webview close");
			}
			await waitFor(() => current.webview.ofType("subagents").some(message => message.subagents.length === 0), "empty subagents");
			assert.deepStrictEqual(await current.store.loadSubagents(sessionId), []);
			assert.deepStrictEqual(closed, [`subagent:${sessionId}/${id}`]);
		});
	}

	test("open subagent rejects unknown ids and a seventh agent", async () => {
		const subagent = createSubagentTool({ models: () => [{ id: "claude::smart", label: "Smart (Claude)", useWhen: "tests" }] });
		const source = createChatToolSource({ enabledTools: () => [subagent], groups: () => [], setEnabled: async () => undefined });
		const rounds: Round[] = [
			progress => progress.report(new vscode.LanguageModelToolCallPart("missing", SUBAGENT_TOOL_NAME, { subagentId: "sa-missing", prompt: "Task" })),
		];
		for (let index = 0; index < 6; index++) {
			rounds.push(
				progress => progress.report(new vscode.LanguageModelToolCallPart(`open-${index}`, SUBAGENT_TOOL_NAME, { prompt: "Task", model: "Smart (Claude)", keepOpen: true })),
				progress => progress.report(new vscode.LanguageModelTextPart("Report")),
			);
		}
		rounds.push(
			progress => progress.report(new vscode.LanguageModelToolCallPart("seventh", SUBAGENT_TOOL_NAME, { prompt: "Task", model: "Smart (Claude)", keepOpen: true })),
			progress => progress.report(new vscode.LanguageModelTextPart("Done")),
		);
		const current = createHarness(root, new FakeBackend(rounds), source);
		harness = current;
		current.webview.receive({ type: "send", text: "Delegate" });
		await waitFor(() => current.webview.ofType("run").some(message => !message.run.running), "turn end");
		const results = current.webview.ofType("partAdded").map(message => message.part).filter(part => part.kind === "toolResult");
		assert.ok(results.some(part => part.callId === "missing" && part.isError && part.text.includes("No subagent is open")));
		assert.ok(results.some(part => part.callId === "seventh" && part.isError && part.text.includes("close_subagent")));
	});

	test("open subagent one-off closes its terminal without being listed", async () => {
		const subagent = createSubagentTool({ models: () => [{ id: "claude::smart", label: "Smart (Claude)", useWhen: "tests" }] });
		const source = createChatToolSource({ enabledTools: () => [subagent], groups: () => [], setEnabled: async () => undefined });
		const closed: string[] = [];
		const backend = new FakeBackend([
			progress => progress.report(new vscode.LanguageModelToolCallPart("one-off", SUBAGENT_TOOL_NAME, { prompt: "Task", model: "Smart (Claude)" })),
			progress => progress.report(new vscode.LanguageModelTextPart("Report")),
			progress => progress.report(new vscode.LanguageModelTextPart("Done")),
		]);
		const current = createHarness(root, backend, source, undefined, { terminals: { closeOwner: owner => { closed.push(owner); return 0; } } });
		harness = current;
		current.webview.receive({ type: "send", text: "Delegate" });
		await waitFor(() => current.webview.ofType("run").some(message => !message.run.running), "turn end");
		assert.deepStrictEqual(closed, ["subagent:one-off"]);
		assert.ok(current.webview.ofType("subagents").every(message => message.subagents.length === 0));
		const sessionId = current.state.get<string>(ACTIVE_SESSION_KEY);
		assert.ok(sessionId);
		assert.deepStrictEqual(await current.store.loadSubagents(sessionId), []);
	});

	test("runs the main agent's tools while a subagent from the same round works", async () => {
		const finishSubagent = deferred();
		const subagent = createSubagentTool({ models: () => [{ id: "claude::smart", label: "Smart (Claude)", useWhen: "tests" }] });
		const probe: ChatTool = {
			name: "probe",
			description: "Read a file.",
			inputSchema: { type: "object", properties: {} },
			group: "files",
			readOnly: true,
			invoke: async () => "probe result",
		};
		const source = createChatToolSource({ enabledTools: () => [subagent, probe], groups: () => [], setEnabled: async () => undefined });
		const backend = new FakeBackend([
			progress => {
				progress.report(new vscode.LanguageModelToolCallPart("delegate", SUBAGENT_TOOL_NAME, { prompt: "Inspect a file", model: "Smart (Claude)" }));
				progress.report(new vscode.LanguageModelToolCallPart("probe", "probe", {}));
			},
			async progress => {
				await finishSubagent.promise;
				progress.report(new vscode.LanguageModelTextPart("Subagent report"));
			},
			progress => progress.report(new vscode.LanguageModelTextPart("Done")),
		]);
		const current = createHarness(root, backend, source);
		harness = current;
		current.webview.receive({ type: "send", text: "Inspect two files" });

		const results = () => current.webview.ofType("partAdded").flatMap(({ part }) => part.kind === "toolResult" ? [part.callId] : []);
		try {
			await waitFor(() => backend.requests.length === 2 && results().includes("probe"), "main tool result while subagent is running");
			assert.deepStrictEqual(results(), ["probe"]);
		} finally {
			finishSubagent.resolve();
		}
		await waitFor(() => current.webview.ofType("run").some(message => !message.run.running), "turn end");
		assert.deepStrictEqual(results(), ["probe", "delegate"]);
		assert.strictEqual(backend.requests.length, 3);
	});

	test("runs a subagent and gives the parent only its report", async () => {
		const owners: Array<{ id: string; label: string } | undefined> = [];
		const closed: string[] = [];
		const probe: ChatTool = {
			name: "probe",
			description: "Read a file.",
			inputSchema: { type: "object", properties: {} },
			group: "files",
			readOnly: true,
			invoke: async (_input, _token, context) => { owners.push(context?.terminalOwner); return "probe body"; },
		};
		const subagent = createSubagentTool({ models: () => [{ id: "claude::smart", label: "Smart (Claude)", useWhen: "tests" }] });
		const source = createChatToolSource({
			enabledTools: () => [subagent, probe],
			groups: () => [{
				id: "agents",
				label: "Subagents",
				tools: [
					{ name: subagent.name, description: subagent.description, enabled: true },
					{ name: probe.name, description: probe.description, enabled: true },
				],
			}],
			setEnabled: async () => undefined,
		});
		const backend = new FakeBackend([
			progress => progress.report(new vscode.LanguageModelToolCallPart("call-main", "probe", {})),
			progress => progress.report(new vscode.LanguageModelToolCallPart("call-sub", SUBAGENT_TOOL_NAME, { description: "Check", prompt: "Inspect a.txt", model: "Smart (Claude)" })),
			progress => progress.report(new vscode.LanguageModelToolCallPart("call-probe", "probe", { path: "a.txt" })),
			progress => progress.report(new vscode.LanguageModelTextPart("REPORT")),
			progress => progress.report(new vscode.LanguageModelTextPart("Done")),
		]);
		const current = createHarness(root, backend, source, undefined, { terminals: { closeOwner: owner => { closed.push(owner); return 0; } } });
		harness = current;
		current.webview.receive({ type: "send", text: "Please inspect" });
		await waitFor(() => current.webview.ofType("run").some(message => !message.run.running), "turn end");

		assert.strictEqual(backend.requests.length, 5);
		assert.deepStrictEqual(owners, [{ id: `chat:${current.state.get<string>(ACTIVE_SESSION_KEY)}`, label: "Chat" }, { id: "subagent:call-sub", label: "Subagent: Check" }]);
		assert.deepStrictEqual(closed, ["subagent:call-sub"]);
		const subagentRequest = backend.requests[2];
		assert.ok(!(subagentRequest.options.tools ?? []).some(tool => tool.name === SUBAGENT_TOOL_NAME));
		assert.ok(subagentRequest.messages.some(message => messageText(message).includes("Inspect a.txt")));
		assert.ok(!subagentRequest.messages.some(message => messageText(message).includes("Please inspect")));

		const parts = current.webview.ofType("partAdded").map(message => message.part);
		const subagentPartIndex = parts.findIndex(part => part.kind === "subagent");
		assert.ok(subagentPartIndex >= 0);
		const subagentPart = parts[subagentPartIndex];
		if (subagentPart.kind !== "subagent") {
			throw new Error("expected a subagent part");
		}
		assert.strictEqual(subagentPart.callId, "call-sub");
		assert.strictEqual(subagentPart.status, "done");
		assert.strictEqual(subagentPart.modelId, "claude::smart");
		assert.ok(subagentPart.steps.some(step => step.kind === "tool" && step.name === "probe"));

		const reportIndex = parts.findIndex(part => part.kind === "toolResult" && part.callId === "call-sub");
		assert.ok(reportIndex > subagentPartIndex, "the subagent part is added before the subagent tool result");
		const report = parts[reportIndex];
		if (report.kind !== "toolResult") {
			throw new Error("expected the subagent tool result");
		}
		assert.strictEqual(report.text, "REPORT");
		assert.strictEqual(report.isError, false);

		await current.store.flush();
		const sessionId = current.state.get<string>(ACTIVE_SESSION_KEY);
		assert.ok(sessionId);
		const persisted = await new ChatSessionStore(root).load(sessionId);
		const assistant = persisted.find(message => message.role === "assistant");
		assert.ok(assistant?.parts.some(part => part.kind === "subagent" && part.callId === "call-sub" && part.status === "done"));
	});

	test("an unknown subagent model gives an error result and the turn continues", async () => {
		const subagent = createSubagentTool({ models: () => [{ id: "claude::smart", label: "Smart (Claude)", useWhen: "tests" }] });
		const source = createChatToolSource({
			enabledTools: () => [subagent],
			groups: () => [],
			setEnabled: async () => undefined,
		});
		const backend = new FakeBackend([
			progress => progress.report(new vscode.LanguageModelToolCallPart("call-sub", SUBAGENT_TOOL_NAME, { description: "Check", prompt: "x", model: "Missing Model" })),
			progress => progress.report(new vscode.LanguageModelTextPart("Done")),
		]);
		const current = createHarness(root, backend, source);
		harness = current;
		current.webview.receive({ type: "send", text: "Delegate" });
		await waitFor(() => current.webview.ofType("run").some(message => !message.run.running), "turn end");

		assert.strictEqual(backend.requests.length, 2);
		const result = current.webview.ofType("partAdded").map(message => message.part).find(part => part.kind === "toolResult");
		if (result?.kind !== "toolResult") {
			throw new Error("expected a tool result");
		}
		assert.strictEqual(result.callId, "call-sub");
		assert.strictEqual(result.isError, true);
		assert.ok(result.text.includes('Unknown subagent model "Missing Model"'));
		assert.strictEqual(current.webview.ofType("textDelta").map(delta => delta.text).join(""), "Done");
	});

	test("sends attachments as a rendered block and keeps only display info", async () => {
		const backend = new FakeBackend([progress => progress.report(new vscode.LanguageModelTextPart("Done."))]);
		const fake = new FakeAttachments();
		fake.contents = [{ attachment: ATTACHMENT, text: "const a = 1;" }];
		const current = createHarness(root, backend, undefined, undefined, { attachments: fake });
		harness = current;
		current.webview.receive({ type: "send", text: "Explain", attachments: [ATTACHMENT] });
		await waitFor(() => current.webview.ofType("run").some(message => !message.run.running), "turn end");

		const block = renderAttachments([{ attachment: ATTACHMENT, text: "const a = 1;" }]);
		assert.strictEqual(messageText(backend.requests[0].messages.at(-1)!), `${block}\n<userRequest>\nExplain\n</userRequest>`);
		assert.deepStrictEqual(fake.reads, [[ATTACHMENT]]);

		const added = current.webview.ofType("messageAdded").map(message => message.message).find(message => message.role === "user");
		assert.deepStrictEqual(added?.attachments, [STORED_ATTACHMENT]);
		assert.strictEqual(added?.attachmentContext, undefined);

		current.webview.receive({ type: "ready" });
		await waitFor(() => current.webview.ofType("init").length === 1, "init");
		const initUser = current.webview.ofType("init")[0].messages.find(message => message.role === "user");
		assert.deepStrictEqual(initUser?.attachments, [STORED_ATTACHMENT]);
		assert.strictEqual(initUser?.attachmentContext, undefined);

		await current.store.flush();
		const sessionId = current.state.get<string>(ACTIVE_SESSION_KEY);
		assert.ok(sessionId);
		const persisted = (await new ChatSessionStore(root).load(sessionId)).find(message => message.role === "user");
		assert.deepStrictEqual(persisted?.attachments, [STORED_ATTACHMENT]);
		assert.strictEqual(persisted?.attachmentContext, block);
	});

	test("marks the attachments the model did not get on the stored message", async () => {
		const backend = new FakeBackend([progress => progress.report(new vscode.LanguageModelTextPart("Done."))]);
		const fake = new FakeAttachments();
		fake.contents = [
			{ attachment: ATTACHMENT, text: "const a = 1;" },
			{ attachment: FILE_ATTACHMENT, error: "the file is larger than 2 MB" },
		];
		const current = createHarness(root, backend, undefined, undefined, { attachments: fake });
		harness = current;
		// The webview cannot set an error itself.
		current.webview.receive({ type: "send", text: "Explain", attachments: [{ ...ATTACHMENT, error: "spoofed" }, FILE_ATTACHMENT] });
		await waitFor(() => current.webview.ofType("run").some(message => !message.run.running), "turn end");

		const added = current.webview.ofType("messageAdded").map(message => message.message).find(message => message.role === "user");
		assert.deepStrictEqual(added?.attachments, [STORED_ATTACHMENT, { ...FILE_ATTACHMENT, error: "the file is larger than 2 MB" }]);
		await current.store.flush();
		const sessionId = current.state.get<string>(ACTIVE_SESSION_KEY);
		assert.ok(sessionId);
		const persisted = (await new ChatSessionStore(root).load(sessionId)).find(message => message.role === "user");
		assert.deepStrictEqual(persisted?.attachments, added?.attachments);
	});

	test("tells the model and the user when the attachments cannot be read at all", async () => {
		const backend = new FakeBackend([progress => progress.report(new vscode.LanguageModelTextPart("Done."))]);
		const fake = new FakeAttachments();
		fake.read = async () => {
			throw new Error("no access");
		};
		const current = createHarness(root, backend, undefined, undefined, { attachments: fake });
		harness = current;
		current.webview.receive({ type: "send", text: "Explain", attachments: [FILE_ATTACHMENT] });
		await waitFor(() => current.webview.ofType("run").some(message => !message.run.running), "turn end");

		const missing = { ...FILE_ATTACHMENT, error: "could not be read: no access" };
		const block = renderAttachments([{ attachment: FILE_ATTACHMENT, error: missing.error }]);
		assert.strictEqual(messageText(backend.requests[0].messages.at(-1)!), `${block}\n<userRequest>\nExplain\n</userRequest>`);
		const added = current.webview.ofType("messageAdded").map(message => message.message).find(message => message.role === "user");
		assert.deepStrictEqual(added?.attachments, [missing]);
	});

	test("posts picked and dropped attachments back to the requesting webview", async () => {
		const fake = new FakeAttachments();
		const file: ChatAttachment = { id: "att-2", kind: "file", path: "src/b.ts", uri: "file:///src/b.ts" };
		fake.picked = [ATTACHMENT];
		fake.from = [file];
		const current = createHarness(root, new FakeBackend(), undefined, undefined, { attachments: fake });
		harness = current;
		current.webview.receive({ type: "pickAttachments" });
		await waitFor(() => current.webview.ofType("attachmentsAdded").length === 1, "picked attachments");
		assert.deepStrictEqual(current.webview.ofType("attachmentsAdded")[0].attachments, [ATTACHMENT]);

		current.webview.receive({ type: "addAttachments", uris: ["file:///src/b.ts", "file:///src/c.ts"] });
		await waitFor(() => current.webview.ofType("attachmentsAdded").length === 2, "dropped attachments");
		assert.deepStrictEqual(fake.fromUriCalls, [["file:///src/b.ts", "file:///src/c.ts"]]);
		assert.deepStrictEqual(current.webview.ofType("attachmentsAdded")[1].attachments, [file]);
	});

	test("editing a message reuses its attachment context without reading the files again", async () => {
		const backend = new FakeBackend([
			progress => progress.report(new vscode.LanguageModelTextPart("First.")),
			progress => progress.report(new vscode.LanguageModelTextPart("Second.")),
		]);
		const fake = new FakeAttachments();
		fake.contents = [{ attachment: ATTACHMENT, text: "const a = 1;" }];
		const current = createHarness(root, backend, undefined, undefined, { attachments: fake });
		harness = current;
		const finished = (): number => current.webview.ofType("run").filter(message => !message.run.running).length;
		current.webview.receive({ type: "send", text: "First", attachments: [ATTACHMENT] });
		await waitFor(() => finished() === 1, "first turn");
		assert.strictEqual(fake.reads.length, 1);
		const user = current.webview.ofType("messageAdded").map(message => message.message).find(message => message.role === "user");
		assert.ok(user);

		current.webview.receive({ type: "editMessage", messageId: user.id, text: "Second" });
		await waitFor(() => finished() === 2 && backend.requests.length === 2, "edited turn");
		assert.strictEqual(fake.reads.length, 1, "the edit must not read the files again");
		const block = renderAttachments([{ attachment: ATTACHMENT, text: "const a = 1;" }]);
		assert.strictEqual(messageText(backend.requests[1].messages.at(-1)!), `${block}\n<userRequest>\nSecond\n</userRequest>`);
		const resent = current.webview.ofType("messageAdded").map(message => message.message).filter(message => message.role === "user").at(-1);
		assert.deepStrictEqual(resent?.attachments, [STORED_ATTACHMENT]);
	});

	test("editing with the same attachments keeps the rendered block", async () => {
		const backend = new FakeBackend([
			progress => progress.report(new vscode.LanguageModelTextPart("First.")),
			progress => progress.report(new vscode.LanguageModelTextPart("Second.")),
		]);
		const fake = new FakeAttachments();
		fake.contents = [{ attachment: ATTACHMENT, text: "const a = 1;" }];
		const current = createHarness(root, backend, undefined, undefined, { attachments: fake });
		harness = current;
		const finished = (): number => current.webview.ofType("run").filter(message => !message.run.running).length;
		current.webview.receive({ type: "send", text: "First", attachments: [ATTACHMENT] });
		await waitFor(() => finished() === 1, "first turn");
		const user = current.webview.ofType("messageAdded").map(message => message.message).find(message => message.role === "user");
		assert.ok(user);

		current.webview.receive({ type: "editMessage", messageId: user.id, text: "Second", attachments: [STORED_ATTACHMENT] });
		await waitFor(() => finished() === 2 && backend.requests.length === 2, "edited turn");
		assert.strictEqual(fake.reads.length, 1, "the same attachments are not read again");
		const block = renderAttachments([{ attachment: ATTACHMENT, text: "const a = 1;" }]);
		assert.strictEqual(messageText(backend.requests[1].messages.at(-1)!), `${block}\n<userRequest>\nSecond\n</userRequest>`);
		const resent = current.webview.ofType("messageAdded").map(message => message.message).filter(message => message.role === "user").at(-1);
		assert.deepStrictEqual(resent?.attachments, [STORED_ATTACHMENT]);
		await current.store.flush();
		const sessionId = current.state.get<string>(ACTIVE_SESSION_KEY);
		assert.ok(sessionId);
		const persisted = (await new ChatSessionStore(root).load(sessionId)).filter(message => message.role === "user").at(-1);
		assert.strictEqual(persisted?.attachmentContext, block);
	});

	test("removing an attachment from an edited message renders without it", async () => {
		const backend = new FakeBackend([
			progress => progress.report(new vscode.LanguageModelTextPart("First.")),
			progress => progress.report(new vscode.LanguageModelTextPart("Second.")),
		]);
		const fake = new FakeAttachments();
		fake.contents = [
			{ attachment: ATTACHMENT, text: "const a = 1;" },
			{ attachment: FILE_ATTACHMENT, text: "export const b = 2;" },
		];
		const current = createHarness(root, backend, undefined, undefined, { attachments: fake });
		harness = current;
		const finished = (): number => current.webview.ofType("run").filter(message => !message.run.running).length;
		current.webview.receive({ type: "send", text: "First", attachments: [ATTACHMENT, FILE_ATTACHMENT] });
		await waitFor(() => finished() === 1, "first turn");
		const user = current.webview.ofType("messageAdded").map(message => message.message).find(message => message.role === "user");
		assert.ok(user);
		fake.contents = [{ attachment: ATTACHMENT, text: "const a = 1;" }];

		current.webview.receive({ type: "editMessage", messageId: user.id, text: "Second", attachments: [STORED_ATTACHMENT] });
		await waitFor(() => finished() === 2 && backend.requests.length === 2, "edited turn");
		assert.strictEqual(fake.reads.length, 2, "the remaining attachment is read again");
		const block = renderAttachments([{ attachment: ATTACHMENT, text: "const a = 1;" }]);
		assert.strictEqual(messageText(backend.requests[1].messages.at(-1)!), `${block}\n<userRequest>\nSecond\n</userRequest>`);
		const resent = current.webview.ofType("messageAdded").map(message => message.message).filter(message => message.role === "user").at(-1);
		assert.deepStrictEqual(resent?.attachments, [STORED_ATTACHMENT]);
	});

	test("adding an attachment to an edited message reads it", async () => {
		const backend = new FakeBackend([
			progress => progress.report(new vscode.LanguageModelTextPart("First.")),
			progress => progress.report(new vscode.LanguageModelTextPart("Second.")),
		]);
		const fake = new FakeAttachments();
		fake.contents = [{ attachment: ATTACHMENT, text: "const a = 1;" }];
		const current = createHarness(root, backend, undefined, undefined, { attachments: fake });
		harness = current;
		const finished = (): number => current.webview.ofType("run").filter(message => !message.run.running).length;
		current.webview.receive({ type: "send", text: "First", attachments: [ATTACHMENT] });
		await waitFor(() => finished() === 1, "first turn");
		const user = current.webview.ofType("messageAdded").map(message => message.message).find(message => message.role === "user");
		assert.ok(user);
		fake.contents = [
			{ attachment: ATTACHMENT, text: "const a = 1;" },
			{ attachment: FILE_ATTACHMENT, text: "export const b = 2;" },
		];

		current.webview.receive({ type: "editMessage", messageId: user.id, text: "Second", attachments: [STORED_ATTACHMENT, FILE_ATTACHMENT] });
		await waitFor(() => finished() === 2 && backend.requests.length === 2, "edited turn");
		assert.deepStrictEqual(fake.reads[1], [STORED_ATTACHMENT, FILE_ATTACHMENT]);
		const block = renderAttachments([
			{ attachment: ATTACHMENT, text: "const a = 1;" },
			{ attachment: FILE_ATTACHMENT, text: "export const b = 2;" },
		]);
		assert.strictEqual(messageText(backend.requests[1].messages.at(-1)!), `${block}\n<userRequest>\nSecond\n</userRequest>`);
		const resent = current.webview.ofType("messageAdded").map(message => message.message).filter(message => message.role === "user").at(-1);
		assert.deepStrictEqual(resent?.attachments, [STORED_ATTACHMENT, FILE_ATTACHMENT]);
	});

	test("drops invalid attachments but still sends the text", async () => {
		const backend = new FakeBackend([progress => progress.report(new vscode.LanguageModelTextPart("Done."))]);
		const fake = new FakeAttachments();
		const current = createHarness(root, backend, undefined, undefined, { attachments: fake });
		harness = current;
		current.webview.receive({ type: "send", text: "Hello", attachments: [{ id: "x", kind: "file", path: "p" } as unknown as ChatAttachment] });
		await waitFor(() => backend.requests.length === 1, "request");
		assert.strictEqual(messageText(backend.requests[0].messages.at(-1)!), "Hello");
		assert.strictEqual(fake.reads.length, 0);
		const added = current.webview.ofType("messageAdded").map(message => message.message).find(message => message.role === "user");
		assert.strictEqual(added?.attachments, undefined);
		await waitFor(() => current.webview.ofType("run").some(message => !message.run.running), "turn end");
	});

	test("a finished turn writes an end marker", async () => {
		const backend = new FakeBackend([progress => progress.report(new vscode.LanguageModelTextPart("Done."))]);
		const current = createHarness(root, backend);
		harness = current;
		current.webview.receive({ type: "send", text: "Question" });
		await waitFor(() => current.webview.ofType("run").some(message => !message.run.running), "turn end");
		const sessionId = current.state.get<string>(ACTIVE_SESSION_KEY);
		assert.ok(sessionId);

		await current.store.flush();
		const loaded = await new ChatSessionStore(root).loadSession(sessionId);
		assert.deepStrictEqual(loaded.messages.map(message => message.role), ["user", "assistant"]);
		assert.strictEqual(loaded.interruptedMessageId, undefined);
	});

	test("reopening an interrupted answer warns once and retryable", async () => {
		const store = new ChatSessionStore(root);
		const meta = await store.create("codex::fast");
		await store.appendMessage(meta.id, { id: "u1", role: "user", turn: 1, createdAt: 1, parts: [{ kind: "text", text: "One" }] });
		await store.appendMessage(meta.id, { id: "a1", role: "assistant", turn: 1, createdAt: 1, modelId: "codex::fast", parts: [{ kind: "text", text: "First" }] });
		await store.endMessage(meta.id, "a1");
		await store.appendMessage(meta.id, { id: "u2", role: "user", turn: 2, createdAt: 2, parts: [{ kind: "text", text: "Two" }] });
		await store.appendMessage(meta.id, { id: "a2", role: "assistant", turn: 2, createdAt: 2, modelId: "codex::fast", parts: [{ kind: "text", text: "Second" }] });

		const countWarnings = (init: HostMessage & { type: "init" }): number =>
			init.messages.flatMap(message => message.parts).filter(part => part.kind === "notice" && part.text === INTERRUPTED_TEXT).length;

		const first = createHarness(root, new FakeBackend());
		harness = first;
		await first.state.update(ACTIVE_SESSION_KEY, meta.id);
		first.webview.receive({ type: "ready" });
		await waitFor(() => first.webview.ofType("init").length === 1, "first init");
		const opened = first.webview.ofType("init")[0];
		const last = opened.messages.at(-1);
		assert.strictEqual(last?.id, "a2");
		assert.deepStrictEqual(last?.parts.at(-1), { kind: "notice", level: "warning", text: INTERRUPTED_TEXT, retryable: true });
		assert.strictEqual(countWarnings(opened), 1);
		first.controller.dispose();
		first.webview.dispose();

		const second = createHarness(root, new FakeBackend());
		harness = second;
		await second.state.update(ACTIVE_SESSION_KEY, meta.id);
		second.webview.receive({ type: "ready" });
		await waitFor(() => second.webview.ofType("init").length === 1, "second init");
		assert.strictEqual(countWarnings(second.webview.ofType("init")[0]), 1);
	});

	test("a failed turn is retryable and a stopped turn is not", async () => {
		const backend = new FakeBackend([
			() => {
				throw new Error("provider failed");
			},
			async (progress, token) => {
				progress.report(new vscode.LanguageModelTextPart("Working"));
				await new Promise<void>(resolve => token.onCancellationRequested(() => resolve()));
				throw new vscode.CancellationError();
			},
		]);
		const current = createHarness(root, backend);
		harness = current;
		const finished = (): number => current.webview.ofType("run").filter(message => !message.run.running).length;
		current.webview.receive({ type: "send", text: "fails" });
		await waitFor(() => finished() === 1, "failed turn");
		const failed = current.webview.ofType("partAdded").map(message => message.part).find(part => part.kind === "notice");
		assert.deepStrictEqual(failed, { kind: "notice", level: "error", text: "provider failed", retryable: true });

		current.webview.receive({ type: "send", text: "stops" });
		await waitFor(() => current.webview.ofType("run").at(-1)?.run.running === true, "second run");
		current.webview.receive({ type: "stop" });
		await waitFor(() => finished() === 2, "stopped turn");
		const notices = current.webview.ofType("partAdded").map(message => message.part).filter(part => part.kind === "notice");
		assert.deepStrictEqual(notices.at(-1), { kind: "notice", level: "info", text: "Stopped." });
	});

	test("retryTurn continues the failed answer and keeps its work, changes and rendered attachments", async () => {
		const calls: string[] = [];
		const tracker = new FakeTracker(calls);
		const backend = new FakeBackend([
			progress => progress.report(new vscode.LanguageModelToolCallPart("call-w", "writer", {})),
			() => {
				throw new Error("provider failed");
			},
			progress => progress.report(new vscode.LanguageModelTextPart("Recovered.")),
		]);
		const fake = new FakeAttachments();
		fake.contents = [{ attachment: ATTACHMENT, text: "const a = 1;" }];
		const current = createHarness(root, backend, loggingTools(calls), tracker, { attachments: fake });
		harness = current;
		const finished = (): number => current.webview.ofType("run").filter(message => !message.run.running).length;
		current.webview.receive({ type: "send", text: "Explain", attachments: [ATTACHMENT] });
		await waitFor(() => finished() === 1, "failed turn");
		const assistant = current.webview.ofType("messageAdded").map(message => message.message).find(message => message.role === "assistant");
		assert.ok(assistant);

		current.webview.receive({ type: "retryTurn", messageId: assistant.id });
		await waitFor(() => finished() === 2 && backend.requests.length === 3, "continued turn");
		assert.deepStrictEqual(current.webview.ofType("truncated"), [], "Retry discards nothing");
		assert.ok(calls.includes("end:1:tree-before"), "the failed turn records its changes");
		assert.ok(!calls.some(call => call.startsWith("forget:") || call.startsWith("undoSince:")), "Keep/Undo keeps the failed turn's changes");
		const continued = backend.requests[2].messages;
		const block = renderAttachments([{ attachment: ATTACHMENT, text: "const a = 1;" }]);
		assert.ok(continued.some(message => messageText(message) === `${block}\n<userRequest>\nExplain\n</userRequest>`), "the original request stays");
		assert.ok(continued.some(message => message.content.some(part => part instanceof vscode.LanguageModelToolCallPart && part.callId === "call-w")),
			"the model sees the tool round of the failed answer");
		assert.strictEqual(messageText(continued.at(-1)!), continuationRequest("provider failed"));
		assert.match(continuationRequest("provider failed"), /with this error:\nprovider failed\n.*continue the same task from where it stopped/s);
		assert.strictEqual(fake.reads.length, 1, "the attachments are not read again");
		const marker = current.webview.ofType("messageAdded").map(message => message.message).filter(message => message.role === "user").at(-1);
		assert.deepStrictEqual(marker?.continuation, { error: "provider failed" });

		await current.store.flush();
		const sessionId = current.state.get<string>(ACTIVE_SESSION_KEY);
		assert.ok(sessionId);
		const loaded = await new ChatSessionStore(root).loadSession(sessionId);
		assert.deepStrictEqual(loaded.messages.map(message => message.role), ["user", "assistant", "user", "assistant"]);
		assert.deepStrictEqual(loaded.messages[1].parts.at(-1), { kind: "notice", level: "error", text: "provider failed", retryable: true });
		assert.deepStrictEqual(loaded.messages[2].continuation, { error: "provider failed" });
		assert.deepStrictEqual(loaded.messages[2].parts, [{ kind: "text", text: continuationRequest("provider failed") }]);
		assert.deepStrictEqual(loaded.messages[3].parts, [{ kind: "text", text: "Recovered." }]);
		assert.strictEqual(loaded.interruptedMessageId, undefined);
	});

	test("retryTurn ignores an answer that is no longer the last message", async () => {
		const backend = new FakeBackend([
			() => {
				throw new Error("provider failed");
			},
			progress => progress.report(new vscode.LanguageModelTextPart("Second.")),
		]);
		const current = createHarness(root, backend);
		harness = current;
		const finished = (): number => current.webview.ofType("run").filter(message => !message.run.running).length;
		current.webview.receive({ type: "send", text: "One" });
		await waitFor(() => finished() === 1, "failed turn");
		const failed = current.webview.ofType("messageAdded").map(message => message.message).find(message => message.role === "assistant");
		assert.ok(failed);
		current.webview.receive({ type: "send", text: "Two" });
		await waitFor(() => finished() === 2, "second turn");
		current.webview.receive({ type: "retryTurn", messageId: failed.id });
		await new Promise<void>(resolve => setTimeout(resolve, 50));
		assert.strictEqual(backend.requests.length, 2);
	});

	test("ignores retryTurn while the chat is running", async () => {
		const gate = deferred();
		const backend = new FakeBackend([
			async progress => {
				progress.report(new vscode.LanguageModelTextPart("Working"));
				await gate.promise;
				progress.report(new vscode.LanguageModelTextPart("Done."));
			},
		]);
		const current = createHarness(root, backend);
		harness = current;
		current.webview.receive({ type: "send", text: "Question" });
		await waitFor(() => current.webview.ofType("textDelta").length > 0, "first delta");
		const assistant = current.webview.ofType("messageAdded").map(message => message.message).find(message => message.role === "assistant");
		assert.ok(assistant);

		current.webview.receive({ type: "retryTurn", messageId: assistant.id });
		await new Promise<void>(resolve => setTimeout(resolve, 50));
		assert.strictEqual(backend.requests.length, 1);
		assert.deepStrictEqual(current.webview.ofType("truncated"), []);

		gate.resolve();
		await waitFor(() => current.webview.ofType("run").some(message => !message.run.running), "turn end");
		assert.strictEqual(backend.requests.length, 1);
		assert.deepStrictEqual(current.webview.ofType("truncated"), []);
		assert.strictEqual(current.webview.ofType("messageAdded").length, 2);
	});

	test("a writing turn marks its changes open and loading a chat recovers the mark", async () => {
		const calls: string[] = [];
		const tracker = new FakeRecoveringTracker(calls);
		const backend = new FakeBackend([
			progress => progress.report(new vscode.LanguageModelToolCallPart("call-w", "writer", {})),
			progress => progress.report(new vscode.LanguageModelTextPart("done")),
		]);
		const current = createHarness(root, backend, loggingTools(calls), tracker);
		harness = current;
		current.webview.receive({ type: "ready" });
		await waitFor(() => current.webview.ofType("init").length === 1, "init");
		const first = current.webview.ofType("init")[0].session.id;
		assert.deepStrictEqual(tracker.recovered, [first]);

		current.webview.receive({ type: "send", text: "edit a file" });
		await waitFor(() => current.webview.ofType("run").some(message => !message.run.running), "turn end");
		const opened = calls.indexOf("markOpen:1");
		assert.ok(opened >= 0, "the writing turn must mark its change window open");
		assert.ok(opened < calls.indexOf("end:1:tree-before"), "the mark comes before the turn ends");

		current.webview.receive({ type: "newChat" });
		await waitFor(() => current.webview.ofType("init").length === 2, "second init");
		const second = current.webview.ofType("init")[1].session.id;
		assert.notStrictEqual(second, first);
		assert.deepStrictEqual(tracker.recovered, [first, second]);

		current.webview.receive({ type: "openSession", sessionId: first });
		await waitFor(() => current.webview.ofType("init").length === 3, "third init");
		assert.deepStrictEqual(tracker.recovered, [first, second, first]);
	});

	test("attaches pasted files and sends their images to a model that accepts images", async () => {
		const model: vscode.LanguageModelChatInformation = {
			id: "codex::eye", name: "Eye (Codex)", family: "codex", version: "1", maxInputTokens: 100_000, maxOutputTokens: 4_000,
			capabilities: { toolCalling: true, imageInput: true },
		};
		const backend = new FakeBackend([progress => progress.report(new vscode.LanguageModelTextPart("A cat."))], [model]);
		const attachments = new FakeAttachments();
		const shot: ChatAttachment = { id: "shot", kind: "file", path: "pasted-20261120-090507.png", uri: "file:///store/pasted-20261120-090507.png" };
		attachments.pasted = [shot];
		attachments.contents = [{ attachment: shot, image: { mimeType: "image/png", data: "iVBORw==", byteLength: 4, name: shot.path } }];
		const current = createHarness(root, backend, undefined, undefined, { attachments });
		harness = current;
		current.webview.receive({ type: "ready" });
		await waitFor(() => current.webview.ofType("init").length === 1, "init");

		current.webview.receive({ type: "pasteFiles", files: [{ name: "image.png", mimeType: "image/png", data: "iVBORw==" }] });
		await waitFor(() => current.webview.ofType("attachmentsAdded").length === 1, "pasted attachment");
		assert.deepStrictEqual(attachments.pastes, [[{ name: "image.png", mimeType: "image/png", data: "iVBORw==" }]]);
		assert.deepStrictEqual(current.webview.ofType("attachmentsAdded")[0].attachments, [shot]);
		// A malformed paste is dropped before it reaches the attachment source.
		current.webview.receive({ type: "pasteFiles", files: [{ name: "x.png", mimeType: "image/png" }] });

		current.webview.receive({ type: "send", text: "What is this?", attachments: [shot] });
		await waitFor(() => current.webview.ofType("run").some(message => !message.run.running), "turn end");
		const user = backend.requests[0].messages.find(message => message.role === vscode.LanguageModelChatMessageRole.User);
		const image = user?.content.find((part): part is vscode.LanguageModelDataPart => part instanceof vscode.LanguageModelDataPart);
		assert.strictEqual(image?.mimeType, "image/png");
		assert.deepStrictEqual(Buffer.from(image.data), Buffer.from("iVBORw==", "base64"));
		const shown = current.webview.ofType("messageAdded").find(message => message.message.role === "user")?.message;
		assert.strictEqual(shown?.images, undefined, "the webview gets the chip, not the bytes");
		assert.deepStrictEqual(attachments.pastes.length, 1);
	});

	test("keeps a draft per chat and gives it back after a reload", async () => {
		const current = createHarness(root, new FakeBackend());
		harness = current;
		const drafts = (): Record<string, { text: string }> => current.state.get<Record<string, { text: string }>>(DRAFTS_KEY) ?? {};
		current.webview.receive({ type: "ready" });
		await waitFor(() => current.webview.ofType("init").length === 1, "init");
		const first = current.webview.ofType("init")[0];
		assert.strictEqual(first.draft, undefined);

		current.webview.receive({ type: "saveDraft", sessionId: first.session.id, text: "half a thought", attachments: [FILE_ATTACHMENT] });
		await waitFor(() => drafts()[first.session.id]?.text === "half a thought", "first draft saved");

		// The new chat starts empty; the first one has no messages, but its draft keeps it.
		current.webview.receive({ type: "newChat" });
		await waitFor(() => current.webview.ofType("init").length === 2, "second init");
		const second = current.webview.ofType("init")[1];
		assert.notStrictEqual(second.session.id, first.session.id);
		assert.strictEqual(second.draft, undefined);
		assert.ok(await current.store.get(first.session.id), "a chat with a draft is not removed when left");
		current.webview.receive({ type: "listSessions" });
		await waitFor(() => current.webview.ofType("sessions").length > 0, "sessions");
		assert.ok(current.webview.ofType("sessions").at(-1)?.sessions.some(meta => meta.id === first.session.id));

		current.webview.receive({ type: "saveDraft", sessionId: second.session.id, text: "another", attachments: [] });
		await waitFor(() => drafts()[second.session.id]?.text === "another", "second draft saved");

		current.webview.receive({ type: "openSession", sessionId: first.session.id });
		await waitFor(() => current.webview.ofType("init").length === 3, "third init");
		assert.deepStrictEqual(current.webview.ofType("init")[2].draft, { text: "half a thought", attachments: [FILE_ATTACHMENT] });

		// Reload: a new controller over the same storage shows the same chat with its draft.
		await current.store.flush();
		const reloaded = new ChatController({
			backend: new FakeBackend(),
			onDidChangeModels: NEVER_FIRES,
			store: new ChatSessionStore(root),
			tools: fakeTools(() => ({ text: "", isError: false })).executor,
			state: current.state,
		});
		const view = new FakeWebview();
		reloaded.attach(view.asWebview());
		try {
			view.receive({ type: "ready" });
			await waitFor(() => view.ofType("init").length === 1, "init after reload");
			const restored = view.ofType("init")[0];
			assert.strictEqual(restored.session.id, first.session.id);
			assert.deepStrictEqual(restored.draft, { text: "half a thought", attachments: [FILE_ATTACHMENT] });
		} finally {
			reloaded.dispose();
			view.dispose();
		}
	});

	test("clears a draft when its chat sends or is deleted, and drops an untouched empty chat", async () => {
		const backend = new FakeBackend([progress => progress.report(new vscode.LanguageModelTextPart("ok"))]);
		const current = createHarness(root, backend);
		harness = current;
		const drafts = (): Record<string, unknown> => current.state.get<Record<string, unknown>>(DRAFTS_KEY) ?? {};
		current.webview.receive({ type: "ready" });
		await waitFor(() => current.webview.ofType("init").length === 1, "init");
		const first = current.webview.ofType("init")[0].session.id;

		current.webview.receive({ type: "saveDraft", sessionId: first, text: "hello", attachments: [] });
		await waitFor(() => first in drafts(), "draft saved");
		current.webview.receive({ type: "send", text: "hello" });
		await waitFor(() => current.webview.ofType("run").some(message => !message.run.running), "turn end");
		assert.ok(!(first in drafts()), "sending clears the draft");

		current.webview.receive({ type: "newChat" });
		await waitFor(() => current.webview.ofType("init").length === 2, "second init");
		const second = current.webview.ofType("init")[1].session.id;
		current.webview.receive({ type: "saveDraft", sessionId: second, text: "doomed", attachments: [] });
		await waitFor(() => second in drafts(), "second draft saved");
		current.webview.receive({ type: "deleteSession", sessionId: second });
		await waitFor(() => current.webview.ofType("init").length === 3, "init after delete");
		assert.ok(!(second in drafts()), "deleting a chat deletes its draft");

		// A late save of the deleted chat does not bring its draft back.
		current.webview.receive({ type: "saveDraft", sessionId: second, text: "late", attachments: [] });
		await new Promise<void>(resolve => setTimeout(resolve, 50));
		assert.ok(!(second in drafts()));

		// An empty chat whose draft was emptied again is removed when left, as before.
		current.webview.receive({ type: "newChat" });
		await waitFor(() => current.webview.ofType("init").length === 4, "fourth init");
		const third = current.webview.ofType("init")[3].session.id;
		current.webview.receive({ type: "saveDraft", sessionId: third, text: "x", attachments: [] });
		await waitFor(() => third in drafts(), "third draft saved");
		current.webview.receive({ type: "saveDraft", sessionId: third, text: "  ", attachments: [] });
		await waitFor(() => !(third in drafts()), "empty draft removed");
		current.webview.receive({ type: "openSession", sessionId: first });
		await waitFor(() => current.webview.ofType("init").length === 5, "fifth init");
		await waitForAsync(async () => (await current.store.get(third)) === undefined, "untouched chat removed");
	});

	test("shares the shown chat's draft with the other views and caps its text", async () => {
		const current = createHarness(root, new FakeBackend());
		harness = current;
		const other = new FakeWebview();
		current.controller.attach(other.asWebview());
		try {
			current.webview.receive({ type: "ready" });
			await waitFor(() => current.webview.ofType("init").length === 1, "init");
			const sessionId = current.webview.ofType("init")[0].session.id;
			current.webview.receive({ type: "saveDraft", sessionId, text: "x".repeat(100_050), attachments: [STORED_ATTACHMENT] });
			await waitFor(() => other.ofType("draft").length === 1, "draft in the other view");
			const shared = other.ofType("draft")[0];
			assert.strictEqual(shared.sessionId, sessionId);
			assert.strictEqual(shared.draft.text.length, 100_000);
			assert.deepStrictEqual(shared.draft.attachments, [STORED_ATTACHMENT]);
			assert.strictEqual(current.webview.ofType("draft").length, 0, "the sender keeps its own composer");
		} finally {
			other.dispose();
		}
	});
});
