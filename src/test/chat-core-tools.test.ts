import * as assert from "node:assert";
import * as fsp from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import * as vscode from "vscode";
import { createCoreTools, findBundledRipgrep } from "../chat/tools/core-tools";
import type { ChatTool } from "../chat/tools/types";
import { displayPath, isInsideWorkspace, resolveToolPath } from "../chat/tools/workspace-paths";

suite("Chat core tools", () => {
	let tmpDir: string;
	let tools: ChatTool[];
	const tokens: vscode.CancellationTokenSource[] = [];

	setup(async () => {
		tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), "chat-core-tools-"));
		tools = createCoreTools({ roots: { roots: () => [tmpDir] } });
	});

	teardown(async () => {
		for (const token of tokens.splice(0)) {
			token.dispose();
		}
		await fsp.rm(tmpDir, { recursive: true, force: true });
	});

	function tool(name: string): ChatTool {
		const found = tools.find(candidate => candidate.name === name);
		assert.ok(found, `tool ${name} must exist`);
		return found;
	}

	async function invoke(name: string, input: unknown): Promise<string> {
		const source = new vscode.CancellationTokenSource();
		tokens.push(source);
		return tool(name).invoke(input, source.token);
	}

	test("resolveToolPath resolves absolute and relative paths and rejects bad values", () => {
		assert.strictEqual(resolveToolPath("src/file.ts", [tmpDir]), path.resolve(tmpDir, "src", "file.ts"));
		assert.strictEqual(
			resolveToolPath(path.join(tmpDir, "src", "..", "file.ts"), []),
			path.resolve(tmpDir, "file.ts")
		);
		assert.throws(() => resolveToolPath("file.ts", []), /workspace folder is required/);
		assert.throws(() => resolveToolPath("", [tmpDir]), /must not be empty/);
		assert.throws(() => resolveToolPath(42, [tmpDir]), /must be a string/);
	});

	test("isInsideWorkspace rejects prefix siblings and parent traversal", () => {
		const root = path.join(tmpDir, "repo");
		const sibling = path.join(tmpDir, "repo2", "file.ts");
		assert.strictEqual(isInsideWorkspace(root, [root]), true);
		assert.strictEqual(isInsideWorkspace(path.join(root, "src", "file.ts"), [root]), true);
		assert.strictEqual(isInsideWorkspace(sibling, [root]), false);
		assert.strictEqual(isInsideWorkspace(path.join(root, "..", "escape.ts"), [root]), false);
		if (process.platform === "win32") {
			assert.strictEqual(isInsideWorkspace(path.join(root.toUpperCase(), "File.ts"), [root]), true);
		}
	});

	test("displayPath shows workspace-relative forward slashes", () => {
		const root = path.join(tmpDir, "repo");
		assert.strictEqual(displayPath(path.join(root, "src", "file.ts"), [root]), "src/file.ts");
		assert.strictEqual(displayPath(path.join(tmpDir, "other.txt"), [root]), path.join(tmpDir, "other.txt"));
	});

	test("read_file returns the requested range with a header", async () => {
		const lines = Array.from({ length: 10 }, (_, index) => `line ${index + 1}`);
		await fsp.writeFile(path.join(tmpDir, "ten.txt"), `${lines.join("\n")}\n`, "utf8");
		const result = await invoke("read_file", { filePath: "ten.txt", startLine: 3, endLine: 5 });
		assert.strictEqual(result, "File: ten.txt (lines 3-5 of 10)\nline 3\nline 4\nline 5");
	});

	test("read_file caps a default read at 2000 lines and says so", async () => {
		const lines = Array.from({ length: 2005 }, (_, index) => `line ${index + 1}`);
		await fsp.writeFile(path.join(tmpDir, "long.txt"), lines.join("\n"), "utf8");
		const result = await invoke("read_file", { filePath: "long.txt" });
		assert.ok(result.startsWith("File: long.txt (lines 1-2000 of 2005)\n"));
		assert.match(result, /truncated at 2000 lines/);
		assert.strictEqual(result.split("\n").filter(line => line.startsWith("line ")).length, 2000);
	});

	test("read_file rejects binary files and missing files", async () => {
		await fsp.writeFile(path.join(tmpDir, "binary.bin"), Buffer.from([0x41, 0x00, 0x42]));
		await assert.rejects(invoke("read_file", { filePath: "binary.bin" }), /looks like a binary file/);
		await assert.rejects(invoke("read_file", { filePath: "missing.txt" }), /File not found/);
		await fsp.mkdir(path.join(tmpDir, "folder"));
		await assert.rejects(invoke("read_file", { filePath: "folder" }), /use list_dir/);
	});

	test("list_dir sorts directories first and marks them with a slash", async () => {
		await fsp.mkdir(path.join(tmpDir, "beta"));
		await fsp.mkdir(path.join(tmpDir, "Alpha"));
		await fsp.writeFile(path.join(tmpDir, "z.txt"), "", "utf8");
		await fsp.writeFile(path.join(tmpDir, "a.txt"), "", "utf8");
		const result = await invoke("list_dir", { path: "." });
		assert.strictEqual(result, "Alpha/\nbeta/\na.txt\nz.txt");
	});

	test("create_file creates parent directories and refuses an existing file", async () => {
		const result = await invoke("create_file", { filePath: "nested/deep/note.txt", content: "a\nb\n" });
		assert.strictEqual(result, "Created nested/deep/note.txt (2 lines).");
		assert.strictEqual(await fsp.readFile(path.join(tmpDir, "nested", "deep", "note.txt"), "utf8"), "a\nb\n");
		await assert.rejects(
			invoke("create_file", { filePath: "nested/deep/note.txt", content: "changed" }),
			/already exists/
		);
	});

	test("needsConfirmation flags paths outside the workspace only", () => {
		const outside = path.join(tmpDir, "..", "outside-file.txt");
		const create = tool("create_file");
		assert.strictEqual(create.needsConfirmation?.({ filePath: "inside.txt", content: "" }), undefined);
		assert.strictEqual(create.needsConfirmation?.({}), undefined);
		const confirmation = create.needsConfirmation?.({ filePath: outside, content: "" });
		assert.strictEqual(confirmation?.title, "Create a file outside the workspace");
		assert.strictEqual(confirmation?.detail, path.resolve(outside));
		const edit = tool("replace_string_in_file");
		assert.strictEqual(edit.needsConfirmation?.({ filePath: outside, oldString: "a", newString: "b" })?.title, "Edit a file outside the workspace");
	});

	test("replace_string_in_file replaces one unique occurrence", async () => {
		await fsp.writeFile(path.join(tmpDir, "edit.txt"), "alpha\nbeta\ngamma\n", "utf8");
		const result = await invoke("replace_string_in_file", { filePath: "edit.txt", oldString: "beta", newString: "BETA" });
		assert.strictEqual(result, "Edited edit.txt: replaced 1 occurrence (lines 2-2).");
		assert.strictEqual(await fsp.readFile(path.join(tmpDir, "edit.txt"), "utf8"), "alpha\nBETA\ngamma\n");
	});

	test("replace_string_in_file reports missing and repeated old strings", async () => {
		await fsp.writeFile(path.join(tmpDir, "edit.txt"), "dup\ndup\n", "utf8");
		await assert.rejects(
			invoke("replace_string_in_file", { filePath: "edit.txt", oldString: "absent", newString: "x" }),
			/oldString was not found/
		);
		await assert.rejects(
			invoke("replace_string_in_file", { filePath: "edit.txt", oldString: "dup", newString: "x" }),
			/oldString occurs 2 times/
		);
	});

	test("replace_string_in_file converts bare LF to CRLF in a CRLF file", async () => {
		await fsp.writeFile(path.join(tmpDir, "crlf.txt"), "alpha\r\nbeta\r\ngamma\r\n", "utf8");
		await invoke("replace_string_in_file", {
			filePath: "crlf.txt",
			oldString: "alpha\nbeta",
			newString: "alpha\nBETA",
		});
		const text = await fsp.readFile(path.join(tmpDir, "crlf.txt"), "utf8");
		assert.strictEqual(text, "alpha\r\nBETA\r\ngamma\r\n");
		assert.ok(!/(?<!\r)\n/.test(text), "the file must not contain bare LF");
	});

	test("replace_string_in_file preserves a UTF-8 BOM", async () => {
		await fsp.writeFile(path.join(tmpDir, "bom.txt"), "\uFEFFhello\n", "utf8");
		await invoke("replace_string_in_file", { filePath: "bom.txt", oldString: "hello", newString: "hi" });
		const text = await fsp.readFile(path.join(tmpDir, "bom.txt"), "utf8");
		assert.strictEqual(text, "\uFEFFhi\n");
	});

	test("replace_string_in_file edits an open document and saves it", async () => {
		const file = path.join(tmpDir, "open.txt");
		await fsp.writeFile(file, "one\ntwo\n", "utf8");
		const document = await vscode.workspace.openTextDocument(vscode.Uri.file(file));
		const result = await invoke("replace_string_in_file", { filePath: file, oldString: "two", newString: "three" });
		assert.strictEqual(result, "Edited open.txt: replaced 1 occurrence (lines 2-2).");
		assert.strictEqual(document.getText(), "one\nthree\n");
		assert.strictEqual(await fsp.readFile(file, "utf8"), "one\nthree\n");
	});

	test("grep_search matches a literal string with the bundled ripgrep", async function () {
		if (!findBundledRipgrep()) {
			this.skip();
			return;
		}
		await fsp.writeFile(
			path.join(tmpDir, "sample.ts"),
			"const a = \"a.b(\";\nconst b = \"axb(\";\n",
			"utf8"
		);
		const result = await invoke("grep_search", { query: "a.b(", includePattern: "*.ts" });
		assert.match(result, /sample\.ts:1: const a = "a\.b\("/);
		assert.doesNotMatch(result, /sample\.ts:2:/);
	});

	test("grep_search supports regular expressions", async function () {
		if (!findBundledRipgrep()) {
			this.skip();
			return;
		}
		await fsp.writeFile(path.join(tmpDir, "regex.ts"), "first\nsixth\nthird\n", "utf8");
		const result = await invoke("grep_search", {
			query: "^s(econ|ix)th$",
			isRegexp: true,
			includePattern: "*.ts",
			caseSensitive: true,
		});
		assert.match(result, /regex\.ts:2: sixth/);
	});

	test("grep_search reports no matches", async function () {
		if (!findBundledRipgrep()) {
			this.skip();
			return;
		}
		await fsp.writeFile(path.join(tmpDir, "nomatch.ts"), "nothing here\n", "utf8");
		assert.strictEqual(
			await invoke("grep_search", { query: "definitely-absent", includePattern: "*.ts" }),
			"No matches."
		);
	});

	test("get_errors returns a string without throwing", async () => {
		const file = path.join(tmpDir, "clean.ts");
		await fsp.writeFile(file, "export const value = 1;\n", "utf8");
		assert.strictEqual(await invoke("get_errors", { filePaths: [file] }), "No errors or warnings.");
		assert.strictEqual(typeof await invoke("get_errors", {}), "string");
	});
});
