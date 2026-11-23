import * as assert from "node:assert";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as vscode from "vscode";
import { CocoHistoryArchive } from "../coco/history-transfer";
import { LlamaCppChatModelProvider } from "../llama-provider";
import { ProviderRegistry } from "../providers/provider-registry";
import { LlamaQuickActionsProvider } from "../ui/quick-access";
import { coalesce } from "../utils";

const never: vscode.CancellationToken = { isCancellationRequested: false, onCancellationRequested: () => new vscode.Disposable(() => undefined) };
const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

class MemorySecrets implements vscode.SecretStorage {
	private readonly values = new Map<string, string>();
	get(key: string): Thenable<string | undefined> { return Promise.resolve(this.values.get(key)); }
	store(key: string, value: string): Thenable<void> { this.values.set(key, value); return Promise.resolve(); }
	delete(key: string): Thenable<void> { this.values.delete(key); return Promise.resolve(); }
	keys(): Thenable<string[]> { return Promise.resolve([...this.values.keys()]); }
	onDidChange = new vscode.EventEmitter<vscode.SecretStorageChangeEvent>().event;
}

function model(id: string): vscode.LanguageModelChatInformation {
	return { id, name: id, family: "test", version: "1", maxInputTokens: 100, maxOutputTokens: 10, capabilities: {} };
}

suite("Agent runtime performance", () => {
	let directory: string;
	setup(() => { directory = fs.mkdtempSync(path.join(os.tmpdir(), "aab-runtime-perf-")); });
	teardown(() => { fs.rmSync(directory, { recursive: true, force: true }); });

	test("one catalog load answers a burst of model selections until an adapter changes", async () => {
		const changed = new vscode.EventEmitter<void>();
		let loads = 0;
		let release: (() => void) | undefined;
		const provider: vscode.LanguageModelChatProvider = {
			onDidChangeLanguageModelChatInformation: changed.event,
			provideLanguageModelChatInformation: async () => {
				loads++;
				await new Promise<void>(resolve => { release = resolve; });
				return [model(`example::model-${loads}`)];
			},
			provideLanguageModelChatResponse: async () => undefined,
			provideTokenCount: async () => 1,
		};
		const registry = new ProviderRegistry([{ id: "example", provider, ownsModel: () => false }]);
		try {
			const cancelled = new vscode.CancellationTokenSource();
			const burst = [registry.models({ silent: true }, never), registry.models({ silent: true }, cancelled.token), registry.models({ silent: true }, never)];
			await delay(0);
			cancelled.cancel();
			release?.();
			const [first, second, third] = await Promise.allSettled(burst);
			assert.strictEqual(loads, 1, "concurrent selections share one load");
			assert.strictEqual(first.status, "fulfilled");
			assert.strictEqual(second.status, "rejected", "a cancelled caller leaves without cancelling the others");
			assert.strictEqual(third.status, "fulfilled");

			assert.deepStrictEqual((await registry.models({ silent: true }, never)).map(item => item.id), ["example::model-1"]);
			assert.strictEqual(loads, 1, "a fresh answer is reused");
			assert.strictEqual(registry.resolve("example::model-1").id, "example");

			changed.fire();
			const reload = registry.models({ silent: true }, never);
			await delay(0);
			release?.();
			assert.deepStrictEqual((await reload).map(item => item.id), ["example::model-2"]);
			assert.strictEqual(loads, 2, "an adapter change drops the shared answer");
		} finally {
			registry.dispose();
			changed.dispose();
		}
	});

	test("an unreachable HTTP source is not asked again on every catalog poll", async () => {
		const provider = new LlamaCppChatModelProvider(new MemorySecrets(), "test-user-agent");
		const internals = provider as unknown as {
			getModelSources: () => Promise<Array<{ key: string; label: string; serverUrl: string }>>;
			fetchModels: () => Promise<unknown[]>;
			fetchRuntimeContextLength: () => Promise<number | undefined>;
		};
		let modelRequests = 0, slotRequests = 0;
		internals.getModelSources = async () => [{ key: "local", label: "Local", serverUrl: "http://127.0.0.1:9" }];
		internals.fetchModels = async () => { modelRequests++; throw new Error("connect ECONNREFUSED 127.0.0.1:9"); };
		internals.fetchRuntimeContextLength = async () => { slotRequests++; return undefined; };
		const poll = () => provider.provideLanguageModelChatInformation({ silent: true }, never);
		try {
			assert.deepStrictEqual(await poll(), []);
			assert.deepStrictEqual(await poll(), []);
			assert.deepStrictEqual(await poll(), []);
			assert.strictEqual(modelRequests, 1, "the failed source waits before the next attempt");
			assert.strictEqual(slotRequests, 1, "an empty /slots answer is not repeated on every poll");

			provider.refreshLanguageModelChatInformation();
			await poll();
			assert.strictEqual(modelRequests, 2, "an explicit refresh retries at once");
			assert.strictEqual(slotRequests, 2);
		} finally {
			provider.disposeCursorTransport();
		}
	});

	test("coalesces bursts into one trailing run and flushes on demand", async () => {
		let runs = 0;
		const callback = coalesce(() => { runs++; }, 20);
		try {
			for (let index = 0; index < 10; index++) { callback(); }
			assert.strictEqual(runs, 0);
			await delay(60);
			assert.strictEqual(runs, 1);
			callback();
			callback.flush();
			await delay(0);
			assert.strictEqual(runs, 2, "flush runs the pending call now");
			callback();
			callback.dispose();
			await delay(60);
			assert.strictEqual(runs, 2, "a disposed callback does not run");
		} finally {
			callback.dispose();
		}
	});

	test("Quick Access rebuilds once per burst of refresh requests", async () => {
		const view = new LlamaQuickActionsProvider({});
		let rebuilds = 0;
		const listener = view.onDidChangeTreeData(() => { rebuilds++; });
		try {
			for (let index = 0; index < 25; index++) { view.refresh(); }
			assert.strictEqual(rebuilds, 0);
			await delay(400);
			assert.strictEqual(rebuilds, 1);
		} finally {
			listener.dispose();
			view.dispose();
		}
	});

	test("prunes only stale Coco archive files", async () => {
		const scope = path.join(directory, "a".repeat(64));
		const stale = path.join(directory, "b".repeat(64));
		const other = path.join(directory, "not-an-archive");
		for (const folder of [scope, stale, other]) { fs.mkdirSync(folder); }
		const old = new Date(Date.now() - 20 * 24 * 60 * 60_000);
		const write = (file: string, aged: boolean) => { fs.writeFileSync(file, "x"); if (aged) { fs.utimesSync(file, old, old); } };
		write(path.join(scope, "old.txt"), true);
		write(path.join(scope, "new.txt"), false);
		write(path.join(stale, "old.png"), true);
		write(path.join(other, "old.txt"), true);
		write(path.join(directory, "sessions.json"), true);

		const removed = await new CocoHistoryArchive(directory).prune(14 * 24 * 60 * 60_000);
		assert.strictEqual(removed, 2);
		assert.ok(!fs.existsSync(path.join(scope, "old.txt")));
		assert.ok(fs.existsSync(path.join(scope, "new.txt")));
		assert.ok(!fs.existsSync(stale), "an emptied archive scope is removed");
		assert.ok(fs.existsSync(path.join(other, "old.txt")), "foreign directories are not touched");
		assert.ok(fs.existsSync(path.join(directory, "sessions.json")), "the session store is not touched");
	});
});
