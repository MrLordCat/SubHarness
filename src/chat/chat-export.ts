import type { ChatMessage, ChatSessionMeta } from "./shared/protocol";

/** Characters Windows does not allow in a file name. */
const INVALID_FILE_NAME_CHARS = new Set(["<", ">", ":", "\"", "/", "\\", "|", "?", "*"]);

function quote(text: string): string {
	return text.split("\n").map(line => `> ${line}`).join("\n");
}

function messageContent(message: ChatMessage): string[] {
	if (message.role === "user" && message.continuation) {
		return ["> Retry: the answer continued"];
	}
	const content: string[] = [];
	for (const part of message.parts) {
		if (part.kind === "text") {
			content.push(part.text);
		} else if (part.kind === "notice") {
			content.push(quote(part.text));
		} else if (part.kind === "toolCall" && message.role === "assistant") {
			content.push(`> Tool: ${part.name}`);
		}
	}
	if (message.role === "user" && message.attachments?.length) {
		content.push(message.attachments.map(attachment => `- ${attachment.path}`).join("\n"));
	}
	return content;
}

/** Renders the stored conversation as Markdown, without thinking and tool results. */
export function renderChatMarkdown(meta: ChatSessionMeta, messages: readonly ChatMessage[]): string {
	const blocks = [`# ${meta.title}`];
	for (const message of messages) {
		const heading = message.role === "user" ? "You" : `Assistant${message.modelId ? ` (${message.modelId})` : ""}`;
		const content = messageContent(message);
		blocks.push(content.length > 0 ? `## ${heading}\n\n${content.join("\n\n")}` : `## ${heading}`);
	}
	return `${blocks.join("\n\n")}\n`;
}

/** A file name for the export that every platform accepts. */
export function chatExportFileName(title: string): string {
	const kept = [...title].filter(char => char.charCodeAt(0) >= 0x20 && !INVALID_FILE_NAME_CHARS.has(char)).join("");
	const name = kept.slice(0, 80).replace(/[.\s]+$/g, "").trim();
	return `${name || "chat"}.md`;
}
