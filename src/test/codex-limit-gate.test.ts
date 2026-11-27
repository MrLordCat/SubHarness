import * as assert from "node:assert";
import { codexWindowExhausted, resolveCodexLimitGate } from "../codex/codex-provider";
import type { CodexRateLimitSnapshot } from "../codex/protocol";

const snapshot = (value: Partial<CodexRateLimitSnapshot>): CodexRateLimitSnapshot => ({
	limitId: "codex",
	limitName: null,
	primary: null,
	secondary: null,
	planType: "plus",
	rateLimitReachedType: null,
	...value,
});

/** Fixed epoch seconds would silently age into the past and change the gate's answer. */
const inSeconds = (hours: number): number => Math.floor(Date.now() / 1_000) + Math.round(hours * 3_600);

suite("Codex limit gate", () => {
	test("a reset 5-hour window clears the gate even when reached-type is stale", () => {
		// Mirrors the reported bug: the panel showed 0% used for the 5-hour window
		// and 57% for the weekly one, while rateLimitReachedType still said primary.
		const decision = resolveCodexLimitGate(snapshot({
			primary: { usedPercent: 0, windowDurationMins: 300, resetsAt: inSeconds(2) },
			secondary: { usedPercent: 57, windowDurationMins: 10_080, resetsAt: inSeconds(50) },
			rateLimitReachedType: "primary",
		}));
		assert.deepStrictEqual(decision, { kind: "clear" });
	});

	test("a window at 100% blocks the chat with its own reset", () => {
		const resetAt = inSeconds(2);
		const decision = resolveCodexLimitGate(snapshot({
			primary: { usedPercent: 100, windowDurationMins: 300, resetsAt: resetAt },
			secondary: { usedPercent: 57, windowDurationMins: 10_080, resetsAt: inSeconds(50) },
			rateLimitReachedType: "primary",
		}));
		assert.strictEqual(decision.kind, "limited");
		if (decision.kind !== "limited") {
			return;
		}
		assert.strictEqual(decision.match.window, "5-hour");
		assert.strictEqual(decision.match.resetAt?.toISOString(), new Date(resetAt * 1_000).toISOString());
		assert.strictEqual(decision.match.provisional, undefined, "a reported window is authoritative");
	});

	test("a full weekly window is named weekly", () => {
		const decision = resolveCodexLimitGate(snapshot({
			primary: { usedPercent: 12, windowDurationMins: 300, resetsAt: null },
			secondary: { usedPercent: 100, windowDurationMins: 10_080, resetsAt: null },
			rateLimitReachedType: "secondary",
		}));
		assert.strictEqual(decision.kind, "limited");
		if (decision.kind === "limited") {
			assert.strictEqual(decision.match.window, "weekly");
			assert.strictEqual(decision.match.resetAt, undefined);
		}
	});

	test("with both windows used up the later reset decides", () => {
		const weeklyResetAt = inSeconds(50);
		const decision = resolveCodexLimitGate(snapshot({
			primary: { usedPercent: 100, windowDurationMins: 300, resetsAt: inSeconds(2) },
			secondary: { usedPercent: 100, windowDurationMins: 10_080, resetsAt: weeklyResetAt },
			rateLimitReachedType: "primary",
		}));
		assert.strictEqual(decision.kind, "limited");
		if (decision.kind === "limited") {
			assert.strictEqual(decision.match.window, "weekly");
			assert.strictEqual(decision.match.resetAt?.toISOString(), new Date(weeklyResetAt * 1_000).toISOString());
		}
	});

	test("a window whose own reset has passed no longer blocks the chat", () => {
		// Refreshes run at most every 15 minutes, so the last snapshot may still say
		// 100% after the reset it reports. The reset time itself ends the block, and
		// otherwise the subagent pre-check would call this model exhausted.
		const decision = resolveCodexLimitGate(snapshot({
			primary: { usedPercent: 100, windowDurationMins: 300, resetsAt: inSeconds(-0.25) },
			secondary: { usedPercent: 20, windowDurationMins: 10_080, resetsAt: inSeconds(50) },
			rateLimitReachedType: "primary",
		}));
		assert.deepStrictEqual(decision, { kind: "clear" });
		assert.strictEqual(codexWindowExhausted({ usedPercent: 100, windowDurationMins: 300, resetsAt: 1_000 }, 2_000_000), false);
		assert.strictEqual(codexWindowExhausted({ usedPercent: 100, windowDurationMins: 300, resetsAt: 3_000 }, 2_000_000), true);
		assert.strictEqual(codexWindowExhausted({ usedPercent: 100, windowDurationMins: 300, resetsAt: null }, 2_000_000), true,
			"an unknown reset keeps the block until the next report");
	});

	test("no window numbers leave the current gate untouched", () => {
		assert.deepStrictEqual(resolveCodexLimitGate(undefined), { kind: "unknown" });
		assert.deepStrictEqual(resolveCodexLimitGate(snapshot({ rateLimitReachedType: "primary" })), { kind: "unknown" });
	});
});
