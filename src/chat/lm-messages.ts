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

/** An argument string shorter than this stays: its note costs about as much. */
export const STALE_ARGUMENT_MIN_CHARS = 300;

/**
 * The arguments whose text a cleaning may shorten, per tool: what an earlier request's edit wrote and what a finished
 * subagent was told. The file, the model and the other options stay, so the call still reads like a normal one.
 */
const STALE_ARGUMENT_FIELDS: Readonly<Record<string, readonly string[]>> = {
	create_file: ["content"],
	replace_string_in_file: ["oldString", "newString"],
	multi_replace_string_in_file: ["oldString", "newString"],
	subagent: ["prompt"],
};

/** What the model receives instead of a long argument; built from the text alone, so later requests repeat it exactly. */
export function staleArgumentText(text: string): string {
	const lines = text.split(/\r\n|\r|\n/).length;
	return `[${lines.toLocaleString("en-US")} ${lines === 1 ? "line" : "lines"}, ${text.length.toLocaleString("en-US")} characters; removed to keep the context small]`;
}

function shortenFields(value: unknown, fields: readonly string[]): unknown {
	if (typeof value !== "object" || value === null || Array.isArray(value)) {
		return value;
	}
	const input = value as Record<string, unknown>;
	let changed = false;
	const shortened: Record<string, unknown> = { ...input };
	for (const field of fields) {
		const text = input[field];
		if (typeof text === "string" && text.length >= STALE_ARGUMENT_MIN_CHARS) {
			shortened[field] = staleArgumentText(text);
			changed = true;
		}
	}
	return changed ? shortened : value;
}

/**
 * A tool call's input with its long text arguments replaced by a size note; the same object when the tool has none
 * or none is long. multi_replace_string_in_file shortens each replacement.
 */
export function shortenToolArguments(name: string, input: unknown): unknown {
	const fields = STALE_ARGUMENT_FIELDS[name];
	if (!fields) {
		return input;
	}
	if (name !== "multi_replace_string_in_file") {
		return shortenFields(input, fields);
	}
	if (typeof input !== "object" || input === null || !Array.isArray((input as { replacements?: unknown }).replacements)) {
		return input;
	}
	const replacements = (input as { replacements: unknown[] }).replacements;
	const shortened = replacements.map(item => shortenFields(item, fields));
	return shortened.some((item, index) => item !== replacements[index]) ? { ...input, replacements: shortened } : input;
}

/** Tool calls whose long arguments the model no longer needs, as it receives them; the same array when none changes. */
export function stubStaleToolArguments(parts: ChatPart[], stale: ReadonlySet<string>): ChatPart[] {
	if (stale.size === 0) {
		return parts;
	}
	let changed = false;
	const stubbed = parts.map(part => {
		if (part.kind !== "toolCall" || !stale.has(part.callId)) {
			return part;
		}
		const input = shortenToolArguments(part.name, part.input);
		if (input === part.input) {
			return part;
		}
		changed = true;
		return { ...part, input };
	});
	return changed ? stubbed : parts;
}

const MEMORY_OPEN = "<memory>";
const MEMORY_CLOSE = "</memory>";
const MEMORY_INDEX_HEADER = "Index of entries:";

/**
 * Where the index list of the memory block opening at `open` starts: right after the block's heading line. Entry
 * texts follow a blank line, so none of them is mistaken for the list.
 */
function memoryIndexMarker(lines: readonly string[], open: number): number | undefined {
	const heading = open + 1;
	if (lines[heading] === undefined || lines[heading].trim() === MEMORY_CLOSE) {
		return undefined;
	}
	return lines[heading + 1]?.trim() === MEMORY_INDEX_HEADER ? heading + 1 : undefined;
}

/** True when a memory context carries the index list of the shared memory. */
export function hasMemoryIndex(memoryContext: string | undefined): boolean {
	if (memoryContext === undefined) {
		return false;
	}
	const lines = memoryContext.split(/\r?\n/);
	return lines.some((line, index) => line.trim() === MEMORY_OPEN && memoryIndexMarker(lines, index) !== undefined);
}

