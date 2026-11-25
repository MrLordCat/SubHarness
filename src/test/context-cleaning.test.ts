import * as assert from "node:assert";
import * as vscode from "vscode";
import { cleaningPaysOff, estimateRequestTokens, findStaleToolResults, LARGE_RESULT_CHARS, planContextCleaning, resolveChatContextBudget, staleOnlyCompaction, STALE_RESULT_MIN_CHARS } from "../chat/context-cleaning";
import { estimateChatMessageTokens, compactChatHistory } from "../chat/compaction";
import { historyResetPending, staleToolResultText, toLanguageModelMessages, type ChatCompactionPart } from "../chat/lm-messages";
import type { ChatMessage, ChatPart } from "../chat/shared/protocol";
import { isHistoryReset, isProviderSwitch } from "../providers/provider-switch";

let seq = 0;
function msg(role: ChatMessage["role"], parts: ChatPart[], extra: Partial<ChatMessage> = {}): ChatMessage {
	return { id: `m${++seq}`, role, turn: 1, createdAt: 0, parts, ...extra };
}
function user(extra: Partial<ChatMessage> = {}): ChatMessage {
	return msg("user", [{ kind: "text", text: "next" }], extra);
}
function use(id: string, name: string, input: object = {}, size = STALE_RESULT_MIN_CHARS): ChatMessage {
	return msg("assistant", [{ kind: "toolCall", callId: id, name, input }, { kind: "toolResult", callId: id, text: "x".repeat(size) }]);
}
function part(first: ChatMessage, extra: Partial<ChatCompactionPart> = {}): ChatCompactionPart {
	return { kind: "compaction", method: "none", summary: "", keepFromMessageId: first.id, summarizedMessages: 0, tokensBefore: 100, tokensAfter: 50, ...extra };
}

