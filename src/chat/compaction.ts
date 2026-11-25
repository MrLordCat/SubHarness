import * as vscode from "vscode";
import {
	buildCompactionSummaryPrompt,
	requestDeepSeekCompactionSummary,
	validateCompactionSummary,
	type CompactionSummaryPrompt,
	type DeepSeekCompactionRequestInput,
} from "../context/deepseek-compaction-summary";
import { buildSummaryContent } from "../context/message-compaction";
import { estimateSharedMessageTokens } from "../context/provider-handoff";
import { parseProviderModelId } from "../model-sources/source-routing";
import { detectBalanceError } from "../providers/balance-errors";
import type { OpenAIChatMessage, OpenAIToolCall } from "../types";
import { activeCompaction, compactionSummaryText, compactionWindow, hasCompactionSummary, renderChatMessage, shortenToolResults, type ChatCompactionPart } from "./lm-messages";
import type { ChatMessage, ChatPart } from "./shared/protocol";

/** Size a chat is cut down to before another model takes it over. */
export const CHAT_COMPACTION_TARGET_TOKENS = 110_000;
/** Longest summary written when a chat changes hands: twice the default, so a long task keeps its details. */
export const CHAT_COMPACTION_SUMMARY_MAX_CHARS = 32_000;
/** Room kept for the summary and the verbatim requests while choosing what stays verbatim. */
export const CHAT_COMPACTION_SUMMARY_RESERVE_TOKENS = 16_000;
/** Evidence digest the summary writer reads: the most the DeepSeek digest takes. */
const CHAT_COMPACTION_INPUT_CHARS = 240_000;
/** Output the writer may use for a summary of CHAT_COMPACTION_SUMMARY_MAX_CHARS. */
const CHAT_COMPACTION_OUTPUT_TOKENS = 12_000;
/** The summary carries the user's requests verbatim: each cut to this length, all of them to the total. */
const REQUEST_MAX_CHARS = 2_000;
const REQUESTS_TOTAL_CHARS = 12_000;
const FAILURE_MAX_CHARS = 300;
const EXTRACTIVE_LABEL = "Conversation summary (chat compaction)";
/** How long an empty DeepSeek balance is remembered: every compaction in between would fail the same way. */
const DEEPSEEK_BALANCE_SKIP_MS = 30 * 60_000;

export interface ChatCompactionLimits {
	/** Compaction starts only above this estimate. */
	triggerTokens: number;
	/** Estimate the compacted request should stay under. */
	targetTokens: number;
	/** Tokens every request carries regardless of history, such as the system prompt. */
	fixedTokens?: number;
}

export interface ChatCompactionPlan {
	/** Index in the history of the first message kept verbatim; always a user message. */
	keepFrom: number;
	/** Messages the new summary has to cover, oldest first; a trimmed turn adds its request and the rounds it drops. */
	dropped: ChatMessage[];
	previousSummary?: string;
	/** All messages that reach the model only through the summary, including earlier compactions. */
	summarizedMessages: number;
	tokensBefore: number;
	/** Estimate of everything the request still carries besides the new summary. */
	keptTokens: number;
	/** The answer to the first kept request keeps only its later tool rounds. */
	trimmedTurn?: ChatCompactionPart["trimmedTurn"];
	/** Kept messages before this user message reach the model with long tool results shortened. */
	abbreviatedUntil?: string;
	/** The user's summarized requests, verbatim, for the new part. */
	requests?: string[];
}

export interface ChatCompactionSummary {
	summary: string;
	method: ChatCompactionPart["method"];
	/** The writer that wrote a "model" summary. */
	summaryModel?: string;
	/** Why DeepSeek and the earlier writers did not write it. */
	fallbackReason?: string;
}

/** A model that writes the summary when DeepSeek cannot: a local llama.cpp model, then the model taking the chat over. */
export interface ChatSummaryWriter {
	name: string;
	write(prompt: CompactionSummaryPrompt, token: vscode.CancellationToken): Promise<string>;
}