/** A line of an index list: an entry line, or the note that lists how many entries are left out. */
function memoryIndexLine(line: string): boolean {
	const trimmed = line.trim();
	return trimmed.startsWith("- [") || /^\(\d+ more; use llamacpp_search_memory\)$/.test(trimmed);
}

/**
 * A memory context without its index lists: a list is redundant once a later message carries a newer one, while the
 * entry texts stay, as an older block may hold the only copy of an entry. Returns the same text when there is no
 * list, and undefined when nothing but the heading remains, so the message loses its memory block.
 */
export function stripMemoryIndex(memoryContext: string): string | undefined {
	const lines = memoryContext.split(/\r?\n/);
	const kept: string[] = [];
	let changed = false;
	for (let index = 0; index < lines.length; index++) {
		const line = lines[index];
		kept.push(line);
		if (line.trim() !== MEMORY_OPEN) {
			continue;
		}
		const marker = memoryIndexMarker(lines, index);
		if (marker === undefined) {
			continue;
		}
		kept.push(lines[index + 1]);
		changed = true;
		index = marker;
		while (index + 1 < lines.length && memoryIndexLine(lines[index + 1])) {
			index++;
		}
	}
	if (!changed) {
		return memoryContext;
	}
	const content = kept.filter(line => {
		const trimmed = line.trim();
		return trimmed !== "" && trimmed !== MEMORY_OPEN && trimmed !== MEMORY_CLOSE;
	});
	// The block held nothing but its heading and the index: the message keeps no memory block at all.
	return content.length > 1 ? kept.join("\n") : undefined;
}

/** A message whose memory block loses its index list; the same message when it has no list or is not a user message. */
export function withoutMemoryIndex(message: ChatMessage): ChatMessage {
	if (message.role !== "user" || message.memoryContext === undefined) {
		return message;
	}
	const memoryContext = stripMemoryIndex(message.memoryContext);
	if (memoryContext === message.memoryContext) {
		return message;
	}
	const stripped: ChatMessage = { ...message };
	if (memoryContext === undefined) {
		delete stripped.memoryContext;
	} else {
		stripped.memoryContext = memoryContext;
	}
	return stripped;
}

export interface CompactionWindow {
	compaction?: { part: ChatCompactionPart; start: number };
	/** The messages the model receives after the summary, as it receives them. */
	messages: ChatMessage[];
	/** Per message, the leading parts the trimmed turn leaves out. */
	partOffsets: number[];
}

/**
 * The active compaction and the kept messages, with stale results stubbed, long arguments of earlier edits and subagent
 * tasks shortened, superseded memory indexes dropped, the trimmed turn cut and older tool outputs shortened.
 */
export function compactionWindow(messages: readonly ChatMessage[]): CompactionWindow {
	const compaction = activeCompaction(messages);
	if (!compaction) {
		return { messages: [...messages], partOffsets: messages.map(() => 0) };
	}
	const kept = messages.slice(compaction.start);
	const { trimmedTurn, abbreviatedUntil } = compaction.part;
	const stale = new Set(compaction.part.staleResults ?? []);
	const staleMemory = new Set(compaction.part.staleMemoryIndex ?? []);
	const staleArguments = new Set(compaction.part.staleArguments ?? []);
	const until = abbreviatedUntil ? kept.findIndex(message => message.id === abbreviatedUntil) : -1;
	const partOffsets = kept.map(() => 0);
	const view = kept.map((message, index) => {
		let parts = stubStaleToolArguments(stubStaleToolResults(message.parts, stale), staleArguments);
		if (trimmedTurn && message.id === trimmedTurn.messageId && message.role === "assistant") {
			parts = parts.slice(trimmedTurn.fromPart);
			partOffsets[index] = trimmedTurn.fromPart;
		}
		if (index < until) {
			parts = shortenToolResults(parts);
		}
		const rendered = parts === message.parts ? message : { ...message, parts };
		return staleMemory.has(rendered.id) ? withoutMemoryIndex(rendered) : rendered;
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
