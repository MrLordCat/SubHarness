import * as assert from "node:assert";
import * as vscode from "vscode";
import { MAX_TOOL_RESULT_CHARS, runAgentTurn, type AgentTurnSink, type ChatToolExecutor } from "../chat/agent-loop";
import { toLanguageModelMessages } from "../chat/lm-messages";
import { groupModels } from "../chat/shared/model-groups";
import type { ChatMessage, ChatPart, ChatPromptCache, ChatStructuredPart, ChatUsage, ChatUsageTotals } from "../chat/shared/protocol";
import { limitSignalPart, LIMIT_SIGNAL_OPTION } from "../providers/limit-signal";
import { promptCacheSignalPart, PROMPT_CACHE_OPTION } from "../providers/prompt-cache-signal";

const none: vscode.CancellationToken = { isCancellationRequested: false, onCancellationRequested: () => new vscode.Disposable(() => undefined) };
const model: vscode.LanguageModelChatInformation = {
	id: "test-model",
	name: "Test Model",
	family: "test",
	version: "1",
	maxInputTokens: 100_000,
	maxOutputTokens: 4_000,
	capabilities: { toolCalling: true },
};
const readTool: vscode.LanguageModelChatTool = {
	name: "read",
	description: "Read a file",
	inputSchema: { type: "object", properties: { path: { type: "string" } } },
};
const ThinkingPart = (vscode as unknown as Record<string, unknown>)["LanguageModelThinkingPart"] as
	(new (value: string | string[], id?: string) => vscode.LanguageModelResponsePart) | undefined;

let messageId = 0;

function chatMessage(role: "user" | "assistant", parts: ChatPart[], turn = 1): ChatMessage {
	messageId += 1;
	return { id: `message-${messageId}`, role, turn, createdAt: 0, parts };
}

type Round = (progress: vscode.Progress<vscode.LanguageModelResponsePart>) => void;

interface Request {
	messages: readonly vscode.LanguageModelChatRequestMessage[];
	options: vscode.ProvideLanguageModelChatResponseOptions;
}

function fakeBackend(rounds: Round[]): { requests: Request[]; provider: Pick<vscode.LanguageModelChatProvider, "provideLanguageModelChatResponse"> } {
	const requests: Request[] = [];
	return {
		requests,
		provider: {
			provideLanguageModelChatResponse: async (_model, messages, options, progress) => {
				requests.push({ messages, options });
				const round = rounds[requests.length - 1];
				if (!round) {
					throw new Error("unexpected extra round");
				}
				round(progress);
			},
		},
	};
}

function recorder(): { sink: AgentTurnSink; events: string[]; parts: ChatStructuredPart[]; usage: ChatUsage[]; totals: ChatUsageTotals[]; promptCache: ChatPromptCache[] } {
	const events: string[] = [], parts: ChatStructuredPart[] = [], usage: ChatUsage[] = [], totals: ChatUsageTotals[] = [], promptCache: ChatPromptCache[] = [];
	return {
		events,
		parts,
		usage,
		totals,
		promptCache,
		sink: {
			text: (kind, text) => events.push(`text:${kind}:${text}`),
			part: part => {
				parts.push(part);
				events.push(part.kind === "toolResult" ? `part:toolResult:${part.callId}:${part.isError ? "error" : "ok"}` : `part:${part.kind}`);
			},
			usage: (value, total) => {
				usage.push(value);
				totals.push(total);
				events.push("usage");
			},
			promptCache: (value, total) => {
				promptCache.push(value);
				totals.push(total);
				events.push("promptCache");
			},
		},
	};
}

function usagePart(payload: Record<string, unknown>): vscode.LanguageModelDataPart {
	return new vscode.LanguageModelDataPart(new TextEncoder().encode(JSON.stringify(payload)), "usage");
}

function tools(handler: ChatToolExecutor["invoke"]): ChatToolExecutor {
	return { tools: [readTool], invoke: handler };
}

