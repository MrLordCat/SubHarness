import * as assert from "node:assert";
import { balanceQuota, subscriptionQuota } from "../chat/quota";
import { groupModels, thinkingOptions, type ModelInfoLike } from "../chat/shared/model-groups";
import { formatQuotaChip, formatQuotaTitle, quotaLevel, quotaSeverity } from "../chat/webview/format";
import type { SubscriptionObservation } from "../diagnostics/subscription-usage";

const MODEL: ModelInfoLike = {
	id: "codex::fast",
	name: "Fast (Codex)",
	maxInputTokens: 100_000,
	configurationSchema: {
		type: "object",
		properties: {
			reasoningEffort: {
				type: "string",
				title: "Reasoning effort",
				enum: ["low", "high", "xhigh"],
				enumItemLabels: ["Low", "High"],
				enumDescriptions: ["Quick answer.", "Deep reasoning."],
				default: "high",
			},
		},
	},
};

suite("Chat quota", () => {
	test("builds both subscription windows with the plan and parsed reset times", () => {
		const observation: SubscriptionObservation = {
			plan: "Pro",
			fiveHour: { utilization: 42.4, resetsAt: "2026-11-19T15:00:00.000Z" },
			weekly: { utilization: 12.6, resetsAt: "2026-11-22T00:00:00.000Z" },
		};
		assert.deepStrictEqual(subscriptionQuota("Codex", observation), {
			provider: "Codex",
			plan: "Pro",
			windows: [
				{ label: "5h", percent: 42, resetsAt: Date.parse("2026-11-19T15:00:00.000Z") },
				{ label: "Week", percent: 13, resetsAt: Date.parse("2026-11-22T00:00:00.000Z") },
			],
		});
	});

	test("clamps the used share to 0-100 and rounds it", () => {
		for (const [utilization, percent] of [[142, 100], [-5, 0], [100, 100], [0, 0], [79.6, 80]] as const) {
			const quota = subscriptionQuota("Claude", { fiveHour: { utilization } });
			assert.deepStrictEqual(quota?.windows, [{ label: "5h", percent }]);
		}
	});

	test("drops a window without a usable utilization and an unparsable reset time", () => {
		const quota = subscriptionQuota("Codex", {
			fiveHour: { utilization: 10, resetsAt: "not a date" },
			weekly: { utilization: Number.NaN, resetsAt: "2026-11-22T00:00:00.000Z" },
		});
		assert.deepStrictEqual(quota, { provider: "Codex", windows: [{ label: "5h", percent: 10 }] });
	});

	test("returns undefined without a usable window and keeps the plan only with windows", () => {
		assert.strictEqual(subscriptionQuota("Codex", undefined), undefined);
		assert.strictEqual(subscriptionQuota("Codex", {}), undefined);
		assert.strictEqual(subscriptionQuota("Codex", { plan: "Pro", weekly: { utilization: Number.POSITIVE_INFINITY } }), undefined);
		const quota = subscriptionQuota("Codex", { plan: "Pro", weekly: { utilization: 5 } });
		assert.strictEqual(quota?.plan, "Pro");
	});

	test("trims a balance and rejects an empty one", () => {
		assert.deepStrictEqual(balanceQuota("DeepSeek", "  $12.30 \n"), { provider: "DeepSeek", windows: [], balance: "$12.30" });
		assert.strictEqual(balanceQuota("DeepSeek", "   "), undefined);
		assert.strictEqual(balanceQuota("DeepSeek", undefined), undefined);
	});

	test("reads reasoning levels, labels, descriptions and the default from the schema", () => {
		assert.deepStrictEqual(thinkingOptions(MODEL), {
			levels: [
				{ value: "low", label: "Low", description: "Quick answer." },
				{ value: "high", label: "High", description: "Deep reasoning." },
				{ value: "xhigh", label: "Xhigh" },
			],
			default: "high",
		});
	});

	test("ignores a default the enum does not offer and falls back to a capitalised value", () => {
		const thinking = thinkingOptions({
			id: "m",
			name: "M",
			maxInputTokens: 1,
			configurationSchema: { properties: { reasoningEffort: { enum: ["low", "xhigh"], default: "medium" } } },
		});
		assert.deepStrictEqual(thinking, { levels: [{ value: "low", label: "Low" }, { value: "xhigh", label: "Xhigh" }] });
	});

	test("returns undefined when the schema has no reasoning enum", () => {
		assert.strictEqual(thinkingOptions({ id: "m", name: "M", maxInputTokens: 1 }), undefined);
		assert.strictEqual(thinkingOptions({ id: "m", name: "M", maxInputTokens: 1, configurationSchema: {} }), undefined);
		assert.strictEqual(thinkingOptions({ id: "m", name: "M", maxInputTokens: 1, configurationSchema: { properties: { reasoningEffort: { type: "string" } } } }), undefined);
		assert.strictEqual(thinkingOptions({ id: "m", name: "M", maxInputTokens: 1, configurationSchema: { properties: { reasoningEffort: { enum: [7, null] } } } }), undefined);
	});

	test("groupModels puts the thinking options on the model entry", () => {
		const groups = groupModels([MODEL, { id: "claude::smart", name: "Smart (Claude)", maxInputTokens: 200_000 }]);
		const codex = groups.find(group => group.provider === "Codex");
		const claude = groups.find(group => group.provider === "Claude");
		assert.deepStrictEqual(codex?.models[0].thinking, thinkingOptions(MODEL));
		assert.strictEqual(claude?.models[0].thinking, undefined);
	});

	test("formats the chip text from the most used window or a balance", () => {
		assert.strictEqual(formatQuotaChip({ provider: "Codex", windows: [{ label: "5h", percent: 42 }, { label: "Week", percent: 12.4 }] }), "5h 42%");
		assert.strictEqual(formatQuotaChip({ provider: "Codex", windows: [{ label: "5h", percent: 3 }, { label: "Week", percent: 80.6 }] }), "Week 81%");
		assert.strictEqual(formatQuotaChip({ provider: "DeepSeek", windows: [], balance: "  $12.30  " }), "$12.30");
		assert.strictEqual(formatQuotaChip({ provider: "Local", windows: [] }), "");
	});

	test("lists every window in the chip tooltip", () => {
		assert.strictEqual(formatQuotaTitle({ provider: "Codex", windows: [{ label: "5h", percent: 42 }, { label: "Week", percent: 12.4 }] }), "Codex limits: 5h 42% · Week 12%");
		assert.strictEqual(formatQuotaTitle({ provider: "DeepSeek", windows: [], balance: "$12.30" }), "DeepSeek limits: $12.30");
		assert.strictEqual(formatQuotaTitle({ provider: "Local", windows: [] }), "Local limits");
	});

	test("grades a used share and the worst window of a provider", () => {
		assert.strictEqual(quotaLevel(0), "normal");
		assert.strictEqual(quotaLevel(79.9), "normal");
		assert.strictEqual(quotaLevel(80), "warning");
		assert.strictEqual(quotaLevel(99), "warning");
		assert.strictEqual(quotaLevel(100), "error");
		assert.strictEqual(quotaLevel(150), "error");
		assert.strictEqual(quotaLevel(Number.NaN), "normal");

		assert.strictEqual(quotaSeverity({ provider: "Codex", windows: [{ label: "5h", percent: 42 }, { label: "Week", percent: 12 }] }), "normal");
		assert.strictEqual(quotaSeverity({ provider: "Claude", windows: [{ label: "5h", percent: 91 }] }), "warning");
		assert.strictEqual(quotaSeverity({ provider: "Claude", windows: [{ label: "5h", percent: 79 }, { label: "Week", percent: 100 }] }), "error");
		assert.strictEqual(quotaSeverity({ provider: "DeepSeek", windows: [], balance: "$12.30" }), "normal");
	});
});
