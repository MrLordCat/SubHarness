import * as assert from "node:assert";
import * as path from "node:path";
import { openFileReference, referenceSelection, type FileReferenceOpener } from "../chat/file-opener";
import type { FileReference } from "../chat/shared/file-reference";

const ROOT = path.resolve(process.platform === "win32" ? "C:\\work\\project" : "/work/project");
const OTHER = path.resolve(process.platform === "win32" ? "C:\\work\\other" : "/work/other");

/** Records what the opener was asked to do, over a fake file system. */
function fakeOpener(entries: Record<string, "file" | "directory">, found: string[] = [], picked?: string): FileReferenceOpener & { calls: string[]; opened: Array<[string, FileReference]> } {
	const calls: string[] = [];
	const opened: Array<[string, FileReference]> = [];
	return {
		calls,
		opened,
		folders: () => [ROOT, OTHER],
		stat: async fsPath => entries[fsPath],
		find: async (relative, limit) => {
			calls.push(`find:${relative}:${limit}`);
			return found;
		},
		openFile: async (fsPath, reference) => {
			calls.push(`open:${fsPath}`);
			opened.push([fsPath, reference]);
		},
		reveal: async fsPath => { calls.push(`reveal:${fsPath}`); },
		pick: async candidates => {
			calls.push(`pick:${candidates.length}`);
			return picked;
		},
		notFound: async reference => { calls.push(`notFound:${reference.path}`); },
	};
}

suite("chat file opener", () => {
	test("opens a relative file from the first workspace folder that has it, at its line", async () => {
		const file = path.join(OTHER, "docs", "report.md");
		const opener = fakeOpener({ [file]: "file" });
		assert.strictEqual(await openFileReference("docs/report.md:12", opener), "opened");
		assert.deepStrictEqual(opener.calls, [`open:${file}`]);
		assert.deepStrictEqual(opener.opened[0][1], { path: "docs/report.md", line: 12 });
	});

	test("opens an absolute path and a file: URI without searching", async () => {
		const file = path.join(ROOT, "src", "a.ts");
		const opener = fakeOpener({ [file]: "file" });
		assert.strictEqual(await openFileReference(file, opener), "opened");
		const uri = `file:///${file.replace(/\\/g, "/").replace(/^\//, "")}#L3`;
		assert.strictEqual(await openFileReference(uri, opener), "opened");
		assert.deepStrictEqual(opener.calls, [`open:${file}`, `open:${file}`]);
		assert.strictEqual(opener.opened[1][1].line, 3);
	});

	test("reveals a folder in the Explorer", async () => {
		const folder = path.join(ROOT, "docs");
		const opener = fakeOpener({ [folder]: "directory" });
		assert.strictEqual(await openFileReference("docs/", opener), "revealed");
		assert.deepStrictEqual(opener.calls, [`reveal:${folder}`]);
	});

	test("a bare file name opens the only workspace match and asks among several", async () => {
		const match = path.join(ROOT, "src", "chat", "chat-controller.ts");
		const single = fakeOpener({}, [match]);
		assert.strictEqual(await openFileReference("chat-controller.ts:120", single), "opened");
		assert.deepStrictEqual(single.calls, ["find:chat-controller.ts:20", `open:${match}`]);

		const second = path.join(OTHER, "chat-controller.ts");
		const several = fakeOpener({}, [match, second, match], second);
		assert.strictEqual(await openFileReference("./chat-controller.ts", several), "picked");
		assert.deepStrictEqual(several.calls, ["find:chat-controller.ts:20", "pick:2", `open:${second}`]);

		const cancelled = fakeOpener({}, [match, second]);
		assert.strictEqual(await openFileReference("chat-controller.ts", cancelled), "cancelled");
		assert.ok(!cancelled.calls.some(call => call.startsWith("open:")));
	});

	test("reports a missing file and never searches for absolute paths, parent paths or globs", async () => {
		const opener = fakeOpener({});
		assert.strictEqual(await openFileReference(path.join(ROOT, "missing.md"), opener), "notFound");
		assert.strictEqual(await openFileReference("../outside/missing.md", opener), "notFound");
		assert.deepStrictEqual(opener.calls.filter(call => call.startsWith("find:")), []);
		assert.strictEqual(opener.calls.filter(call => call.startsWith("notFound:")).length, 2);
	});

	test("rejects references that are not local files", async () => {
		const opener = fakeOpener({});
		for (const target of ["https://example.com/a.md", "command:workbench.action.reloadWindow", "\\\\server\\share\\a.md", ""]) {
			assert.strictEqual(await openFileReference(target, opener), "invalid", target);
		}
		assert.deepStrictEqual(opener.calls, []);
	});

	test("selects the cursor position or whole lines of a range", () => {
		assert.strictEqual(referenceSelection({ path: "a.ts" }), undefined);
		const cursor = referenceSelection({ path: "a.ts", line: 12, column: 5 });
		assert.deepStrictEqual([cursor?.start.line, cursor?.start.character, cursor?.isEmpty], [11, 4, true]);
		const range = referenceSelection({ path: "a.ts", line: 5, endLine: 9 });
		assert.deepStrictEqual([range?.start.line, range?.start.character, range?.end.line, range?.end.character], [4, 0, 9, 0]);
	});
});