export type ChatSummarizer = (
	plan: ChatCompactionPlan,
	token: vscode.CancellationToken,
	/** Writers tried in order; a single writer is a list of one. */
	writer?: ChatSummaryWriter | readonly ChatSummaryWriter[],
) => Promise<ChatCompactionSummary>;

export function estimateTextTokens(text: string): number {
	return estimateSharedMessageTokens(vscode.LanguageModelChatMessage.User(text));
}

export function estimateChatMessageTokens(message: ChatMessage): number {
	return renderChatMessage(message).reduce((sum, rendered) => sum + estimateSharedMessageTokens(rendered), 0);
}

/** Room a local model needs for the summary evidence: a smaller window cannot hold the compaction prompt. */
export const LOCAL_SUMMARY_MIN_INPUT_TOKENS = 32_000;
/** A local llama.cpp model that has not written the summary by then is skipped for the chat model. */
export const LOCAL_SUMMARY_TIMEOUT_MS = 120_000;

/** The llama.cpp sources: `local`, and `primary`, which the default settings leave as the only one (both URLs are localhost:8000). */
const LLAMA_CPP_SOURCE_KEYS = new Set(["local", "primary"]);

/**
 * The first llama.cpp model with room for the evidence, other than the chat model itself: a local chat model is
 * already the chat model writer.
 */
export function pickLocalSummaryModel<T extends { id: string; maxInputTokens: number }>(models: readonly T[], chatModelId: string): T | undefined {
	return models.find(model =>
		model.id !== chatModelId
		&& LLAMA_CPP_SOURCE_KEYS.has(parseProviderModelId(model.id).sourceKey ?? "")
		&& model.maxInputTokens >= LOCAL_SUMMARY_MIN_INPUT_TOKENS
	);
}

function durationLabel(timeoutMs: number): string {
	return timeoutMs >= 1000 ? `${Math.round(timeoutMs / 1000)} s` : `${Math.max(1, Math.round(timeoutMs))} ms`;
}

/**
 * A writer that gives up when the model does not answer in time: the model sees a linked token, cancelled by the
 * timer or by the outer token. A timeout fails this writer only; an outer cancellation throws CancellationError.
 */
export function withSummaryTimeout(writer: ChatSummaryWriter, timeoutMs: number = LOCAL_SUMMARY_TIMEOUT_MS): ChatSummaryWriter {
	return {
		name: writer.name,
		write: async (prompt, token) => {
			if (token.isCancellationRequested) {
				throw new vscode.CancellationError();
			}
			const source = new vscode.CancellationTokenSource();
			let timedOut = false;
			const timer = setTimeout(() => {
				timedOut = true;
				source.cancel();
			}, Math.max(1, timeoutMs));
			const linked = token.onCancellationRequested(() => source.cancel());
			try {
				return await writer.write(prompt, source.token);
			} catch (error) {
				if (token.isCancellationRequested) {
					throw new vscode.CancellationError();
				}
				if (timedOut) {
					throw new Error(`did not answer within ${durationLabel(timeoutMs)}`, { cause: error });
				}
				throw error;
			} finally {
				clearTimeout(timer);
				linked.dispose();
				source.dispose();
			}
		},
	};
}

/** The model that answered last; a different model now means the chat changes hands. */
export function previousModelId(history: readonly ChatMessage[]): string | undefined {
	for (let index = history.length - 1; index >= 0; index--) {
		const message = history[index];
		if (message.role === "assistant" && message.modelId) {
			return message.modelId;
		}
	}
	return undefined;
}

/**
 * Where an answer may be cut: right after a tool round, once every call made so far has its result.
 * A cut there keeps every kept tool call next to its result.
 */
