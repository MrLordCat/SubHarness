import * as assert from "node:assert";
import { estimateSharedTextTokens as t } from "../context/provider-handoff";
import { staleArgumentText, staleToolResultText } from "../chat/lm-messages";
import { chatRequestBreakdown, CHAT_REQUEST_BREAKDOWN_KEYS, estimateRequestBreakdown } from "../chat/request-breakdown";
import type { ChatMessage, ChatPart } from "../chat/shared/protocol";

const IMAGE = { mimeType: "image/png", data: "AA==", byteLength: 1 };
const TOOLS = [{ name: "read_file", description: "Reads a file", inputSchema: { type: "object" } }];

function history(): ChatMessage[] {
	const long = "y".repeat(2_000);
	const first: ChatMessage = {
		id: "u1", role: "user", turn: 1, createdAt: 0, parts: [{ kind: "text", text: "first request" }],
		memoryContext: "<memory>\nShared memory.\nEntry.\n</memory>", hostContext: "<context>today</context>",
	};
	const answer: ChatMessage = { id: "a1", role: "assistant", turn: 1, createdAt: 0, parts: [
		{ kind: "thinking", text: "never sent to the model" },
		{ kind: "text", text: "Looking." },
		{ kind: "toolCall", callId: "edit", name: "create_file", input: { filePath: "a.ts", content: long } },
		{ kind: "toolResult", callId: "edit", text: "Created a.ts." },
		{ kind: "toolCall", callId: "grep", name: "grep_search", input: { query: "x" } },
		{ kind: "toolResult", callId: "grep", text: "z".repeat(3_000), images: [IMAGE] },
		{ kind: "toolCall", callId: "shot", name: "view_image", input: { filePath: "b.png" } },
		{ kind: "toolResult", callId: "shot", text: "Image", images: [IMAGE] },
	] };
	const next: ChatMessage = { id: "u2", role: "user", turn: 2, createdAt: 0, parts: [{ kind: "text", text: "next" }] };
	const cleaning: ChatPart = {
		kind: "compaction", method: "extractive", summary: "SUMMARY", keepFromMessageId: "u1", summarizedMessages: 3,
		tokensBefore: 0, tokensAfter: 0, staleResults: ["grep"], staleArguments: ["edit"],
	};
	return [first, answer, next, { id: "a2", role: "assistant", turn: 2, createdAt: 0, parts: [cleaning] }];
}

suite("chat request breakdown", () => {
	test("splits a request by kind of content as the model receives it after cleaning", () => {
		const { tokens, messages, stubbedResults, shortenedArguments } = estimateRequestBreakdown(history(), "SYSTEM", TOOLS);
		assert.strictEqual(tokens.system, t("SYSTEM"));
		assert.strictEqual(tokens.tools, t("read_file\nReads a file\n{\"type\":\"object\"}"));
		assert.ok(tokens.summary > t("SUMMARY"), "the summary counts as the model receives it, with its frame");
		assert.strictEqual(tokens.memory, t("<memory>\nShared memory.\nEntry.\n</memory>"));
		assert.strictEqual(tokens.requests, t("first request") + t("<context>today</context>") + t("next"));
		assert.strictEqual(tokens.answers, t("Looking."), "thinking is not sent, so it does not count");
		assert.strictEqual(tokens.toolArguments,
			t(JSON.stringify({ filePath: "a.ts", content: staleArgumentText("y".repeat(2_000)) })) + t(JSON.stringify({ query: "x" })) + t(JSON.stringify({ filePath: "b.png" })));
		assert.strictEqual(tokens.toolResults, t("Created a.ts.") + t(staleToolResultText("z".repeat(3_000))) + t("Image"));
		assert.strictEqual(tokens.images, 4_096, "the stub drops its image; the kept result keeps one");
		assert.deepStrictEqual({ messages, stubbedResults, shortenedArguments }, { messages: 4, stubbedResults: 1, shortenedArguments: 1 });
	});

	test("converts the estimate to provider tokens and records what it is for", () => {
		const estimate = estimateRequestBreakdown(history(), "SYSTEM", TOOLS).tokens;
		const event = chatRequestBreakdown(history(), "SYSTEM", TOOLS, { conversationId: "chat-1", modelId: "deepseek::flash", at: 42, scale: 0.8 });
		let total = 0;
		for (const key of CHAT_REQUEST_BREAKDOWN_KEYS) {
			assert.strictEqual(event.tokens[key], Math.round(estimate[key] * 0.8), key);
			total += event.tokens[key];
		}
		assert.strictEqual(event.total, total);
		assert.deepStrictEqual({ conversationId: event.conversationId, modelId: event.modelId, at: event.at, scale: event.scale }, { conversationId: "chat-1", modelId: "deepseek::flash", at: 42, scale: 0.8 });
		// Without a report the chat's default ratio applies.
		assert.strictEqual(chatRequestBreakdown(history(), "SYSTEM", TOOLS, { conversationId: "c", modelId: "m" }).scale, 0.5);
	});
});