suite("chat message conversion", () => {
	test("converts user text parts and skips empty user messages", () => {
		const converted = toLanguageModelMessages([
			chatMessage("user", [{ kind: "text", text: "Hello" }, { kind: "thinking", text: "ignored" }, { kind: "text", text: " world" }]),
			chatMessage("user", [{ kind: "text", text: "" }]),
		]);
		assert.strictEqual(converted.length, 1);
		assert.strictEqual(converted[0].role, vscode.LanguageModelChatMessageRole.User);
		assert.strictEqual(converted[0].content.length, 1);
		const text = converted[0].content[0];
		assert.ok(text instanceof vscode.LanguageModelTextPart);
		assert.strictEqual(text.value, "Hello world");
	});

	test("groups assistant text and calls before a tool result message", () => {
		const converted = toLanguageModelMessages([chatMessage("assistant", [
			{ kind: "thinking", text: "plan" },
			{ kind: "text", text: "Reading." },
			{ kind: "toolCall", callId: "call-1", name: "read", input: { path: "a" } },
			{ kind: "toolResult", callId: "call-1", text: "contents" },
			{ kind: "notice", level: "info", text: "note" },
			{ kind: "text", text: "Finished." },
		])]);
		assert.deepStrictEqual(converted.map(message => message.role), [
			vscode.LanguageModelChatMessageRole.Assistant,
			vscode.LanguageModelChatMessageRole.User,
			vscode.LanguageModelChatMessageRole.Assistant,
		]);
		assert.deepStrictEqual(converted[0].content.map(part => {
			if (part instanceof vscode.LanguageModelTextPart) {
				return `text:${part.value}`;
			}
			if (part instanceof vscode.LanguageModelToolCallPart) {
				return `call:${part.callId}:${part.name}`;
			}
			return "other";
		}), ["text:Reading.", "call:call-1:read"]);
		const result = converted[1];
		assert.strictEqual(result.content.length, 1);
		const resultPart = result.content[0];
		assert.ok(resultPart instanceof vscode.LanguageModelToolResultPart);
		assert.strictEqual(resultPart.callId, "call-1");
		assert.strictEqual(resultPart.content.length, 1);
		const body = resultPart.content[0];
		assert.ok(body instanceof vscode.LanguageModelTextPart);
		assert.strictEqual(body.value, "contents");
		const last = converted[2].content[0];
		assert.ok(last instanceof vscode.LanguageModelTextPart);
		assert.strictEqual(last.value, "Finished.");
	});

	test("answers stopped tool calls with a synthetic result", () => {
		const converted = toLanguageModelMessages([chatMessage("assistant", [
			{ kind: "toolCall", callId: "done", name: "read", input: {} },
			{ kind: "toolResult", callId: "done", text: "ok" },
			{ kind: "toolCall", callId: "stopped", name: "read", input: {} },
		])]);
		assert.deepStrictEqual(converted.map(message => message.role), [
			vscode.LanguageModelChatMessageRole.Assistant,
			vscode.LanguageModelChatMessageRole.User,
			vscode.LanguageModelChatMessageRole.Assistant,
			vscode.LanguageModelChatMessageRole.User,
		]);
		const synthetic = converted[3].content[0];
		assert.ok(synthetic instanceof vscode.LanguageModelToolResultPart);
		assert.strictEqual(synthetic.callId, "stopped");
		const body = synthetic.content[0];
		assert.ok(body instanceof vscode.LanguageModelTextPart);
		assert.match(body.value, /Not executed: the turn was stopped before this tool ran\./);
	});

	test("skips thinking/notice-only and empty assistant messages", () => {
		const converted = toLanguageModelMessages([
			chatMessage("assistant", [
				{ kind: "thinking", text: "hmm" },
				{ kind: "notice", level: "warning", text: "oops" },
			]),
			chatMessage("assistant", []),
		]);
		assert.deepStrictEqual(converted, []);
	});

	test("renders tool result images as data parts and skips images without data", () => {
		const bytes = Buffer.from([1, 2, 3, 4]);
		const converted = toLanguageModelMessages([chatMessage("assistant", [
			{ kind: "toolCall", callId: "with-image", name: "read", input: {} },
			{ kind: "toolResult", callId: "with-image", text: "Image", images: [{ mimeType: "image/png", data: bytes.toString("base64"), byteLength: 4, name: "a.png" }] },
			{ kind: "toolCall", callId: "without-data", name: "read", input: {} },
			{ kind: "toolResult", callId: "without-data", text: "Image", images: [{ mimeType: "image/png", byteLength: 4, name: "b.png" }] },
		])]);
		assert.deepStrictEqual(converted.map(message => message.role), [
			vscode.LanguageModelChatMessageRole.Assistant,
			vscode.LanguageModelChatMessageRole.User,
			vscode.LanguageModelChatMessageRole.Assistant,
			vscode.LanguageModelChatMessageRole.User,
		]);
		const withImage = converted[1].content[0];
		assert.ok(withImage instanceof vscode.LanguageModelToolResultPart);
		assert.strictEqual(withImage.content.length, 2);
		const image = withImage.content[1];
		assert.ok(image instanceof vscode.LanguageModelDataPart);
		assert.strictEqual(image.mimeType, "image/png");
		assert.deepStrictEqual([...image.data], [...bytes]);
		const withoutData = converted[3].content[0];
		assert.ok(withoutData instanceof vscode.LanguageModelToolResultPart);
		assert.strictEqual(withoutData.content.length, 1);
	});
});

