import * as assert from "node:assert";
import * as vscode from "vscode";

import { COCO_CATALOG_KEY, CocoChatModelProvider } from "../coco/coco-provider";
import type { CocoAcpClient } from "../coco/acp-client";
import { classifyCocoDiscoveryError, redactCocoDiagnostic } from "../coco/discovery-diagnostics";
import { mapCocoModel } from "../coco/model-adapter";

const sessionResult = (id = "test-session", model = "test-model", name = "Test Model") => ({ sessionId: id, configOptions: [{
	category: "model", type: "select", options: [{ value: "auto", name: "Auto" }, { value: model, name }],
}] });

function catalogState(): { memento: vscode.Memento; values: Map<string, unknown> } {
	const values = new Map<string, unknown>();
	const memento = {
		keys: () => [...values.keys()],
		get: <T>(key: string, fallback?: T): T => (values.has(key) ? values.get(key) : fallback) as T,
		update: async (key: string, value: unknown) => { values.set(key, value); },
	} as vscode.Memento;
	return { memento, values };
}

function discoveryClient(session: () => Promise<Record<string, unknown>>, overrides: Record<string, unknown> = {}): CocoAcpClient {
	return {
		initialize: async () => undefined,
		newSession: session,
		prompt: async () => { throw new Error("A discovery check must not prompt"); },
		cancel: () => undefined,
		dispose: () => undefined,
		...overrides,
	} as unknown as CocoAcpClient;
}

