import * as assert from "node:assert";
import * as vscode from "vscode";

import { LlamaCppChatModelProvider } from "../llama-provider";
import { LOCAL_PROBE_BACKOFF_DELAYS_MS, ProbeBackoff } from "../providers/probe-backoff";

const never: vscode.CancellationToken = {
	isCancellationRequested: false,
	onCancellationRequested: () => new vscode.Disposable(() => undefined),
};

class MemorySecrets implements vscode.SecretStorage {
	private readonly values = new Map<string, string>();
	get(key: string): Thenable<string | undefined> { return Promise.resolve(this.values.get(key)); }
	store(key: string, value: string): Thenable<void> { this.values.set(key, value); return Promise.resolve(); }
	delete(key: string): Thenable<void> { this.values.delete(key); return Promise.resolve(); }
	keys(): Thenable<string[]> { return Promise.resolve([...this.values.keys()]); }
	onDidChange = new vscode.EventEmitter<vscode.SecretStorageChangeEvent>().event;
}

suite("probe backoff", () => {
	test("grows 15 s, 30 s, 1 min, 2 min, 5 min and then stays at 5 min", () => {
		let now = 1_000;
		const changes: Array<{ failures: number; delayMs?: number }> = [];
		const backoff = new ProbeBackoff({
			now: () => now,
			onChange: state => changes.push({ failures: state.failureCount, delayMs: state.delayMs }),
		});
		assert.deepStrictEqual([...LOCAL_PROBE_BACKOFF_DELAYS_MS], [15_000, 30_000, 60_000, 120_000, 300_000]);
		const delays = [15_000, 30_000, 60_000, 120_000, 300_000, 300_000];
		for (const [index, delay] of delays.entries()) {
			assert.strictEqual(backoff.canProbe(), true);
			assert.strictEqual(backoff.failed(), delay);
			assert.strictEqual(backoff.canProbe(), false);
			assert.strictEqual(backoff.remainingMs(), delay);
			now += delay - 1;
			assert.strictEqual(backoff.canProbe(), false, `still paused 1 ms before ${delay}`);
			now += 1;
			assert.strictEqual(backoff.canProbe(), true, `allowed after ${delay}`);
			assert.strictEqual(backoff.failures, index + 1);
		}
		assert.deepStrictEqual(
			changes.map(change => change.delayMs),
			[15_000, 30_000, 60_000, 120_000, 300_000],
			"the pause is reported once per step, not on every failure at the cap"
		);
		assert.strictEqual(changes.at(-1)?.failures, 5);
	});

	test("a failure inside an active pause does not count twice", () => {
		let now = 1_000;
		const backoff = new ProbeBackoff({ now: () => now });
		assert.strictEqual(backoff.failed(), 15_000);
		assert.strictEqual(backoff.failed(), undefined);
		assert.strictEqual(backoff.failures, 1);
		now += 15_000;
		assert.strictEqual(backoff.failed(), 30_000);
	});

	test("success and reset clear the pause immediately", () => {
		const now = 1_000;
		const changes: Array<{ failures: number; delayMs?: number }> = [];
		const backoff = new ProbeBackoff({
			now: () => now,
			onChange: state => changes.push({ failures: state.failureCount, delayMs: state.delayMs }),
		});
		backoff.failed();
		backoff.failed();
		assert.strictEqual(backoff.canProbe(), false);
		backoff.succeeded();
		assert.strictEqual(backoff.canProbe(), true);
		assert.strictEqual(backoff.failures, 0);
		assert.strictEqual(backoff.nextProbeAt, undefined);
		assert.strictEqual(backoff.failed(), 15_000, "the schedule starts over after a success");
		backoff.reset();
		assert.strictEqual(backoff.canProbe(), true);
		assert.deepStrictEqual(changes.map(change => change.delayMs), [15_000, undefined, 15_000, undefined]);
	});
});

