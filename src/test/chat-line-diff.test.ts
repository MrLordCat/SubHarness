import * as assert from "node:assert";
import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { lineDiff } from "../chat/line-diff";
import { SubagentFiles } from "../chat/subagent-files";

suite("subagent file changes", () => {
	test("counts inserted, deleted and modified lines and ignores line endings", () => {
		assert.deepStrictEqual(lineDiff("a\nb\n", "a\nb\nc\n"), { added: 1, removed: 0 });
		assert.deepStrictEqual(lineDiff("a\nb\n", "a\n"), { added: 0, removed: 1 });
		assert.deepStrictEqual(lineDiff("a\n", "b\n"), { added: 1, removed: 1 });
		assert.deepStrictEqual(lineDiff("a\r\nb\r\n", "a\nb\n"), { added: 0, removed: 0 });
		assert.deepStrictEqual(lineDiff("", "a\nb\n"), { added: 2, removed: 0 });
		assert.deepStrictEqual(lineDiff("a\nb\n", ""), { added: 0, removed: 2 });
	});

	test("reports snapshots before the first write and omits unchanged files", async () => {
		const root = await fs.mkdtemp(path.join(os.tmpdir(), "subagent-files-"));
		try {
			const file = path.join(root, "file.txt");
			const files = new SubagentFiles();
			assert.strictEqual(await files.report([root]), "");
			await files.capture([file]);
			await fs.writeFile(file, "one\ntwo\n");
			await files.capture([file]);
			assert.strictEqual(await files.report([root]), "\n\nFiles changed by this subagent:\n- file.txt (new, +2)");
			const deleted = new SubagentFiles();
			await deleted.capture([file]);
			await fs.unlink(file);
			assert.ok((await deleted.report([root])).includes("file.txt (deleted, −2)"));
		} finally { await fs.rm(root, { recursive: true, force: true }); }
	});
});
