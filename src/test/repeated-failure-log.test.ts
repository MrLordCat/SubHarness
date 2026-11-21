import * as assert from "node:assert";
import { RepeatedFailureLog } from "../repeated-failure-log";

suite("repeated failure log", () => {
	function clockedLog(intervalMs = 1000) {
		let now = 0;
		const log = new RepeatedFailureLog(intervalMs, () => now);
		return { log, advance: (ms: number) => { now += ms; } };
	}

	test("logs a new failure and skips its identical repeats", () => {
		const { log, advance } = clockedLog();
		assert.strictEqual(log.report("codex", new Error("spawn codex ENOENT")), 0);
		advance(10);
		assert.strictEqual(log.report("codex", new Error("spawn codex ENOENT")), undefined);
		assert.strictEqual(log.report("codex", new Error("spawn codex ENOENT")), undefined);
	});

	test("logs again when the message changes", () => {
		const { log } = clockedLog();
		assert.strictEqual(log.report("codex", new Error("spawn codex ENOENT")), 0);
		assert.strictEqual(log.report("codex", new Error("timeout")), 0);
		assert.strictEqual(log.report("codex", new Error("timeout")), undefined);
	});

	test("logs once per interval with the number of skipped repeats", () => {
		const { log, advance } = clockedLog(1000);
		log.report("server", "ECONNREFUSED");
		advance(100);
		log.report("server", "ECONNREFUSED");
		advance(100);
		log.report("server", "ECONNREFUSED");
		advance(800);
		assert.strictEqual(log.report("server", "ECONNREFUSED"), 2);
		advance(10);
		assert.strictEqual(log.report("server", "ECONNREFUSED"), undefined);
		advance(1000);
		assert.strictEqual(log.report("server", "ECONNREFUSED"), 1);
	});

	test("keeps keys apart and forgets a failure once cleared", () => {
		const { log } = clockedLog();
		assert.strictEqual(log.report("a", "down"), 0);
		assert.strictEqual(log.report("b", "down"), 0);
		assert.strictEqual(log.clear("a"), true);
		assert.strictEqual(log.clear("a"), false);
		assert.strictEqual(log.report("a", "down"), 0);
		assert.strictEqual(log.report("b", "down"), undefined);
	});
});
