import * as vscode from "vscode";
import { estimateChatMessageTokens, estimateTextTokens } from "./compaction";
import { activeCompaction, compactionSummaryText, compactionWindow, hasCompactionSummary, hasMemoryIndex, shortenToolArguments, stubStaleToolArguments, stubStaleToolResults, withoutMemoryIndex, type ChatCompactionPart } from "./lm-messages";
import type { ChatMessage, ChatPart } from "./shared/protocol";
import { ASK_QUESTIONS_TOOL_NAME, TODO_TOOL_NAME } from "./tools/interaction-tools";
import { CLOSE_SUBAGENT_TOOL_NAME, SUBAGENT_TOOL_NAME, WAIT_SUBAGENTS_TOOL_NAME } from "./tools/subagent-tool";
import { LIST_TOOLS_TOOL_NAME, REQUEST_TOOLS_TOOL_NAME } from "./tools/tool-access-tools";

/** Share of the budget a cleaning brings the chat down to, so the next one is a while away. */
export const CONTEXT_CLEANING_TARGET_RATIO = 0.6;
/**
 * Share of llamacpp.providerSwitchContextTokens a cleaned history may take. Claude replays up to about 2 characters
 * per estimated token of it, and its JSON encoding and the tool schemas take the rest.
 */
export const CONTEXT_CLEANING_REPLAY_RATIO = 0.7;
/** A cleaning that saves less than this share of the budget is skipped: the new session replays the history once. */
export const CONTEXT_CLEANING_MIN_SAVING_RATIO = 0.1;
/** Default of llamacpp.chatContextBudget, in provider tokens. */
export const DEFAULT_CHAT_CONTEXT_BUDGET = 200_000;
/** Smallest budget the setting takes; zero turns cleaning off. */
export const CONTEXT_CLEANING_MIN_BUDGET = 64_000;
export const CONTEXT_CLEANING_MAX_BUDGET = 1_048_576;
/** Shorter results cost about as much as their stub. */
export const STALE_RESULT_MIN_CHARS = 1_200;
/** Results this long go stale after LARGE_RESULT_MIN_AGE requests whatever the tool. */
export const LARGE_RESULT_CHARS = 8_000;
export const LARGE_RESULT_MIN_AGE = 2;
/**
 * What one image adds to a tool result's size. The chat's own estimate counts an image as about 4,096 tokens
 * (estimateSharedMessageTokens) at two characters per token, so an image weighs like this many characters.
 */
export const IMAGE_RESULT_CHARS = 8_192;
/** The chat's estimate counts two bytes a token; providers report about half that. */
const DEFAULT_TOKEN_SCALE = 0.5;
const MIN_TOKEN_SCALE = 0.2;
const MAX_TOKEN_SCALE = 1.5;

/** Results the agent cannot get again by rerunning the tool, or that hold the plan of the task. */
const KEPT_TOOLS = new Set([
	SUBAGENT_TOOL_NAME, WAIT_SUBAGENTS_TOOL_NAME, CLOSE_SUBAGENT_TOOL_NAME, ASK_QUESTIONS_TOOL_NAME, TODO_TOOL_NAME,
	LIST_TOOLS_TOOL_NAME, REQUEST_TOOLS_TOOL_NAME,
]);
/** Lookups whose results from an earlier request are stale: the workspace may have changed since. */
const LOOKUP_TOOLS = new Set(["grep_search", "file_search", "list_dir", "workspace_symbols", "list_code_usages", "fetch_webpage", "view_image"]);
const WRITE_TOOLS = new Set(["create_file", "replace_string_in_file", "multi_replace_string_in_file", "delete_file", "rename_symbol"]);
/** Browser state is replaced by the next snapshot of the same kind. */
const BROWSER_STATE = /browser_(snapshot|take_screenshot|console_messages)$/;

interface ToolUse {
	callId: string;
	name: string;
	input: Record<string, unknown>;
	/** Index of the message in the window. */
	message: number;
	/** User requests after this one; 0 for the current request. */
	age: number;
	resultChars: number;
}

