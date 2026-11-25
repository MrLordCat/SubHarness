import * as vscode from "vscode";
import { CONVERSATION_SUMMARY_TAG } from "../context/provider-handoff";
import type { ChatMessage, ChatPart, ChatToolImage } from "./shared/protocol";

const STOPPED_TOOL_RESULT = "Not executed: the turn was stopped before this tool ran.";
/** LanguageModelChatMessageRole.System is proposed API; the bridge's providers read any other role as system. */
const SYSTEM_ROLE = 3 as vscode.LanguageModelChatMessageRole;

export type ChatCompactionPart = Extract<ChatPart, { kind: "compaction" }>;

export interface LanguageModelRenderOptions {
	system?: string;
	/** The model accepts images; otherwise attached images are replaced by a note. */
	imageInput?: boolean;
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

/** False for a cleaning that only stubbed stale results: the model gets no summary message. */
export function hasCompactionSummary(part: ChatCompactionPart): boolean {
	return part.method !== "none";
}

/**
 * True until a model answers after the newest compaction. Native sessions hold the history from before it, so the
 * request must start a new one from the chat's history; a retry after a failed first request starts it again.
 */
export function historyResetPending(messages: readonly ChatMessage[]): boolean {
	for (let index = messages.length - 1; index >= 0; index--) {
		const message = messages[index];
		for (let partIndex = message.parts.length - 1; partIndex >= 0; partIndex--) {
			const kind = message.parts[partIndex].kind;
			if (kind === "compaction") {
				return true;
			}
			if (message.role === "assistant" && (kind === "text" || kind === "thinking" || kind === "toolCall")) {
				return false;
			}
		}
	}
	return false;
}

export function compactionSummaryText(part: ChatCompactionPart): string {
	const covered = [
		...(part.summarizedMessages > 0 || !part.trimmedTurn ? [`${part.summarizedMessages} messages`] : []),
		...(part.trimmedTurn
			? [`the first ${part.trimmedTurn.rounds} tool ${part.trimmedTurn.rounds === 1 ? "round" : "rounds"} of the answer to the first request below`]
			: []),
	].join(" and ");
	const log = part.transcriptPath
		? `\n\nEvery earlier message is kept in full in the chat log ${JSON.stringify(part.transcriptPath)} (JSON Lines, one event per line). Search it when a detail is missing instead of redoing the work.`
		: "";
	const requests = part.requests?.length
		? `\n\nThe user's requests in the summarized part, verbatim (long ones shortened), oldest first:\n${part.requests.map((request, index) => `[${index + 1}] ${request}`).join("\n")}`
		: "";
	// Providers recognize the summary by its opening tag and keep it when a replay drops old messages.
	return `${CONVERSATION_SUMMARY_TAG}\nThe earlier part of this conversation (${covered}) was compacted. Summary:\n\n${part.summary}${requests}${log}\n</conversation_summary>`;
}

/** Tool results above this length in older kept turns reach the model as their start and end. */
export const COMPACTED_TOOL_RESULT_MAX_CHARS = 12_000;
const COMPACTED_TOOL_RESULT_HEAD = 8_000;
const COMPACTED_TOOL_RESULT_TAIL = 3_800;
const COMPACTED_TOOL_RESULT_NOTE = "\n[Earlier tool output shortened at compaction; the chat log keeps it in full]\n";

/** Long tool results as compaction keeps them in older turns; the same array when none is long. */
export function shortenToolResults(parts: ChatPart[]): ChatPart[] {
	let changed = false;
	const shortened = parts.map(part => {
		if (part.kind !== "toolResult" || part.text.length <= COMPACTED_TOOL_RESULT_MAX_CHARS) {
			return part;
		}
		changed = true;
		return { ...part, text: `${part.text.slice(0, COMPACTED_TOOL_RESULT_HEAD)}${COMPACTED_TOOL_RESULT_NOTE}${part.text.slice(-COMPACTED_TOOL_RESULT_TAIL)}` };
	});
	return changed ? shortened : parts;
}

const STALE_RESULT_START_CHARS = 200;

/**
 * What the model receives instead of a stale tool result. Built from the result alone, so it is the same in
 * every later request and the provider's prompt cache keeps it.
 */
export function staleToolResultText(text: string): string {
	const first = text.split(/\r?\n/, 40).map(line => line.trim()).find(line => line.length > 0) ?? "";
	const start = first.length > STALE_RESULT_START_CHARS ? `${first.slice(0, STALE_RESULT_START_CHARS)}…` : first;
	return `[Earlier tool output (${text.length.toLocaleString("en-US")} characters) was removed to keep the context small; run the tool again if you need it.${start ? ` It began: ${start}` : ""}]`;
}

/** Stale tool results as the model receives them: a stub without images; the same array when none is stale. */
export function stubStaleToolResults(parts: ChatPart[], stale: ReadonlySet<string>): ChatPart[] {
	if (stale.size === 0) {
		return parts;
	}
	let changed = false;
	const stubbed = parts.map(part => {
		if (part.kind !== "toolResult" || !stale.has(part.callId)) {
			return part;
		}
		changed = true;
		const stub: ChatPart = { kind: "toolResult", callId: part.callId, text: staleToolResultText(part.text), ...(part.isError ? { isError: true } : {}) };
		return stub;
	});
	return changed ? stubbed : parts;
}

export interface CompactionWindow {
	compaction?: { part: ChatCompactionPart; start: number };
	/** The messages the model receives after the summary, as it receives them. */
	messages: ChatMessage[];
	/** Per message, the leading parts the trimmed turn leaves out. */
	partOffsets: number[];
}

/** The active compaction and the kept messages, with stale results stubbed, the trimmed turn cut and older tool outputs shortened. */
export function compactionWindow(messages: readonly ChatMessage[]): CompactionWindow {
	const compaction = activeCompaction(messages);
	if (!compaction) {
		return { messages: [...messages], partOffsets: messages.map(() => 0) };
	}
	const kept = messages.slice(compaction.start);
	const { trimmedTurn, abbreviatedUntil } = compaction.part;
	const stale = new Set(compaction.part.staleResults ?? []);
	const until = abbreviatedUntil ? kept.findIndex(message => message.id === abbreviatedUntil) : -1;
	const partOffsets = kept.map(() => 0);
	const view = kept.map((message, index) => {
		let parts = stubStaleToolResults(message.parts, stale);
		if (trimmedTurn && message.id === trimmedTurn.messageId && message.role === "assistant") {
			parts = parts.slice(trimmedTurn.fromPart);
			partOffsets[index] = trimmedTurn.fromPart;
		}
		if (index < until) {
			parts = shortenToolResults(parts);
		}
		return parts === message.parts ? message : { ...message, parts };
	});
	return { compaction, messages: view, partOffsets };
}

/** A system message; LanguageModelChatMessageRole.System is proposed API. */
export function systemMessage(text: string): vscode.LanguageModelChatMessage {
	return new vscode.LanguageModelChatMessage(SYSTEM_ROLE, text);
}

/** The user's text in the form the model receives: host context, memory, attachments, then the request itself. */
export function userRequestText(message: ChatMessage): string {
	const text = message.parts.filter(part => part.kind === "text").map(part => part.text).join("");
	if (!text) {
		return text;
	}
	const context = [message.hostContext, message.memoryContext, message.attachmentContext]
		.filter((part): part is string => !!part);
	if (context.length === 0) {
		return text;
	}
	return `${context.join("\n")}\n<userRequest>\n${text}\n</userRequest>`;
}

function toolResult(callId: string, text: string, images?: readonly ChatToolImage[]): vscode.LanguageModelToolResultPart {
	const content: Array<vscode.LanguageModelTextPart | vscode.LanguageModelDataPart> = [new vscode.LanguageModelTextPart(text)];
	for (const image of images ?? []) {
		if (image.data !== undefined) {
			content.push(vscode.LanguageModelDataPart.image(Buffer.from(image.data, "base64"), image.mimeType));
		}
	}
	return new vscode.LanguageModelToolResultPart(callId, content);
}

function toolInput(input: unknown): object {
	return typeof input === "object" && input !== null ? input : {};
}

export function toLanguageModelMessages(messages: readonly ChatMessage[], options: LanguageModelRenderOptions = {}): vscode.LanguageModelChatRequestMessage[] {
	const converted: vscode.LanguageModelChatRequestMessage[] = [];
	if (options.system) {
		converted.push(systemMessage(options.system));
	}
	const window = compactionWindow(messages);
	if (window.compaction && hasCompactionSummary(window.compaction.part)) {
		converted.push(vscode.LanguageModelChatMessage.User(compactionSummaryText(window.compaction.part)));
	}
	for (const message of window.messages) {
		converted.push(...renderChatMessage(message, options));
	}
	return converted;
}

function imageNote(count: number): string {
	return `\n[${count === 1 ? "1 attached image was" : `${count} attached images were`} left out: this model does not accept images.]`;
}

/** One stored message as model messages, without the system prompt or compaction window. */
export function renderChatMessage(message: ChatMessage, options: Pick<LanguageModelRenderOptions, "imageInput"> = {}): vscode.LanguageModelChatRequestMessage[] {
	const converted: vscode.LanguageModelChatRequestMessage[] = [];
	if (message.role === "user") {
		const text = userRequestText(message);
		if (!text) {
			return converted;
		}
		const images = (message.images ?? []).filter(image => image.data !== undefined);
		if (images.length === 0) {
			converted.push(vscode.LanguageModelChatMessage.User(text));
		} else if (options.imageInput) {
			converted.push(vscode.LanguageModelChatMessage.User([
				new vscode.LanguageModelTextPart(text),
				...images.map(image => vscode.LanguageModelDataPart.image(Buffer.from(image.data ?? "", "base64"), image.mimeType)),
			]));
		} else {
			converted.push(vscode.LanguageModelChatMessage.User(`${text}${imageNote(images.length)}`));
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
				results.push(toolResult(part.callId, part.text, part.images));
				break;
			default:
				break;
		}
	}
	flushAssistant();
	flushResults();
	return converted;
}
