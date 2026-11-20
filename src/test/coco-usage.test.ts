import * as assert from "node:assert";
import * as vscode from "vscode";
import { CocoAcpClient } from "../coco/acp-client";
import { CocoChatModelProvider } from "../coco/coco-provider";
import { mapCocoModel } from "../coco/model-adapter";
import { resolveSharedContextLimit } from "../context/provider-handoff";
import { CocoResponseStream } from "../coco/response-stream";
import { CocoTurnBridge } from "../coco/turn-bridge";
import { createCocoNativeContextUsage, parseCocoContextUsage } from "../coco/usage-adapter";
import { parsePromptCacheSignal, PROMPT_CACHE_MIME, PROMPT_CACHE_OPTION } from "../providers/prompt-cache-signal";

suite("Coco context usage", () => {
	const update = (used = 62_229, size = 1_000_000) => ({ sessionUpdate: "usage_update", used, size });
	const usageParts = (parts: vscode.LanguageModelResponsePart[]) => parts
		.filter((part): part is vscode.LanguageModelDataPart => part instanceof vscode.LanguageModelDataPart && part.mimeType === "usage")
		.map(part => JSON.parse(Buffer.from(part.data).toString("utf8")) as Record<string, number>);

	test("reads current snapshots including empty and overfull context without accumulating them", () => {
		assert.deepStrictEqual(parseCocoContextUsage(update()), { usedTokens: 62_229, contextWindowTokens: 1_000_000 });
		assert.deepStrictEqual(parseCocoContextUsage(update(0)), { usedTokens: 0, contextWindowTokens: 1_000_000 });
		assert.deepStrictEqual(parseCocoContextUsage(update(120, 100)), { usedTokens: 120, contextWindowTokens: 100 });
		assert.deepStrictEqual(createCocoNativeContextUsage(parseCocoContextUsage(update())!), { prompt_tokens: 62_229, total_tokens: 62_229 });
	});

	test("rejects invalid sizes, negative, fractional and nonnumeric token counters", () => {
		for (const invalid of [null, {}, { ...update(), sessionUpdate: "other" }, { ...update(), used: "10" },
			update(-1), update(NaN), update(Infinity), update(1.5), update(1, 0), update(1, -1),
			update(1, Infinity), update(1, Number.MAX_SAFE_INTEGER + 1)]) {
			assert.strictEqual(parseCocoContextUsage(invalid), undefined);
		}
	});

	test("emits native usage separately from answer text without inventing billing or cache counters", () => {
		const parts: vscode.LanguageModelResponsePart[] = [];
		const token = new vscode.CancellationTokenSource();
		try {
			const stream = new CocoResponseStream({ report: part => parts.push(part) }, token.token);
			stream.accept(update()); stream.accept(update(60_000)); stream.accept(update(-1));
			stream.accept({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "Answer" } });
			assert.deepStrictEqual(usageParts(parts), [{ prompt_tokens: 62_229, total_tokens: 62_229 }, { prompt_tokens: 60_000, total_tokens: 60_000 }]);
			assert.strictEqual((parts[2] as vscode.LanguageModelTextPart).value, "Answer");
			token.cancel(); stream.accept(update(90_000)); assert.strictEqual(parts.length, 3);
		} finally { token.dispose(); }
	});

	test("keeps the latest context across tool boundaries and accepts a reduction after compaction", async () => {
		const tool = { name: "test_tool", description: "Test tool", inputSchema: { type: "object" } };
		const bridge = new CocoTurnBridge([tool], () => undefined);
		const token = new vscode.CancellationTokenSource();
		const first: vscode.LanguageModelResponsePart[] = [], second: vscode.LanguageModelResponsePart[] = [];
		try {
			await bridge.start(async () => {
				bridge.accept(update()); await bridge.delegate(String(bridge.clientTools[0].name), {});
			}, { report: part => first.push(part) }, token.token);
			const call = first.find((part): part is vscode.LanguageModelToolCallPart => part instanceof vscode.LanguageModelToolCallPart)!;
			bridge.accept(update(90_000)); bridge.accept(update(40_000)); bridge.accept(update(-1));
			await bridge.resume([new vscode.LanguageModelToolResultPart(call.callId, [new vscode.LanguageModelTextPart("Done")])],
				{ report: part => second.push(part) }, token.token);
			assert.deepStrictEqual(usageParts(first), [{ prompt_tokens: 62_229, total_tokens: 62_229 }]);
			assert.deepStrictEqual(usageParts(second), [{ prompt_tokens: 40_000, total_tokens: 40_000 }]);
		} finally { bridge.dispose(); token.dispose(); }
	});

	test("updates the model's total context window from ACP and resets it on a source change", async () => {
		let connection = "First";
		const provider = new CocoChatModelProvider({ isEnabled: () => true, resolveCli: () => "mock", resolveConnection: () => connection,
			createClient: (_exe, _cwd, _connection, _model, handlers) => ({
				initialize: async () => undefined,
				newSession: async () => ({ sessionId: "session" }),
				prompt: async () => {
					handlers?.onUpdate?.(update());
					handlers?.onUpdate?.({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "Done" } });
					return { stopReason: "end_turn", usage: { inputTokens: 999_999_999 } };
				},
				cancel: () => undefined, dispose: () => undefined,
			}) as unknown as CocoAcpClient });
		const token = new vscode.CancellationTokenSource(), parts: vscode.LanguageModelResponsePart[] = [];
		try {
			await provider.provideLanguageModelChatResponse(mapCocoModel({ id: "auto", name: "Auto" }), [vscode.LanguageModelChatMessage.User("Hi")],
				{ toolMode: vscode.LanguageModelChatToolMode.Auto }, { report: part => parts.push(part) }, token.token);
			assert.deepStrictEqual(usageParts(parts), [{ prompt_tokens: 62_229, total_tokens: 62_229 }]);
			// The measured 1M window is adopted, then capped by the shared working context.
			const advertised = Math.min(1_000_000, resolveSharedContextLimit());
			const model = (await provider.provideLanguageModelChatInformation({ silent: true }, token.token))[0];
			assert.strictEqual(model.maxInputTokens + model.maxOutputTokens, advertised);
			provider.refreshLanguageModelChatInformation();
			const refreshed = (await provider.provideLanguageModelChatInformation({ silent: true }, token.token))[0];
			assert.strictEqual(refreshed.maxInputTokens + refreshed.maxOutputTokens, advertised);
			connection = "Second"; provider.refreshLanguageModelChatInformation();
			const reset = (await provider.provideLanguageModelChatInformation({ silent: true }, token.token))[0];
			assert.notStrictEqual(reset.maxInputTokens + reset.maxOutputTokens, advertised);
		} finally { provider.dispose(); token.dispose(); }
	});

	test("does not fabricate context when the runtime supplies only cumulative billing usage", async () => {
		const bridge = new CocoTurnBridge([], () => undefined), token = new vscode.CancellationTokenSource();
		const parts: vscode.LanguageModelResponsePart[] = [];
		try {
			await bridge.start(async () => ({ usage: { inputTokens: 1_000_000, outputTokens: 300 } }), { report: part => parts.push(part) }, token.token);
			assert.deepStrictEqual(usageParts(parts), []);
		} finally { bridge.dispose(); token.dispose(); }
	});
});

