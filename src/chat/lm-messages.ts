import * as vscode from "vscode";
import type { ChatMessage } from "./shared/protocol";

const STOPPED_TOOL_RESULT = "Not executed: the turn was stopped before this tool ran.";

function toolResult(callId: string, text: string): vscode.LanguageModelToolResultPart {
	return new vscode.LanguageModelToolResultPart(callId, [new vscode.LanguageModelTextPart(text)]);
}

function toolInput(input: unknown): object {
	return typeof input === "object" && input !== null ? input : {};
}

export function toLanguageModelMessages(messages: readonly ChatMessage[]): vscode.LanguageModelChatRequestMessage[] {
	const converted: vscode.LanguageModelChatRequestMessage[] = [];
	for (const message of messages) {
		if (message.role === "user") {
			const text = message.parts.filter(part => part.kind === "text").map(part => part.text).join("");
			if (text) {
				converted.push(vscode.LanguageModelChatMessage.User(text));
			}
			continue;
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
	}
	return converted;
}
