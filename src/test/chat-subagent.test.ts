import * as assert from "node:assert";
import * as vscode from "vscode";
import type { ChatToolExecutor } from "../chat/agent-loop";
import type { ChatSubagentRun } from "../chat/shared/protocol";
import { runChatSubagent, SUBAGENT_INSTRUCTIONS } from "../chat/subagent-runner";
import { createChatToolSource } from "../chat/tool-executor";
import { ChatToolCatalog, type ToolRegistry } from "../chat/tools/catalog";
import { createSubagentTool, parseSubagentInput, SUBAGENT_TOOL_NAME } from "../chat/tools/subagent-tool";
import type { ChatTool, SubagentModelOption, SubagentRequest } from "../chat/tools/types";
import { limitSignalPart } from "../providers/limit-signal";
import { enhanceSubagentToolDescription, withRequiredSubagentModel } from "../subagent-guidance";

const MODELS: SubagentModelOption[] = [
	{ id: "claude::smart", label: "Smart (Claude)", useWhen: "hard tests" },
	{ id: "deepseek::flash", label: "Flash (DeepSeek)", useWhen: "quick searches" },
];

const MODEL: vscode.LanguageModelChatInformation = {
	id: "claude::smart",
	name: "Smart (Claude)",
	family: "claude",
	version: "1",
	maxInputTokens: 100_000,
	maxOutputTokens: 4_000,
	capabilities: { toolCalling: true },
};

const NONE: vscode.CancellationToken = { isCancellationRequested: false, onCancellationRequested: () => new vscode.Disposable(() => undefined) };

const READ_TOOL: vscode.LanguageModelChatTool = {
	name: "read",
	description: "Read a file",
	inputSchema: { type: "object", properties: { path: { type: "string" } } },
};

const EMPTY_REGISTRY: ToolRegistry = {
	tools: () => [],
	invoke: async () => new vscode.LanguageModelToolResult([]),
	local: () => undefined,
};

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

type Round = (progress: vscode.Progress<vscode.LanguageModelResponsePart>, token: vscode.CancellationToken) => void | Promise<void>;

class FakeBackend implements Pick<vscode.LanguageModelChatProvider, "provideLanguageModelChatResponse"> {
	readonly requests: Array<{ messages: readonly vscode.LanguageModelChatRequestMessage[]; options: vscode.ProvideLanguageModelChatResponseOptions }> = [];
	private readonly _rounds: Round[];