suite("chat agent loop", () => {
	test("runs tool rounds, forwards sink events and parses usage", async () => {
		const fake = fakeBackend([
			progress => {
				progress.report(new vscode.LanguageModelTextPart("Checking."));
				progress.report(new vscode.LanguageModelToolCallPart("call-1", "read", { path: "a.txt" }));
			},
			progress => {
				progress.report(new vscode.LanguageModelTextPart("All done."));
				progress.report(new vscode.LanguageModelDataPart(new TextEncoder().encode(JSON.stringify({
					prompt_tokens: 10,
					completion_tokens: 5,
					total_tokens: 15,
					prompt_tokens_details: { cached_tokens: 3 },
				})), "usage"));
			},
		]);
		const { sink, events, usage } = recorder();
		const invocations: Array<{ name: string; input: unknown }> = [];
		const result = await runAgentTurn({
			backend: fake.provider,
			model,
			history: [chatMessage("user", [{ kind: "text", text: "Inspect the file" }])],
			conversationId: "chat-1",
			turn: 7,
			tools: tools(async (name, input) => {
				invocations.push({ name, input });
				return { text: "file body", isError: false };
			}),
			sink,
			token: none,
		});
		assert.deepStrictEqual(result, { rounds: 2, stopReason: "done" });
		assert.deepStrictEqual(invocations, [{ name: "read", input: { path: "a.txt" } }]);
		assert.deepStrictEqual(events, [
			"text:text:Checking.",
			"part:toolCall",
			"part:toolResult:call-1:ok",
			"text:text:All done.",
			"usage",
		]);
		assert.deepStrictEqual(usage, [{ promptTokens: 10, completionTokens: 5, totalTokens: 15, cachedTokens: 3 }]);
		assert.strictEqual(fake.requests.length, 2);
		const options = fake.requests[0].options;
		assert.strictEqual(options.toolMode, vscode.LanguageModelChatToolMode.Auto);
		assert.strictEqual(options.modelOptions?._conversationId, "chat-1");
		assert.strictEqual(options.modelOptions?._copilotTurnIndex, 7);
		assert.deepStrictEqual(options.tools, [readTool]);
		const second = fake.requests[1].messages;
		assert.strictEqual(second.length, 3);
		assert.strictEqual(second[1].role, vscode.LanguageModelChatMessageRole.Assistant);
		const call = second[1].content.find((part): part is vscode.LanguageModelToolCallPart => part instanceof vscode.LanguageModelToolCallPart);
		assert.ok(call);
		assert.strictEqual(call.callId, "call-1");
		assert.strictEqual(second[2].role, vscode.LanguageModelChatMessageRole.User);
		assert.strictEqual(second[2].content.length, 1);
		const resultPart = second[2].content[0];
		assert.ok(resultPart instanceof vscode.LanguageModelToolResultPart);
		assert.strictEqual(resultPart.callId, "call-1");
		const body = resultPart.content[0];
		assert.ok(body instanceof vscode.LanguageModelTextPart);
		assert.strictEqual(body.value, "file body");
	});

	test("carries tool images into the result part and the next request", async () => {
		const bytes = Buffer.from([9, 8, 7, 6, 5]);
		const fake = fakeBackend([
			progress => progress.report(new vscode.LanguageModelToolCallPart("call-image", "read", { path: "a.png" })),
			progress => progress.report(new vscode.LanguageModelTextPart("Seen it.")),
		]);
		const { sink, parts } = recorder();
		const result = await runAgentTurn({
			backend: fake.provider,
			model,
			history: [chatMessage("user", [{ kind: "text", text: "Look at a.png" }])],
			conversationId: "chat-image",
			turn: 1,
			tools: tools(async () => ({
				text: "Image a.png: image/png, 5 B.",
				isError: false,
				images: [{ mimeType: "image/png", data: bytes.toString("base64"), byteLength: bytes.byteLength, name: "a.png" }],
			})),
			sink,
			token: none,
		});
		assert.deepStrictEqual(result, { rounds: 2, stopReason: "done" });
		const resultPart = parts.find(part => part.kind === "toolResult");
		if (!resultPart || resultPart.kind !== "toolResult") {
			throw new Error("expected a tool result");
		}
		assert.deepStrictEqual(resultPart.images, [{ mimeType: "image/png", data: bytes.toString("base64"), byteLength: 5, name: "a.png" }]);
		const next = fake.requests[1].messages;
		const toolResultPart = next[2].content[0];
		assert.ok(toolResultPart instanceof vscode.LanguageModelToolResultPart);
		assert.strictEqual(toolResultPart.content.length, 2);
		const image = toolResultPart.content[1];
		assert.ok(image instanceof vscode.LanguageModelDataPart);
		assert.strictEqual(image.mimeType, "image/png");
		assert.deepStrictEqual([...image.data], [...bytes]);
	});

	test("yields after the round's tools when the user queued a message", async () => {
		const fake = fakeBackend([
			progress => progress.report(new vscode.LanguageModelToolCallPart("call-1", "read", { path: "a.txt" })),
			progress => progress.report(new vscode.LanguageModelTextPart("Unexpected next round.")),
		]);
		const { sink, events, parts } = recorder();
		let queued = false;
		const result = await runAgentTurn({
			backend: fake.provider,
			model,
			history: [chatMessage("user", [{ kind: "text", text: "Go" }])],
			conversationId: "chat-yield",
			turn: 1,
			tools: tools(async () => {
				queued = true;
				return { text: "file body", isError: false };
			}),
			sink,
			token: none,
			shouldYield: () => queued,
		});
		assert.deepStrictEqual(result, { rounds: 1, stopReason: "yielded" });
		assert.strictEqual(fake.requests.length, 1);
		assert.deepStrictEqual(events, ["part:toolCall", "part:toolResult:call-1:ok"]);
		const resultPart = parts.find(part => part.kind === "toolResult");
		if (!resultPart || resultPart.kind !== "toolResult") {
			throw new Error("expected a tool result");
		}
		assert.strictEqual(resultPart.text, "file body");
	});

	test("does not yield before the first request", async () => {
		const fake = fakeBackend([progress => progress.report(new vscode.LanguageModelTextPart("Answered."))]);
		const { sink } = recorder();
		const result = await runAgentTurn({
			backend: fake.provider,
			model,
			history: [chatMessage("user", [{ kind: "text", text: "Go" }])],
			conversationId: "chat-yield-first",
			turn: 1,
			tools: tools(async () => ({ text: "", isError: false })),
			sink,
			token: none,
			shouldYield: () => true,
		});
		assert.deepStrictEqual(result, { rounds: 1, stopReason: "done" });
		assert.strictEqual(fake.requests.length, 1);
	});

	test("sums usage over rounds and replaces incremental reports within a round", async () => {
		const fake = fakeBackend([
			progress => {
				progress.report(usagePart({ prompt_tokens: 100, completion_tokens: 5, total_tokens: 105 }));
				progress.report(new vscode.LanguageModelToolCallPart("call-1", "read", { path: "a.txt" }));
				progress.report(usagePart({ prompt_tokens: 1000, completion_tokens: 50, total_tokens: 1050, prompt_tokens_details: { cached_tokens: 800 } }));
			},
			progress => {
				progress.report(usagePart({ prompt_tokens: 1200, completion_tokens: 60, total_tokens: 1260, prompt_tokens_details: { cached_tokens: 1100 } }));
				progress.report(new vscode.LanguageModelTextPart("Done."));
			},
		]);
		const { sink, usage, totals } = recorder();
		const result = await runAgentTurn({
			backend: fake.provider,
			model,
			history: [chatMessage("user", [{ kind: "text", text: "Go" }])],
			conversationId: "chat-usage",
			turn: 1,
			tools: tools(async () => ({ text: "file body", isError: false })),
			sink,
			token: none,
		});
		assert.deepStrictEqual(result, { rounds: 2, stopReason: "done" });
		assert.deepStrictEqual(usage, [
			{ promptTokens: 100, completionTokens: 5, totalTokens: 105 },
			{ promptTokens: 1000, completionTokens: 50, totalTokens: 1050, cachedTokens: 800 },
			{ promptTokens: 1200, completionTokens: 60, totalTokens: 1260, cachedTokens: 1100 },
		]);
		assert.deepStrictEqual(totals, [
			{ requests: 1, promptTokens: 100, cachedTokens: 0, completionTokens: 5, cacheReported: 0, cachedPromptTokens: 0 },
			{ requests: 1, promptTokens: 1000, cachedTokens: 800, completionTokens: 50, cacheReported: 1, cachedPromptTokens: 1000 },
			{ requests: 2, promptTokens: 2200, cachedTokens: 1900, completionTokens: 110, cacheReported: 2, cachedPromptTokens: 2200 },
		]);
	});

	test("keeps context usage apart and adds a prompt-cache part to the totals", async () => {
		const fake = fakeBackend([progress => {
			progress.report(usagePart({ prompt_tokens: 1000, total_tokens: 1000 }));
			progress.report(promptCacheSignalPart({
				promptTokens: 900, cachedTokens: 700, cacheWriteTokens: 100, completionTokens: 50, requests: 1,
			}));
			progress.report(new vscode.LanguageModelTextPart("Done."));
		}]);
		const { sink, usage, totals, promptCache } = recorder();
		const result = await runAgentTurn({
			backend: fake.provider,
			model,
			history: [chatMessage("user", [{ kind: "text", text: "Go" }])],
			conversationId: "chat-prompt-cache",
			turn: 1,
			tools: tools(async () => ({ text: "", isError: false })),
			sink,
			token: none,
		});
		assert.deepStrictEqual(result, { rounds: 1, stopReason: "done" });
		assert.deepStrictEqual(usage, [{ promptTokens: 1000, totalTokens: 1000 }]);
		assert.deepStrictEqual(promptCache, [
			{ promptTokens: 900, cachedTokens: 700, cacheWriteTokens: 100, completionTokens: 50, requests: 1 },
		]);
		assert.deepStrictEqual(totals, [
			{ requests: 1, promptTokens: 1000, cachedTokens: 0, completionTokens: 0, cacheReported: 0, cachedPromptTokens: 0 },
			{ requests: 2, promptTokens: 1900, cachedTokens: 700, completionTokens: 50, cacheReported: 1, cachedPromptTokens: 900 },
		]);
		const options = fake.requests[0].options.modelOptions!;
		assert.strictEqual(options[PROMPT_CACHE_OPTION], true);
		assert.strictEqual(options[LIMIT_SIGNAL_OPTION], true);
	});

	test("turns a limit signal into one notice and swallows the repeated text", async () => {
		const resetAt = 1_700_000_000_000;
		const fake = fakeBackend([progress => {
			progress.report(limitSignalPart({ kind: "limit", provider: "Codex", text: "Codex limit reached.", window: "5-hour", resetAt }));
			progress.report(new vscode.LanguageModelTextPart("Codex limit "));
			progress.report(new vscode.LanguageModelTextPart("reached."));
			progress.report(new vscode.LanguageModelTextPart("Extra."));
		}]);
		const { sink, events, parts } = recorder();
		const result = await runAgentTurn({
			backend: fake.provider,
			model,
			history: [chatMessage("user", [{ kind: "text", text: "Go" }])],
			conversationId: "chat-limit",
			turn: 1,
			tools: tools(async () => ({ text: "", isError: false })),
			sink,
			token: none,
		});
		assert.deepStrictEqual(result, { rounds: 1, stopReason: "done" });
		assert.deepStrictEqual(events, ["part:notice", "text:text:Extra."]);
		const notices = parts.filter(part => part.kind === "notice");
		assert.strictEqual(notices.length, 1);
		const notice = notices[0];
		if (notice.kind !== "notice") {
			throw new Error("expected a notice");
		}
		assert.strictEqual(notice.text, "Codex limit reached.");
		assert.deepStrictEqual(notice.limit, { kind: "limit", provider: "Codex", window: "5-hour", resetAt });
		assert.strictEqual(fake.requests[0].options.modelOptions?._aabLimitSignals, true);
	});

	test("turns a thrown tool error into an error result and continues", async () => {
		const fake = fakeBackend([
			progress => progress.report(new vscode.LanguageModelToolCallPart("call-error", "read", {})),
			progress => progress.report(new vscode.LanguageModelTextPart("Recovered.")),
		]);
		const { sink, events, parts } = recorder();
		const result = await runAgentTurn({
			backend: fake.provider,
			model,
			history: [chatMessage("user", [{ kind: "text", text: "Go" }])],
			conversationId: "chat-error",
			turn: 1,
			tools: tools(async () => { throw new Error("boom"); }),
			sink,
			token: none,
		});
		assert.deepStrictEqual(result, { rounds: 2, stopReason: "done" });
		assert.deepStrictEqual(events, ["part:toolCall", "part:toolResult:call-error:error", "text:text:Recovered."]);
		const failure = parts[1];
		if (failure.kind !== "toolResult") {
			throw new Error("expected a tool result");
		}
		assert.strictEqual(failure.text, "boom");
		assert.strictEqual(failure.isError, true);
	});

	test("truncates oversized tool results and marks them", async () => {
		const fake = fakeBackend([
			progress => progress.report(new vscode.LanguageModelToolCallPart("call-big", "read", {})),
			progress => progress.report(new vscode.LanguageModelTextPart("Done.")),
		]);
		const { sink, parts } = recorder();
		const huge = "x".repeat(MAX_TOOL_RESULT_CHARS + 10);
		const result = await runAgentTurn({
			backend: fake.provider,
			model,
			history: [chatMessage("user", [{ kind: "text", text: "Read everything" }])],
			conversationId: "chat-truncate",
			turn: 1,
			tools: tools(async () => ({ text: huge, isError: false })),
			sink,
			token: none,
		});
		assert.deepStrictEqual(result, { rounds: 2, stopReason: "done" });
		const resultPart = parts.find(part => part.kind === "toolResult");
		if (!resultPart || resultPart.kind !== "toolResult") {
			throw new Error("expected a tool result");
		}
		assert.strictEqual(resultPart.truncated, true);
		assert.strictEqual(resultPart.isError, false);
		assert.ok(resultPart.text.startsWith("x".repeat(MAX_TOOL_RESULT_CHARS)));
		assert.match(resultPart.text, /\[Tool result truncated\.\]$/);
	});

	test("rejects with CancellationError when the token is cancelled during a tool invoke", async () => {
		let cancelled = false;
		const token: vscode.CancellationToken = {
			get isCancellationRequested() { return cancelled; },
			onCancellationRequested: () => new vscode.Disposable(() => undefined),
		};
		const fake = fakeBackend([progress => progress.report(new vscode.LanguageModelToolCallPart("call-a", "read", {}))]);
		const { sink } = recorder();
		let invocations = 0;
		await assert.rejects(runAgentTurn({
			backend: fake.provider,
			model,
			history: [chatMessage("user", [{ kind: "text", text: "Go" }])],
			conversationId: "chat-cancel",
			turn: 1,
			tools: tools(async () => {
				invocations += 1;
				cancelled = true;
				return { text: "ok", isError: false };
			}),
			sink,
			token,
		}), error => error instanceof vscode.CancellationError);
		assert.strictEqual(invocations, 1);
		assert.strictEqual(fake.requests.length, 1);
	});

	test("does not invoke the next tool after the token is cancelled", async () => {
		let cancelled = false;
		const token: vscode.CancellationToken = {
			get isCancellationRequested() { return cancelled; },
			onCancellationRequested: () => new vscode.Disposable(() => undefined),
		};
		const fake = fakeBackend([progress => {
			progress.report(new vscode.LanguageModelToolCallPart("call-a", "read", {}));
			progress.report(new vscode.LanguageModelToolCallPart("call-b", "read", {}));
		}]);
		const { sink } = recorder();
		let invocations = 0;
		await assert.rejects(runAgentTurn({
			backend: fake.provider,
			model,
			history: [chatMessage("user", [{ kind: "text", text: "Go" }])],
			conversationId: "chat-cancel-next",
			turn: 1,
			tools: tools(async () => {
				invocations += 1;
				cancelled = true;
				return { text: "ok", isError: false };
			}),
			sink,
			token,
		}), error => error instanceof vscode.CancellationError);
		assert.strictEqual(invocations, 1);
	});

	test("stops a tool loop at maxRounds with a warning notice", async () => {
		const fake = fakeBackend([
			progress => progress.report(new vscode.LanguageModelToolCallPart("call-1", "read", {})),
			progress => progress.report(new vscode.LanguageModelToolCallPart("call-2", "read", {})),
		]);
		const { sink, parts } = recorder();
		const result = await runAgentTurn({
			backend: fake.provider,
			model,
			history: [chatMessage("user", [{ kind: "text", text: "Loop" }])],
			conversationId: "chat-max",
			turn: 1,
			maxRounds: 2,
			tools: tools(async () => ({ text: "again", isError: false })),
			sink,
			token: none,
		});
		assert.deepStrictEqual(result, { rounds: 2, stopReason: "maxRounds" });
		assert.strictEqual(fake.requests.length, 2);
		const notice = parts.at(-1);
		if (!notice || notice.kind !== "notice") {
			throw new Error("expected a notice");
		}
		assert.strictEqual(notice.level, "warning");
		assert.match(notice.text, /stopped after 2 tool rounds/);
	});

	test("forwards thinking parts when the runtime supports them", async function () {
		const Part = ThinkingPart;
		if (!Part) {
			this.skip();
			return;
		}
		const fake = fakeBackend([progress => {
			progress.report(new Part(["step ", "one"]));
			progress.report(new vscode.LanguageModelTextPart("Answer"));
		}]);
		const { sink, events } = recorder();
		const result = await runAgentTurn({
			backend: fake.provider,
			model,
			history: [chatMessage("user", [{ kind: "text", text: "Think" }])],
			conversationId: "chat-thinking",
			turn: 1,
			tools: tools(async () => ({ text: "", isError: false })),
			sink,
			token: none,
		});
		assert.deepStrictEqual(result, { rounds: 1, stopReason: "done" });
		assert.deepStrictEqual(events, ["text:thinking:step one", "text:text:Answer"]);
	});
});