function record(input: unknown): Record<string, unknown> {
	return typeof input === "object" && input !== null && !Array.isArray(input) ? input as Record<string, unknown> : {};
}

function normalizePath(value: unknown): string | undefined {
	if (typeof value !== "string" || !value.trim()) {
		return undefined;
	}
	return value.trim().replace(/\\/g, "/").replace(/^file:\/\/\/?/i, "").replace(/^\.\//, "").toLowerCase();
}

function samePath(left: string, right: string): boolean {
	return left === right || left.endsWith(`/${right}`) || right.endsWith(`/${left}`);
}

function writtenPaths(use: ToolUse): string[] {
	if (!WRITE_TOOLS.has(use.name)) {
		return [];
	}
	const paths = [normalizePath(use.input.filePath)];
	if (Array.isArray(use.input.replacements)) {
		paths.push(...use.input.replacements.map(item => normalizePath(record(item).filePath)));
	}
	return paths.filter((path): path is string => path !== undefined);
}

function readRange(use: ToolUse): { path: string; start: number; end: number } | undefined {
	const path = use.name === "read_file" ? normalizePath(use.input.filePath) : undefined;
	if (!path) {
		return undefined;
	}
	const start = typeof use.input.startLine === "number" ? use.input.startLine : 1;
	const end = typeof use.input.endLine === "number" ? use.input.endLine : Number.POSITIVE_INFINITY;
	return { path, start, end };
}

function sortedJson(value: unknown): string {
	return JSON.stringify(Array.isArray(value) ? [...value].map(String).sort() : value ?? null);
}

/** What a later call of the same tool replaces: the same command, checks, files or browser state. */
function rerunKey(use: ToolUse): string | undefined {
	switch (use.name) {
		case "run_in_terminal":
			return typeof use.input.command === "string" ? `terminal:${use.input.command.replace(/\s+/g, " ").trim()}` : undefined;
		case "read_terminal":
			return typeof use.input.terminalId === "string" ? `read_terminal:${use.input.terminalId}` : undefined;
		case "run_checks":
			return `checks:${sortedJson(use.input.checks)}`;
		case "get_errors":
			return `errors:${sortedJson(use.input.filePaths)}`;
		case "runTests":
			return `tests:${sortedJson(use.input.files)}:${sortedJson(use.input.testNames)}`;
		default:
			return BROWSER_STATE.test(use.name) ? `browser:${use.name}` : undefined;
	}
}

function keptTool(name: string): boolean {
	return KEPT_TOOLS.has(name) || /memory/i.test(name);
}

function toolUses(messages: readonly ChatMessage[]): ToolUse[] {
	const requestsAfter: number[] = new Array<number>(messages.length).fill(0);
	let requests = 0;
	for (let index = messages.length - 1; index >= 0; index--) {
		requestsAfter[index] = requests;
		const message = messages[index];
		if (message.role === "user" && !message.continuation) {
			requests++;
		}
	}
	const uses: ToolUse[] = [];
	messages.forEach((message, index) => {
		if (message.role !== "assistant") {
			return;
		}
		const calls = new Map<string, Extract<ChatPart, { kind: "toolCall" }>>();
		for (const part of message.parts) {
			if (part.kind === "toolCall") {
				calls.set(part.callId, part);
			} else if (part.kind === "toolResult") {
				const call = calls.get(part.callId);
				if (call) {
					const images = part.images?.length ?? 0;
					uses.push({ callId: part.callId, name: call.name, input: record(call.input), message: index, age: requestsAfter[index], resultChars: part.text.length + images * IMAGE_RESULT_CHARS });
				}
			}
		}
	});
	return uses;
}

/**
 * Tool results of earlier requests that no longer help: a file read that a later call rewrote or read again in
 * full, a command or check that ran again later, a lookup from an earlier request, or a large result
 * LARGE_RESULT_MIN_AGE requests old. Results of the current request, subagent reports, answers, the todo plan and
 * memory are kept. An image counts IMAGE_RESULT_CHARS, so a view_image result goes stale one request later and an
 * image-bearing result of any other tool counts as a large result.
 */
export function findStaleToolResults(messages: readonly ChatMessage[]): Set<string> {
	const uses = toolUses(messages);
	const writes = uses.map(writtenPaths);
	const reads = uses.map(readRange);
	const keys = uses.map(rerunKey);
	const stale = new Set<string>();
	uses.forEach((use, index) => {
		if (use.age === 0 || use.resultChars < STALE_RESULT_MIN_CHARS || keptTool(use.name)) {
			return;
		}
		if (LOOKUP_TOOLS.has(use.name) || (use.resultChars >= LARGE_RESULT_CHARS && use.age >= LARGE_RESULT_MIN_AGE)) {
			stale.add(use.callId);
			return;
		}
		const read = reads[index];
		const key = keys[index];
		for (let next = index + 1; next < uses.length; next++) {
			const again = reads[next];
			const superseded = read !== undefined
				? writes[next].some(path => samePath(path, read.path))
					|| (again !== undefined && samePath(again.path, read.path) && again.start <= read.start && again.end >= read.end)
				: key !== undefined && keys[next] === key;
			if (superseded) {
				stale.add(use.callId);
				return;
			}
		}
	});
	return stale;
}

/**
 * User messages whose memory index a later message's index replaces: every index-bearing message but the newest.
 * The entry texts stay in every message, so an older block may still hold the only copy of an entry.
 */
export function findStaleMemoryIndexes(messages: readonly ChatMessage[]): Set<string> {
	const withIndex = messages.filter(message => message.role === "user" && hasMemoryIndex(message.memoryContext));
	return new Set(withIndex.slice(0, -1).map(message => message.id));
}

/**
 * Tool calls of earlier requests whose long arguments no longer help: the text an edit wrote (the file holds it now,
 * and read_file shows it) and the task a finished subagent was given (its report is in the result). Calls of the
 * current request keep their arguments, as do calls the turn stopped before they had a result.
 */
export function findStaleToolArguments(messages: readonly ChatMessage[]): Set<string> {
	const stale = new Set<string>();
	for (const use of toolUses(messages)) {
		if (use.age > 0 && shortenToolArguments(use.name, use.input) !== use.input) {
			stale.add(use.callId);
		}
	}
	return stale;
}

/** The prompt tokens the provider reported for the chat's last request. */
export function lastReportedPromptTokens(history: readonly ChatMessage[]): number | undefined {
	for (let index = history.length - 1; index >= 0; index--) {
		const message = history[index];
		if (message.role === "assistant" && message.usage?.promptTokens) {
			return message.usage.promptTokens;
		}
	}
	return undefined;
}

/**
 * Provider tokens per estimated token: the last reported prompt over the chat's estimate of the history it covered
 * (everything but the newest message). 0.5 before the provider reported a request.
 */
export function providerTokenScale(history: readonly ChatMessage[], fixedTokens: number, tokensBefore = estimateRequestTokens(history, fixedTokens)): number {
	const newest = history.at(-1);
	const reported = lastReportedPromptTokens(history);
	const previous = tokensBefore - (newest ? estimateChatMessageTokens(newest) : 0);
	const measured = reported !== undefined && previous > 0 ? reported / previous : DEFAULT_TOKEN_SCALE;
	return Math.min(MAX_TOKEN_SCALE, Math.max(MIN_TOKEN_SCALE, measured));
}

/** The chat's estimate of a request with this history: the system prompt, the summary and the kept messages. */
export function estimateRequestTokens(history: readonly ChatMessage[], fixedTokens: number): number {
	const view = compactionWindow(history);
	const summary = view.compaction && hasCompactionSummary(view.compaction.part) ? estimateTextTokens(compactionSummaryText(view.compaction.part)) : 0;
	return fixedTokens + summary + view.messages.reduce((sum, message) => sum + estimateChatMessageTokens(message), 0);
}

/** One finished cleaning, for Session Quality. Token counts are in provider tokens. */
export interface ChatCleaningEvent {
	conversationId: string;
	modelId: string;
	budgetTokens: number;
	tokensBefore: number;
	tokensAfter: number;
	staleResults: number;
	/** Tool calls whose long arguments this cleaning shortened. */
	staleArguments?: number;
	summary: boolean;
	summarizedMessages: number;
	durationMs: number;
	/** Epoch milliseconds. */
	at: number;
}

export interface ContextCleaningOptions {
	/** The chat context budget in provider tokens. */
	budgetTokens: number;
	/** Tokens every request carries regardless of history, such as the system prompt; in estimate units. */
	fixedTokens: number;
	/**
	 * The most a new native session replays, in estimate units: the providers bound the replay after a cleaning by
	 * llamacpp.providerSwitchContextTokens, and a longer history loses its oldest messages, the summary among them.
	 */
	replayTokens?: number;
}

export interface ContextCleaningPlan {
	/** The history with this cleaning's stubs written into the results, for the summary step. */
	stubbed: ChatMessage[];
	/** Every result the cleaned history stubs: the earlier ones still kept and the new ones. */
	staleResults: string[];
	/** Results this cleaning stubs for the first time. */
	newStale: number;
	/** Their call ids. */
	freshResults: string[];
	/** Every user message whose memory index the cleaned history strips: the earlier ones still kept and the new ones. */
	staleMemoryIndex: string[];
	/** Memory indexes this cleaning strips for the first time. */
	newStaleMemoryIndex: number;
	/** Every tool call whose long arguments the cleaned history shortens: the earlier ones still kept and the new ones. */
	staleArguments: string[];
	/** Call ids whose arguments this cleaning shortens for the first time. */
	freshArguments: string[];
	/** Provider tokens per estimated token, from the last reported request. */
	scale: number;
	/** In estimate units. */
	tokensBefore: number;
	tokensAfterStubs: number;
	targetTokens: number;
	budgetTokens: number;
}

/**
 * Plans a cleaning when the next request would be over the budget. Sizes are measured in the provider's tokens:
 * the chat's estimate times the ratio of the last reported prompt to its estimate, so a session the provider
 * compacted itself does not trigger one. Returns undefined while the chat fits, and for a continuation.
 */
export function planContextCleaning(history: readonly ChatMessage[], options: ContextCleaningOptions): ContextCleaningPlan | undefined {
	const newest = history.at(-1);
	if (options.budgetTokens <= 0 || newest?.role !== "user" || newest.continuation) {
		return undefined;
	}
	const tokensBefore = estimateRequestTokens(history, options.fixedTokens);
	const scale = providerTokenScale(history, options.fixedTokens, tokensBefore);
	if (tokensBefore * scale <= options.budgetTokens) {
		return undefined;
	}
	const active = activeCompaction(history);
	const start = active?.start ?? 0;
	const window = compactionWindow(history).messages;
	const earlier = new Set(active?.part.staleResults ?? []);
	const found = findStaleToolResults(window);
	const fresh = new Set([...found].filter(callId => !earlier.has(callId)));
	const earlierIndex = new Set(active?.part.staleMemoryIndex ?? []);
	const foundIndex = findStaleMemoryIndexes(window);
	const freshIndex = new Set([...foundIndex].filter(id => !earlierIndex.has(id)));
	const earlierArguments = new Set(active?.part.staleArguments ?? []);
	const freshArguments = new Set([...findStaleToolArguments(window)].filter(callId => !earlierArguments.has(callId)));
	const stubbed = history.map((message, index) => {
		if (index < start || (fresh.size === 0 && freshArguments.size === 0)) {
			return message;
		}
		const parts = stubStaleToolArguments(stubStaleToolResults(message.parts, fresh), freshArguments);
		return parts === message.parts ? message : { ...message, parts };
	});
	const staleResults: string[] = [];
	const staleMemoryIndex: string[] = [];
	const staleArguments: string[] = [];
	for (const message of history.slice(start)) {
		if (message.role === "user" && message.memoryContext !== undefined && (earlierIndex.has(message.id) || foundIndex.has(message.id))) {
			staleMemoryIndex.push(message.id);
		}
		for (const part of message.parts) {
			if (part.kind === "toolResult" && (earlier.has(part.callId) || fresh.has(part.callId))) {
				staleResults.push(part.callId);
			} else if (part.kind === "toolCall" && (earlierArguments.has(part.callId) || freshArguments.has(part.callId))) {
				staleArguments.push(part.callId);
			}
		}
	}
	// The saved tokens are those of the history as the cleaning part renders it: stubs and stripped memory indexes.
	const marked = new Set(staleMemoryIndex);
	const rendered = marked.size === 0 ? stubbed : stubbed.map(message => marked.has(message.id) ? withoutMemoryIndex(message) : message);
	return {
		stubbed,
		staleResults,
		newStale: fresh.size,
		freshResults: [...fresh],
		staleMemoryIndex,
		newStaleMemoryIndex: freshIndex.size,
		staleArguments,
		freshArguments: [...freshArguments],
		scale,
		tokensBefore,
		tokensAfterStubs: estimateRequestTokens(rendered, options.fixedTokens),
		targetTokens: Math.floor(Math.min(
			options.budgetTokens * CONTEXT_CLEANING_TARGET_RATIO / scale,
			options.replayTokens ?? Number.POSITIVE_INFINITY,
		)),
		budgetTokens: options.budgetTokens,
	};
}

/** A cleaning part saves enough to pay for the replay its new session costs. */
export function cleaningPaysOff(part: ChatCompactionPart, budgetTokens: number): boolean {
	return part.tokensBefore - part.tokensAfter >= budgetTokens * CONTEXT_CLEANING_MIN_SAVING_RATIO;
}

/** llamacpp.chatContextBudget: zero turns cleaning off; other values are kept to the supported range. */
export function resolveChatContextBudget(config: Pick<vscode.WorkspaceConfiguration, "get"> = vscode.workspace.getConfiguration("llamacpp")): number {
	const value = Number(config.get("chatContextBudget", DEFAULT_CHAT_CONTEXT_BUDGET));
	if (!Number.isFinite(value)) {
		return DEFAULT_CHAT_CONTEXT_BUDGET;
	}
	return value <= 0 ? 0 : Math.floor(Math.min(CONTEXT_CLEANING_MAX_BUDGET, Math.max(CONTEXT_CLEANING_MIN_BUDGET, value)));
}

/**
 * A part for a cleaning that only stubs results: it keeps the earlier summary and window, or summarizes nothing.
 * Its sizes are in provider tokens, like every part that self-cleaning makes.
 */
export function staleOnlyCompaction(history: readonly ChatMessage[], plan: ContextCleaningPlan): ChatCompactionPart | undefined {
	const first = history[0];
	if (!first) {
		return undefined;
	}
	const active = activeCompaction(history)?.part;
	const base: ChatCompactionPart = active
		? { ...active }
		: { kind: "compaction", summary: "", keepFromMessageId: first.id, summarizedMessages: 0, tokensBefore: 0, tokensAfter: 0, method: "none" };
	// The plan lists every result still stubbed and every memory index still stripped; earlier lists must not outlive it.
	delete base.staleResults;
	delete base.staleMemoryIndex;
	delete base.staleArguments;
	return {
		...base,
		tokensBefore: Math.round(plan.tokensBefore * plan.scale),
		tokensAfter: Math.round(plan.tokensAfterStubs * plan.scale),
		...(plan.staleResults.length > 0 ? { staleResults: [...plan.staleResults] } : {}),
		...(plan.staleMemoryIndex.length > 0 ? { staleMemoryIndex: [...plan.staleMemoryIndex] } : {}),
		...(plan.staleArguments.length > 0 ? { staleArguments: [...plan.staleArguments] } : {}),
		cleaning: {
			staleResults: plan.newStale,
			...(plan.freshArguments.length > 0 ? { staleArguments: plan.freshArguments.length } : {}),
			summary: false, summarizedMessages: 0, budgetTokens: plan.budgetTokens,
		},
	};
}