suite("Coco catalog discovery", () => {
	test("a recorded catalog seeds a reload and starts no CLI", async () => {
		const { memento, values } = catalogState();
		let probes = 0;
		const first = new CocoChatModelProvider({ isEnabled: () => true, resolveCli: () => "mock-cli", resolveConnection: () => "Azure SSO",
			catalogState: memento, createClient: () => { probes++; return discoveryClient(async () => sessionResult()); } });
		try {
			assert.strictEqual((await first.refreshStatus()).state, "connected");
			assert.strictEqual(probes, 1);
			assert.ok(values.get(COCO_CATALOG_KEY));
		} finally { first.dispose(); }
		const events: Array<{ event: string; data: Record<string, unknown> }> = [];
		let reloaded = 0;
		const reload = new CocoChatModelProvider({ isEnabled: () => true, resolveCli: () => "mock-cli", resolveConnection: () => "Azure SSO",
			catalogState: memento, log: (event, data) => events.push({ event, data }),
			createClient: () => { reloaded++; return discoveryClient(async () => sessionResult()); } });
		const token = new vscode.CancellationTokenSource();
		try {
			const models = await reload.provideLanguageModelChatInformation({ silent: true }, token.token);
			assert.ok(models.some(model => model.id === "coco::test-model"));
			assert.strictEqual(reload.providerStatus.state, "connected");
			assert.strictEqual(reload.providerStatus.modelCount, 2);
			assert.ok(reload.providerStatus.checkedAt);
			await reload.refreshStatus();
			reload.refreshLanguageModelChatInformation();
			await reload.refreshStatus();
			assert.strictEqual(reloaded, 0, "a recorded source must not start another CLI process");
			assert.strictEqual(events.filter(entry => entry.event === "coco.discovery.skipped").length, 1, "the skip is logged once per source");
			const skipped = events.find(entry => entry.event === "coco.discovery.skipped")?.data;
			assert.strictEqual(skipped?.reason, "recorded");
			assert.strictEqual(skipped?.state, "connected");
			assert.strictEqual(typeof skipped?.ageMs, "number");
		} finally { token.dispose(); reload.dispose(); }
	});

	test("the first check without a record runs once and a reload starts no client", async () => {
		const { memento, values } = catalogState();
		let probes = 0;
		const first = new CocoChatModelProvider({ isEnabled: () => true, resolveCli: () => "mock-cli", catalogState: memento,
			createClient: () => { probes++; return discoveryClient(async () => sessionResult()); } });
		try {
			assert.strictEqual((await first.refreshStatus()).state, "connected");
			assert.strictEqual(probes, 1);
			await first.refreshStatus();
			assert.strictEqual(probes, 1);
			assert.match(JSON.stringify(values.get(COCO_CATALOG_KEY)), /test-model/);
		} finally { first.dispose(); }
		let reloaded = 0;
		const reload = new CocoChatModelProvider({ isEnabled: () => true, resolveCli: () => "mock-cli", catalogState: memento,
			createClient: () => { reloaded++; return discoveryClient(async () => sessionResult()); } });
		const token = new vscode.CancellationTokenSource();
		try {
			const models = await reload.provideLanguageModelChatInformation({ silent: true }, token.token);
			assert.ok(models.some(model => model.id === "coco::test-model"));
			assert.strictEqual(reloaded, 0);
		} finally { token.dispose(); reload.dispose(); }
	});

	test("a failed check writes a failure record and later automatic checks start no client", async () => {
		const { memento, values } = catalogState();
		let probes = 0;
		const provider = new CocoChatModelProvider({ isEnabled: () => true, resolveCli: () => "mock-cli", catalogState: memento,
			createClient: () => { probes++; throw new Error("Connection failed"); } });
		const token = new vscode.CancellationTokenSource();
		try {
			const failed = await provider.refreshStatus();
			assert.strictEqual(failed.state, "unavailable");
			assert.match(failed.summary, /Show Coco Connection Status/);
			assert.strictEqual(probes, 1);
			await provider.provideLanguageModelChatInformation({ silent: true }, token.token);
			await provider.refreshStatus();
			assert.strictEqual(probes, 1);
			const stored = values.get(COCO_CATALOG_KEY) as Array<{ state: string; summary: string }> | undefined;
			assert.strictEqual(stored?.[0]?.state, "unavailable");
			assert.match(stored![0].summary, /Show Coco Connection Status/);
		} finally { token.dispose(); provider.dispose(); }
		let reloaded = 0;
		const reload = new CocoChatModelProvider({ isEnabled: () => true, resolveCli: () => "mock-cli", catalogState: memento,
			createClient: () => { reloaded++; return discoveryClient(async () => sessionResult()); } });
		const retry = new vscode.CancellationTokenSource();
		try {
			await reload.provideLanguageModelChatInformation({ silent: true }, retry.token);
			assert.strictEqual(reload.providerStatus.state, "unavailable");
			assert.strictEqual(reloaded, 0);
		} finally { retry.dispose(); reload.dispose(); }
	});

	test("a forced check runs with a record and replaces it", async () => {
		const { memento } = catalogState();
		let model = "first-model", probes = 0;
		const provider = new CocoChatModelProvider({ isEnabled: () => true, resolveCli: () => "mock-cli", catalogState: memento,
			createClient: () => { probes++; return discoveryClient(async () => sessionResult("session", model, model)); } });
		try {
			await provider.refreshStatus();
			assert.strictEqual(probes, 1);
			model = "second-model";
			await provider.refreshStatus();
			assert.strictEqual(probes, 1, "a recorded source is not checked automatically");
			assert.strictEqual((await provider.refreshStatus(true)).state, "connected");
			assert.strictEqual(probes, 2);
		} finally { provider.dispose(); }
		const reload = new CocoChatModelProvider({ isEnabled: () => true, resolveCli: () => "mock-cli", catalogState: memento,
			createClient: () => { throw new Error("A recorded source must not be checked"); } });
		const token = new vscode.CancellationTokenSource();
		try {
			const models = await reload.provideLanguageModelChatInformation({ silent: true }, token.token);
			assert.ok(models.some(info => info.id === "coco::second-model"));
			assert.ok(!models.some(info => info.id === "coco::first-model"));
		} finally { token.dispose(); reload.dispose(); }
	});

	test("a ready native turn records the catalog without a separate check", async () => {
		const { memento, values } = catalogState();
		let probes = 0, turns = 0;
		const provider = new CocoChatModelProvider({ isEnabled: () => true, resolveCli: () => "mock-cli", catalogState: memento,
			createClient: (_executable, _cwd, _connection, model, handlers) => {
				if (!model) { probes++; return discoveryClient(async () => sessionResult()); }
				turns++;
				return { initialize: async () => undefined, newSession: async () => sessionResult("chat"),
					prompt: async () => { handlers?.onUpdate?.({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "Hi" } }); return { stopReason: "end_turn" }; },
					cancel: () => undefined, dispose: () => undefined } as unknown as CocoAcpClient;
			} });
		const token = new vscode.CancellationTokenSource();
		try {
			await provider.provideLanguageModelChatResponse(mapCocoModel({ id: "auto", name: "Auto" }),
				[vscode.LanguageModelChatMessage.User("Hello")],
				{ toolMode: vscode.LanguageModelChatToolMode.Auto }, { report: () => undefined }, token.token);
			assert.strictEqual(turns, 1);
			assert.strictEqual(probes, 0);
			const stored = values.get(COCO_CATALOG_KEY) as Array<{ state: string; models: Array<{ id: string }> }> | undefined;
			assert.strictEqual(stored?.[0]?.state, "connected");
			assert.ok(stored![0].models.some(model => model.id === "test-model"));
			await provider.refreshStatus();
			assert.strictEqual(probes, 0, "the turn's record must satisfy later automatic checks");
		} finally { token.dispose(); provider.dispose(); }
	});

	test("redacts credential-like runs and classifies discovery failures", () => {
		const redacted = redactCocoDiagnostic("OAuth failed Bearer ya29.abcdefghijklmnopqrstuvwxyz0123456789"
			+ " token=secret-value eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.signature"
			+ " 0123456789abcdef0123456789abcdef done");
		assert.match(redacted, /OAuth failed/);
		assert.match(redacted, /done$/);
		assert.ok(!redacted.includes("ya29.abcdefghijklmnopqrstuvwxyz0123456789"));
		assert.ok(!redacted.includes("secret-value"));
		assert.ok(!redacted.includes("eyJhbGciOiJIUzI1NiJ9"));
		assert.ok(!redacted.includes("0123456789abcdef0123456789abcdef"));
		assert.strictEqual(redactCocoDiagnostic("failure ".repeat(100)).length, 300);
		assert.strictEqual(redactCocoDiagnostic(new Error("plain failure")), "plain failure");
		assert.strictEqual(classifyCocoDiscoveryError(new Error("Coco initialize timed out.")), "timeout");
		assert.strictEqual(classifyCocoDiscoveryError(new Error("Cannot start Coco CLI: spawn ENOENT")), "cli_missing");
		assert.strictEqual(classifyCocoDiscoveryError(new Error("Request failed"), "OAuth login expired (401)"), "auth");
		assert.strictEqual(classifyCocoDiscoveryError(new Error("something else")), "other");
	});

	test("shows the sign-in wait while initialization is pending and logs the check", async () => {
		let release!: () => void;
		const initialized = new Promise<void>(resolve => { release = resolve; });
		const events: Array<{ event: string; data: Record<string, unknown> }> = [];
		const { memento } = catalogState();
		const provider = new CocoChatModelProvider({ isEnabled: () => true, resolveCli: () => "mock-cli", catalogState: memento,
			signInHintMs: 5, discoveryTimeoutMs: 2_000, log: (event, data) => events.push({ event, data }),
			createClient: () => ({ initialize: () => initialized, newSession: async () => sessionResult(), dispose: () => undefined }) as unknown as CocoAcpClient });
		try {
			const pending = provider.refreshStatus(true);
			await new Promise(resolve => setTimeout(resolve, 30));
			assert.match(provider.providerStatus.summary, /Waiting for Snowflake sign-in/);
			release();
			assert.strictEqual((await pending).state, "connected");
			const started = events.find(entry => entry.event === "coco.discovery.started")?.data;
			assert.strictEqual(started?.forced, true);
			assert.strictEqual(started?.trigger, "manual");
			const finished = events.find(entry => entry.event === "coco.discovery.finished")?.data;
			assert.strictEqual(finished?.state, "connected");
			assert.strictEqual(finished?.models, 2);
			assert.strictEqual(finished?.waitedForSignIn, true);
		} finally { release(); provider.dispose(); }
	});

	test("closes a successful discovery connection gracefully and disposes failures at once", async () => {
		const closes: number[] = [];
		let disposed = 0;
		const provider = new CocoChatModelProvider({ isEnabled: () => true, resolveCli: () => "mock-cli",
			createClient: () => discoveryClient(async () => sessionResult(), {
				close: async (graceMs: number) => { closes.push(graceMs); },
				dispose: () => { disposed++; },
			}) });
		try {
			await provider.refreshStatus();
			assert.deepStrictEqual(closes, [5_000]);
			assert.strictEqual(disposed, 0);
		} finally { provider.dispose(); }
		const failedCloses: number[] = [];
		let failedDisposed = 0;
		const failing = new CocoChatModelProvider({ isEnabled: () => true, resolveCli: () => "mock-cli",
			createClient: () => discoveryClient(async () => { throw new Error("Connection failed"); }, {
				close: async (graceMs: number) => { failedCloses.push(graceMs); },
				dispose: () => { failedDisposed++; },
			}) });
		try {
			assert.strictEqual((await failing.refreshStatus(true)).state, "unavailable");
			assert.deepStrictEqual(failedCloses, []);
			assert.strictEqual(failedDisposed, 1);
		} finally { failing.dispose(); }
	});

	test("a cancelled check leaves no record", async () => {
		const { memento, values } = catalogState();
		const source = new vscode.CancellationTokenSource();
		const provider = new CocoChatModelProvider({ isEnabled: () => true, resolveCli: () => "mock-cli", catalogState: memento,
			createClient: () => discoveryClient(() => new Promise<Record<string, unknown>>(() => undefined)) });
		try {
			const pending = provider.refreshStatus(true, source.token);
			source.cancel();
			await pending;
			assert.strictEqual(values.get(COCO_CATALOG_KEY), undefined);
		} finally { provider.dispose(); source.dispose(); }
	});
});
