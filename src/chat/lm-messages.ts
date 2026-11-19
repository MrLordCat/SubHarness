import * as vscode from "vscode";
import type { ChatMessage, ChatPart } from "./shared/protocol";

const STOPPED_TOOL_RESULT = "Not executed: the turn was stopped before this tool ran.";
/** LanguageModelChatMessageRole.System is proposed API; the bridge's providers read any other role as system. */
const SYSTEM_ROLE = 3 as vscode.LanguageModelChatMessageRole;

export type ChatCompactionPart = Extract<ChatPart, { kind: "compaction" }>;

export interface LanguageModelRenderOptions {
	system?: string;
}

/** The newest compaction whose first kept message is still in the list; earlier messages reach the model only as its summary. */
export function activeCompaction(messages: readonly ChatMessage[]): { part: ChatCompactionPart; start: number } | undefined {
	for (let index = messages.length - 1; index >= 0; index--) {
		const parts = messages[index].parts;
		for (let partIndex = parts.length - 1; partIndex >= 0; partIndex--) {
			const part = parts[partIndex];
			if (part.kind !== "compaction") {
				continue;
			}
			const start = messages.findIndex(message => message.id === part.keepFromMessageId);
			return start >= 0 ? { part, start } : undefined;
		}
	}
	return undefined;
}

export function compactionSummaryText(part: ChatCompactionPart): string {
	return `<conversation_summary>\nThe earlier part of this conversation (${part.summarizedMessages} messages) was compacted. Summary:\n\n${part.summary}\n</conversation_summary>`;
}

/** The user's text in the form the model receives: host context, attachments, then the request itself. */
export function userRequestText(message: ChatMessage): string {
	const text = message.parts.filter(part => part.kind === "text").map(part => part.text).join("");
	if (!text) {
		return text;
	}
	const context = [message.hostContext, message.attachmentContext].filter((part): part is string => !!part);
	if (context.length === 0) {
		return text;
	}
	return `${context.join("\n")}\n<userRequest>\n${text}\n</userRequest>`;
}

function toolResult(callId: string, text: string): vscode.LanguageModelToolResultPart {
	return new vscode.LanguageModelToolResultPart(callId, [new vscode.LanguageModelTextPart(text)]);
}

function toolInput(input: unknown): object {
	return typeof input === "object" && input !== null ? input : {};
}

export function toLanguageModelMessages(messages: readonly ChatMessage[], options: LanguageModelRenderOptions = {}): vscode.LanguageModelChatRequestMessage[] {
	const converted: vscode.LanguageModelChatRequestMessage[] = [];
	if (options.system) {
		converted.push(new vscode.LanguageModelChatMessage(SYSTEM_ROLE, options.system));
	}
	const compaction = activeCompaction(messages);
	if (compaction) {
		converted.push(vscode.LanguageModelChatMessage.User(compactionSummaryText(compaction.part)));
	}
	for (const message of compaction ? messages.slice(compaction.start) : messages) {
		converted.push(...renderChatMessage(message));
	}
	return converted;
}

/** One stored message as model messages, without the system prompt or compaction window. */
export function renderChatMessage(message: ChatMessage): vscode.LanguageModelChatRequestMessage[] {
	const converted: vscode.LanguageModelChatRequestMessage[] = [];
	if (message.role === "user") {
		const text = userRequestText(message);
		if (text) {
			converted.push(vscode.LanguageModelChatMessage.User(text));
		}
		return converted;
	}
	const answered = new Set<string>();
	for (const part of message.parts) {
		if (part.kind === "toolResult") {
			answered.add(part.callId);
		}
	}
	let assistant: Array<vscode.LanguageModelTextPart | vscode.LanguageModelToolCallPart> = [];
	let openAssistant = false;
	let results: vscode.LanguageModelToolResultPart[] = [];
	let calls: string[] = [];
	const flushAssistant = (): void => {
		if (openAssistant && assistant.length > 0) {
			converted.push(vscode.LanguageModelChatMessage.Assistant(assistant));
		}
		assistant = [];
		openAssistant = false;
	};
	const flushResults = (): void => {
		for (const callId of calls) {
			if (!answered.has(callId)) {
				results.push(toolResult(callId, STOPPED_TOOL_RESULT));
			}
		}
		if (results.length > 0) {
			converted.push(vscode.LanguageModelChatMessage.User(results));
		}
		results = [];
		calls = [];
	};
	for (const part of message.parts) {
		switch (part.kind) {
			case "text":
				if (!part.text) {
					break;
				}
				if (results.length > 0) {
					flushResults();
				}
				openAssistant = true;
				assistant.push(new vscode.LanguageModelTextPart(part.text));
				break;
			case "toolCall":
				if (results.length > 0) {
					flushResults();
				}
				openAssistant = true;
				assistant.push(new vscode.LanguageModelToolCallPart(part.callId, part.name, toolInput(part.input)));
				calls.push(part.callId);
				break;
			case "toolResult":
				flushAssistant();
				results.push(toolResult(part.callId, part.text));
				break;
			default:
				break;
		}
	}
	flushAssistant();
	flushResults();
	return converted;
}
