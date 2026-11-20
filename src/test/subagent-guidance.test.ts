import * as assert from "assert";

import {
	buildSubagentToolGuidance,
	codexSubagentRole,
	codexSubagentUseWhen,
	enhanceSubagentToolDescription,
	getSubagentModelProfiles,
	setSubagentModelProfiles,
	subagentProviderForSource,
	withRequiredSubagentModel,
} from "../subagent-guidance";

suite("subagent model guidance", () => {
	test("explains native model inheritance and preferred routing profiles", () => {
		setSubagentModelProfiles("local", [{
			id: "local::qwen3-coder",
			label: "Qwen 3 Coder",
			provider: "local",
			useWhen: "Narrow economical tasks",
		}]);
		setSubagentModelProfiles("deepseek", [{
			id: "deepseek::deepseek-v4-pro",
			label: "DeepSeek V4 Pro",
			provider: "deepseek",
			defaultEffort: "high",
			useWhen: "Focused complex tasks",
		}]);
		setSubagentModelProfiles("codex", [{
			id: "codex::gpt-6-luna",
			label: "GPT-6-Luna (Codex)",
			provider: "codex",
			defaultEffort: "high",
			useWhen: "Small steps",
		}]);

		const guidance = buildSubagentToolGuidance();
		assert.ok(guidance.includes('model="DeepSeek V4 Pro (llamacpp)", high thinking'));
		assert.ok(guidance.includes('model="GPT-6-Luna (Codex) (llamacpp)", high thinking'));
		assert.ok(!guidance.includes('model="DeepSeek V4 Pro"'), "VS Code rejects a bare name for a non-Copilot vendor");
		assert.ok(guidance.includes("Budget routing policy"));
		assert.ok(guidance.includes("Never omit runSubagent.model"));
		assert.ok(guidance.includes("agentName selects behaviour/custom instructions independently of model"));
		assert.ok(guidance.includes('set runSubagent.model to one of the quoted model= strings'));
		assert.ok(guidance.includes('Copy the exact string inside the quotes'));
		assert.ok(guidance.includes("one bounded, independently verifiable task"));
		assert.ok(guidance.includes("explicit allowed files"));
		assert.ok(guidance.includes("expected output"));
	});

	test("augments only subagent tool descriptions", () => {
		assert.ok(enhanceSubagentToolDescription("runSubagent", "Run an agent").includes("Subagent model routing"));
		assert.strictEqual(enhanceSubagentToolDescription("read_file", "Read a file"), "Read a file");
	});

	test("requires an explicit model in subagent schemas without mutating the host definition", () => {
		// Self-contained: extension activation refreshes profiles from the live
		// model catalog asynchronously, so relying on the previous test state
		// is a race on CI runners (the catalog there is empty).
		setSubagentModelProfiles("deepseek", [{
			id: "deepseek::deepseek-v4-pro",
			label: "DeepSeek V4 Pro",
			provider: "deepseek",
			defaultEffort: "high",
			useWhen: "Focused complex tasks",
		}]);
		const original = {
			name: "runSubagent",
			inputSchema: {
				type: "object",
				properties: { description: { type: "string" } },
				required: ["description"],
			},
		};
		const routed = withRequiredSubagentModel(original);
		const schema = routed.inputSchema as Record<string, unknown>;
		const properties = schema.properties as Record<string, unknown>;

		assert.notStrictEqual(routed, original);
		assert.deepStrictEqual(schema.required, ["description", "model"]);
		assert.deepStrictEqual(properties.description, { type: "string" });
		const modelProperty = properties.model as { type?: string; enum?: string[] };
		assert.strictEqual(modelProperty.type, "string");
		// The injected enum lists the advertised catalog labels and forbids Auto.
		assert.ok(Array.isArray(modelProperty.enum));
		// VS Code's runSubagent resolves "Name (vendor)"; the bare name only works for Copilot's own models.
		assert.ok(modelProperty.enum!.includes("DeepSeek V4 Pro (llamacpp)"));
		assert.ok(!modelProperty.enum!.includes("DeepSeek V4 Pro"));
		assert.ok(!modelProperty.enum!.includes("Auto"));
		assert.deepStrictEqual(original.inputSchema.required, ["description"]);
		assert.ok(!("model" in original.inputSchema.properties));
	});

	test("preserves an existing model schema and leaves ordinary tools unchanged", () => {
		const subagent = {
			name: "executionSubagent",
			inputSchema: {
				type: "object",
				properties: { model: { type: "string", enum: ["Qwen"] } },
				required: ["model"],
			},
		};
		const ordinary = { name: "read_file", inputSchema: { type: "object", properties: {} } };

		const routed = withRequiredSubagentModel(subagent);
		const properties = routed.inputSchema.properties as Record<string, unknown>;
		assert.deepStrictEqual(properties.model, { type: "string", enum: ["Qwen"] });
		assert.deepStrictEqual(routed.inputSchema.required, ["model"]);
		assert.strictEqual(withRequiredSubagentModel(ordinary), ordinary);
	});

	test("keeps model-visible guidance stable when availability changes", () => {
		setSubagentModelProfiles("claude", [{
			id: "claude-opus-5",
			label: "Opus 5 (Claude)",
			provider: "claude",
			defaultEffort: "high",
			useWhen: "Complex coding model",
			availability: "unavailable",
			availabilityReason: "5-hour limit 100%",
			unavailableUntil: "2026-07-19T10:50:00.000Z",
		}]);
		const unavailableGuidance = buildSubagentToolGuidance();
		setSubagentModelProfiles("claude", [{
			id: "claude-opus-5",
			label: "Opus 5 (Claude)",
			provider: "claude",
			defaultEffort: "high",
			useWhen: "Complex coding model",
			availability: "available",
			availabilityReason: "Subscription limit reset",
		}]);
		const availableGuidance = buildSubagentToolGuidance();
		assert.strictEqual(unavailableGuidance, availableGuidance);
		assert.ok(availableGuidance.includes('model="Opus 5 (Claude) (llamacpp)", high thinking'));
		assert.ok(!availableGuidance.includes("5-hour limit"));
		assert.ok(!availableGuidance.includes("Subscription limit reset"));
	});

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
		const guidance = buildSubagentToolGuidance();
		assert.ok(!guidance.includes("GPT-6.2-Sol"));
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

	test("orders budget tiers from cheapest local to premium subscription", () => {
		setSubagentModelProfiles("local", [{
			id: "local::qwen3-coder", label: "Qwen 3 Coder", provider: "local", useWhen: "Narrow tasks",
		}]);
		setSubagentModelProfiles("deepseek", [{
			id: "deepseek::deepseek-v4-pro", label: "DeepSeek V4 Pro", provider: "deepseek", defaultEffort: "high", useWhen: "Complex tasks",
		}]);
		setSubagentModelProfiles("codex", [{
			id: "codex::gpt-6-luna", label: "GPT-6-Luna (Codex)", provider: "codex", defaultEffort: "high", useWhen: "Small steps",
		}]);
		setSubagentModelProfiles("claude", [{
			id: "claude::claude-opus-5", label: "Opus 5 (Claude)", provider: "claude", defaultEffort: "high", useWhen: "Hardest tasks",
		}]);
		setSubagentModelProfiles("api", []);
		const guidance = buildSubagentToolGuidance();
		const cheapest = guidance.indexOf("cheapest —");
		const mid = guidance.indexOf("mid —");
		const subscription = guidance.indexOf("subscription —");
		const premium = guidance.indexOf("premium —");
		assert.ok(cheapest >= 0 && mid > cheapest && subscription > mid && premium > subscription);
		setSubagentModelProfiles("claude", []);
	});

	test("omits budget policy when only one cost tier is available", () => {
		setSubagentModelProfiles("local", []);
		setSubagentModelProfiles("deepseek", []);
		setSubagentModelProfiles("codex", [{
			id: "codex::gpt-6-luna", label: "GPT-6-Luna (Codex)", provider: "codex", defaultEffort: "high", useWhen: "Small steps",
		}]);
		setSubagentModelProfiles("claude", []);
		setSubagentModelProfiles("api", []);
		const guidance = buildSubagentToolGuidance();
		assert.ok(!guidance.includes("Budget routing policy"));
		assert.ok(guidance.includes("Never omit runSubagent.model"));
	});

	test("includes vision delegation guidance when a local model is available", () => {
		setSubagentModelProfiles("local", [{
			id: "local::qwen3-coder", label: "Qwen 3 Coder", provider: "local", useWhen: "Narrow tasks",
		}]);
		setSubagentModelProfiles("deepseek", []);
		setSubagentModelProfiles("codex", []);
		setSubagentModelProfiles("claude", []);
		setSubagentModelProfiles("api", []);
		const guidance = buildSubagentToolGuidance();
		assert.ok(guidance.includes("Vision delegation:"));
		assert.ok(guidance.includes("The subagent has access to view_image and terminal tools"));
		assert.ok(guidance.includes("Use agentName 'Explore' or any available agent type with a local model"));
	});

	test("omits vision delegation guidance when no local model is available", () => {
		setSubagentModelProfiles("local", []);
		setSubagentModelProfiles("deepseek", [{
			id: "deepseek::deepseek-v4-pro", label: "DeepSeek V4 Pro", provider: "deepseek", defaultEffort: "high", useWhen: "Complex tasks",
		}]);
		setSubagentModelProfiles("codex", []);
		setSubagentModelProfiles("claude", []);
		setSubagentModelProfiles("api", []);
		const guidance = buildSubagentToolGuidance();
		assert.ok(!guidance.includes("Vision delegation:"));
		assert.ok(!guidance.includes("unlimited tokens and no rate limits"), "no local model is promised when none exists");
	});

	test("routes small steps to Luna, larger ones to Terra and warns DeepSeek cannot see", () => {
		setSubagentModelProfiles("local", []);
		setSubagentModelProfiles("deepseek", [{
			id: "deepseek::deepseek-v4-pro", label: "DeepSeek V4 Pro", provider: "deepseek", defaultEffort: "high", useWhen: "Complex tasks",
		}]);
		setSubagentModelProfiles("codex", [
			{ id: "codex::gpt-6.1-terra", label: "GPT-6.1 Terra (Codex)", provider: "codex", useWhen: codexSubagentUseWhen("gpt-6.1-terra") },
			{ id: "codex::gpt-6-luna", label: "GPT-6-Luna (Codex)", provider: "codex", useWhen: codexSubagentUseWhen("gpt-6-luna") },
		]);
		setSubagentModelProfiles("claude", []);
		setSubagentModelProfiles("api", []);
		const profiles = getSubagentModelProfiles();
		const terraIndex = profiles.findIndex(profile => profile.id === "codex::gpt-6.1-terra");
		const lunaIndex = profiles.findIndex(profile => profile.id === "codex::gpt-6-luna");
		assert.ok(lunaIndex >= 0 && terraIndex > lunaIndex, "Luna, the cheaper model, comes first");
		const guidance = buildSubagentToolGuidance();
		assert.ok(guidance.includes('model="GPT-6-Luna (Codex) (llamacpp)": Fast and affordable: small, well-defined steps'));
		assert.ok(guidance.includes('model="GPT-6.1 Terra (Codex) (llamacpp)": Larger multi-step steps'));
		assert.ok(guidance.includes("Codex Luna (fast and affordable) for small, well-defined steps"));
		assert.ok(guidance.includes("Codex Terra for larger multi-step steps"));
		assert.ok(guidance.includes("same kind of steps as DeepSeek Flash"));
		assert.ok(guidance.includes("Codex Luna (small steps) → Codex Terra (larger steps)"));
		assert.ok(guidance.includes("DeepSeek cannot process image input"));
		assert.ok(!guidance.includes("premium —"), "without Claude there is no premium tier");
		setSubagentModelProfiles("codex", []);
	});

	test("notes DeepSeek Flash vision support when a Flash profile is available", () => {
		setSubagentModelProfiles("local", []);
		setSubagentModelProfiles("deepseek", [{
			id: "deepseek::deepseek-flash", label: "DeepSeek Flash", provider: "deepseek", defaultEffort: "high", useWhen: "Complex tasks",
		}]);
		setSubagentModelProfiles("codex", [{
			id: "codex::gpt-6-luna", label: "GPT-6-Luna (Codex)", provider: "codex", defaultEffort: "high", useWhen: "Small steps",
		}]);
		setSubagentModelProfiles("claude", []);
		setSubagentModelProfiles("api", []);
		const guidance = buildSubagentToolGuidance();
		assert.ok(guidance.includes("DeepSeek Flash accepts image input"));
		assert.ok(!guidance.includes("DeepSeek cannot process image input"));
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

	test("advertises paid API profiles last and as billed per use", () => {
		setSubagentModelProfiles("local", [{
			id: "local::qwen3-coder", label: "Qwen 3 Coder", provider: "local", useWhen: "Narrow tasks",
		}]);
		setSubagentModelProfiles("deepseek", []);
		setSubagentModelProfiles("codex", []);
		setSubagentModelProfiles("claude", []);
		setSubagentModelProfiles("api", [{
			id: "cursor::claude-opus-5-5",
			label: "Opus 5.5 (Cursor)",
			provider: "api",
			availability: "available",
			useWhen: "Paid API model, billed per use; use only when the user names it or no cheaper tier fits",
		}]);
		const profiles = getSubagentModelProfiles();
		assert.deepStrictEqual(profiles.map(profile => profile.provider), ["local", "api"], "paid API profiles come last");
		const guidance = buildSubagentToolGuidance();
		assert.ok(guidance.includes("paid API — models from API profiles (for example Cursor) are billed per use"));
		assert.ok(guidance.includes("route there only when the user names the model or no tier above can run the task"));
		assert.ok(guidance.includes("paid API profiles (only on request)"));
		assert.ok(guidance.includes('model="Opus 5.5 (Cursor) (llamacpp)": Paid API model, billed per use'));
		setSubagentModelProfiles("api", []);
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
