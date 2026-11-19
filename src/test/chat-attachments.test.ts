import * as assert from "node:assert";
import {
	ATTACHMENT_MAX_CHARS,
	ATTACHMENTS_TOTAL_MAX_CHARS,
	attachmentLabel,
	looksBinary,
	renderAttachments,
	type AttachmentContent,
} from "../chat/attachments";
import type { ChatAttachment } from "../chat/shared/protocol";

function attachment(overrides: Partial<ChatAttachment> = {}): ChatAttachment {
	return { id: "a1", kind: "file", path: "src/a.ts", uri: "file:///src/a.ts", ...overrides };
}

suite("chat attachments", () => {
	test("renders nothing for an empty list", () => {
		assert.strictEqual(renderAttachments([]), "");
	});

	test("renders paths, lines and the language fence", () => {
		const contents: AttachmentContent[] = [
			{ attachment: attachment({ id: "f", languageId: "typescript" }), text: "const a = 1;" },
			{ attachment: attachment({ id: "s", kind: "selection", path: "src/b.ts", uri: "file:///src/b.ts", startLine: 10, endLine: 20 }), text: "selected" },
		];
		assert.strictEqual(renderAttachments(contents), [
			"<attachments>",
			'<attachment path="src/a.ts">',
			"```ts",
			"const a = 1;",
			"```",
			"</attachment>",
			'<attachment path="src/b.ts" lines="10-20">',
			"```",
			"selected",
			"```",
			"</attachment>",
			"</attachments>",
		].join("\n"));
	});

	test("uses one line number when the selection is a single line", () => {
		const output = renderAttachments([{ attachment: attachment({ kind: "selection", startLine: 3, endLine: 3 }), text: "x" }]);
		assert.ok(output.includes('<attachment path="src/a.ts" lines="3">'));
	});

	test("makes the fence longer than any backtick run in the content", () => {
		const output = renderAttachments([{ attachment: attachment(), text: "a ```` b ``` c" }]);
		assert.ok(output.includes("`````\na ```` b ``` c\n`````"), output);
	});

	test("escapes quotes, angle brackets and ampersands in the path attribute", () => {
		const output = renderAttachments([{ attachment: attachment({ path: 'a "b" <c> & d.ts' }), text: "x" }]);
		assert.ok(output.includes('<attachment path="a &quot;b&quot; &lt;c> &amp; d.ts">'));
	});

	test("cuts one attachment to the per-attachment limit with a note", () => {
		const text = "x".repeat(ATTACHMENT_MAX_CHARS + 25);
		const output = renderAttachments([{ attachment: attachment(), text }]);
		assert.ok(output.includes(`${"x".repeat(ATTACHMENT_MAX_CHARS)}\n… (truncated, 25 more characters)`));
		assert.ok(!output.includes("x".repeat(ATTACHMENT_MAX_CHARS + 1)));
	});

	test("cuts later attachments to what is left of the total budget", () => {
		const big = "x".repeat(ATTACHMENT_MAX_CHARS);
		const contents = ["a", "b", "c", "d"].map(name => ({
			attachment: attachment({ id: name, path: `src/${name}.ts`, uri: `file:///src/${name}.ts` }),
			text: big,
		}));
		const output = renderAttachments(contents);
		const remaining = ATTACHMENTS_TOTAL_MAX_CHARS - 2 * ATTACHMENT_MAX_CHARS;
		const more = ATTACHMENT_MAX_CHARS - remaining;
		assert.ok(output.includes(`${"x".repeat(remaining)}\n… (truncated, ${more} more characters)`), output);
		assert.ok(output.includes('<attachment path="src/d.ts">(not included: the attachments are too large)</attachment>'));
	});

	test("renders an attachment that could not be read", () => {
		const output = renderAttachments([{ attachment: attachment({ path: "logo.png" }), error: "binary file" }]);
		assert.ok(output.includes('<attachment path="logo.png">(not included: binary file)</attachment>'));
	});

	test("labels attachments with their base name and selection lines", () => {
		assert.strictEqual(attachmentLabel(attachment({ path: "src/dir/a.ts" })), "a.ts");
		assert.strictEqual(attachmentLabel(attachment({ kind: "selection", path: "src/a.ts", startLine: 5, endLine: 9 })), "a.ts:5-9");
		assert.strictEqual(attachmentLabel(attachment({ kind: "selection", path: "src/a.ts", startLine: 5, endLine: 5 })), "a.ts:5");
		assert.strictEqual(attachmentLabel(attachment({ kind: "selection", path: "src/a.ts", startLine: 5 })), "a.ts:5");
	});

	test("detects binary content by a NUL in the first 8 KB", () => {
		assert.strictEqual(looksBinary(new Uint8Array([65, 66, 67])), false);
		assert.strictEqual(looksBinary(new Uint8Array([65, 0, 66])), true);
		const early = new Uint8Array(9_000).fill(65);
		early[8 * 1024 - 1] = 0;
		assert.strictEqual(looksBinary(early), true);
		const late = new Uint8Array(9_000).fill(65);
		late[8 * 1024] = 0;
		assert.strictEqual(looksBinary(late), false);
	});
});