suite("chat model grouping", () => {
	test("derives provider labels from name suffixes and id prefixes", () => {
		const groups = groupModels([
			{ id: "codex::gpt-5.1-codex", name: "GPT-5.1 Codex (Codex)", maxInputTokens: 400_000 },
			{ id: "claude::opus-5", name: "Opus 5", maxInputTokens: 200_000 },
			{ id: "deepseek::flash", name: "Flash", maxInputTokens: 128_000 },
			{ id: "local::qwen", name: "Qwen", maxInputTokens: 32_000 },
			{ id: "primary::llama", name: "Llama", maxInputTokens: 32_000 },
			{ id: "gemini::pro", name: "Pro", maxInputTokens: 1_000_000 },
			{ id: "standalone", name: "Standalone", maxInputTokens: 8_000 },
		]);
		assert.deepStrictEqual(groups.map(group => group.provider), ["Codex", "Claude", "DeepSeek", "Local", "Gemini", "Other"]);
		assert.deepStrictEqual(groups[0].models, [
			{ id: "codex::gpt-5.1-codex", name: "GPT-5.1 Codex", maxInputTokens: 400_000 },
		]);
		assert.deepStrictEqual(groups[3].models.map(entry => entry.name), ["Llama", "Qwen"]);
	});

	test("orders priority groups first and the rest alphabetically", () => {
		const groups = groupModels([
			{ id: "other::one", name: "One", maxInputTokens: 1 },
			{ id: "zeta::two", name: "Two", maxInputTokens: 1 },
			{ id: "deepseek::three", name: "Three", maxInputTokens: 1 },
			{ id: "claude::four", name: "Four", maxInputTokens: 1 },
			{ id: "codex::five", name: "Five", maxInputTokens: 1 },
			{ id: "cursor::six", name: "Six", maxInputTokens: 1 },
			{ id: "coco::seven", name: "Seven", maxInputTokens: 1 },
			{ id: "local::eight", name: "Eight", maxInputTokens: 1 },
			{ id: "alpha::nine", name: "Nine", maxInputTokens: 1 },
		]);
		assert.deepStrictEqual(groups.map(group => group.provider), [
			"Codex", "Claude", "Coco", "Cursor", "DeepSeek", "Local", "Alpha", "Other", "Zeta",
		]);
	});

	test("sorts models numerically inside a group", () => {
		const groups = groupModels([
			{ id: "codex::ten", name: "Model 10", maxInputTokens: 1 },
			{ id: "codex::two", name: "Model 2", maxInputTokens: 1 },
			{ id: "codex::one", name: "Model 1", maxInputTokens: 1 },
		]);
		assert.deepStrictEqual(groups[0].models.map(entry => entry.name), ["Model 1", "Model 2", "Model 10"]);
	});

	test("keeps full names when derived names collide", () => {
		const groups = groupModels([
			{ id: "codex::a", name: "GPT (Codex)", maxInputTokens: 1 },
			{ id: "codex::b", name: "GPT", maxInputTokens: 1 },
		]);
		assert.strictEqual(groups.length, 1);
		assert.deepStrictEqual(groups[0].models.map(entry => entry.name), ["GPT", "GPT (Codex)"]);
	});
});
