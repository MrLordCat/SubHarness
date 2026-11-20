import * as assert from "node:assert";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import * as vscode from "vscode";
import { ChatAttachmentSource, pastedFileName } from "../chat/attachment-source";
import {
	ATTACHMENT_MAX_CHARS,
	ATTACHMENTS_TOTAL_MAX_CHARS,
	attachmentLabel,
	looksBinary,
	renderAttachments,
	type AttachmentContent,
} from "../chat/attachments";
import { renderChatMessage } from "../chat/lm-messages";
import { imageExtension, imageMimeType } from "../chat/shared/attachment-label";
import type { ChatAttachment, ChatMessage } from "../chat/shared/protocol";

/** The 8-byte PNG signature; enough for a file that is read back, not decoded. */
const PNG_BYTES = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

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

	test("names an image attachment in the block and leaves its bytes to the message", () => {
		const contents: AttachmentContent[] = [
			{ attachment: attachment({ path: "shots/a.png", uri: "file:///shots/a.png" }), image: { mimeType: "image/png", data: "iVBORw==", byteLength: 4 } },
		];
		assert.strictEqual(renderAttachments(contents), [
			"<attachments>",
			'<attachment path="shots/a.png" image="image/png">(an image; it follows this message)</attachment>',
			"</attachments>",
		].join("\n"));
	});

	test("maps image file names to the types models accept", () => {
		assert.strictEqual(imageMimeType("a/b/Shot.PNG"), "image/png");
		assert.strictEqual(imageMimeType("photo.jpeg"), "image/jpeg");
		assert.strictEqual(imageMimeType("anim.gif"), "image/gif");
		assert.strictEqual(imageMimeType("x.webp"), "image/webp");
		assert.strictEqual(imageMimeType("icon.svg"), undefined);
		assert.strictEqual(imageMimeType("README"), undefined);
		assert.strictEqual(imageExtension("image/jpeg"), "jpg");
		assert.strictEqual(imageExtension("application/pdf"), undefined);
	});

	test("names pasted files safely and dates nameless screenshots", () => {
		const now = new Date(2026, 10, 20, 9, 5, 7);
		assert.strictEqual(pastedFileName("image.png", "image/png", now), "pasted-20261120-090507.png");
		assert.strictEqual(pastedFileName("", "image/jpeg", now), "pasted-20261120-090507.jpg");
		assert.strictEqual(pastedFileName("", "", now), "pasted-20261120-090507.bin");
		assert.strictEqual(pastedFileName("re:port?.txt", "text/plain", now), "re_port_.txt");
		assert.strictEqual(pastedFileName(" ..notes.md. ", "text/markdown", now), "notes.md");
		assert.strictEqual(pastedFileName("diagram.png", "image/png", now), "diagram.png");
	});

	test("sends a user message's images to vision models and a note to the others", () => {
		const message: ChatMessage = {
			id: "u1", role: "user", turn: 1, createdAt: 0,
			parts: [{ kind: "text", text: "What is on the screenshot?" }],
			images: [{ mimeType: "image/png", data: PNG_BYTES.toString("base64"), byteLength: PNG_BYTES.byteLength }],
		};
		const [vision] = renderChatMessage(message, { imageInput: true });
		assert.ok(vision.content[0] instanceof vscode.LanguageModelTextPart);
		const image = vision.content[1];
		assert.ok(image instanceof vscode.LanguageModelDataPart);
		assert.strictEqual(image.mimeType, "image/png");
		assert.deepStrictEqual(Buffer.from(image.data), PNG_BYTES);

		const [text] = renderChatMessage(message);
		assert.strictEqual(text.content.length, 1);
		const note = text.content[0];
		assert.ok(note instanceof vscode.LanguageModelTextPart);
		assert.match(note.value, /What is on the screenshot\?\n\[1 attached image was left out: this model does not accept images\.\]$/);
	});

	test("saves pasted bytes as files and reads an image attachment as an image", async () => {
		const root = await fs.mkdtemp(path.join(os.tmpdir(), "chat-paste-"));
		try {
			const source = new ChatAttachmentSource({ pasteDir: vscode.Uri.file(root) });
			const [pasted, note] = await source.savePasted([
				{ name: "image.png", mimeType: "image/png", data: PNG_BYTES.toString("base64") },
				{ name: "note.txt", mimeType: "text/plain", data: Buffer.from("hello").toString("base64") },
				{ name: "empty.txt", mimeType: "text/plain", data: "" },
			]);
			assert.ok(pasted && note, "two non-empty files are attached");
			assert.match(attachmentLabel(pasted), /^pasted-\d{8}-\d{6}\.png$/);
			assert.strictEqual(attachmentLabel(note), "note.txt");
			assert.deepStrictEqual(await fs.readFile(vscode.Uri.parse(pasted.uri).fsPath), PNG_BYTES);

			const [image, text] = await source.read([pasted, note]);
			assert.strictEqual(image.image?.mimeType, "image/png");
			assert.strictEqual(image.image?.data, PNG_BYTES.toString("base64"));
			assert.strictEqual(image.image?.byteLength, PNG_BYTES.byteLength);
			assert.strictEqual(text.text, "hello");
		} finally {
			await fs.rm(root, { recursive: true, force: true });
		}
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
