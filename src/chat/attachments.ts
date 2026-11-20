import { attachmentLabel } from "./shared/attachment-label";
import type { ChatAttachment, ChatToolImage } from "./shared/protocol";

export { attachmentLabel };

export interface AttachmentContent {
	attachment: ChatAttachment;
	text?: string;
	/** An image file: the model gets it after the message text, the block only names it. */
	image?: ChatToolImage;
	error?: string;
}

export const ATTACHMENT_MAX_CHARS = 60_000;
export const ATTACHMENTS_TOTAL_MAX_CHARS = 150_000;
/** The view_image limit; providers reject larger images. */
export const IMAGE_ATTACHMENT_MAX_BYTES = 3_750_000;

/** Fence names for common VS Code language ids. */
const FENCE_LANGUAGES: Record<string, string> = {
	typescript: "ts",
	ts: "ts",
	typescriptreact: "tsx",
	tsx: "tsx",
	javascript: "js",
	js: "js",
	javascriptreact: "jsx",
	jsx: "jsx",
	json: "json",
	jsonc: "json",
	markdown: "md",
	md: "md",
	python: "py",
	py: "py",
	shellscript: "bash",
	sh: "sh",
	powershell: "powershell",
	batch: "bat",
	csharp: "cs",
	cs: "cs",
	cpp: "cpp",
	c: "c",
	java: "java",
	go: "go",
	rust: "rust",
	php: "php",
	ruby: "ruby",
	yaml: "yaml",
	toml: "toml",
	xml: "xml",
	html: "html",
	css: "css",
	scss: "scss",
	less: "less",
	sql: "sql",
	kotlin: "kotlin",
	swift: "swift",
	dockerfile: "dockerfile",
	makefile: "makefile",
	diff: "diff",
	vue: "vue",
	svelte: "svelte",
	graphql: "graphql",
	prisma: "prisma",
	proto: "proto",
	lua: "lua",
	r: "r",
	dart: "dart",
	scala: "scala",
	clojure: "clojure",
	elixir: "elixir",
	erlang: "erlang",
	haskell: "haskell",
	plaintext: "text",
};

function fenceLanguage(languageId: string | undefined): string | undefined {
	return languageId ? FENCE_LANGUAGES[languageId] : undefined;
}

function escapeAttribute(value: string): string {
	return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/"/g, "&quot;");
}

function linesAttribute(attachment: ChatAttachment): string {
	if (attachment.startLine === undefined) {
		return "";
	}
	const end = attachment.endLine ?? attachment.startLine;
	return end === attachment.startLine ? ` lines="${attachment.startLine}"` : ` lines="${attachment.startLine}-${end}"`;
}

function fenceFor(text: string): string {
	let longest = 0;
	let run = 0;
	for (const character of text) {
		if (character === "`") {
			run += 1;
			longest = Math.max(longest, run);
		} else {
			run = 0;
		}
	}
	return "`".repeat(Math.max(3, longest + 1));
}

/** Renders the user's attachments as the block the model receives. */
export function renderAttachments(contents: readonly AttachmentContent[]): string {
	if (contents.length === 0) {
		return "";
	}
	let remaining = ATTACHMENTS_TOTAL_MAX_CHARS;
	const blocks: string[] = ["<attachments>"];
	for (const content of contents) {
		const path = escapeAttribute(content.attachment.path);
		if (content.error) {
			blocks.push(`<attachment path="${path}">(not included: ${content.error})</attachment>`);
			continue;
		}
		if (content.image) {
			blocks.push(`<attachment path="${path}" image="${escapeAttribute(content.image.mimeType)}">(an image; it follows this message)</attachment>`);
			continue;
		}
		if (remaining <= 0) {
			blocks.push(`<attachment path="${path}"${linesAttribute(content.attachment)}>(not included: the attachments are too large)</attachment>`);
			continue;
		}
		const text = content.text ?? "";
		const keep = Math.min(text.length, ATTACHMENT_MAX_CHARS, remaining);
		const cut = text.length - keep;
		const included = cut > 0 ? `${text.slice(0, keep)}\n… (truncated, ${cut} more characters)` : text;
		remaining -= keep;
		const fence = fenceFor(included);
		const language = fenceLanguage(content.attachment.languageId) ?? "";
		const body = included && !included.endsWith("\n") ? `${included}\n` : included;
		blocks.push(`<attachment path="${path}"${linesAttribute(content.attachment)}>\n${fence}${language}\n${body}${fence}\n</attachment>`);
	}
	blocks.push("</attachments>");
	return blocks.join("\n");
}

export function looksBinary(buffer: Uint8Array): boolean {
	const limit = Math.min(buffer.length, 8 * 1024);
	for (let index = 0; index < limit; index++) {
		if (buffer[index] === 0) {
			return true;
		}
	}
	return false;
}
