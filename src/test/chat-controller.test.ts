import * as assert from "node:assert";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import * as vscode from "vscode";
import type { ChatChangeTrackerLike, TurnSnapshot } from "../chat/changes/change-tracker";
import { ChatController, type ChatControllerDeps } from "../chat/chat-controller";
import type { ChatCompactionPlan } from "../chat/compaction";
import { compactionSummaryText } from "../chat/lm-messages";
import { ChatSessionStore } from "../chat/session-store";
import { groupModels } from "../chat/shared/model-groups";
import { applyHostUpdate, WEBVIEW_TOOL_RESULT_PREVIEW_CHARS, type ChatChangeSet, type ChatMessage, type ChatToolGroup, type HostMessage } from "../chat/shared/protocol";
import { createChatToolSource, DENIED_TOOL_RESULT, type ChatToolSource } from "../chat/tool-executor";
import { createSubagentTool, SUBAGENT_TOOL_NAME } from "../chat/tools/subagent-tool";
import type { ChatTool } from "../chat/tools/types";

const MODELS: vscode.LanguageModelChatInformation[] = [
	{ id: "codex::fast", name: "Fast (Codex)", family: "codex", version: "1", maxInputTokens: 100_000, maxOutputTokens: 4_000, capabilities: { toolCalling: true } },
	{ id: "claude::smart", name: "Smart (Claude)", family: "claude", version: "1", maxInputTokens: 200_000, maxOutputTokens: 8_000, capabilities: { toolCalling: true } },
];

const NEVER_FIRES: vscode.Event<void> = () => new vscode.Disposable(() => undefined);
const ACTIVE_SESSION_KEY = "llamacpp.chat.activeSession";
const LAST_MODEL_KEY = "llamacpp.chat.lastModel";

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

