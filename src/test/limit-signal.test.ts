import * as assert from "node:assert";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import * as vscode from "vscode";
import { CompositeChatModelProvider } from "../composite-provider";
import { ConversationHistory } from "../providers/conversation-history";
import {
	isLimitSignalPart,
	LIMIT_SIGNAL_MIME,
	LIMIT_SIGNAL_OPTION,
	limitSignalPart,
	parseLimitSignal,
	reportBalanceNotice,
	reportLimitNotice,
	type LimitSignal,
} from "../providers/limit-signal";

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

suite("Limit signals", () => {
	test("round-trips a signal through a data part", () => {
		const signal: LimitSignal = { kind: "limit", provider: "Codex", text: "Codex 5-hour limit reached.", window: "5-hour", resetAt: 1_700_000_000_000 };
		const part = limitSignalPart(signal);
		assert.strictEqual(part.mimeType, LIMIT_SIGNAL_MIME);
		assert.ok(isLimitSignalPart(part));
		assert.deepStrictEqual(parseLimitSignal(part), signal);
		const balance: LimitSignal = { kind: "balance", provider: "DeepSeek", text: "DeepSeek balance is empty." };
		assert.deepStrictEqual(parseLimitSignal(limitSignalPart(balance)), balance);
	});

	test("rejects malformed payloads and a foreign mime type", () => {
		assert.strictEqual(parseLimitSignal(undefined), undefined);
		assert.strictEqual(parseLimitSignal(dataPart("application/json", JSON.stringify({ kind: "limit", provider: "Codex", text: "x" }))), undefined);
		assert.strictEqual(parseLimitSignal(dataPart(LIMIT_SIGNAL_MIME, "{ not json")), undefined);
		assert.strictEqual(parseLimitSignal(dataPart(LIMIT_SIGNAL_MIME, "[]")), undefined);
		assert.strictEqual(parseLimitSignal(dataPart(LIMIT_SIGNAL_MIME, "null")), undefined);
		assert.strictEqual(parseLimitSignal(dataPart(LIMIT_SIGNAL_MIME, JSON.stringify({ kind: "other", provider: "Codex", text: "x" }))), undefined);
		assert.strictEqual(parseLimitSignal(dataPart(LIMIT_SIGNAL_MIME, JSON.stringify({ kind: "limit", provider: 5, text: "x" }))), undefined);
		assert.strictEqual(parseLimitSignal(dataPart(LIMIT_SIGNAL_MIME, JSON.stringify({ kind: "limit", provider: "Codex", text: 5 }))), undefined);
		assert.deepStrictEqual(
			parseLimitSignal(dataPart(LIMIT_SIGNAL_MIME, JSON.stringify({ kind: "limit", provider: "Codex", text: "x", window: 5, resetAt: "later" }))),
			{ kind: "limit", provider: "Codex", text: "x" },
			"optional fields of the wrong type are dropped",
		);
	});

	test("reports a limit as a signal part followed by the same text", () => {
		const { parts, progress } = recorder();
		reportLimitNotice(progress, "codex", { provider: "codex", window: "5-hour", resetAt: new Date(1_700_000_000_000), reason: "usage limit" });
		assert.strictEqual(parts.length, 2);
		assert.ok(isLimitSignalPart(parts[0]));
		const signal = parseLimitSignal(parts[0]);
		assert.ok(signal);
		assert.strictEqual(signal.kind, "limit");
		assert.strictEqual(signal.provider, "Codex");
		assert.strictEqual(signal.window, "5-hour");
		assert.strictEqual(signal.resetAt, 1_700_000_000_000);
		const text = parts[1];
		assert.ok(text instanceof vscode.LanguageModelTextPart);
		assert.strictEqual(text.value, signal.text);
	});

	test("reports an empty balance as a signal part followed by the same text", () => {
		const { parts, progress } = recorder();
		reportBalanceNotice(progress, { providerLabel: "DeepSeek", status: 402, detail: "Insufficient Balance" });
		assert.strictEqual(parts.length, 2);
		assert.ok(isLimitSignalPart(parts[0]));
		const signal = parseLimitSignal(parts[0]);
		assert.ok(signal);
		assert.strictEqual(signal.kind, "balance");
		assert.strictEqual(signal.provider, "DeepSeek");
		const text = parts[1];
		assert.ok(text instanceof vscode.LanguageModelTextPart);
		assert.strictEqual(text.value, signal.text);
	});

	test("forwards a provider signal only to a caller that asked for it", async () => {
		const root = await fs.mkdtemp(path.join(os.tmpdir(), "limit-signal-composite-"));
		const composite = new CompositeChatModelProvider({
			history: new ConversationHistory(root),
			providers: [{
				id: "codex",
				ownsModel: id => id.startsWith("codex::"),
				provider: {
					provideLanguageModelChatInformation: async () => [],
					provideTokenCount: async () => 1,
					provideLanguageModelChatResponse: async (_model, _messages, _options, progress) => {
						reportLimitNotice(progress, "codex", undefined, "Codex limit reached.");
					},
				},
			}],
		});
		try {
			const wanted = recorder();
			await composite.provideLanguageModelChatResponse(
				model("codex::gpt"),
				[],
				{ toolMode: vscode.LanguageModelChatToolMode.Auto, modelOptions: { _conversationId: "limit-signal-wanted", [LIMIT_SIGNAL_OPTION]: true } },
				wanted.progress,
				none,
			);
			assert.strictEqual(wanted.parts.length, 2);
			assert.ok(isLimitSignalPart(wanted.parts[0]));
			assert.strictEqual(parseLimitSignal(wanted.parts[0])?.text, "Codex limit reached.");
			const wantedText = wanted.parts[1];
			assert.ok(wantedText instanceof vscode.LanguageModelTextPart);
			assert.strictEqual(wantedText.value, "Codex limit reached.");

			const dropped = recorder();
			await composite.provideLanguageModelChatResponse(
				model("codex::gpt"),
				[],
				{ toolMode: vscode.LanguageModelChatToolMode.Auto, modelOptions: { _conversationId: "limit-signal-dropped" } },
				dropped.progress,
				none,
			);
			assert.strictEqual(dropped.parts.length, 1);
			const droppedText = dropped.parts[0];
			assert.ok(droppedText instanceof vscode.LanguageModelTextPart);
			assert.strictEqual(droppedText.value, "Codex limit reached.");
		} finally {
			composite.dispose();
			await fs.rm(root, { recursive: true, force: true });
		}
	});

	test("turns an escaped limit error into a signal and text instead of failing", async () => {
		const root = await fs.mkdtemp(path.join(os.tmpdir(), "limit-signal-thrown-"));
		const composite = new CompositeChatModelProvider({
			history: new ConversationHistory(root),
			providers: [{
				id: "codex",
				ownsModel: id => id.startsWith("codex::"),
				provider: {
					provideLanguageModelChatInformation: async () => [],
					provideTokenCount: async () => 1,
					provideLanguageModelChatResponse: async () => {
						throw new Error("You've hit your usage limit. Try again at 2:32 PM.");
					},
				},
			}],
		});
		try {
			const { parts, progress } = recorder();
			await composite.provideLanguageModelChatResponse(
				model("codex::gpt"),
				[],
				{ toolMode: vscode.LanguageModelChatToolMode.Auto, modelOptions: { _conversationId: "limit-signal-thrown", [LIMIT_SIGNAL_OPTION]: true } },
				progress,
				none,
			);
			assert.strictEqual(parts.length, 2);
			assert.ok(isLimitSignalPart(parts[0]));
			const signal = parseLimitSignal(parts[0]);
			assert.ok(signal);
			assert.strictEqual(signal.kind, "limit");
			assert.strictEqual(signal.provider, "Codex");
			const text = parts[1];
			assert.ok(text instanceof vscode.LanguageModelTextPart);
			assert.strictEqual(text.value, signal.text);
			assert.match(text.value, /^Codex limit reached/);
		} finally {
			composite.dispose();
			await fs.rm(root, { recursive: true, force: true });
		}
	});

	test("abandons a conversation in every registration even when one throws", async () => {
		const root = await fs.mkdtemp(path.join(os.tmpdir(), "limit-signal-abandon-"));
		const calls: string[] = [];
		const adapter = (): vscode.LanguageModelChatProvider => ({
			provideLanguageModelChatInformation: async () => [],
			provideLanguageModelChatResponse: async () => undefined,
			provideTokenCount: async () => 1,
		});
		const composite = new CompositeChatModelProvider({
			history: new ConversationHistory(root),
			providers: [
				{ id: "first", ownsModel: () => false, provider: adapter(), abandonConversation: id => { calls.push(`first:${id}`); } },
				{ id: "second", ownsModel: () => false, provider: adapter(), abandonConversation: () => { throw new Error("cannot abandon"); } },
				{ id: "third", ownsModel: () => false, provider: adapter(), abandonConversation: async id => { calls.push(`third:${id}`); } },
			],
		});
		try {
			await composite.abandonConversation("chat-1");
			assert.deepStrictEqual(calls, ["first:chat-1", "third:chat-1"]);
		} finally {
			composite.dispose();
			await fs.rm(root, { recursive: true, force: true });
		}
	});
});
