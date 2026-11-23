import * as assert from "node:assert";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as vscode from "vscode";
import { createCheckTool, parseCheckOutput, resolveChecks } from "../chat/tools/check-tools";
import { compileDangerousCommandRules } from "../chat/tools/danger";

suite("chat check tools", () => {
	let root: string;
	setup(() => { root = fs.mkdtempSync(path.join(os.tmpdir(), "checks-")); });
	teardown(() => { fs.rmSync(root, { recursive: true, force: true }); });
	function config(checks: object[]): void {
		fs.mkdirSync(path.join(root, ".subharness"), { recursive: true });
		fs.writeFileSync(path.join(root, ".subharness", "checks.json"), JSON.stringify({ checks }));
	}
	test("parses summaries and fallback", () => {
		assert.match(parseCheckOutput("  4 passing\n  2 pending\n  1 failing", false), /4 passing, 2 pending, 1 failing/);
		assert.match(parseCheckOutput("src/a.ts(12,5): error TS2322: bad\nsrc/b.ts:1:2 - error TS1234: bad", true), /TypeScript errors: 2/);
		assert.match(parseCheckOutput("a.ts\n  1:2  error  bad  rule\n✖ 1 problem (1 error, 0 warnings)", true), /a.ts: 1:2/);
		assert.match(parseCheckOutput("plain failure", true), /plain failure/);
	});
	test("parses mocha failures", () => {
		const parsed = parseCheckOutput("      1) inline marker\n      ✔ passing test\n\n  2 failing\n\n  1) suite one\n       first test:\n\n     Error: first\n\n  2) suite two\n       second test:\n\n     Error: second\n", true);
		assert.doesNotMatch(parsed, /inline marker|passing test/);
		assert.match(parsed, /suite one[\s\S]*first test[\s\S]*Error: first/);
		assert.match(parsed, /suite two[\s\S]*second test[\s\S]*Error: second/);
	});
	test("cancellation stops subsequent checks and prunes logs", async () => {
		config([{ name: "slow", command: "node -e \"setTimeout(() => {}, 60000)\"" }, { name: "next", command: "node -v" }]);
		const logs = path.join(root, "logs");
		fs.mkdirSync(logs);
		for (let i = 0; i < 51; i++) { fs.writeFileSync(path.join(logs, `old-${i}.log`), "old"); }
		const tool = createCheckTool({ logDir: logs, roots: () => [root], isTrusted: () => true, rules: () => [] });
		const source = new vscode.CancellationTokenSource();
		const timer = setTimeout(() => source.cancel(), 300);
		try {
			const result = String(await tool.invoke({}, source.token));
			assert.match(result, /slow — CANCELLED/);
			assert.doesNotMatch(result, /next —/);
			assert.strictEqual(fs.readdirSync(logs).length, 50);
		} finally { clearTimeout(timer); source.dispose(); }
	});
	test("invalid selections do not request approval", async () => {
		config([{ name: "ok", command: "node -v" }]);
		const tool = createCheckTool({ logDir: path.join(root, "logs"), roots: () => [root], isTrusted: () => true, rules: () => [] });
		const input = { checks: ["missing"] };
		assert.strictEqual(tool.needsConfirmation?.(input), undefined);
		const source = new vscode.CancellationTokenSource();
		try {
			await assert.rejects(tool.invoke(input, source.token), /Unknown check missing\. Available: ok\./);
		} finally {
			source.dispose();
		}
	});
	test("timeout stops remaining checks", async () => {
		config([{ name: "slow", command: 'node -e "setTimeout(()=>{},60000)"', timeoutMs: 300 }, { name: "next", command: "node -v" }]);
		const tool = createCheckTool({ logDir: path.join(root, "logs"), roots: () => [root], isTrusted: () => true, rules: () => [], minTimeoutMs: 300 });
		const source = new vscode.CancellationTokenSource();
		try {
			const result = String(await tool.invoke({}, source.token));
			assert.match(result, /slow — TIMED OUT/);
			assert.doesNotMatch(result, /next —/);
		} finally {
			source.dispose();
		}
	});
	test("configuration precedence and validation", () => {
		fs.writeFileSync(path.join(root, "package.json"), JSON.stringify({ scripts: { build: "x", lint: "x", test: "x" } }));
		assert.deepStrictEqual(resolveChecks(root).map(c => c.name), ["compile", "lint", "test"]);
		config([{ name: "custom", command: "node -v" }]);
		assert.deepStrictEqual(resolveChecks(root).map(c => c.name), ["custom"]);
		config([{ name: "bad name", command: "x" }]);
		assert.throws(() => resolveChecks(root), /Invalid/);
	});
	test("approval and running checks", async () => {
		config([{ name: "ok", command: "node -e \"console.log('ok')\"" }, { name: "fail", command: "node -e \"process.exit(3)\"" }]);
		const tool = createCheckTool({ logDir: path.join(root, "logs"), roots: () => [root], isTrusted: () => true, rules: () => compileDangerousCommandRules(["process\\.exit"]) });
		assert.ok(tool.needsConfirmation?.({}));
		assert.strictEqual(tool.needsConfirmation?.({ checks: ["ok"] }), undefined);
		const result = await tool.invoke({}, new vscode.CancellationTokenSource().token);
		assert.match(String(result), /ok — PASSED/);
		assert.match(String(result), /fail — FAILED \(exit 3\)/);
		assert.strictEqual(fs.readdirSync(path.join(root, "logs")).length, 2);
	});
});
