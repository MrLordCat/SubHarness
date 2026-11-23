import * as assert from "node:assert";
import * as fsp from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import * as vscode from "vscode";
import { createCoreTools } from "../chat/tools/core-tools";
import { reportEditErrors, snapshotDiagnostics, type EditDiagnosticsSource } from "../chat/tools/edit-diagnostics";

suite("Edit diagnostics", () => {
	const uri = vscode.Uri.file(path.join(os.tmpdir(), "diagnostics-test.ts"));
	let emitter: vscode.EventEmitter<vscode.DiagnosticChangeEvent>;
	let current: vscode.Diagnostic[];
	let source: EditDiagnosticsSource;
	let cancellation: vscode.CancellationTokenSource;
	const diagnostic = (message: string, line = 0): vscode.Diagnostic => new vscode.Diagnostic(new vscode.Range(line, 0, line, 1), message, vscode.DiagnosticSeverity.Error);
	setup(() => {
		emitter = new vscode.EventEmitter();
		current = [];
		cancellation = new vscode.CancellationTokenSource();
		source = { getDiagnostics: () => current, onDidChangeDiagnostics: emitter.event, openDocument: () => Promise.resolve({ languageId: "typescript" }), settleMs: 30, maxWaitMs: 150 };
	});
	teardown(() => { emitter.dispose(); cancellation.dispose(); });
	const event = (): vscode.DiagnosticChangeEvent => ({ uris: [uri] });
	const run = (before: readonly vscode.Diagnostic[] = []): Promise<string> => reportEditErrors(new Map([[uri.fsPath, before]]), source, cancellation.token, () => "test.ts");
	test("reports new errors using a multiset independent of position", async () => {
		current = [diagnostic("old")];
		const before = snapshotDiagnostics(uri, source);
		current = [diagnostic("old", 8), diagnostic("new", 2)];
		const result = run(before);
		emitter.fire(event());
		assert.match(await result, /test.ts:3:1 error new/);
		assert.doesNotMatch(await run([diagnostic("old", 1), diagnostic("new")]), /New errors/);
	});
	test("settles after the last event", async () => {
		source.settleMs = 130;
		source.maxWaitMs = 500;
		const started = Date.now();
		const result = run();
		emitter.fire(event());
		await new Promise(resolve => setTimeout(resolve, 100));
		emitter.fire(event());
		await result;
		assert.ok(Date.now() - started >= 210);
	});
	test("times out without events", async () => {
		const started = Date.now();
		assert.strictEqual(await run(), "");
		assert.ok(Date.now() - started >= 120);
	});
	test("skips markdown without previous diagnostics", async () => {
		source.openDocument = async () => ({ languageId: "markdown" });
		const started = Date.now();
		assert.strictEqual(await run(), "");
		assert.ok(Date.now() - started < 30);
	});
	test("waits for markdown with a previous warning", async () => {
		source.openDocument = async () => ({ languageId: "markdown" });
		const warning = diagnostic("warning");
		warning.severity = vscode.DiagnosticSeverity.Warning;
		const started = Date.now();
		assert.strictEqual(await run([warning]), "");
		assert.ok(Date.now() - started >= 120);
	});
	test("caps output at ten", async () => {
		current = Array.from({ length: 12 }, (_, i) => diagnostic(`error ${i}`));
		const result = run(); emitter.fire(event());
		assert.match(await result, /New errors in edited files \(12\):[\s\S]*… and 2 more/);
	});
	test("cancellation stops waiting", async () => {
		const started = Date.now();
		const result = run(); cancellation.cancel();
		assert.strictEqual(await result, "");
		assert.ok(Date.now() - started < 120);
	});
	test("replace tool appends diagnostics", async () => {
		const dir = await fsp.mkdtemp(path.join(os.tmpdir(), "edit-diag-"));
		try {
			const file = path.join(dir, "file.txt");
			await fsp.writeFile(file, "before");
			source.openDocument = async edited => { current = [diagnostic("introduced")]; emitter.fire({ uris: [edited] }); return { languageId: "typescript" }; };
			const tool = createCoreTools({ roots: { roots: () => [dir] }, diagnostics: source }).find(item => item.name === "replace_string_in_file");
			assert.ok(tool);
			const result = await tool.invoke({ filePath: file, oldString: "before", newString: "after" }, cancellation.token);
			assert.match(typeof result === "string" ? result : result.text, /New errors in edited files \(1\)/);
		} finally { await fsp.rm(dir, { recursive: true, force: true }); }
	});
});