export function roundStarts(parts: readonly ChatPart[]): number[] {
	const starts: number[] = [];
	const open = new Set<string>();
	for (let index = 0; index < parts.length; index++) {
		const part = parts[index];
		if (index > 0 && parts[index - 1].kind === "toolResult" && part.kind !== "toolResult" && open.size === 0) {
			starts.push(index);
		}
		if (part.kind === "toolCall") {
			open.add(part.callId);
		} else if (part.kind === "toolResult") {
			open.delete(part.callId);
		}
	}
	return starts;
}

/** The newest tool rounds of a turn's single answer that fit the room left after its request. */
function trimAnswer(window: readonly ChatMessage[], user: number, next: number, room: number): { fromPart: number; cost: number } | undefined {
	const answer = window[user + 1];
	if (next !== user + 2 || answer?.role !== "assistant") {
		return undefined;
	}
	const left = room - estimateChatMessageTokens(window[user]);
	for (const fromPart of roundStarts(answer.parts)) {
		const cost = estimateChatMessageTokens({ ...answer, parts: answer.parts.slice(fromPart) });
		if (cost <= left) {
			return { fromPart, cost };
		}
	}
	return undefined;
}

function rawRequestText(message: ChatMessage): string {
	return message.parts.flatMap(part => part.kind === "text" ? [part.text] : []).join("");
}

function clipRequest(text: string): string {
	const flat = text.trim();
	if (flat.length <= REQUEST_MAX_CHARS) {
		return flat;
	}
	const head = Math.floor(REQUEST_MAX_CHARS * 0.75);
	return `${flat.slice(0, head)} […] ${flat.slice(-(REQUEST_MAX_CHARS - head - 5))}`;
}

/**
 * The user's requests a summary covers, verbatim: the earlier ones and those of the dropped messages.
 * The first usually states the task and the newest say where it stands, so those stay when the total is over.
 */
export function summarizedRequests(previous: readonly string[], dropped: readonly ChatMessage[]): string[] {
	const all = [...previous, ...dropped.flatMap(message => message.role === "user" && !message.continuation ? [clipRequest(rawRequestText(message))] : [])]
		.filter(request => request.length > 0);
	if (all.length === 0) {
		return [];
	}
	const [first, ...rest] = all;
	const newest: string[] = [];
	let total = first.length;
	for (let index = rest.length - 1; index >= 0 && total + rest[index].length <= REQUESTS_TOTAL_CHARS; index--) {
		newest.unshift(rest[index]);
		total += rest[index].length;
	}
	return [first, ...newest];
}

/**
 * Chooses what stays verbatim; everything before it is summarized. Whole turns are kept newest first while they fit.
 * The turn that does not fit keeps its request and the newest tool rounds of its answer that do, so a long task is not
 * reduced to its summary. Long tool results of the turns before the latest request count, and reach the model, shortened.
 */