suite("local server probe backoff", () => {
	test("catalog polls retry 15 s, 30 s and 60 s after failures and a refresh retries at once", async () => {
		const provider = new LlamaCppChatModelProvider(new MemorySecrets(), "test-user-agent");
		const internals = provider as unknown as {
			localProbeBackoff: ProbeBackoff;
			getModelSources: () => Promise<Array<{ key: string; label: string; serverUrl: string }>>;
			fetchModels: () => Promise<unknown[]>;
			fetchRuntimeContextLength: () => Promise<number | undefined>;
		};
		let now = 1_000;
		internals.localProbeBackoff = new ProbeBackoff({ now: () => now });
		let modelRequests = 0;
		let slotRequests = 0;
		// With the default settings `localServerUrl` and `serverUrl` are both
		// http://localhost:8000, so createModelSources keeps only `primary`.
		internals.getModelSources = async () => [{ key: "primary", label: "Primary", serverUrl: "http://localhost:8000" }];
		internals.fetchModels = async () => {
			modelRequests += 1;
			throw new Error("connect ECONNREFUSED 127.0.0.1:8000");
		};
		internals.fetchRuntimeContextLength = async () => {
			slotRequests += 1;
			return 65_536;
		};
		const poll = () => provider.provideLanguageModelChatInformation({ silent: true }, never);
		try {
			await poll();
			assert.strictEqual(modelRequests, 1);
			await poll();
			assert.strictEqual(modelRequests, 1, "skipped during the 15 s pause");

			now += 15_000;
			await poll();
			assert.strictEqual(modelRequests, 2, "retried after 15 s");
			await poll();
			assert.strictEqual(modelRequests, 2, "skipped during the 30 s pause");

			now += 30_000;
			await poll();
			assert.strictEqual(modelRequests, 3, "retried after 30 s");
			await poll();
			assert.strictEqual(modelRequests, 3, "skipped during the 60 s pause");

			now += 60_000;
			await poll();
			assert.strictEqual(modelRequests, 4, "retried after 1 min");
			assert.strictEqual(slotRequests, 1, "a successful /slots answer is cached instead of polled again");

			provider.refreshLanguageModelChatInformation();
			await poll();
			assert.strictEqual(modelRequests, 5, "an explicit refresh retries at once");
			assert.strictEqual(slotRequests, 2, "the explicit refresh also re-reads /slots");
		} finally {
			provider.disposeCursorTransport();
		}
	});

	test("a health check probes the paused local server and clears the pause on success", async () => {
		const provider = new LlamaCppChatModelProvider(new MemorySecrets(), "test-user-agent");
		const internals = provider as unknown as {
			localProbeBackoff: ProbeBackoff;
			getModelSources: () => Promise<Array<{ key: string; label: string; serverUrl: string }>>;
			fetchModels: () => Promise<unknown[]>;
			fetchRuntimeContextLength: () => Promise<number | undefined>;
		};
		internals.localProbeBackoff = new ProbeBackoff({ now: () => 1_000 });
		let fail = true;
		let modelRequests = 0;
		internals.getModelSources = async () => [{ key: "local", label: "Local", serverUrl: "http://127.0.0.1:9" }];
		internals.fetchModels = async () => {
			modelRequests += 1;
			if (fail) {
				throw new Error("connect ECONNREFUSED 127.0.0.1:9");
			}
			return [{ id: "local-model" }];
		};
		internals.fetchRuntimeContextLength = async () => 65_536;
		const poll = () => provider.provideLanguageModelChatInformation({ silent: true }, never);
		try {
			await poll();
			assert.strictEqual(modelRequests, 1);
			await poll();
			assert.strictEqual(modelRequests, 1, "background discovery is paused");

			fail = false;
			const report = await provider.runHealthCheck("2.0.13", never);
			assert.strictEqual(modelRequests, 2, "the explicit health check probes despite the pause");
			assert.strictEqual(
				report.sources.find(source => source.key === "local")?.checks.find(check => check.id === "model-discovery")?.status,
				"pass"
			);
			await poll();
			assert.strictEqual(modelRequests, 3, "a successful health check clears the pause for discovery");
		} finally {
			provider.disposeCursorTransport();
		}
	});
});
