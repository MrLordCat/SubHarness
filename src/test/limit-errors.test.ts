import * as assert from "node:assert";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import * as vscode from "vscode";
import { CompositeChatModelProvider } from "../composite-provider";
import { ConversationHistory } from "../providers/conversation-history";
import {
	detectLimitError,
	formatLimitNotice,
	formatResetClock,
	formatWait,
	LimitGate,
	parseResetTime,
	SubscriptionLimitError,
} from "../providers/limit-errors";

const none: vscode.CancellationToken = {
	isCancellationRequested: false,
	onCancellationRequested: () => new vscode.Disposable(() => undefined),
};
const model = (id: string) => ({ id, name: id, family: "fixture", version: "1", maxInputTokens: 100_000, maxOutputTokens: 8_192, capabilities: {} });

suite("Subscription limit errors", () => {
	const reference = new Date("2026-11-01T10:00:00.000Z");
	const fixed = new Date("2026-11-25T10:00:00.000Z");

	test("recognizes the Claude 5-hour window and its reset time", () => {
		const match = detectLimitError(new Error("Claude API error: You've hit your 5-hour limit · resets 4pm (Europe/Tallinn)"), undefined, reference);
		assert.ok(match);
		assert.strictEqual(match.provider, "claude");
		assert.strictEqual(match.window, "5-hour");
		assert.strictEqual(match.timeZone, "Europe/Tallinn");
		assert.ok(match.resetAt);
		assert.strictEqual(match.resetAt.toISOString(), "2026-11-01T14:00:00.000Z",
			"16:00 in Tallinn (UTC+2 in November) on the same day");
	});

	test("reads a dated Claude reset instead of a clock time", () => {
		const weekly = detectLimitError(new Error("You've hit your weekly limit · resets Nov 28, 4pm (Europe/Tallinn)"), undefined, fixed);
		assert.ok(weekly);
		assert.strictEqual(weekly.provider, "claude");
		assert.strictEqual(weekly.window, "weekly");
		assert.strictEqual(weekly.timeZone, "Europe/Tallinn");
		assert.strictEqual(weekly.resetAt?.toISOString(), "2026-11-28T14:00:00.000Z",
			"16:00 in Tallinn, not 04:00 today and not 28:00");
		const opus = detectLimitError(new Error("You've hit your Opus limit · resets Nov 28, 4:30pm (Europe/Tallinn)"), undefined, fixed);
		assert.strictEqual(opus?.window, "weekly");
		assert.strictEqual(opus?.resetAt?.toISOString(), "2026-11-28T14:30:00.000Z");
		assert.strictEqual(detectLimitError(new Error("You've hit your Sonnet limit · resets Nov 28, 4pm (Europe/Tallinn)"), undefined, fixed)?.window, "weekly");
		assert.strictEqual(detectLimitError(new Error("You've hit your Fable 5 limit · resets Nov 28, 4pm (Europe/Tallinn)"), undefined, fixed)?.window, "weekly");
	});

	test("a Claude session limit is the 5-hour window", () => {
		const match = detectLimitError(new Error("You've hit your session limit · resets 6pm (Europe/Tallinn)"), undefined, fixed);
		assert.strictEqual(match?.window, "5-hour");
		assert.strictEqual(match?.resetAt?.toISOString(), "2026-11-25T16:00:00.000Z");
	});

	test("a dated reset without a year uses the year that keeps it current", () => {
		const explicit = parseResetTime("resets Jan 2, 2027, 4pm (Europe/Tallinn)", fixed);
		assert.strictEqual(explicit?.at.toISOString(), "2027-01-02T14:00:00.000Z");
		const sameYear = parseResetTime("resets Nov 28, 4pm (Europe/Tallinn)", fixed);
		assert.strictEqual(sameYear?.at.toISOString(), "2026-11-28T14:00:00.000Z");
		const rollover = parseResetTime("resets Jan 2, 4pm (Europe/Tallinn)", new Date("2026-12-30T10:00:00.000Z"));
		assert.strictEqual(rollover?.at.toISOString(), "2027-01-02T14:00:00.000Z", "December sees January in the next year");
		const recent = parseResetTime("resets Nov 28, 4pm (Europe/Tallinn)", new Date("2026-11-29T10:00:00.000Z"));
		assert.strictEqual(recent?.at.toISOString(), "2026-11-28T14:00:00.000Z", "less than a day past keeps the current year");
		const past = parseResetTime("resets Nov 28, 4pm (Europe/Tallinn)", new Date("2026-11-30T10:00:00.000Z"));
		assert.strictEqual(past?.at.toISOString(), "2027-11-28T14:00:00.000Z", "more than a day past means next year");
	});

	test("reads the Codex month-day form as local time", () => {
		const match = detectLimitError(new Error(
			"You've hit your usage limit. Upgrade to Pro (https://chatgpt.com/explore/pro), visit https://chatgpt.com/settings/usage to purchase more credits or try again at Nov 28th, 2026 4:12 PM."),
			undefined, fixed);
		assert.ok(match);
		assert.strictEqual(match.provider, "codex");
		assert.strictEqual(match.timeZone, undefined, "Codex reports local time");
		assert.ok(match.resetAt);
		assert.strictEqual(match.resetAt.getFullYear(), 2026);
		assert.strictEqual(match.resetAt.getMonth(), 10, "November");
		assert.strictEqual(match.resetAt.getDate(), 28);
		assert.strictEqual(match.resetAt.getHours(), 16);
		assert.strictEqual(match.resetAt.getMinutes(), 12);
	});

	test("formats multi-day waits and resets with their date", () => {
		assert.strictEqual(formatWait(new Date(fixed.getTime() + (2 * 24 + 5) * 3_600_000), fixed), "2 d 5 h");
		assert.strictEqual(formatWait(new Date(fixed.getTime() + 3 * 24 * 3_600_000), fixed), "3 d");
		assert.strictEqual(formatWait(new Date(fixed.getTime() + 25 * 3_600_000), fixed), "1 d 1 h");
		assert.strictEqual(formatWait(new Date(fixed.getTime() + 45 * 60_000), fixed), "45 min", "under a day is unchanged");
		assert.strictEqual(formatWait(new Date(fixed.getTime() + (3 * 60 + 37) * 60_000), fixed), "3 h 37 min");
		const reset = { resetAt: new Date("2026-11-28T14:00:00.000Z"), timeZone: "Europe/Tallinn" };
		const clock = formatResetClock(reset, fixed);
		assert.ok(clock);
		assert.match(clock, /28 Nov/);
		assert.match(clock, /16:00/);
		assert.match(clock, /EET/);
		assert.strictEqual(
			formatLimitNotice("claude", { provider: "claude", window: "weekly", reason: "usage limit", ...reset }, fixed),
			`Claude weekly limit reached. It resets at ${clock} (in 3 d 4 h). Wait for the reset, then send the message again. No retry was made.`
		);
		assert.strictEqual(formatResetClock({ resetAt: new Date("2026-11-25T14:00:00.000Z"), timeZone: "Europe/Tallinn" }, fixed), "16:00 EET",
			"within a day only the clock is shown");
		assert.match(formatResetClock({ resetAt: new Date("2027-01-02T14:00:00.000Z"), timeZone: "Europe/Tallinn" }, fixed) ?? "", /2 Jan 2027/);
	});

	test("recognizes the Codex usage limit and its retry time", () => {
		const match = detectLimitError(new Error(
			"You've hit your usage limit. Upgrade to Pro (https://chatgpt.com/explore/pro), visit https://chatgpt.com/settings/usage to purchase more credits or try again at 2:32 PM."),
			undefined, reference);
		assert.ok(match);
		assert.strictEqual(match.provider, "codex");
		assert.ok(match.resetAt);
		const now = new Date(match.resetAt.getTime() - 90 * 60_000);
		assert.strictEqual(formatWait(match.resetAt, now), "1 h 30 min");
	});

	test("a text-derived block never outlives its window", () => {
		const gate = new LimitGate();
		// A day-old "try again at 23:33" resolves to the next 23:33: 16 hours out.
		const now = new Date("2026-11-04T07:51:00.000Z").getTime();
		const match = detectLimitError(new Error("You've hit your usage limit. Try again at 23:33."), "codex", new Date(now));
		assert.strictEqual(match?.provisional, true);
		// A bare clock time is local and resolves to the next occurrence of 23:33.
		assert.strictEqual(match?.resetAt?.getHours(), 23);
		assert.strictEqual(match?.resetAt?.getMinutes(), 33);
		assert.ok((match?.resetAt?.getTime() ?? 0) - now <= 24 * 3_600_000);
		gate.note("codex", match, now);
		assert.match(gate.blocked("codex", now + 60_000) ?? "", /Codex limit reached/);
		assert.strictEqual(
			gate.blocked("codex", now + 6.5 * 3_600_000),
			undefined,
			"a five-hour window cannot stay limited for sixteen hours"
		);
		// A weekly window keeps a longer ceiling.
		const weekly = new LimitGate();
		weekly.note("codex", {
			provider: "codex", window: "weekly", provisional: true, reason: "usage limit",
			resetAt: new Date(now + 5 * 24 * 3_600_000),
		}, now);
		assert.ok(weekly.blocked("codex", now + 3 * 24 * 3_600_000), "a weekly block survives several days");
	});

	test("a provisional block asks to be verified before the next refusal", () => {
		const gate = new LimitGate();
		const now = Date.now();
		gate.note("codex", {
			provider: "codex", reason: "usage limit", provisional: true,
			resetAt: new Date(now + 3 * 3_600_000),
		}, now);
		assert.strictEqual(gate.shouldRecheck("codex", now + 1_000), true, "text-derived limits are re-checked");
		gate.note("codex", { provider: "codex", reason: "usage limit", resetAt: new Date(now + 3 * 3_600_000) }, now);
		assert.strictEqual(gate.shouldRecheck("codex", now + 1_000), false, "a provider-reported window is trusted");
		assert.strictEqual(gate.shouldRecheck("codex", now + 3 * 60_000), true, "an older block is re-checked too");
		gate.clear("codex");
		assert.strictEqual(gate.shouldRecheck("codex", now + 3 * 60_000), false);
	});

	test("keeps the short notice for both providers", () => {
		const claude = new SubscriptionLimitError("claude",
			detectLimitError(new Error("You've hit your 5-hour limit · resets 4pm (Europe/Tallinn)"), undefined, reference), reference);
		assert.match(claude.message, /^Claude 5-hour limit reached\. It resets at /);
		assert.match(claude.message, /Wait for the reset, then send the message again\. No retry was made\.$/);
		assert.ok(claude.message.length < 220, "the notice must stay short");
		assert.strictEqual(claude.retryable, false);
		const codex = new SubscriptionLimitError("codex",
			detectLimitError(new Error("You've hit your usage limit. try again at 2:32 PM"), "codex", reference), reference);
		assert.match(codex.message, /^Codex limit reached\. It resets at /);
	});

	test("ignores context and payload limits", () => {
		assert.strictEqual(detectLimitError(new Error("Claude API error: input exceeds the maximum length")), undefined);
		assert.strictEqual(detectLimitError(new Error("context length exceeded: too many tokens")), undefined);
		assert.strictEqual(detectLimitError(new Error("You've hit your usage limit"), "claude")?.provider, "claude",
			"the provider hint decides who owns an ambiguous message");
	});

	test("parses clock, ISO and zone-less resets", () => {
		const now = new Date(2026, 10, 1, 10, 0, 0);
		assert.strictEqual(parseResetTime("resets at 14:30", now)?.at.getHours(), 14);
		assert.strictEqual(parseResetTime("2026-11-01T18:00:00.000Z", now)?.at.toISOString(), "2026-11-01T18:00:00.000Z");
		const past = parseResetTime("resets at 9am", now);
		assert.ok(past); assert.ok(past.at.getTime() > now.getTime(), "a past clock time means tomorrow");
		const dated = parseResetTime("resets Nov 28, 4pm", now);
		assert.ok(dated);
		assert.strictEqual(dated.at.getMonth(), 10);
		assert.strictEqual(dated.at.getDate(), 28, "the day is a date, not a clock hour");
		assert.strictEqual(dated.at.getHours(), 16);
		assert.strictEqual(dated.at.getMinutes(), 0);
	});

	test("fails fast while the window is still limited", () => {
		const gate = new LimitGate();
		const now = Date.now(), resetAt = new Date(now + 60 * 60_000);
		gate.note("codex", { provider: "codex", resetAt, reason: "usage limit" }, now);
		assert.match(gate.blocked("codex", now + 1_000) ?? "", /Codex limit reached/);
		assert.strictEqual(gate.blocked("codex", resetAt.getTime() + 1), undefined, "the block ends at the reset");
		assert.strictEqual(gate.blocked("claude", now), undefined, "providers are independent");
		gate.note("claude", { provider: "claude", reason: "usage limit" }, now);
		assert.match(gate.blocked("claude", now) ?? "", /Wait for the limit to reset/);
		gate.clear("claude");
		assert.strictEqual(gate.blocked("claude", now), undefined);
	});

	test("the notice survives a missing reset time", () => {
		assert.strictEqual(formatLimitNotice("claude", undefined).includes("resets at"), false);
		assert.match(formatLimitNotice("codex", { provider: "codex", reason: "rate limit" }), /No retry was made/);
	});

	test("an escaped limit becomes a one-line answer instead of an error", async () => {
		const root = await fs.mkdtemp(path.join(os.tmpdir(), "limit-composite-"));
		const thrown = "Claude API error: You've hit your 5-hour limit · resets 4pm (Europe/Tallinn)";
		const composite = new CompositeChatModelProvider({
			history: new ConversationHistory(root),
			providers: [{
				id: "claude",
				ownsModel: () => true,
				provider: {
					provideLanguageModelChatInformation: async () => [],
					provideTokenCount: async () => 1,
					provideLanguageModelChatResponse: async () => { throw new Error(thrown); },
				},
			}],
		});
		const parts: vscode.LanguageModelResponsePart[] = [];
		try {
			await composite.provideLanguageModelChatResponse(
				model("claude::claude-opus-5-5"),
				[vscode.LanguageModelChatMessage.User("hello")],
				{ toolMode: vscode.LanguageModelChatToolMode.Auto, modelOptions: { _conversationId: "limit-chat" } } as never,
				{ report: part => parts.push(part) },
				none
			);
			assert.strictEqual(parts.length, 1, "the request completes with exactly one short answer");
			const text = (parts[0] as vscode.LanguageModelTextPart).value;
			assert.match(text, /^Claude 5-hour limit reached\. It resets at /);
			assert.ok(text.length < 220);
			assert.strictEqual(text.includes(thrown), false, "the provider text is replaced, not echoed");
		} finally {
			composite.dispose();
			await fs.rm(root, { recursive: true, force: true });
		}
	});

	test("other provider failures still surface as errors", async () => {
		const root = await fs.mkdtemp(path.join(os.tmpdir(), "limit-composite-real-"));
		const composite = new CompositeChatModelProvider({
			history: new ConversationHistory(root),
			providers: [{
				id: "claude",
				ownsModel: () => true,
				provider: {
					provideLanguageModelChatInformation: async () => [],
					provideTokenCount: async () => 1,
					provideLanguageModelChatResponse: async () => { throw new Error("Claude API error: connection reset by peer"); },
				},
			}],
		});
		try {
			await assert.rejects(() => composite.provideLanguageModelChatResponse(
				model("claude::claude-opus-5-5"),
				[vscode.LanguageModelChatMessage.User("hello")],
				{ toolMode: vscode.LanguageModelChatToolMode.Auto, modelOptions: { _conversationId: "other-failure" } } as never,
				{ report: () => undefined },
				none
			), /connection reset by peer/);
		} finally {
			composite.dispose();
			await fs.rm(root, { recursive: true, force: true });
		}
	});
});
