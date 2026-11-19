import type { ChatAttachment } from "./protocol";

export function attachmentLabel(attachment: ChatAttachment): string {
	const name = attachment.path.split(/[\\/]/).pop() || attachment.path;
	if (attachment.kind !== "selection" || attachment.startLine === undefined) {
		return name;
	}
	const end = attachment.endLine ?? attachment.startLine;
	return end === attachment.startLine ? `${name}:${attachment.startLine}` : `${name}:${attachment.startLine}-${end}`;
}

/** The full path plus the selection lines, for a tooltip. */
export function attachmentTitle(attachment: ChatAttachment): string {
	if (attachment.kind !== "selection" || attachment.startLine === undefined) {
		return attachment.path;
	}
	const end = attachment.endLine ?? attachment.startLine;
	return `${attachment.path} (lines ${attachment.startLine}-${end})`;
}