	constructor(rounds: Round[]) {
		this._rounds = [...rounds];
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

function messageText(message: vscode.LanguageModelChatRequestMessage): string {
	return message.content
		.filter((part): part is vscode.LanguageModelTextPart => part instanceof vscode.LanguageModelTextPart)
		.map(part => part.value)
		.join("");
}

function subagentRun(backend: FakeBackend, options: {
	callId?: string;
	tools?: ChatToolExecutor;
	request?: SubagentRequest;
	onFinish: (run: ChatSubagentRun) => void;
}): Promise<string> {
	return runChatSubagent({
		backend,
		model: MODEL,
		request: options.request ?? { description: "Check", prompt: "Inspect a.txt", model: MODELS[0] },
		callId: options.callId ?? "call-sub",
		conversationId: "chat-1",
		tools: options.tools ?? { tools: [READ_TOOL], invoke: async () => ({ text: "ok", isError: false }) },
		token: NONE,
		onUpdate: () => undefined,
		onFinish: options.onFinish,
	});
}

suite("chat subagent", () => {
	test("parseSubagentInput matches the model by label, id or label case and derives a description", () => {
		const byLabel = parseSubagentInput({ description: "  Check files  ", prompt: "Inspect a.txt", model: "Smart (Claude)" }, MODELS);
		assert.strictEqual(byLabel.model.id, "claude::smart");
		assert.strictEqual(byLabel.description, "Check files");
		assert.strictEqual(byLabel.prompt, "Inspect a.txt");

		const byId = parseSubagentInput({ prompt: "x", model: "deepseek::flash" }, MODELS);
		assert.strictEqual(byId.model.label, "Flash (DeepSeek)");

		const byCase = parseSubagentInput({ prompt: "x", model: "smart (claude)" }, MODELS);
		assert.strictEqual(byCase.model.id, "claude::smart");

		const fallback = parseSubagentInput({ prompt: "First line\nsecond line", model: "Smart (Claude)" }, MODELS);
		assert.strictEqual(fallback.description, "First line");
	});

	test("parseSubagentInput accepts a model name without the provider suffix or punctuation", () => {
		const models: SubagentModelOption[] = [
			{ id: "deepseek::deepseek-flash", label: "deepseek-flash (DeepSeek)", useWhen: "cheap" },
			{ id: "deepseek::deepseek-pro", label: "deepseek-pro (DeepSeek)", useWhen: "reasoning" },
		];
		for (const wanted of ["deepseek-flash", "DeepSeek Flash", "deepseek_flash (DeepSeek) (llamacpp)"]) {
			assert.strictEqual(parseSubagentInput({ prompt: "x", model: wanted }, models).model.id, "deepseek::deepseek-flash", wanted);
		}
		const twins: SubagentModelOption[] = [
			{ id: "codex::gpt-5.6-terra", label: "GPT-5.6 Terra (Codex)", useWhen: "a" },
			{ id: "codex-work::gpt-5.6-terra", label: "GPT-5.6 Terra (Codex) · work", useWhen: "b" },
		];
		assert.throws(() => parseSubagentInput({ prompt: "x", model: "gpt 5.6 terra" }, twins), /Unknown subagent model/);
	});

	test("parseSubagentInput reports a missing prompt and lists the labels for an unknown model", () => {
		assert.throws(() => parseSubagentInput({ model: "Smart (Claude)" }, MODELS), /prompt is required/);
		assert.throws(
			() => parseSubagentInput({ prompt: "x", model: "Missing" }, MODELS),
			(error: unknown) => error instanceof Error
				&& error.message.includes('Unknown subagent model "Missing"')
				&& error.message.includes('"Smart (Claude)"')
				&& error.message.includes('"Flash (DeepSeek)"'),
		);
	});

	test("createSubagentTool hides itself without models and builds the schema from the labels", () => {
		const unavailable = createSubagentTool({ models: () => [] });
		assert.strictEqual(unavailable.available?.(), false);

		const duplicated: SubagentModelOption[] = [
			...MODELS,
			{ id: "claude::smart-copy", label: "Smart (Claude)", useWhen: "duplicate label" },
		];
		const tool = createSubagentTool({ models: () => duplicated });
		assert.strictEqual(tool.name, SUBAGENT_TOOL_NAME);
		assert.strictEqual(tool.group, "agents");
		assert.strictEqual(tool.available?.(), true);
		const schema = tool.inputSchema as { properties: { model: { enum?: string[]; description: string } }; required: string[] };
		// An enum would let a provider's schema check drop the whole response over a near-miss name.
		assert.strictEqual(schema.properties.model.enum, undefined);
		// Providers may keep an old copy of the schema, so it must not change with the model list.
		assert.deepStrictEqual(createSubagentTool({ models: () => MODELS.slice(0, 1) }).inputSchema, tool.inputSchema);
		assert.ok(tool.description.includes('- "Smart (Claude)": '));
		assert.ok(tool.description.includes('- "Flash (DeepSeek)": '));
		// Providers rewrite Copilot's runSubagent by name; this tool must keep its own description and schema.
		assert.strictEqual(enhanceSubagentToolDescription(tool.name, "own"), "own");
		const definition = { name: tool.name, inputSchema: tool.inputSchema };
		assert.strictEqual(withRequiredSubagentModel(definition), definition);
		assert.deepStrictEqual(schema.required, ["description", "prompt", "model"]);
		assert.ok(tool.description.includes("hard tests"));
		assert.ok(tool.description.includes("quick searches"));
		assert.ok(tool.description.includes("duplicate label"));
	});

	test("createSubagentTool invokes the controller's runner with the parsed request", async () => {
		const tool = createSubagentTool({ models: () => MODELS });
		await assert.rejects(tool.invoke({ prompt: "x", model: "Smart (Claude)" }, NONE), /cannot start another subagent/);

		const requests: SubagentRequest[] = [];
		const text = await tool.invoke({ description: "Check", prompt: "Inspect a.txt", model: "Smart (Claude)" }, NONE, {
			runSubagent: async (request, token) => {
				assert.strictEqual(token, NONE);
				requests.push(request);
				return "REPORT";
			},
		});
		assert.strictEqual(text, "REPORT");
		assert.deepStrictEqual(requests.map(request => ({ description: request.description, prompt: request.prompt, id: request.model.id })), [
			{ description: "Check", prompt: "Inspect a.txt", id: "claude::smart" },
		]);
	});

	test("the catalog leaves unavailable builtins out and labels the agents group Subagents", () => {
		const hidden: ChatTool = {
			name: "whenever",
			description: "Hidden.",
			inputSchema: { type: "object", properties: {} },
			group: "agents",
			available: () => false,
			invoke: async () => "",
		};
		const subagent = createSubagentTool({ models: () => MODELS });
		const catalog = new ChatToolCatalog({ builtins: [hidden, subagent], state: new FakeMemento(), registry: EMPTY_REGISTRY });
		assert.deepStrictEqual(catalog.enabledTools().map(tool => tool.name), [SUBAGENT_TOOL_NAME]);
		const groups = catalog.groups();
		assert.deepStrictEqual(groups.map(group => group.label), ["Subagents"]);
		assert.deepStrictEqual(groups[0].tools.map(tool => tool.name), [SUBAGENT_TOOL_NAME]);
	});

	test("createChatToolSource passes the call id and the subagent runner to the tool", async () => {
		const runSubagent = async (): Promise<string> => "report";
		const seen: Array<{ input: unknown; callId?: string; runner?: boolean }> = [];
		const tool: ChatTool = {
			name: "probe",
			description: "Probe.",
			inputSchema: { type: "object", properties: {} },
			group: "files",
			invoke: async (input, _token, context) => {
				seen.push({ input, callId: context?.callId, runner: context?.runSubagent === runSubagent });
				return "ok";
			},
		};
		const source = createChatToolSource({ enabledTools: () => [tool], groups: () => [], setEnabled: async () => undefined });
		const result = await source.invoke("probe", { path: "a.txt" }, NONE, { callId: "call-7", approve: async () => true, runSubagent });
		assert.deepStrictEqual(result, { text: "ok", isError: false });
		assert.deepStrictEqual(seen, [{ input: { path: "a.txt" }, callId: "call-7", runner: true }]);
	});

	test("runs a nested turn and finishes with the text after the last tool call", async () => {
		const backend = new FakeBackend([
			progress => {
				progress.report(new vscode.LanguageModelTextPart("Looking."));
				progress.report(new vscode.LanguageModelToolCallPart("call-read", "read", { path: "a.txt" }));
			},
			progress => progress.report(new vscode.LanguageModelTextPart("REPORT")),
		]);
		const toolCalls: string[] = [];
		const finishes: ChatSubagentRun[] = [];
		const text = await subagentRun(backend, {
			tools: {
				tools: [READ_TOOL],
				invoke: async name => {
					toolCalls.push(name);
					return { text: "boom", isError: true };
				},
			},
			onFinish: run => finishes.push(run),
		});

		assert.strictEqual(text, "REPORT");
		assert.deepStrictEqual(toolCalls, ["read"]);
		assert.strictEqual(backend.requests.length, 2);
		const first = backend.requests[0];
		assert.strictEqual(first.messages.length, 2);
		assert.strictEqual(first.messages[0].role as number, 3);
		assert.ok(messageText(first.messages[0]).includes(SUBAGENT_INSTRUCTIONS));
		assert.strictEqual(first.messages[1].role, vscode.LanguageModelChatMessageRole.User);
		assert.strictEqual(messageText(first.messages[1]), "Inspect a.txt");
		assert.strictEqual(first.options.modelOptions?._copilotSubagentInvocationId, "chat-subagent-call-sub");

		assert.strictEqual(finishes.length, 1);
		const run = finishes[0];
		assert.strictEqual(run.status, "done");
		assert.strictEqual(run.callId, "call-sub");
		assert.strictEqual(run.modelId, "claude::smart");
		assert.ok((run.durationMs ?? -1) >= 0);
		assert.deepStrictEqual(run.steps.map(step => step.kind === "tool"
			? `tool:${step.name}:${step.summary}:${step.isError ? "error" : "ok"}`
			: `${step.kind}:${step.text}`), [
			"text:Looking.",
			'tool:read:{"path":"a.txt"}:error',
			"text:REPORT",
		]);
	});

	test("reports a backend failure and adds an error notice step", async () => {
		const backend = new FakeBackend([() => { throw new Error("backend is down"); }]);
		const finishes: ChatSubagentRun[] = [];
		await assert.rejects(
			subagentRun(backend, { onFinish: run => finishes.push(run) }),
			(error: unknown) => error instanceof Error && error.message === "backend is down",
		);

		assert.strictEqual(finishes.length, 1);
		assert.strictEqual(finishes[0].status, "failed");
		assert.ok(finishes[0].steps.some(step => step.kind === "notice" && step.level === "error" && step.text === "backend is down"));
	});

	test("a cancelled run stops without an error notice", async () => {
		const backend = new FakeBackend([() => { throw new vscode.CancellationError(); }]);
		const finishes: ChatSubagentRun[] = [];
		await assert.rejects(subagentRun(backend, { onFinish: run => finishes.push(run) }), vscode.CancellationError);

		assert.strictEqual(finishes.length, 1);
		assert.strictEqual(finishes[0].status, "stopped");
		assert.deepStrictEqual(finishes[0].steps, []);
	});

	test("a round with only a limit notice fails with the notice text", async () => {
		const backend = new FakeBackend([
			progress => {
				progress.report(limitSignalPart({ kind: "limit", provider: "Codex", text: "Codex limit reached.", window: "5-hour" }));
				progress.report(new vscode.LanguageModelTextPart("Codex limit reached."));
			},
		]);
		const finishes: ChatSubagentRun[] = [];
		await assert.rejects(
			subagentRun(backend, { onFinish: run => finishes.push(run) }),
			(error: unknown) => error instanceof Error && error.message === "The subagent did not finish: Codex limit reached.",
		);

		assert.strictEqual(finishes.length, 1);
		assert.strictEqual(finishes[0].status, "failed");
		assert.ok(finishes[0].steps.some(step => step.kind === "notice" && step.level === "warning" && step.text === "Codex limit reached."));
	});
});