export function planChatCompaction(history: readonly ChatMessage[], limits: ChatCompactionLimits): ChatCompactionPlan | undefined {
	const view = compactionWindow(history);
	const active = view.compaction;
	const start = active?.start ?? 0;
	const window = view.messages;
	const fixed = limits.fixedTokens ?? 0;
	const summaryCost = active && hasCompactionSummary(active.part) ? estimateTextTokens(compactionSummaryText(active.part)) : 0;
	const tokensBefore = fixed + summaryCost + window.reduce((sum, message) => sum + estimateChatMessageTokens(message), 0);
	if (tokensBefore <= limits.triggerTokens) {
		return undefined;
	}
	let latestUser = -1;
	for (let index = window.length - 1; index >= 0; index--) {
		if (window[index].role === "user") {
			latestUser = index;
			break;
		}
	}
	if (latestUser < 0) {
		return undefined;
	}
	const kept = window.map((message, index) => {
		const parts = index < latestUser ? shortenToolResults(message.parts) : message.parts;
		return parts === message.parts ? message : { ...message, parts };
	});
	const costs = kept.map(estimateChatMessageTokens);
	const sum = (from: number, to: number): number => costs.slice(from, to).reduce((total, cost) => total + cost, 0);
	const budget = limits.targetTokens - fixed - CHAT_COMPACTION_SUMMARY_RESERVE_TOKENS;
	// The latest request is kept whole even when it alone is over the budget.
	let keepFrom = latestUser;
	let keptCost = sum(latestUser, window.length);
	let trim: { fromPart: number; cost: number } | undefined;
	for (let index = latestUser - 1; index >= 0; index--) {
		if (kept[index].role !== "user") {
			continue;
		}
		const turnCost = sum(index, keepFrom);
		if (keptCost + turnCost <= budget) {
			keepFrom = index;
			keptCost += turnCost;
			continue;
		}
		trim = trimAnswer(kept, index, keepFrom, budget - keptCost);
		if (trim) {
			keptCost += costs[index] + trim.cost;
			keepFrom = index;
		}
		break;
	}
	if (keepFrom === 0 && !trim) {
		return undefined;
	}
	const dropped = window.slice(0, keepFrom);
	const requests = summarizedRequests(active?.part.requests ?? [], dropped);
	let trimmedTurn: ChatCompactionPlan["trimmedTurn"];
	if (trim) {
		// The summary reads the request with the rounds it replaces, as the model saw them.
		const answer = window[keepFrom + 1];
		dropped.push(window[keepFrom], { ...answer, parts: answer.parts.slice(0, trim.fromPart) });
		const original = history[start + keepFrom + 1];
		const fromPart = view.partOffsets[keepFrom + 1] + trim.fromPart;
		trimmedTurn = { messageId: original.id, fromPart, rounds: Math.max(1, roundStarts(original.parts).indexOf(fromPart) + 1) };
	}
	const abbreviated = kept.some((message, index) => index >= keepFrom && index < latestUser && message !== window[index]);
	return {
		keepFrom: start + keepFrom,
		dropped,
		previousSummary: active && hasCompactionSummary(active.part) ? active.part.summary : undefined,
		summarizedMessages: (active?.part.summarizedMessages ?? 0) + keepFrom,
		tokensBefore,
		keptTokens: fixed + keptCost,
		...(trimmedTurn ? { trimmedTurn } : {}),
		...(abbreviated ? { abbreviatedUntil: window[latestUser].id } : {}),
		...(requests.length > 0 ? { requests } : {}),
	};
}

function stringifyInput(input: unknown): string {
	try {
		return JSON.stringify(input ?? {});
	} catch {
		return "{}";
	}
}

/** A user message as the summary writer reads it: the request itself, without the host context and memory blocks. */
function summaryUserText(message: ChatMessage): string {
	if (message.continuation) {
		const error = message.continuation.error ? ` after it stopped with: ${message.continuation.error}` : "";
		return `[Retry: the user asked to continue the previous answer${error}]`;
	}
	const text = rawRequestText(message);
	const attached = (message.attachments ?? []).map(attachment => attachment.path);
	return attached.length > 0 ? `${text}\n[Attached: ${attached.join(", ")}]` : text;
}

/** Chat messages in the OpenAI shape the DeepSeek summarizer and the extractive fallback read. */
export function toOpenAIMessages(messages: readonly ChatMessage[]): OpenAIChatMessage[] {
	const converted: OpenAIChatMessage[] = [];
	for (const message of messages) {
		if (message.role === "user") {
			const text = summaryUserText(message);
			if (text) {
				converted.push({ role: "user", content: text });
			}
			continue;
		}
		let text = "";
		let calls: OpenAIToolCall[] = [];
		const flush = (): void => {
			if (text || calls.length > 0) {
				converted.push({ role: "assistant", content: text, ...(calls.length > 0 ? { tool_calls: calls } : {}) });
			}
			text = "";
			calls = [];
		};
		for (const part of message.parts) {
			switch (part.kind) {
				case "text":
					if (calls.length > 0) {
						flush();
					}
					text += part.text;
					break;
				case "toolCall":
					calls.push({ id: part.callId, type: "function", function: { name: part.name, arguments: stringifyInput(part.input) } });
					break;
				case "toolResult": {
					flush();
					const images = (part.images ?? []).map(image => `[image: ${image.name ?? image.mimeType}]`);
					converted.push({ role: "tool", tool_call_id: part.callId, content: [part.text, ...images].filter(text => text.length > 0).join("\n") });
					break;
				}
				default:
					break;
			}
		}
		flush();
	}
	return converted;
}

