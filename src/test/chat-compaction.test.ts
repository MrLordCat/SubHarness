import * as assert from "node:assert";
import * as vscode from "vscode";
import {
	CHAT_COMPACTION_SUMMARY_RESERVE_TOKENS,
	compactChatHistory,
	createChatSummarizer,
	estimateChatMessageTokens,
	estimateTextTokens,
	planChatCompaction,
	previousModelId,
	toOpenAIMessages,
	type ChatCompactionLimits,
	type ChatCompactionPlan,
	type ChatSummarizerDeps,
} from "../chat/compaction";
import { activeCompaction, compactionSummaryText, toLanguageModelMessages, userRequestText, type ChatCompactionPart } from "../chat/lm-messages";
import type { ChatMessage, ChatPart } from "../chat/shared/protocol";

const SYSTEM_ROLE = 3;

type SummaryRequest = Parameters<NonNullable<ChatSummarizerDeps["request"]>>[0];

let messageSequence = 0;

function chatMessage(role: ChatMessage["role"], parts: ChatPart[], extra: Partial<ChatMessage> = {}): ChatMessage {
	messageSequence += 1;
	return { id: `m${messageSequence}`, role, turn: 1, createdAt: 0, parts, ...extra };
}

function textMessage(role: ChatMessage["role"], text: string, extra: Partial<ChatMessage> = {}): ChatMessage {
	return chatMessage(role, [{ kind: "text", text }], extra);
}

function compactionPart(summary: string, keepFromMessageId: string, summarizedMessages = 2): ChatCompactionPart {
	return { kind: "compaction", summary, keepFromMessageId, summarizedMessages, tokensBefore: 500, tokensAfter: 100, method: "deepseek" };
}

/** Six equal-cost messages: u1, a1, u2, a2, u3, a3. */
function equalCostHistory(): ChatMessage[] {
	return Array.from({ length: 6 }, (_, index) => textMessage(index % 2 === 0 ? "user" : "assistant", "x".repeat(2_000)));
}

function messageText(message: vscode.LanguageModelChatRequestMessage): string {
	return message.content
		.filter((part): part is vscode.LanguageModelTextPart => part instanceof vscode.LanguageModelTextPart)
		.map(part => part.value)
		.join("");
}

function roleOf(message: vscode.LanguageModelChatRequestMessage): number {
	return message.role as number;
}

function planForSummarizer(): ChatCompactionPlan {
	const user = textMessage("user", "First request");
	const assistant = textMessage("assistant", "First answer");
	return {
		keepFrom: 2,
		dropped: [user, assistant],
		previousSummary: "PREVIOUS",
		summarizedMessages: 2,
		tokensBefore: 500,
		keptTokens: 100,
	};
}