function fakeTools(handler: (name: string, input: unknown) => { text: string; isError: boolean }): { executor: ChatToolSource; invocations: Array<{ name: string; input: unknown }> } {
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

/** Records the controller's calls in one log shared with the tools, so the order is visible. */
class FakeTracker implements ChatChangeTrackerLike {
	set: ChatChangeSet = { files: [], sinceTurn: [] };
	constructor(readonly calls: string[]) {}
	async beginTurn(): Promise<TurnSnapshot | undefined> {
		this.calls.push("begin");
		return new Map([["root", "tree-before"]]);
	}
	async endTurn(_sessionId: string, turn: number, begin: TurnSnapshot): Promise<void> {
		this.calls.push(`end:${turn}:${begin.get("root")}`);
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
	extra?: Pick<ChatControllerDeps, "prompt" | "compaction" | "abandonConversation">,
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

function messageText(message: vscode.LanguageModelChatRequestMessage): string {
	return message.content
		.filter((part): part is vscode.LanguageModelTextPart => part instanceof vscode.LanguageModelTextPart)
		.map(part => part.value)
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
		await fs.rm(root, { recursive: true, force: true });
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
		assert.strictEqual(init.session.modelId, "codex::fast");
		assert.deepStrictEqual(init.messages, []);
		assert.deepStrictEqual(init.run, { running: false });
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
		assert.deepStrictEqual(current.webview.ofType("run").map(message => message.run.running), [true, false]);

		await current.store.flush();
		const sessionId = current.state.get<string>(ACTIVE_SESSION_KEY);
		if (!sessionId) {
			throw new Error("no active session");
		}
		const persisted = await new ChatSessionStore(root).load(sessionId);
		const replayed: ChatMessage[] = [];
		for (const message of current.webview.messages) {
			applyHostUpdate(replayed, message);
		}
		assert.deepStrictEqual(replayed, persisted);
	});

	test("stops a running turn with an info notice", async () => {
		const backend = new FakeBackend([
			async (progress, token) => {
				progress.report(new vscode.LanguageModelTextPart("Working"));
				await new Promise<void>(resolve => token.onCancellationRequested(() => resolve()));
				throw new vscode.CancellationError();
			},
		]);
		const current = createHarness(root, backend);
		harness = current;
		current.webview.receive({ type: "send", text: "Long job" });
		await waitFor(() => current.webview.ofType("run").some(message => message.run.running), "run start");
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
		assert.strictEqual(current.webview.ofType("run").at(-1)?.run.running, false);
	});

	test("trims a long tool result for the webview and loads the full text on request", async () => {
		const full = "x".repeat(WEBVIEW_TOOL_RESULT_PREVIEW_CHARS + 500);
		const backend = new FakeBackend([
			progress => progress.report(new vscode.LanguageModelToolCallPart("call-big", "llamacpp_read", {})),
			progress => progress.report(new vscode.LanguageModelTextPart("Done.")),
		]);
		const current = createHarness(root, backend, fakeTools(() => ({ text: full, isError: false })).executor);
		harness = current;
		current.webview.receive({ type: "send", text: "Read everything" });
		await waitFor(() => current.webview.ofType("run").some(message => !message.run.running), "turn end");

		const broadcast = current.webview.ofType("partAdded").find(message => message.part.kind === "toolResult");
		if (!broadcast || broadcast.part.kind !== "toolResult") {
			throw new Error("expected a tool result");
		}
		assert.strictEqual(broadcast.part.preview, true);
		assert.strictEqual(broadcast.part.text.length, WEBVIEW_TOOL_RESULT_PREVIEW_CHARS);
		assert.ok(full.startsWith(broadcast.part.text));

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
		assert.strictEqual((await current.store.list()).length, 2);
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

	test("answers with an error notice instead of starting a turn when no model is available", async () => {
		const current = createHarness(root, new FakeBackend([], []));
		harness = current;
		current.webview.receive({ type: "send", text: "Hello" });
		await waitFor(() => current.webview.ofType("messageAdded").length === 1, "notice message");

		const added = current.webview.ofType("messageAdded")[0];
		assert.strictEqual(added.message.role, "assistant");
		assert.strictEqual(added.message.modelId, undefined);
		assert.deepStrictEqual(added.message.parts, [{ kind: "notice", level: "error", text: "No model is available. Configure a provider first." }]);
		assert.deepStrictEqual(current.webview.ofType("run"), []);
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
		];
		for (const message of malformed) {
			current.webview.receive(message);
		}
		await new Promise<void>(resolve => setTimeout(resolve, 50));
		assert.deepStrictEqual(current.webview.messages, []);

		current.webview.receive({ type: "ready" });
		await waitFor(() => current.webview.ofType("init").length === 1, "init after malformed messages");
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

	test("broadcasts the session title after the first message", async () => {
		const backend = new FakeBackend([progress => progress.report(new vscode.LanguageModelTextPart("ok"))]);
		const current = createHarness(root, backend);
		harness = current;
		current.webview.receive({ type: "send", text: "Name this chat" });
		await waitFor(() => current.webview.ofType("session").length > 0, "session update");

		const session = current.webview.ofType("session").at(-1);
		assert.ok(session?.session.title.startsWith("Name this chat"));
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

	test("runs a subagent and gives the parent only its report", async () => {
		const probe: ChatTool = {
			name: "probe",
			description: "Read a file.",
			inputSchema: { type: "object", properties: {} },
			group: "files",
			readOnly: true,
			invoke: async () => "probe body",
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
			progress => progress.report(new vscode.LanguageModelToolCallPart("call-sub", SUBAGENT_TOOL_NAME, { description: "Check", prompt: "Inspect a.txt", model: "Smart (Claude)" })),
			progress => progress.report(new vscode.LanguageModelToolCallPart("call-probe", "probe", { path: "a.txt" })),
			progress => progress.report(new vscode.LanguageModelTextPart("REPORT")),
			progress => progress.report(new vscode.LanguageModelTextPart("Done")),
		]);
		const current = createHarness(root, backend, source);
		harness = current;
		current.webview.receive({ type: "send", text: "Please inspect" });
		await waitFor(() => current.webview.ofType("run").some(message => !message.run.running), "turn end");

		assert.strictEqual(backend.requests.length, 4);
		const subagentRequest = backend.requests[1];
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
});
