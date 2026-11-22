import * as assert from "node:assert";
import { codeFileTarget, linkFileTarget, parseFileReference } from "../chat/shared/file-reference";

suite("chat file reference", () => {
	test("parses paths and positions", () => {
		for (const [input, expected] of [
			["src/a.ts:12", { path: "src/a.ts", line: 12 }],
			["a.ts:12", { path: "a.ts", line: 12 }],
			["package.json:12", { path: "package.json", line: 12 }],
			["chat-controller.ts:120:5", { path: "chat-controller.ts", line: 120, column: 5 }],
			["docs/CHAT.md:10-20", { path: "docs/CHAT.md", line: 10, endLine: 20 }],
			["package.json:12#L20", { path: "package.json", line: 20 }],
			["package.json:12#usage", { path: "package.json", line: 12 }],
			["package.json:12?query", { path: "package.json", line: 12 }],
			["C:\\x\\y.ts:12:3", { path: "C:\\x\\y.ts", line: 12, column: 3 }],
			["README.md#usage", { path: "README.md" }],
			["file:///c%3A/x/a.ts#L5-L9", { path: "c:/x/a.ts", line: 5, endLine: 9 }],
			["file://localhost/home/u/y.md", { path: "/home/u/y.md" }],
			["file:///C:/x/y.md", { path: "C:/x/y.md" }],
			["file:///home/u/y.md", { path: "/home/u/y.md" }],
			["a.ts#L12C3", { path: "a.ts", line: 12, column: 3 }],
			["a.ts#L12-20", { path: "a.ts", line: 12, endLine: 20 }],
			["a.ts#12", { path: "a.ts", line: 12 }],
			["a.ts#12-20", { path: "a.ts", line: 12, endLine: 20 }],
			["src/a.ts:12-20", { path: "src/a.ts", line: 12, endLine: 20 }],
			["src/a.ts:0", { path: "src/a.ts" }],
			["a.ts#L12-L2", { path: "a.ts", line: 12 }],
			["<docs/a%20b.md?x>", { path: "docs/a b.md" }],
		] as const) { assert.deepStrictEqual(parseFileReference(input), expected, input); }
	});
	test("rejects invalid paths", () => {
		for (const input of ["", "a".repeat(1025), "a\0b", "a\rb", "a\nb", "\\\\server\\x", "//server/x", "file://host/x", "https://x", "tel:123", "localhost:3000", "mailto:x@y", "command:foo", "vscode:x", "C:foo", "_vscodecontentref_", ".", "../", "/"]) {
			assert.strictEqual(parseFileReference(input), undefined, input);
		}
	});
	test("recognizes strict inline paths", () => {
		for (const input of ["src/chat/webview/markdown.tsx", "package.json", "package.json:12", "chat-controller.ts:120:5", "CHANGELOG.md", "docs/CHAT.md#L20", "src/a.ts:12", "C:\\Users\\x\\report.md", "./scripts/build.mjs", ".gitignore", "artifacts/screens/limit-auto-dark.png"]) {
			assert.strictEqual(codeFileTarget(input), input);
		}
		for (const input of ["npm run compile", "Promise.all", "this._stop()", "llamacpp.chat.systemNotifications", "2.0.3", "v1.9.0", "origin/main", "vscode.open", "Node.js", "https://example.com/a.md", "\\\\server\\share\\a.md", "runtime.busy", "a", "**/*.ts"]) {
			assert.strictEqual(codeFileTarget(input), undefined, input);
		}
	});
	test("recognizes local links", () => {
		for (const input of ["https://example.com", "mailto:a@b", "#anchor", "command:foo", ""]) { assert.strictEqual(linkFileTarget(input), undefined); }
		assert.strictEqual(linkFileTarget("<docs/>"), "docs/");
		assert.strictEqual(linkFileTarget("file:///home/a.md"), "file:///home/a.md");
	});
});
