import * as assert from "node:assert";
import * as fsp from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import * as vscode from "vscode";
import { createCoreTools, findBundledRipgrep } from "../chat/tools/core-tools";
import { MAX_IMAGE_BYTES, type ChatTool, type ChatToolOutput } from "../chat/tools/types";
import { displayPath, isInsideWorkspace, resolveToolPath } from "../chat/tools/workspace-paths";

suite("Chat core tools", () => {
	let tmpDir: string;
	let tools: ChatTool[];
	const tokens: vscode.CancellationTokenSource[] = [];

	setup(async () => {
		tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), "chat-core-tools-"));
		tools = createCoreTools({ roots: { roots: () => [tmpDir] }, diagnostics: false });
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
		return (await invokeOutput(name, input)).text;
	}

	async function invokeOutput(name: string, input: unknown): Promise<ChatToolOutput> {
		const source = new vscode.CancellationTokenSource();
		tokens.push(source);
		const result = await tool(name).invoke(input, source.token);
		return typeof result === "string" ? { text: result } : result;
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

	test("view_image returns a PNG as text and base64 image data", async () => {
		const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==", "base64");
		await fsp.writeFile(path.join(tmpDir, "pixel.png"), png);
		const output = await invokeOutput("view_image", { filePath: "pixel.png" });
		assert.strictEqual(output.text, `Image pixel.png: image/png, ${png.byteLength} B (1×1).`);
		assert.deepStrictEqual(output.images?.map(image => [image.mimeType, image.byteLength, image.name]), [["image/png", png.byteLength, "pixel.png"]]);
		assert.deepStrictEqual(Buffer.from(output.images?.[0].data ?? "", "base64"), png);
	});

	test("view_image detects JPEG, GIF and WebP by magic bytes and reads GIF dimensions", async () => {
		await fsp.writeFile(path.join(tmpDir, "photo.jpeg"), Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10]));
		await fsp.writeFile(path.join(tmpDir, "anim.gif"), Buffer.concat([Buffer.from("GIF89a", "latin1"), Buffer.from([0x02, 0x00, 0x03, 0x00])]));
		await fsp.writeFile(path.join(tmpDir, "picture.webp"), Buffer.from("RIFF\x10\x00\x00\x00WEBP", "latin1"));
		assert.match((await invokeOutput("view_image", { filePath: "photo.jpeg" })).text, /^Image photo\.jpeg: image\/jpeg, 6 B\.$/);
		assert.match((await invokeOutput("view_image", { filePath: "anim.gif" })).text, /: image\/gif, 10 B \(2×3\)\.$/);
		assert.match((await invokeOutput("view_image", { filePath: "picture.webp" })).text, /: image\/webp, 12 B\.$/);
	});

	test("view_image rejects text files, missing files and oversized images", async () => {
		await fsp.writeFile(path.join(tmpDir, "notes.txt"), "plain text", "utf8");
		await assert.rejects(invoke("view_image", { filePath: "notes.txt" }), /is not a PNG, JPEG, GIF or WebP image/);
		await assert.rejects(invoke("view_image", { filePath: "missing.png" }), /File not found/);
		await fsp.writeFile(path.join(tmpDir, "huge.png"), Buffer.alloc(MAX_IMAGE_BYTES + 1));
		await assert.rejects(invoke("view_image", { filePath: "huge.png" }), /is 3\.6 MB; view_image accepts up to 3\.75 MB/);
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
		await fsp.mkdir(path.join(tmpDir, "nested"));
		await fsp.writeFile(path.join(tmpDir, "nested", "seed.txt"), "x\ny\n", "utf8");
		const result = await invoke("create_file", { filePath: "nested/deep/note.txt", content: "a\nb\n" });
		assert.strictEqual(result, "Created nested/deep/note.txt (2 lines, LF).");
		assert.strictEqual(await fsp.readFile(path.join(tmpDir, "nested", "deep", "note.txt"), "utf8"), "a\nb\n");
		await assert.rejects(
			invoke("create_file", { filePath: "nested/deep/note.txt", content: "changed" }),
			/already exists/
		);
	});

	test("create_file uses CRLF when nearby files of the same extension use CRLF", async () => {
		await fsp.writeFile(path.join(tmpDir, "style.ts"), "const a = 1;\r\nconst b = 2;\r\n", "utf8");
		const result = await invoke("create_file", { filePath: "nested/fresh.ts", content: "one\ntwo\n" });
		assert.strictEqual(result, "Created nested/fresh.ts (2 lines, CRLF).");
		assert.strictEqual(await fsp.readFile(path.join(tmpDir, "nested", "fresh.ts"), "utf8"), "one\r\ntwo\r\n");
	});

	test("create_file uses LF when nearby files of the same extension use LF", async () => {
		await fsp.writeFile(path.join(tmpDir, "style.txt"), "one\ntwo\n", "utf8");
		const result = await invoke("create_file", { filePath: "fresh.txt", content: "one\r\ntwo\n" });
		assert.strictEqual(result, "Created fresh.txt (2 lines, LF).");
		assert.strictEqual(await fsp.readFile(path.join(tmpDir, "fresh.txt"), "utf8"), "one\ntwo\n");
	});

	test("create_file writes single-line content as it is", async () => {
		await fsp.writeFile(path.join(tmpDir, "seed.txt"), "a\nb\n", "utf8");
		const result = await invoke("create_file", { filePath: "single.txt", content: "just one line" });
		assert.strictEqual(result, "Created single.txt (1 lines, LF).");
		assert.strictEqual(await fsp.readFile(path.join(tmpDir, "single.txt"), "utf8"), "just one line");
	});

	test("create_file and replace_string_in_file report the paths they may write", () => {
		const create = tool("create_file");
		const replace = tool("replace_string_in_file");
		assert.deepStrictEqual(
			create.writes?.({ filePath: "nested/deep/note.txt", content: "" }),
			[path.resolve(tmpDir, "nested", "deep", "note.txt")]
		);
		assert.deepStrictEqual(
			replace.writes?.({ filePath: "edit.txt", oldString: "a", newString: "b" }),
			[path.resolve(tmpDir, "edit.txt")]
		);
		assert.deepStrictEqual(create.writes?.({ filePath: 42, content: "" }), []);
		assert.deepStrictEqual(create.writes?.({}), []);
		assert.deepStrictEqual(replace.writes?.("not an object"), []);
	});

	test("needsConfirmation flags paths outside the workspace only", () => {
		const outside = path.join(tmpDir, "..", "outside-file.txt");
		const create = tool("create_file");
		assert.strictEqual(create.needsConfirmation?.({ filePath: "inside.txt", content: "" }), undefined);
		assert.strictEqual(create.needsConfirmation?.({}), undefined);
		const confirmation = create.needsConfirmation?.({ filePath: outside, content: "" });
		assert.deepStrictEqual(confirmation?.kinds?.map(kind => kind.key), ["write-outside-workspace"]);
		assert.deepStrictEqual(tool("replace_string_in_file").needsConfirmation?.({ filePath: outside })?.kinds?.map(kind => kind.key), ["write-outside-workspace"]);
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

	test("multi_replace_string_in_file applies edits in order across files", async () => {
		await fsp.writeFile(path.join(tmpDir, "first.txt"), "alpha\nbeta\n", "utf8");
		await fsp.writeFile(path.join(tmpDir, "second.txt"), "one\ntwo\n", "utf8");
		const result = await invoke("multi_replace_string_in_file", {
			replacements: [
				{ filePath: "first.txt", oldString: "alpha", newString: "ALPHA" },
				{ filePath: "first.txt", oldString: "ALPHA\nbeta", newString: "ALPHA\nBETA" },
				{ filePath: "second.txt", oldString: "two", newString: "TWO" },
			],
		});
		assert.strictEqual(
			result,
			"Applied 3 of 3 replacements:\n1. Edited first.txt: replaced 1 occurrence (lines 1-1).\n"
			+ "2. Edited first.txt: replaced 1 occurrence (lines 1-2).\n3. Edited second.txt: replaced 1 occurrence (lines 2-2)."
		);
		assert.strictEqual(await fsp.readFile(path.join(tmpDir, "first.txt"), "utf8"), "ALPHA\nBETA\n");
		assert.strictEqual(await fsp.readFile(path.join(tmpDir, "second.txt"), "utf8"), "one\nTWO\n");
	});

	test("multi_replace_string_in_file reports failed items and keeps going", async () => {
		await fsp.writeFile(path.join(tmpDir, "partial.txt"), "one\ntwo\nthree\n", "utf8");
		const result = await invoke("multi_replace_string_in_file", {
			replacements: [
				{ filePath: "partial.txt", oldString: "one", newString: "ONE" },
				{ filePath: "partial.txt", oldString: "absent", newString: "x" },
				{ filePath: "partial.txt", oldString: "three", newString: "THREE" },
			],
		});
		assert.match(result, /^Applied 2 of 3 replacements:\n/);
		assert.match(result, /\n2\. Failed: oldString was not found in partial\.txt\./);
		assert.match(result, /\n3\. Edited partial\.txt: replaced 1 occurrence/);
		assert.strictEqual(await fsp.readFile(path.join(tmpDir, "partial.txt"), "utf8"), "ONE\ntwo\nTHREE\n");
	});

	test("multi_replace_string_in_file throws when every replacement fails", async () => {
		await fsp.writeFile(path.join(tmpDir, "none.txt"), "only\n", "utf8");
		await assert.rejects(
			invoke("multi_replace_string_in_file", {
				replacements: [
					{ filePath: "none.txt", oldString: "missing", newString: "x" },
					{ filePath: "gone.txt", oldString: "a", newString: "b" },
				],
			}),
			/None of the 2 replacements applied:\n1\. Failed: oldString was not found[\s\S]*2\. Failed: File not found/
		);
	});

	test("multi_replace_string_in_file validates its replacements array", async () => {
		await assert.rejects(invoke("multi_replace_string_in_file", { replacements: [] }), /non-empty array/);
		await assert.rejects(invoke("multi_replace_string_in_file", { replacements: "x" }), /non-empty array/);
		await assert.rejects(invoke("multi_replace_string_in_file", {}), /non-empty array/);
		await assert.rejects(
			invoke("multi_replace_string_in_file", { replacements: Array.from({ length: 51 }, () => ({ filePath: "x.txt", oldString: "a", newString: "b" })) }),
			/at most 50 items/
		);
	});

	test("multi_replace_string_in_file keeps CRLF files in CRLF", async () => {
		await fsp.writeFile(path.join(tmpDir, "multi-crlf.txt"), "alpha\r\nbeta\r\ngamma\r\n", "utf8");
		await invoke("multi_replace_string_in_file", {
			replacements: [
				{ filePath: "multi-crlf.txt", oldString: "alpha\nbeta", newString: "alpha\nBETA" },
				{ filePath: "multi-crlf.txt", oldString: "gamma", newString: "GAMMA" },
			],
		});
		const text = await fsp.readFile(path.join(tmpDir, "multi-crlf.txt"), "utf8");
		assert.strictEqual(text, "alpha\r\nBETA\r\nGAMMA\r\n");
		assert.ok(!/(?<!\r)\n/.test(text), "the file must not contain bare LF");
	});

	test("multi_replace_string_in_file reports its resolved write paths once", () => {
		const multi = tool("multi_replace_string_in_file");
		assert.deepStrictEqual(
			multi.writes?.({
				replacements: [
					{ filePath: "one.txt", oldString: "a", newString: "b" },
					{ filePath: path.join(tmpDir, "one.txt"), oldString: "c", newString: "d" },
					{ filePath: "two.txt", oldString: "e", newString: "f" },
					{ filePath: 42, oldString: "g", newString: "h" },
				],
			}),
			[path.resolve(tmpDir, "one.txt"), path.resolve(tmpDir, "two.txt")]
		);
		assert.deepStrictEqual(multi.writes?.({}), []);
		assert.deepStrictEqual(multi.writes?.("not an object"), []);
	});

	test("multi_replace_string_in_file needs confirmation for outside paths", () => {
		const multi = tool("multi_replace_string_in_file");
		assert.strictEqual(multi.needsConfirmation?.({
			replacements: [{ filePath: "inside.txt", oldString: "a", newString: "b" }],
		}), undefined);
		assert.strictEqual(multi.needsConfirmation?.({}), undefined);
		const outside = path.join(tmpDir, "..", "outside-multi.txt");
		const confirmation = multi.needsConfirmation?.({
			replacements: [
				{ filePath: "inside.txt", oldString: "a", newString: "b" },
				{ filePath: outside, oldString: "c", newString: "d" },
			],
		});
		assert.deepStrictEqual(confirmation?.kinds?.map(kind => kind.key), ["write-outside-workspace"]);
		assert.strictEqual(confirmation?.title, "Edit files outside the workspace");
		assert.strictEqual(confirmation?.detail, path.resolve(outside));
		assert.strictEqual(confirmation?.reason, "The path is outside the open workspace folders.");
		const unrooted = createCoreTools({ roots: { roots: () => [] } }).find(candidate => candidate.name === "multi_replace_string_in_file");
		const unrootedConfirmation = unrooted?.needsConfirmation?.({
			replacements: [{ filePath: "relative.txt", oldString: "a", newString: "b" }],
		});
		assert.strictEqual(unrootedConfirmation?.detail, path.resolve("relative.txt"));
	});

	test("delete_file deletes a file and reports missing files", async () => {
		await fsp.writeFile(path.join(tmpDir, "gone.txt"), "bye\n", "utf8");
		assert.strictEqual(await invoke("delete_file", { filePath: "gone.txt" }), "Deleted gone.txt.");
		await assert.rejects(fsp.stat(path.join(tmpDir, "gone.txt")), /ENOENT/);
		await assert.rejects(invoke("delete_file", { filePath: "gone.txt" }), /File not found: gone\.txt/);
	});

	test("delete_file refuses a non-empty folder unless recursive is true", async () => {
		await fsp.mkdir(path.join(tmpDir, "folder"));
		await fsp.writeFile(path.join(tmpDir, "folder", "inner.txt"), "x\n", "utf8");
		await assert.rejects(invoke("delete_file", { filePath: "folder" }), /not empty; pass recursive: true/);
		assert.ok(await fsp.stat(path.join(tmpDir, "folder")));
		assert.strictEqual(await invoke("delete_file", { filePath: "folder", recursive: true }), "Deleted folder folder.");
		await assert.rejects(fsp.stat(path.join(tmpDir, "folder")), /ENOENT/);
	});

	test("delete_file refuses to delete the workspace folder", async () => {
		await assert.rejects(invoke("delete_file", { filePath: tmpDir, recursive: true }), /workspace folder/);
		assert.ok(await fsp.stat(tmpDir));
	});

	test("delete_file needs confirmation for recursive folders and outside paths", async () => {
		const remove = tool("delete_file");
		await fsp.mkdir(path.join(tmpDir, "folder"));
		await fsp.writeFile(path.join(tmpDir, "plain.txt"), "x\n", "utf8");
		assert.strictEqual(remove.needsConfirmation?.({ filePath: "plain.txt", recursive: true }), undefined);
		assert.strictEqual(remove.needsConfirmation?.({ filePath: "folder" }), undefined);
		assert.strictEqual(remove.needsConfirmation?.({ filePath: "missing", recursive: true }), undefined);
		const folder = remove.needsConfirmation?.({ filePath: "folder", recursive: true });
		assert.deepStrictEqual(folder?.kinds?.map(kind => kind.key), ["delete-folder"]);
		const outsideFolder = path.join(tmpDir, "..", path.basename(tmpDir) + "-outside");
		await fsp.mkdir(outsideFolder);
		try {
			const outsideFile = path.join(outsideFolder, "file.txt");
			await fsp.writeFile(outsideFile, "x");
			assert.deepStrictEqual(remove.needsConfirmation?.({ filePath: outsideFile, recursive: true })?.kinds?.map(kind => kind.key), ["write-outside-workspace"]);
			await fsp.unlink(outsideFile);
			const both = remove.needsConfirmation?.({ filePath: outsideFolder, recursive: true });
			assert.strictEqual(both?.title, "Delete a folder outside the workspace");
			assert.deepStrictEqual(both?.kinds?.map(kind => kind.key), ["write-outside-workspace", "delete-folder"]);
		} finally {
			await fsp.rmdir(outsideFolder);
		}
		assert.strictEqual(folder?.title, "Delete a folder");
		assert.strictEqual(folder?.detail, path.resolve(tmpDir, "folder"));
		assert.strictEqual(folder?.reason, "Deletes the folder and everything in it.");
		const outside = path.join(tmpDir, "..", "outside-delete.txt");
		const confirmation = remove.needsConfirmation?.({ filePath: outside });
		assert.deepStrictEqual(confirmation?.kinds?.map(kind => kind.key), ["write-outside-workspace"]);
		assert.strictEqual(confirmation?.title, "Delete outside the workspace");
		assert.strictEqual(confirmation?.detail, path.resolve(outside));
		assert.strictEqual(confirmation?.reason, "The path is outside the open workspace folders.");
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

	test("grep_search applies a slash includePattern relative to the workspace root", async function () {
		if (!findBundledRipgrep()) {
			this.skip();
			return;
		}
		await fsp.mkdir(path.join(tmpDir, "sub", "dir"), { recursive: true });
		await fsp.mkdir(path.join(tmpDir, "other"), { recursive: true });
		await fsp.writeFile(path.join(tmpDir, "sub", "dir", "a.ts"), "const globMarker = 1;\n", "utf8");
		await fsp.writeFile(path.join(tmpDir, "other", "a.ts"), "const globMarker = 2;\n", "utf8");
		const result = await invoke("grep_search", { query: "globMarker", includePattern: "sub/dir/*.ts" });
		assert.match(result, /sub\/dir\/a\.ts:1: const globMarker = 1;/);
		assert.doesNotMatch(result, /other\/a\.ts/);
	});

	test("grep_search turns an absolute includePattern folder into a root-relative glob", async function () {
		if (!findBundledRipgrep()) {
			this.skip();
			return;
		}
		await fsp.mkdir(path.join(tmpDir, "abs", "nested"), { recursive: true });
		await fsp.writeFile(path.join(tmpDir, "abs", "nested", "one.ts"), "const absoluteMarker = 1;\n", "utf8");
		await fsp.writeFile(path.join(tmpDir, "absolute.ts"), "const absoluteMarker = 2;\n", "utf8");
		const result = await invoke("grep_search", { query: "absoluteMarker", includePattern: path.join(tmpDir, "abs") });
		assert.match(result, /abs\/nested\/one\.ts:1: const absoluteMarker = 1;/);
		assert.doesNotMatch(result, /absolute\.ts/);
		await assert.rejects(
			invoke("grep_search", { query: "absoluteMarker", includePattern: path.join(tmpDir, "..") }),
			/must be inside the workspace/
		);
	});

	test("grep_search strips a leading ./ from includePattern", async function () {
		if (!findBundledRipgrep()) {
			this.skip();
			return;
		}
		await fsp.mkdir(path.join(tmpDir, "sub", "deep"), { recursive: true });
		await fsp.mkdir(path.join(tmpDir, "other"), { recursive: true });
		await fsp.writeFile(path.join(tmpDir, "sub", "a.ts"), "const dotMarker = 1;\n", "utf8");
		await fsp.writeFile(path.join(tmpDir, "sub", "deep", "b.ts"), "const dotMarker = 2;\n", "utf8");
		await fsp.writeFile(path.join(tmpDir, "other", "a.ts"), "const dotMarker = 3;\n", "utf8");
		const result = await invoke("grep_search", { query: "dotMarker", includePattern: "./sub/**" });
		assert.match(result, /sub\/a\.ts:1: const dotMarker = 1;/);
		assert.match(result, /sub\/deep\/b\.ts:1: const dotMarker = 2;/);
		assert.doesNotMatch(result, /other\/a\.ts/);
	});

	test("get_errors returns a string without throwing", async () => {
		const file = path.join(tmpDir, "clean.ts");
		await fsp.writeFile(file, "export const value = 1;\n", "utf8");
		assert.strictEqual(await invoke("get_errors", { filePaths: [file] }), "No errors or warnings.");
		assert.strictEqual(typeof await invoke("get_errors", {}), "string");
	});
});
