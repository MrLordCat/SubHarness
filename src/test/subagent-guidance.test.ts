import * as assert from "assert";

import {
	availableSubagentModelProfiles,
	codexSubagentRole,
	codexSubagentUseWhen,
	getSubagentModelProfiles,
	setSubagentModelProfiles,
	subagentProviderForSource,
	subagentStandIn,
	blockedSubagentModel,
	unavailableSubagentModelProfiles,
} from "../subagent-guidance";

suite("subagent model guidance", () => {










	test("excludes Sol from subagent routing while retaining Opus 5", () => {
		setSubagentModelProfiles("codex", [
			{ id: "gpt-6.2-sol", label: "GPT-6.2-Sol", provider: "codex", useWhen: "Large tasks" },
			{ id: "gpt-6-luna", label: "GPT-6-Luna", provider: "codex", useWhen: "Subagent tasks" },
		]);
		setSubagentModelProfiles("claude", [
			{ id: "claude-opus-5", label: "Opus 5", provider: "claude", useWhen: "Subagent tasks" },
		]);
		const profiles = getSubagentModelProfiles();
		assert.ok(!profiles.some(profile => profile.id === "gpt-6.2-sol"));
		assert.ok(profiles.some(profile => profile.id === "gpt-6-luna"));
		assert.ok(profiles.some(profile => profile.id === "claude-opus-5"));
	});

	test("offers only the newest Codex Luna and Terra, Luna first", () => {
		const codex = (slug: string) => ({ id: `codex::${slug}`, label: `${slug} (Codex)`, provider: "codex" as const, useWhen: "x" });
		const codexIds = () => getSubagentModelProfiles().filter(profile => profile.provider === "codex").map(profile => profile.id);
		setSubagentModelProfiles("codex", ["gpt-5.4-mini", "gpt-5.5", "gpt-6.2-sol", "gpt-6.1-sol", "gpt-5.6-terra", "gpt-6.1-terra", "gpt-5.6-luna", "gpt-6-luna", "gpt-5.6-codex"].map(codex));
		assert.deepStrictEqual(codexIds(), ["codex::gpt-6-luna", "codex::gpt-6.1-terra"]);

		// The newest 6.x version of each wins.
		setSubagentModelProfiles("codex", ["gpt-6.1-terra", "gpt-6.2-luna", "gpt-6-luna", "gpt-6-terra"].map(codex));
		assert.deepStrictEqual(codexIds(), ["codex::gpt-6.2-luna", "codex::gpt-6.1-terra"]);

		// Only the 6.x family is used: an account with only 5.x models offers no Codex subagent.
		setSubagentModelProfiles("codex", ["gpt-5.6-terra", "gpt-5.6-sol", "gpt-5.6-luna"].map(codex));
		assert.deepStrictEqual(codexIds(), []);
		setSubagentModelProfiles("codex", []);
	});

	test("keeps scoped Codex catalogs for separate accounts", () => {
		const codex = (slug: string, suffix: string) => ({
			id: `codex::${slug}`,
			label: `${slug} (Codex)${suffix}`,
			provider: "codex" as const,
			useWhen: "x",
		});
		setSubagentModelProfiles("codex", ["gpt-6.1-terra", "gpt-6-luna"].map(slug => codex(slug, " A")), "acc-a");
		setSubagentModelProfiles("codex", ["gpt-6.1-terra", "gpt-6-luna"].map(slug => codex(slug, " B")), "acc-b");

		const profiles = getSubagentModelProfiles().filter(profile => profile.provider === "codex");
		assert.deepStrictEqual(profiles.map(profile => profile.label), [
			"gpt-6-luna (Codex) A",
			"gpt-6.1-terra (Codex) A",
			"gpt-6-luna (Codex) B",
			"gpt-6.1-terra (Codex) B",
		]);
		setSubagentModelProfiles("codex", []);
	});

	test("removes only the selected scoped Codex catalog", () => {
		const codex = (slug: string, suffix: string) => ({
			id: `codex::${slug}`,
			label: `${slug} (Codex)${suffix}`,
			provider: "codex" as const,
			useWhen: "x",
		});
		setSubagentModelProfiles("codex", ["gpt-6-luna", "gpt-6.1-terra"].map(slug => codex(slug, " A")), "acc-a");
		setSubagentModelProfiles("codex", ["gpt-6-luna", "gpt-6.1-terra"].map(slug => codex(slug, " B")), "acc-b");

		setSubagentModelProfiles("codex", [], "acc-a");
		assert.deepStrictEqual(
			getSubagentModelProfiles().filter(profile => profile.provider === "codex").map(profile => profile.label),
			["gpt-6-luna (Codex) B", "gpt-6.1-terra (Codex) B"]
		);
		setSubagentModelProfiles("codex", []);
	});

	test("lists a model of two accounts once and lets the second stand in while the first is used up", () => {
		const luna = (account: string, availability: "available" | "unavailable") => ({
			id: account ? `codex::${account}::gpt-6-luna` : "codex::gpt-6-luna",
			label: "GPT-6-Luna (Codex)",
			provider: "codex" as const,
			useWhen: "x",
			availability,
		});
		const codexIds = () => availableSubagentModelProfiles().filter(profile => profile.provider === "codex").map(profile => profile.id);
		try {
			setSubagentModelProfiles("codex", [luna("", "available")], "", 0);
			setSubagentModelProfiles("codex", [luna("work", "available")], "work", 2);
			assert.deepStrictEqual(codexIds(), ["codex::gpt-6-luna"], "one entry, on the account tried first");
			assert.strictEqual(subagentStandIn("codex::gpt-6-luna"), undefined, "an available model keeps its account");

			setSubagentModelProfiles("codex", [luna("", "unavailable")], "", 0);
			assert.deepStrictEqual(codexIds(), ["codex::work::gpt-6-luna"], "the second subscription stands in");
			assert.strictEqual(subagentStandIn("codex::gpt-6-luna"), "codex::work::gpt-6-luna");

			assert.deepStrictEqual(unavailableSubagentModelProfiles().map(profile => profile.id), [], "a used-up account with a stand-in is not reported");
			assert.strictEqual(blockedSubagentModel("codex::gpt-6-luna"), undefined, "an open subagent moves instead");

			setSubagentModelProfiles("codex", [luna("work", "unavailable")], "work", 2);
			assert.deepStrictEqual(codexIds(), [], "no Codex subagent while both are used up");
			assert.strictEqual(subagentStandIn("codex::gpt-6-luna"), undefined);
			assert.deepStrictEqual(unavailableSubagentModelProfiles().map(profile => profile.id), ["codex::gpt-6-luna"], "listed once, as used up");
			assert.strictEqual(blockedSubagentModel("codex::gpt-6-luna")?.id, "codex::gpt-6-luna");
			assert.strictEqual(blockedSubagentModel("codex::work::gpt-6-luna")?.id, "codex::work::gpt-6-luna");
		} finally {
			setSubagentModelProfiles("codex", []);
		}
	});

	test("an open subagent of an account that dropped its catalog moves to the same model of another", () => {
		try {
			setSubagentModelProfiles("codex", [{ id: "codex::work::gpt-6-luna", label: "GPT-6-Luna (Codex)", provider: "codex", useWhen: "x" }], "work", 1);
			assert.strictEqual(subagentStandIn("codex::gpt-6-luna"), "codex::work::gpt-6-luna");
			assert.strictEqual(subagentStandIn("codex::gpt-6.1-terra"), undefined, "no Terra on the other account");
			assert.strictEqual(subagentStandIn("claude::smart"), undefined, "other providers keep their model");
		} finally {
			setSubagentModelProfiles("codex", []);
		}
	});

	test("Claude models fall back to the same model on another account", () => {
		try {
			setSubagentModelProfiles("claude", [{ id: "claude::opus", label: "Opus (Claude 1)", provider: "claude", useWhen: "x", availability: "available" }], "", 0);
			setSubagentModelProfiles("claude", [{ id: "claude::work::opus", label: "Opus (Claude 2)", provider: "claude", useWhen: "x", availability: "unavailable" }], "work", 1);
			assert.strictEqual(subagentStandIn("claude::work::opus"), "claude::opus");
			setSubagentModelProfiles("claude", [], "work");
			assert.strictEqual(subagentStandIn("claude::work::opus"), "claude::opus");
			assert.strictEqual(subagentStandIn("claude::work::sonnet"), undefined);
		} finally {
			setSubagentModelProfiles("claude", []);
		}
	});

	test("tries the account with the lower priority first, whatever its id", () => {
		const luna = (account: string) => ({ id: `codex::${account}::gpt-6-luna`, label: "GPT-6-Luna (Codex)", provider: "codex" as const, useWhen: "x" });
		try {
			setSubagentModelProfiles("codex", [luna("a")], "a", 2);
			setSubagentModelProfiles("codex", [luna("b")], "b", 0);
			assert.deepStrictEqual(getSubagentModelProfiles().filter(profile => profile.provider === "codex").map(profile => profile.id), ["codex::b::gpt-6-luna"]);
		} finally {
			setSubagentModelProfiles("codex", []);
		}
	});

	test("unscoped empty Codex catalog clears every scope", () => {
		const codex = (suffix: string) => ({
			id: "codex::gpt-6-luna",
			label: `gpt-6-luna (Codex)${suffix}`,
			provider: "codex" as const,
			useWhen: "x",
		});
		setSubagentModelProfiles("codex", [codex(" A")], "acc-a");
		setSubagentModelProfiles("codex", [codex(" B")], "acc-b");

		setSubagentModelProfiles("codex", []);
		assert.deepStrictEqual(getSubagentModelProfiles().filter(profile => profile.provider === "codex"), []);
		setSubagentModelProfiles("codex", []);
	});

	test("gives Luna the small steps and Terra the larger ones", () => {
		assert.strictEqual(codexSubagentRole("gpt-6-luna"), "luna");
		assert.strictEqual(codexSubagentRole("codex::work::gpt-6.1-terra"), "terra");
		assert.strictEqual(codexSubagentRole("gpt-6.2-sol"), undefined);
		assert.strictEqual(codexSubagentRole("gpt-5.6-codex"), undefined);
		assert.strictEqual(codexSubagentRole("gpt-5.6-luna"), undefined, "5.x is not used");
		assert.strictEqual(codexSubagentRole("codex::gpt-5.6-terra"), undefined, "5.x is not used");
		assert.match(codexSubagentUseWhen("codex::gpt-6-luna"), /^Fast and affordable: small, well-defined steps/);
		assert.match(codexSubagentUseWhen("codex::gpt-6.1-terra"), /^Larger multi-step steps/);
		assert.match(codexSubagentUseWhen("gpt-6.2-sol"), /repository-wide/);
	});













	test("classifies HTTP model sources into local, DeepSeek and paid API groups", () => {
		assert.strictEqual(
			subagentProviderForSource({ protocol: "cursor", serverUrl: "https://api.cursor.com" }),
			"api",
			"Cursor models are billed per use"
		);
		assert.strictEqual(
			subagentProviderForSource({ protocol: "openai", serverUrl: "https://gateway.example.com/v1" }),
			"api",
			"a remote OpenAI-compatible gateway is a paid API profile"
		);
		assert.strictEqual(
			subagentProviderForSource({ protocol: "openai", serverUrl: "http://127.0.0.1:1234" }),
			"local",
			"a loopback endpoint is self-hosted"
		);
		assert.strictEqual(
			subagentProviderForSource({ protocol: "llamacpp", serverUrl: "https://llama.example.com" }),
			"local",
			"the llama.cpp protocol marks a self-hosted server"
		);
		assert.strictEqual(
			subagentProviderForSource({ protocol: "openai", serverUrl: "https://gateway.example.com/v1", llamaCppCompat: true }),
			"local",
			"llama.cpp behind an OpenAI-compatible gateway is still self-hosted"
		);
		assert.strictEqual(
			subagentProviderForSource({ protocol: "deepseek", serverUrl: "https://api.deepseek.com" }),
			"deepseek"
		);
		assert.strictEqual(
			subagentProviderForSource({ protocol: "openai", serverUrl: "https://api.deepseek.com" }),
			"deepseek",
			"the DeepSeek URL alone identifies the tier"
		);
	});



	test("lists a duplicated API label once", () => {
		setSubagentModelProfiles("local", []);
		setSubagentModelProfiles("deepseek", []);
		setSubagentModelProfiles("codex", []);
		setSubagentModelProfiles("claude", []);
		setSubagentModelProfiles("api", [
			{ id: "cursor::auto-a", label: "Auto", provider: "api", useWhen: "Automatic routing" },
			{ id: "cursor::auto-b", label: "Auto", provider: "api", useWhen: "Automatic routing" },
		]);
		const profiles = getSubagentModelProfiles();
		assert.strictEqual(profiles.length, 1, "a label can be selected only once");
		assert.strictEqual(profiles[0].provider, "api");
		setSubagentModelProfiles("api", []);
	});
});