suite("chat compaction", () => {
	test("puts the system prompt first and omits it when not given", () => {
		const history = [textMessage("user", "Hello")];
		const withSystem = toLanguageModelMessages(history, { system: "SYSTEM" });
		assert.strictEqual(withSystem.length, 2);
		assert.strictEqual(withSystem[0].role as number, SYSTEM_ROLE);
		assert.strictEqual(messageText(withSystem[0]), "SYSTEM");
		assert.strictEqual(roleOf(withSystem[1]), vscode.LanguageModelChatMessageRole.User);
		assert.strictEqual(messageText(withSystem[1]), "Hello");

		const withoutSystem = toLanguageModelMessages(history);
		assert.strictEqual(withoutSystem.length, 1);
		assert.deepStrictEqual(withoutSystem.map(roleOf), [vscode.LanguageModelChatMessageRole.User]);
	});

	test("renders a user message with and without host context", () => {
		const plain = textMessage("user", "Hello");
		assert.strictEqual(userRequestText(plain), "Hello");
		assert.strictEqual(messageText(toLanguageModelMessages([plain])[0]), "Hello");

		const hostContext = "<context>\nturn 1\n</context>";
		const withContext = textMessage("user", "Hello", { hostContext });
		assert.strictEqual(userRequestText(withContext), `${hostContext}\n<userRequest>\nHello\n</userRequest>`);
		assert.strictEqual(messageText(toLanguageModelMessages([withContext])[0]), userRequestText(withContext));
	});

	test("puts attachments between the host context and the request", () => {
		const attachmentContext = '<attachments>\n<attachment path="a.ts">\n```ts\nx\n```\n</attachment>\n</attachments>';
		const withoutHost = textMessage("user", "Look", { attachmentContext });
		assert.strictEqual(userRequestText(withoutHost), `${attachmentContext}\n<userRequest>\nLook\n</userRequest>`);
		assert.strictEqual(messageText(toLanguageModelMessages([withoutHost])[0]), userRequestText(withoutHost));

		const hostContext = "<context>\nturn 1\n</context>";
		const withBoth = textMessage("user", "Look", { hostContext, attachmentContext });
		assert.strictEqual(userRequestText(withBoth), `${hostContext}\n${attachmentContext}\n<userRequest>\nLook\n</userRequest>`);
	});

	test("renders the compaction window instead of the summarized messages", () => {
		const u1 = textMessage("user", "one");
		const a1 = textMessage("assistant", "answer one");
		const u2 = textMessage("user", "two");
		const a2 = textMessage("assistant", "answer two");
		const u3 = textMessage("user", "three");
		const part = compactionPart("EARLIER TURNS", u2.id);
		const a3 = chatMessage("assistant", [part, { kind: "text", text: "answer three" }]);
		const history = [u1, a1, u2, a2, u3, a3];

		const converted = toLanguageModelMessages(history);
		assert.deepStrictEqual(converted.map(roleOf), [
			vscode.LanguageModelChatMessageRole.User,
			vscode.LanguageModelChatMessageRole.User,
			vscode.LanguageModelChatMessageRole.Assistant,
			vscode.LanguageModelChatMessageRole.User,
			vscode.LanguageModelChatMessageRole.Assistant,
		]);
		assert.deepStrictEqual(converted.map(messageText), [compactionSummaryText(part), "two", "answer two", "three", "answer three"]);

		const withSystem = toLanguageModelMessages(history, { system: "SYSTEM" });
		assert.strictEqual(withSystem[0].role as number, SYSTEM_ROLE);
		assert.strictEqual(messageText(withSystem[0]), "SYSTEM");
		assert.deepStrictEqual(withSystem.slice(1).map(messageText), converted.map(messageText));
	});

	test("activeCompaction ignores a compaction whose kept message is gone", () => {
		const u1 = textMessage("user", "one");
		const a1 = textMessage("assistant", "answer one");
		const u2 = textMessage("user", "two");
		const a2 = textMessage("assistant", "answer two");
		const u3 = textMessage("user", "three");
		const part = compactionPart("EARLIER TURNS", "missing-message");
		const a3 = chatMessage("assistant", [part, { kind: "text", text: "answer three" }]);
		const history = [u1, a1, u2, a2, u3, a3];

		assert.strictEqual(activeCompaction(history), undefined);
		assert.deepStrictEqual(toLanguageModelMessages(history).map(messageText), ["one", "answer one", "two", "answer two", "three", "answer three"]);
	});

	test("plans a compaction only above the trigger and keeps a fitting user turn tail", () => {
		const history = equalCostHistory();
		const costs = history.map(estimateChatMessageTokens);
		const total = costs.reduce((sum, cost) => sum + cost, 0);
		const fixedTokens = 100;
		const estimate = fixedTokens + total;
		assert.strictEqual(planChatCompaction(history, { triggerTokens: estimate, targetTokens: 18_200, fixedTokens }), undefined);
		assert.strictEqual(planChatCompaction(history, { triggerTokens: estimate + 100, targetTokens: 18_200, fixedTokens }), undefined);

		const limits: ChatCompactionLimits = { triggerTokens: estimate - 1, targetTokens: 18_200, fixedTokens };
		const plan = planChatCompaction(history, limits);
		assert.ok(plan);
		const budget = limits.targetTokens - fixedTokens - CHAT_COMPACTION_SUMMARY_RESERVE_TOKENS;
		assert.ok(budget > 0);
		assert.strictEqual(history[plan.keepFrom].role, "user");
		const tail = costs.slice(plan.keepFrom).reduce((sum, cost) => sum + cost, 0);
		assert.ok(tail <= budget, `tail ${tail} fits ${budget}`);
		const previousUser = plan.keepFrom - 2;
		assert.strictEqual(history[previousUser].role, "user");
		const previousTail = costs.slice(previousUser).reduce((sum, cost) => sum + cost, 0);
		assert.ok(fixedTokens + previousTail > budget, "the previous user message would not fit");
		assert.deepStrictEqual(plan.dropped, history.slice(0, plan.keepFrom));
		assert.strictEqual(plan.summarizedMessages, plan.dropped.length);
		assert.strictEqual(plan.tokensBefore, fixedTokens + total);
		assert.strictEqual(plan.keptTokens, fixedTokens + tail);
		assert.strictEqual(plan.previousSummary, undefined);
	});

	test("keeps the latest turn whole when even it is over the budget", () => {
		const history = equalCostHistory();
		const total = history.map(estimateChatMessageTokens).reduce((sum, cost) => sum + cost, 0);
		const plan = planChatCompaction(history, { triggerTokens: total - 1, targetTokens: 16_100 });
		assert.ok(plan);
		const latestUser = history.findLastIndex(message => message.role === "user");
		assert.strictEqual(plan.keepFrom, latestUser);
		assert.deepStrictEqual(plan.dropped, history.slice(0, latestUser));
	});

	test("does not compact a single huge first turn", () => {
		const history = [textMessage("user", "x".repeat(100_000))];
		assert.strictEqual(planChatCompaction(history, { triggerTokens: 1, targetTokens: 16_100 }), undefined);
	});

	test("plans from the previous compaction's window and summary", () => {
		const u1 = textMessage("user", "one");
		const u2 = textMessage("user", "x".repeat(2_000));
		const summary = "PREVIOUS WORK";
		const part = compactionPart(summary, u2.id, 5);
		const a1 = chatMessage("assistant", [{ kind: "text", text: "answer one" }, part]);
		const a2 = textMessage("assistant", "x".repeat(2_000));
		const u3 = textMessage("user", "x".repeat(2_000));
		const a3 = textMessage("assistant", "x".repeat(2_000));
		const u4 = textMessage("user", "x".repeat(2_000));
		const a4 = textMessage("assistant", "x".repeat(2_000));
		const history = [u1, a1, u2, a2, u3, a3, u4, a4];
		const window = history.slice(2);
		assert.deepStrictEqual(window.map(message => message.id), [u2.id, a2.id, u3.id, a3.id, u4.id, a4.id]);
		const windowTokens = window.map(estimateChatMessageTokens).reduce((sum, cost) => sum + cost, 0);
		const summaryTokens = estimateTextTokens(compactionSummaryText(part));

		const plan = planChatCompaction(history, { triggerTokens: windowTokens - 1, targetTokens: 18_200 });
		assert.ok(plan);
		assert.strictEqual(plan.keepFrom, 6);
		assert.strictEqual(history[plan.keepFrom].id, u4.id);
		assert.strictEqual(plan.previousSummary, summary);
		assert.strictEqual(plan.summarizedMessages, 5 + 4);
		assert.deepStrictEqual(plan.dropped, history.slice(2, 6));
		assert.strictEqual(plan.tokensBefore, summaryTokens + windowTokens);
	});

	test("previousModelId finds the newest assistant that names a model", () => {
		assert.strictEqual(previousModelId([]), undefined);
		const older = textMessage("assistant", "older", { modelId: "codex::fast" });
		const unnamed = textMessage("assistant", "unnamed");
		const user = textMessage("user", "question");
		assert.strictEqual(previousModelId([older, user, unnamed]), "codex::fast");

		const newest = textMessage("assistant", "newest", { modelId: "claude::smart" });
		assert.strictEqual(previousModelId([older, unnamed, newest, user]), "claude::smart");
	});

	test("converts the history to the OpenAI summarizer shape", () => {
		const user = textMessage("user", "Hello", { hostContext: "<context>\nnow\n</context>" });
		const assistant = chatMessage("assistant", [
			{ kind: "text", text: "A" },
			{ kind: "toolCall", callId: "c1", name: "read", input: { path: "a.txt" } },
			{ kind: "toolResult", callId: "c1", text: "R" },
			{ kind: "text", text: "B" },
			{ kind: "thinking", text: "ignored" },
			{ kind: "notice", level: "info", text: "ignored" },
		]);
		assert.deepStrictEqual(toOpenAIMessages([user, assistant]), [
			{ role: "user", content: userRequestText(user) },
			{
				role: "assistant",
				content: "A",
				tool_calls: [{ id: "c1", type: "function", function: { name: "read", arguments: JSON.stringify({ path: "a.txt" }) } }],
			},
			{ role: "tool", tool_call_id: "c1", content: "R" },
			{ role: "assistant", content: "B" },
		]);
	});

	test("createChatSummarizer asks DeepSeek when a key is set", async () => {
		const plan = planForSummarizer();
		const requests: SummaryRequest[] = [];
		const source = new vscode.CancellationTokenSource();
		const summarize = createChatSummarizer({
			apiKey: async () => "sk-test",
			userAgent: "test-agent",
			request: async input => {
				requests.push(input);
				return { content: "DEEP SUMMARY", inputChars: 0 };
			},
		});
		const result = await summarize(plan, source.token);
		source.dispose();

		assert.deepStrictEqual(result, { method: "deepseek", summary: "DEEP SUMMARY" });
		assert.strictEqual(requests.length, 1);
		assert.strictEqual(requests[0].apiKey, "sk-test");
		assert.strictEqual(requests[0].userAgent, "test-agent");
		assert.strictEqual(requests[0].previousSummary, "PREVIOUS");
		assert.deepStrictEqual(requests[0].droppedMessages, toOpenAIMessages(plan.dropped));
	});

	test("createChatSummarizer falls back to the extractive summary when DeepSeek fails", async () => {
		const plan = planForSummarizer();
		const logs: string[] = [];
		const source = new vscode.CancellationTokenSource();
		const summarize = createChatSummarizer({
			apiKey: async () => "sk-test",
			userAgent: "test-agent",
			log: event => logs.push(event),
			request: async () => { throw new Error("deepseek is down"); },
		});
		const result = await summarize(plan, source.token);
		source.dispose();

		assert.strictEqual(result.method, "extractive");
		assert.ok(result.summary.startsWith("Conversation summary (chat compaction):"));
		assert.deepStrictEqual(logs, ["chat.compaction.deepseek_failed"]);
	});

	test("createChatSummarizer never calls DeepSeek without a key", async () => {
		const plan = planForSummarizer();
		const source = new vscode.CancellationTokenSource();
		let requested = false;
		const summarize = createChatSummarizer({
			apiKey: async () => undefined,
			userAgent: "test-agent",
			request: async () => {
				requested = true;
				return { content: "unused", inputChars: 0 };
			},
		});
		const result = await summarize(plan, source.token);
		source.dispose();

		assert.strictEqual(result.method, "extractive");
		assert.strictEqual(requested, false);
	});

	test("createChatSummarizer reports cancellation instead of falling back", async () => {
		const plan = planForSummarizer();
		const source = new vscode.CancellationTokenSource();
		source.cancel();
		const summarize = createChatSummarizer({
			apiKey: async () => "sk-test",
			userAgent: "test-agent",
			request: async () => { throw new Error("deepseek was cancelled"); },
		});
		await assert.rejects(summarize(plan, source.token), (error: unknown) => error instanceof vscode.CancellationError);
		source.dispose();
	});

	test("compactChatHistory returns a part for a history over the trigger", async () => {
		const history = equalCostHistory();
		const costs = history.map(estimateChatMessageTokens);
		const total = costs.reduce((sum, cost) => sum + cost, 0);
		const limits: ChatCompactionLimits = { triggerTokens: total - 1, targetTokens: 18_200, fixedTokens: 100 };
		const plan = planChatCompaction(history, limits);
		assert.ok(plan);
		const source = new vscode.CancellationTokenSource();
		let calls = 0;
		const part = await compactChatHistory(history, {
			limits,
			token: source.token,
			summarize: async () => {
				calls += 1;
				return { summary: "CHAT SUMMARY", method: "extractive" };
			},
		});
		source.dispose();

		assert.strictEqual(calls, 1);
		assert.ok(part);
		assert.strictEqual(part.keepFromMessageId, history[plan.keepFrom].id);
		assert.strictEqual(part.summary, "CHAT SUMMARY");
		assert.strictEqual(part.method, "extractive");
		assert.strictEqual(part.summarizedMessages, plan.summarizedMessages);
		assert.strictEqual(part.tokensBefore, plan.tokensBefore);
		assert.ok(part.tokensAfter < part.tokensBefore);
	});

	test("compactChatHistory skips a history under the trigger", async () => {
		const source = new vscode.CancellationTokenSource();
		let calls = 0;
		const part = await compactChatHistory(equalCostHistory(), {
			limits: { triggerTokens: 1_000_000, targetTokens: 18_200 },
			token: source.token,
			summarize: async () => {
				calls += 1;
				return { summary: "unused", method: "extractive" };
			},
		});
		source.dispose();

		assert.strictEqual(part, undefined);
		assert.strictEqual(calls, 0);
	});
});
