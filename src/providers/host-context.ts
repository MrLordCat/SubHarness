import { createHash } from "node:crypto";
import * as vscode from "vscode";

const HOST_BLOCK = /<(context|environment_info|workspace_info|attachments|reminderInstructions)>[\s\S]*?<\/\1>/g;

export interface HostContextSnapshot {
	/** Volatile host blocks by tag; a later block with the same tag replaces an earlier one. */
	blocks: Map<string, string>;
	/** The system message without host blocks; undefined when the first message is not a system message or nothing remains. */
	instructions?: string;
	/** sha256 hex of `instructions`. */
	instructionsDigest?: string;
}

/**
 * Splits the first request message into volatile host context and stable instructions.
 * A continuing native session receives only new entries, so a changed system prompt
 * (base instructions, AGENTS.md) is detected by its digest and sent once.
 */
export function hostContextSnapshot(first: vscode.LanguageModelChatRequestMessage | undefined): HostContextSnapshot {
	const text = (first?.content ?? []).filter(part => part instanceof vscode.LanguageModelTextPart).map(part => (part as vscode.LanguageModelTextPart).value).join("");
	const blocks = new Map<string, string>();
	for (const match of text.matchAll(HOST_BLOCK)) { blocks.set(match[1], match[0]); }
	const system = first !== undefined && first.role !== vscode.LanguageModelChatMessageRole.User && first.role !== vscode.LanguageModelChatMessageRole.Assistant;
	const instructions = system ? text.replace(HOST_BLOCK, "").replace(/\n{3,}/g, "\n\n").trim() || undefined : undefined;
	return { blocks, instructions, instructionsDigest: instructions === undefined ? undefined : createHash("sha256").update(instructions).digest("hex") };
}

export function updatedInstructionsMessage(instructions: string): vscode.LanguageModelChatMessage {
	return vscode.LanguageModelChatMessage.User(`Current VS Code instructions (updated; they replace the earlier system instructions):\n${instructions}`);
}