suite("context cleaning", () => {
	test("file writes and covering reads supersede reads, but narrower reads do not", () => {
		const old = use("old", "read_file", { filePath: "a.ts", startLine: 10, endLine: 20 });
		for (const later of [use("write", "replace_string_in_file", { filePath: "a.ts" }), use("cover", "read_file", { filePath: "a.ts", startLine: 1, endLine: 30 })]) {
			assert.ok(findStaleToolResults([user(), old, user(), later]).has("old"));
		}
		assert.ok(!findStaleToolResults([user(), old, user(), use("narrow", "read_file", { filePath: "a.ts", startLine: 11, endLine: 19 })]).has("old"));
	});
	test("repeated terminal commands and old lookups become stale, but short results and current results stay", () => {
		const history = [user(), use("same", "run_in_terminal", { command: "npm test" }), use("different", "run_in_terminal", { command: "npm lint" }), use("grep", "grep_search"), use("short", "grep_search", {}, STALE_RESULT_MIN_CHARS - 1), user(), use("new", "grep_search"), use("repeat", "run_in_terminal", { command: "npm test" })];
		assert.deepStrictEqual([...findStaleToolResults(history)], ["same", "grep"]);
	});
	test("protected tools stay and large unknown results age by real requests", () => {
		const protectedUses = ["subagent", "manage_todo_list", "ask_questions", "search_memory"].map((name, i) => use(`p${i}`, name, {}, LARGE_RESULT_CHARS));
		const old = use("unknown", "unknown", {}, LARGE_RESULT_CHARS);
		const continuation = user({ continuation: {} });
		assert.deepStrictEqual([...findStaleToolResults([user(), ...protectedUses, old, user(), continuation])], []);
		assert.deepStrictEqual([...findStaleToolResults([user(), ...protectedUses, old, user(), continuation, user()])], ["unknown"]);
	});
	test("budget settings clamp and reject invalid values", () => {
		for (const [value, expected] of [[0, 0], [-1, 0], [1000, 64000], [300000, 300000], [5e6, 1048576], [NaN, 200000], ["garbage", 200000]] as const) {
			const config = { get: () => value } as unknown as Pick<vscode.WorkspaceConfiguration, "get">;
			assert.strictEqual(resolveChatContextBudget(config), expected);
		}
	});
	test("planning respects boundaries and reported scale", () => {
		const answer = use("old", "grep_search", {}, 20000);
		const newest = user();
		const history = [user(), answer, newest];
		assert.strictEqual(planContextCleaning(history, { budgetTokens: 100000, fixedTokens: 0 }), undefined);
		assert.strictEqual(planContextCleaning([...history, user({ continuation: {} })], { budgetTokens: 10, fixedTokens: 0 }), undefined);
		assert.strictEqual(planContextCleaning([user(), answer], { budgetTokens: 10, fixedTokens: 0 }), undefined);
		const previous = estimateRequestTokens(history, 0) - estimateChatMessageTokens(newest);
		answer.usage = { promptTokens: previous * 0.8 };
		const plan = planContextCleaning(history, { budgetTokens: 100, fixedTokens: 0 });
		assert.ok(plan);
		assert.ok(Math.abs(plan.scale - 0.8) < 0.00001);
		assert.strictEqual(plan.targetTokens, Math.floor(100 * 0.6 / plan.scale));
		assert.ok(plan.tokensAfterStubs < plan.tokensBefore);
		answer.usage = { promptTokens: 1 };
		assert.strictEqual(planContextCleaning(history, { budgetTokens: 3000, fixedTokens: 0 }), undefined);
	});
	test("the target stays within what a new session replays", () => {
		const history = [user(), use("old", "grep_search", {}, 20000), user()];
		const open = planContextCleaning(history, { budgetTokens: 100, fixedTokens: 0 });
		const capped = planContextCleaning(history, { budgetTokens: 100, fixedTokens: 0, replayTokens: 7 });
		assert.ok(open && capped);
		assert.ok(open.targetTokens > 7);
		assert.strictEqual(capped.targetTokens, 7);
		assert.deepStrictEqual(capped.freshResults, ["old"]);
	});
	test("plans only new stale results and retains earlier stubs", () => {
		const first = user(), old = use("old", "grep_search", {}, 20000), fresh = use("fresh", "grep_search", {}, 20000);
		const marker = msg("assistant", [part(first, { staleResults: ["old"] })]);
		const history = [first, old, user(), fresh, marker, user()];
		const plan = planContextCleaning(history, { budgetTokens: 100, fixedTokens: 0 });
		assert.ok(plan);
		assert.deepStrictEqual(plan.staleResults, ["old", "fresh"]);
		assert.strictEqual(plan.newStale, 1);
		assert.ok(plan.tokensAfterStubs < plan.tokensBefore);
		const cleaned = staleOnlyCompaction(history, plan);
		assert.ok(cleaned);
		assert.deepStrictEqual(cleaned.staleResults, ["old", "fresh"]);
		assert.strictEqual(cleaned.cleaning?.summary, false);
	});
	test("stale-only compaction creates or preserves summary and window", () => {
		const first = user(), old = use("old", "grep_search", {}, 20000), last = user();
		const history = [first, old, last];
		const plan = planContextCleaning(history, { budgetTokens: 100, fixedTokens: 0 });
		assert.ok(plan);
		const plain = staleOnlyCompaction(history, plan);
		assert.ok(plain);
		assert.strictEqual(plain.method, "none");
		assert.strictEqual(plain.summary, "");
		assert.strictEqual(plain.keepFromMessageId, first.id);
		assert.strictEqual(plain.cleaning?.summary, false);
		const active = part(first, { method: "extractive", summary: "summary", staleResults: ["obsolete"] });
		const next = staleOnlyCompaction([...history, msg("assistant", [active])], plan);
		assert.ok(next);
		assert.strictEqual(next.summary, "summary");
		assert.strictEqual(next.method, "extractive");
		assert.strictEqual(next.keepFromMessageId, first.id);
		assert.deepStrictEqual(next.staleResults, plan.staleResults);
		assert.strictEqual(next.tokensBefore, Math.round(plan.tokensBefore * plan.scale));
	});
	test("saving boundary is ten percent", () => {
		const first = user();
		assert.strictEqual(cleaningPaysOff(part(first, { tokensBefore: 100, tokensAfter: 91 }), 100), false);
		assert.strictEqual(cleaningPaysOff(part(first, { tokensBefore: 100, tokensAfter: 90 }), 100), true);
	});
	test("stubs are deterministic and preserve only 200 characters of the first nonempty line", () => {
		const input = "\n  " + "a".repeat(201) + "\nsecond";
		const output = staleToolResultText(input);
		assert.strictEqual(output, staleToolResultText(input));
		assert.ok(output.includes("a".repeat(200) + "…"));
		assert.ok(!output.includes("a".repeat(201)));
		assert.ok(!output.includes("second"));
	});
	test("rendering removes stale images and only emits real summaries", () => {
		const first = user();
		const result = use("old", "read_file");
		const resultPart = result.parts[1];
		assert.ok(resultPart.kind === "toolResult");
		resultPart.images = [{ mimeType: "image/png", data: "AA==", byteLength: 1 }];
		const marker = msg("assistant", [part(first, { staleResults: ["old"] })]);
		const rendered = toLanguageModelMessages([first, result, marker], { imageInput: true });
		const tool = rendered.flatMap(m => m.content).find(p => p instanceof vscode.LanguageModelToolResultPart);
		assert.ok(tool instanceof vscode.LanguageModelToolResultPart);
		assert.strictEqual(tool.content.length, 1);
		assert.strictEqual((tool.content[0] as vscode.LanguageModelTextPart).value, staleToolResultText(resultPart.text));
		assert.strictEqual((rendered[0].content[0] as vscode.LanguageModelTextPart).value, "next");
		marker.parts = [part(first, { method: "extractive", summary: "SUMMARY" })];
		assert.match((toLanguageModelMessages([first, result, marker])[0].content[0] as vscode.LanguageModelTextPart).value, /SUMMARY/);
	});
	test("reset stays pending through users and notices until an assistant answers", () => {
		const first = user(), marker = msg("assistant", [part(first)]);
		assert.strictEqual(historyResetPending([first]), false);
		assert.strictEqual(historyResetPending([first, marker]), true);
		assert.strictEqual(historyResetPending([first, marker, user(), msg("assistant", [{ kind: "notice", level: "error", text: "error" }])]), true);
		assert.strictEqual(historyResetPending([first, marker, msg("assistant", [{ kind: "text", text: "ok" }])]), false);
		assert.strictEqual(historyResetPending([first, marker, msg("assistant", [{ kind: "toolCall", callId: "c", name: "x", input: {} }])]), false);
	});
	test("compaction keeps stale IDs only for retained messages", async () => {
		const history = [user(), use("dropped", "grep_search"), user(), use("kept", "grep_search")];
		const result = await compactChatHistory(history, {
			limits: { triggerTokens: 1, targetTokens: 1 }, token: new vscode.CancellationTokenSource().token,
			plan: { keepFrom: 2, dropped: history.slice(0, 2), summarizedMessages: 2, tokensBefore: 100, keptTokens: 10 },
			staleResults: ["dropped", "kept", "missing"], summarize: async () => ({ summary: "s", method: "extractive" }),
		});
		assert.deepStrictEqual(result?.staleResults, ["kept"]);
	});
	test("provider reset accepts only boolean true", () => {
		assert.strictEqual(isProviderSwitch({ _aabHistoryReset: true }), true);
		assert.strictEqual(isProviderSwitch({ _aabHistoryReset: "x" }), false);
		assert.strictEqual(isHistoryReset({ _aabHistoryReset: true }), true);
		assert.strictEqual(isHistoryReset({ _aabHistoryReset: "x" }), false);
	});
});