export function extractiveChatSummary(previousSummary: string | undefined, dropped: readonly OpenAIChatMessage[]): string {
	return buildSummaryContent(EXTRACTIVE_LABEL, previousSummary ? [previousSummary] : [], [...dropped], undefined);
}

export interface ChatSummarizerDeps {
	apiKey: () => Promise<string | undefined>;
	userAgent: string;
	log?: (event: string, data: Record<string, unknown>) => void;
	/** Clock behind the DeepSeek balance memo; tests replace it. */
	now?: () => number;
	/** Test hook; defaults to the DeepSeek request. */
	request?: typeof requestDeepSeekCompactionSummary;
}

function failureText(error: unknown): string {
	return (error instanceof Error ? error.message : String(error)).replace(/\s+/g, " ").trim().slice(0, FAILURE_MAX_CHARS);
}

function clockTime(timestamp: number): string {
	const date = new Date(timestamp);
	return `${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;
}

function writerList(writers: ChatSummaryWriter | readonly ChatSummaryWriter[] | undefined): readonly ChatSummaryWriter[] {
	if (!writers) {
		return [];
	}
	return Array.isArray(writers) ? writers : [writers as ChatSummaryWriter];
}

/**
 * DeepSeek writes the summary when a key is set. When it cannot (no key, an error, an empty balance), the writers
 * tried next in order (a local llama.cpp model, then the chat model taking the chat over); the extractive summary
 * is the last resort. An empty DeepSeek balance is remembered for 30 minutes instead of retried every compaction.
 * The result says why.
 */
export function createChatSummarizer(deps: ChatSummarizerDeps): ChatSummarizer {
	const request = deps.request ?? requestDeepSeekCompactionSummary;
	const now = deps.now ?? Date.now;
	/** Per API key: until when its empty balance is not asked again. */
	const balanceSkips = new Map<string, number>();
	return async (plan, token, writers) => {
		const dropped = toOpenAIMessages(plan.dropped);
		const input: DeepSeekCompactionRequestInput = {
			previousSummary: plan.previousSummary,
			droppedMessages: dropped,
			maxSummaryChars: CHAT_COMPACTION_SUMMARY_MAX_CHARS,
			maxInputChars: CHAT_COMPACTION_INPUT_CHARS,
			maxOutputTokens: CHAT_COMPACTION_OUTPUT_TOKENS,
		};
		const failures: string[] = [];
		const apiKey = await deps.apiKey().catch(() => undefined);
		if (apiKey) {
			const until = balanceSkips.get(apiKey);
			if (until !== undefined && now() < until) {
				const reason = `DeepSeek balance is empty; skipped until ${clockTime(until)}.`;
				failures.push(reason);
				deps.log?.("chat.compaction.deepseek_skipped", { until });
			} else {
				balanceSkips.delete(apiKey);
				try {
					const result = await request({ ...input, apiKey, userAgent: deps.userAgent, cancellation: token });
					return { summary: result.content, method: "deepseek" };
				} catch (error) {
					if (token.isCancellationRequested) {
						throw new vscode.CancellationError();
					}
					const message = failureText(error);
					failures.push(message);
					if (detectBalanceError(error, "DeepSeek")) {
						balanceSkips.set(apiKey, now() + DEEPSEEK_BALANCE_SKIP_MS);
					}
					deps.log?.("chat.compaction.deepseek_failed", { message });
				}
			}
		} else {
			failures.push("No DeepSeek API key is set.");
		}
		for (const writer of writerList(writers)) {
			try {
				const text = await writer.write(buildCompactionSummaryPrompt(input), token);
				if (token.isCancellationRequested) {
					throw new vscode.CancellationError();
				}
				const summary = validateCompactionSummary(text, CHAT_COMPACTION_SUMMARY_MAX_CHARS, writer.name);
				return { summary, method: "model", summaryModel: writer.name, fallbackReason: failures.join(" ") };
			} catch (error) {
				if (error instanceof vscode.CancellationError || token.isCancellationRequested) {
					throw new vscode.CancellationError();
				}
				failures.push(`${writer.name}: ${failureText(error)}`);
				deps.log?.("chat.compaction.model_failed", { model: writer.name, message: failureText(error) });
			}
		}
		return { summary: extractiveChatSummary(plan.previousSummary, dropped), method: "extractive", fallbackReason: failures.join(" ") };
	};
}

export interface CompactChatOptions {
	limits: ChatCompactionLimits;
	summarize: ChatSummarizer;
	token: vscode.CancellationToken;
	/** A plan already made for this history with the same limits. */
	plan?: ChatCompactionPlan;
	/** Writers tried in order when DeepSeek cannot; a single writer is a list of one. */
	writer?: ChatSummaryWriter | readonly ChatSummaryWriter[];
	/** The chat log the summary names, so the model can look up details it left out. */
	transcriptPath?: string;
	/** Call ids whose results stay stubbed; the active compaction's when absent. */
	staleResults?: readonly string[];
}

/** A compaction part for the history, or undefined when the history already fits. */
export async function compactChatHistory(history: readonly ChatMessage[], options: CompactChatOptions): Promise<ChatCompactionPart | undefined> {
	const plan = options.plan ?? planChatCompaction(history, options.limits);
	if (!plan) {
		return undefined;
	}
	const result = await options.summarize(plan, options.token, options.writer);
	if (options.token.isCancellationRequested) {
		throw new vscode.CancellationError();
	}
	const stale = keptStaleResults(history, plan.keepFrom, options.staleResults ?? activeCompaction(history)?.part.staleResults);
	const part: ChatCompactionPart = {
		kind: "compaction",
		summary: result.summary,
		keepFromMessageId: history[plan.keepFrom].id,
		summarizedMessages: plan.summarizedMessages,
		tokensBefore: plan.tokensBefore,
		tokensAfter: 0,
		method: result.method,
		...(plan.trimmedTurn ? { trimmedTurn: { ...plan.trimmedTurn } } : {}),
		...(plan.abbreviatedUntil ? { abbreviatedUntil: plan.abbreviatedUntil } : {}),
		...(plan.requests?.length ? { requests: [...plan.requests] } : {}),
		...(result.summaryModel ? { summaryModel: result.summaryModel } : {}),
		...(result.fallbackReason ? { fallbackReason: result.fallbackReason } : {}),
		...(options.transcriptPath ? { transcriptPath: options.transcriptPath } : {}),
		...(stale.length > 0 ? { staleResults: stale } : {}),
	};
	part.tokensAfter = plan.keptTokens + estimateTextTokens(compactionSummaryText(part));
	return part;
}

/** The stale results a new compaction keeps stubbed: those of the messages it keeps. */
export function keptStaleResults(history: readonly ChatMessage[], keepFrom: number, stale: readonly string[] | undefined): string[] {
	if (!stale?.length) {
		return [];
	}
	const wanted = new Set(stale);
	const kept: string[] = [];
	for (const message of history.slice(keepFrom)) {
		for (const part of message.parts) {
			if (part.kind === "toolResult" && wanted.has(part.callId)) {
				kept.push(part.callId);
			}
		}
	}
	return kept;
}
