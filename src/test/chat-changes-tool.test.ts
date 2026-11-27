import * as assert from "node:assert";
import * as vscode from "vscode";
import { createChatToolSource } from "../chat/tool-executor";
import { CHANGES_DIFF_TOOL_NAME, createChangesDiffTool, parseChangesDiffInput } from "../chat/tools/changes-tools";
import type { ChatChangesDiffRequest } from "../chat/tools/types";

const token = new vscode.CancellationTokenSource().token;

suite("changes_diff tool", () => {
	test("reads its arguments and rejects bad ones", () => {
		assert.deepStrictEqual(parseChangesDiffInput({}), { scope: "turn" });
		assert.deepStrictEqual(parseChangesDiffInput({ scope: "pending", paths: ["src"], contextLines: 0, maxChars: 2_000 }),
			{ scope: "pending", paths: ["src"], contextLines: 0, maxChars: 2_000 });
		assert.throws(() => parseChangesDiffInput({ scope: "all" }), /scope must be "turn" or "pending"/);
		assert.throws(() => parseChangesDiffInput({ paths: "src" }), /paths must be an array of strings/);
		assert.throws(() => parseChangesDiffInput({ contextLines: 21 }), /contextLines must be a whole number from 0 to 20/);
		assert.throws(() => parseChangesDiffInput({ maxChars: 100 }), /maxChars must be a whole number from 2000 to 120000/);
	});

	test("is read-only, reaches the host through the tool source and explains a chat without tracking", async () => {
		const tool = createChangesDiffTool();
		assert.strictEqual(tool.readOnly, true, "a review must not start a change snapshot");
		const asked: ChatChangesDiffRequest[] = [];
		const source = createChatToolSource({ enabledTools: () => [tool], groups: () => [], setEnabled: async () => undefined });
		const result = await source.invoke(CHANGES_DIFF_TOOL_NAME, { paths: ["a.ts"] }, token, {
			approve: async () => true,
			changesDiff: async request => { asked.push(request); return "1 file changed in this turn"; },
		});
		assert.deepStrictEqual(result, { text: "1 file changed in this turn", isError: false });
		assert.deepStrictEqual(asked, [{ scope: "turn", paths: ["a.ts"] }]);
		// A model whose provider takes 12,000 characters of a result gets a diff that fits, with room for its note.
		await source.invoke(CHANGES_DIFF_TOOL_NAME, {}, token, { approve: async () => true, resultChars: 12_000, changesDiff: async request => { asked.push(request); return "ok"; } });
		assert.deepStrictEqual(asked[1], { scope: "turn", maxChars: 11_400 });
		await assert.rejects(tool.invoke({}, token, {}), /does not track file changes.*Review the changed files with read_file/);
	});
});
