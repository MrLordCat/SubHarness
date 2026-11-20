import * as assert from "node:assert";
import * as vscode from "vscode";
import { CompositeChatModelProvider } from "../composite-provider";
import {
	isPromptCacheSignalPart,
	parsePromptCacheSignal,
	PROMPT_CACHE_MIME,
	PROMPT_CACHE_OPTION,
	promptCacheSignalPart,
	type PromptCacheSignal,
} from "../providers/prompt-cache-signal";

const none: vscode.CancellationToken = {
	isCancellationRequested: false,
	onCancellationRequested: () => new vscode.Disposable(() => undefined),
};
const model = (id: string) => ({ id, name: id, family: "fixture", version: "1", maxInputTokens: 100_000, maxOutputTokens: 8_192, capabilities: {} });

function dataPart(mimeType: string, value: string): vscode.LanguageModelDataPart {
	return new vscode.LanguageModelDataPart(new TextEncoder().encode(value), mimeType);
}

function recorder(): { parts: vscode.LanguageModelResponsePart[]; progress: vscode.Progress<vscode.LanguageModelResponsePart> } {
	const parts: vscode.LanguageModelResponsePart[] = [];
	return { parts, progress: { report: part => parts.push(part) } };
}

suite("Prompt cache signals", () => {
	test("round-trips counters through a data part", () => {
		const signal: PromptCacheSignal = { promptTokens: 180, cachedTokens: 100, cacheWriteTokens: 10, completionTokens: 20, requests: 1 };
		const part = promptCacheSignalPart(signal);
		assert.strictEqual(part.mimeType, PROMPT_CACHE_MIME);
		assert.ok(isPromptCacheSignalPart(part));
		assert.deepStrictEqual(parsePromptCacheSignal(part), signal);
		assert.deepStrictEqual(
			parsePromptCacheSignal(promptCacheSignalPart({ promptTokens: 5, completionTokens: 1, requests: 2 })),
			{ promptTokens: 5, completionTokens: 1, requests: 2 },
		);
	});

	test("rejects malformed payloads and a foreign mime type", () => {
		assert.strictEqual(parsePromptCacheSignal(undefined), undefined);
		assert.strictEqual(parsePromptCacheSignal(dataPart("application/json", JSON.stringify({ promptTokens: 1, completionTokens: 1, requests: 1 }))), undefined);
		assert.strictEqual(parsePromptCacheSignal(dataPart(PROMPT_CACHE_MIME, "{ not json")), undefined);
		assert.strictEqual(parsePromptCacheSignal(dataPart(PROMPT_CACHE_MIME, "[]")), undefined);
		assert.strictEqual(parsePromptCacheSignal(dataPart(PROMPT_CACHE_MIME, "null")), undefined);
		assert.strictEqual(parsePromptCacheSignal(dataPart(PROMPT_CACHE_MIME, JSON.stringify({ completionTokens: 1, requests: 1 }))), undefined);
		assert.strictEqual(parsePromptCacheSignal(dataPart(PROMPT_CACHE_MIME, JSON.stringify({ promptTokens: -1, completionTokens: 1, requests: 1 }))), undefined);
		assert.strictEqual(parsePromptCacheSignal(dataPart(PROMPT_CACHE_MIME, JSON.stringify({ promptTokens: 1.5, completionTokens: 1, requests: 1 }))), undefined);
		assert.strictEqual(parsePromptCacheSignal(dataPart(PROMPT_CACHE_MIME, JSON.stringify({ promptTokens: 1, completionTokens: 1, requests: 0 }))), undefined);
		assert.strictEqual(parsePromptCacheSignal(dataPart(PROMPT_CACHE_MIME, JSON.stringify({ promptTokens: 1, completionTokens: 1, requests: 1, cachedTokens: "many" }))), undefined);
		assert.strictEqual(parsePromptCacheSignal(dataPart(PROMPT_CACHE_MIME, JSON.stringify({ promptTokens: 1, completionTokens: 1, requests: 1, cacheWriteTokens: -2 }))), undefined);
	});

	test("forwards the part only to a caller that asked for it", async () => {
		const signal: PromptCacheSignal = { promptTokens: 900, cachedTokens: 700, completionTokens: 50, requests: 1 };
		const composite = new CompositeChatModelProvider([{
			id: "coco",
			ownsModel: id => id.startsWith("coco::"),
			provider: {
				provideLanguageModelChatInformation: async () => [],
				provideTokenCount: async () => 1,
				provideLanguageModelChatResponse: async (_model, _messages, _options, progress) => {
					progress.report(new vscode.LanguageModelTextPart("Before."));
					progress.report(promptCacheSignalPart(signal));
					progress.report(new vscode.LanguageModelTextPart("After."));
				},
			},
		}]);
		try {
			const wanted = recorder();
			await composite.provideLanguageModelChatResponse(
				model("coco::auto"),
				[],
				{ toolMode: vscode.LanguageModelChatToolMode.Auto, modelOptions: { _conversationId: "prompt-cache-wanted", [PROMPT_CACHE_OPTION]: true } },
				wanted.progress,
				none,
			);
			assert.strictEqual(wanted.parts.length, 3);
			assert.deepStrictEqual(parsePromptCacheSignal(wanted.parts[1]), signal);
			assert.deepStrictEqual(wanted.parts.map(part => part instanceof vscode.LanguageModelTextPart ? part.value : "data"), ["Before.", "data", "After."]);

			const dropped = recorder();
			await composite.provideLanguageModelChatResponse(
				model("coco::auto"),
				[],
				{ toolMode: vscode.LanguageModelChatToolMode.Auto, modelOptions: { _conversationId: "prompt-cache-dropped" } },
				dropped.progress,
				none,
			);
			assert.deepStrictEqual(dropped.parts.map(part => part instanceof vscode.LanguageModelTextPart ? part.value : "data"), ["Before.", "After."]);
		} finally {
			composite.dispose();
		}
	});
});