suite("Coco prompt cache counters", () => {
	const usage = { inputTokens: 100, outputTokens: 20, cachedReadTokens: 80, cachedWriteTokens: 5 };
	const expected = { promptTokens: 185, cachedTokens: 80, cacheWriteTokens: 5, completionTokens: 20, requests: 1 };
	const cacheParts = (parts: vscode.LanguageModelResponsePart[]) => parts
		.filter((part): part is vscode.LanguageModelDataPart => part instanceof vscode.LanguageModelDataPart && part.mimeType === PROMPT_CACHE_MIME)
		.map(part => parsePromptCacheSignal(part));
	const contextParts = (parts: vscode.LanguageModelResponsePart[]) => parts
		.filter((part): part is vscode.LanguageModelDataPart => part instanceof vscode.LanguageModelDataPart && part.mimeType === "usage")
		.map(part => JSON.parse(Buffer.from(part.data).toString("utf8")) as Record<string, number>);

	function provider(result: Record<string, unknown>): CocoChatModelProvider {
		return new CocoChatModelProvider({
			isEnabled: () => true,
			resolveCli: () => "mock",
			createClient: (_exe, _cwd, _connection, _model, handlers) => ({
				initialize: async () => undefined,
				newSession: async () => ({ sessionId: "prompt-cache-session" }),
				prompt: async () => {
					handlers?.onUpdate?.({ sessionUpdate: "usage_update", used: 50_000, size: 100_000 });
					handlers?.onUpdate?.({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "Done" } });
					return result;
				},
				cancel: () => undefined,
				dispose: () => undefined,
			}) as unknown as CocoAcpClient,
		});
	}

	async function run(provider: CocoChatModelProvider, modelOptions?: Record<string, unknown>): Promise<vscode.LanguageModelResponsePart[]> {
		const token = new vscode.CancellationTokenSource(), parts: vscode.LanguageModelResponsePart[] = [];
		try {
			await provider.provideLanguageModelChatResponse(mapCocoModel({ id: "auto", name: "Auto" }), [vscode.LanguageModelChatMessage.User("Hi")],
				{ toolMode: vscode.LanguageModelChatToolMode.Auto, ...(modelOptions ? { modelOptions } : {}) }, { report: part => parts.push(part) }, token.token);
		} finally {
			token.dispose();
			provider.dispose();
		}
		return parts;
	}

	test("reports the prompt result usage as a chat-only part when asked", async () => {
		const parts = await run(provider({ stopReason: "end_turn", usage }), { [PROMPT_CACHE_OPTION]: true });
		assert.deepStrictEqual(cacheParts(parts), [expected]);
		assert.deepStrictEqual(contextParts(parts), [{ prompt_tokens: 50_000, total_tokens: 50_000 }], "context usage stays unchanged");
	});

	test("reports nothing extra without the marker", async () => {
		const parts = await run(provider({ stopReason: "end_turn", usage }));
		assert.deepStrictEqual(cacheParts(parts), []);
		assert.deepStrictEqual(contextParts(parts), [{ prompt_tokens: 50_000, total_tokens: 50_000 }]);
	});

	test("skips a prompt result without usable usage", async () => {
		const parts = await run(provider({ stopReason: "end_turn" }), { [PROMPT_CACHE_OPTION]: true });
		assert.deepStrictEqual(cacheParts(parts), []);
		assert.deepStrictEqual(contextParts(parts), [{ prompt_tokens: 50_000, total_tokens: 50_000 }]);
	});

	test("does not invent cache reads that the prompt result omitted", async () => {
		const parts = await run(provider({ stopReason: "end_turn", usage: { inputTokens: 100, outputTokens: 20 } }), { [PROMPT_CACHE_OPTION]: true });
		assert.deepStrictEqual(cacheParts(parts), [{ promptTokens: 100, completionTokens: 20, requests: 1 }]);
	});

	test("reports on the final tool segment, where the native prompt resolves", async () => {
		let alias = "";
		const provider = new CocoChatModelProvider({
			isEnabled: () => true,
			resolveCli: () => "mock",
			createClient: (_exe, _cwd, _connection, _model, handlers) => ({
				initialize: async () => undefined,
				newSession: async (_cwd: string, tools: Array<Record<string, unknown>>) => {
					alias = String(tools[0]?.name);
					return { sessionId: "prompt-cache-tools" };
				},
				prompt: async () => {
					handlers?.onUpdate?.({ sessionUpdate: "usage_update", used: 50_000, size: 100_000 });
					handlers?.onUpdate?.({ sessionUpdate: "tool_call", title: alias, kind: "other" });
					await handlers?.onClientTool?.(alias, { value: "x" }, "native-call");
					handlers?.onUpdate?.({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "Done" } });
					return { stopReason: "end_turn", usage };
				},
				cancel: () => undefined,
				dispose: () => undefined,
			}) as unknown as CocoAcpClient,
		});
		const tool: vscode.LanguageModelChatTool = { name: "probe", description: "Probe", inputSchema: { type: "object" } };
		const options = { toolMode: vscode.LanguageModelChatToolMode.Auto, tools: [tool], modelOptions: { [PROMPT_CACHE_OPTION]: true } };
		const token = new vscode.CancellationTokenSource();
		try {
			const first: vscode.LanguageModelResponsePart[] = [];
			await provider.provideLanguageModelChatResponse(mapCocoModel({ id: "auto", name: "Auto" }), [vscode.LanguageModelChatMessage.User("Work")],
				options, { report: part => first.push(part) }, token.token);
			const call = first.find((part): part is vscode.LanguageModelToolCallPart => part instanceof vscode.LanguageModelToolCallPart);
			assert.ok(call, "the first segment reports the native tool call");
			assert.deepStrictEqual(cacheParts(first), [], "the prompt has not finished in the first segment");

			const last: vscode.LanguageModelResponsePart[] = [];
			await provider.provideLanguageModelChatResponse(mapCocoModel({ id: "auto", name: "Auto" }), [
				vscode.LanguageModelChatMessage.Assistant([call]),
				vscode.LanguageModelChatMessage.User([new vscode.LanguageModelToolResultPart(call.callId, [new vscode.LanguageModelTextPart("ok")])]),
			], options, { report: part => last.push(part) }, token.token);
			assert.deepStrictEqual(cacheParts(last), [expected]);
			assert.deepStrictEqual(contextParts(last), [{ prompt_tokens: 50_000, total_tokens: 50_000 }]);
			assert.ok(last.some(part => part instanceof vscode.LanguageModelTextPart && part.value === "Done"));
		} finally {
			token.dispose();
			provider.dispose();
		}
	});
});