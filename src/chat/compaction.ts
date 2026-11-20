import * as vscode from "vscode";
import { DEEPSEEK_COMPACTION_SUMMARY_MAX_CHARS, requestDeepSeekCompactionSummary } from "../context/deepseek-compaction-summary";
import { buildSummaryContent } from "../context/message-compaction";
import { estimateSharedMessageTokens } from "../context/provider-handoff";
import type { OpenAIChatMessage, OpenAIToolCall } from "../types";
import { activeCompaction, compactionSummaryText, renderChatMessage, userRequestText, type ChatCompactionPart } from "./lm-messages";
import type { ChatMessage } from "./shared/protocol";

/** Size a chat is cut down to before another model takes it over. */
export const CHAT_COMPACTION_TARGET_TOKENS = 110_000;
/** Room kept for the summary itself while choosing what stays verbatim. */
export const CHAT_COMPACTION_SUMMARY_RESERVE_TOKENS = DEEPSEEK_COMPACTION_SUMMARY_MAX_CHARS;
const EXTRACTIVE_LABEL = "Conversation summary (chat compaction)";

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
	/** Messages the new summary has to cover, oldest first. */
	dropped: ChatMessage[];
	previousSummary?: string;
	/** All messages that reach the model only through the summary, including earlier compactions. */
	summarizedMessages: number;
	tokensBefore: number;
	/** Estimate of everything the request still carries besides the new summary. */
	keptTokens: number;
}

export interface ChatCompactionSummary {
	summary: string;
	method: ChatCompactionPart["method"];
}

export type ChatSummarizer = (plan: ChatCompactionPlan, token: vscode.CancellationToken) => Promise<ChatCompactionSummary>;

export function estimateTextTokens(text: string): number {
	return estimateSharedMessageTokens(vscode.LanguageModelChatMessage.User(text));
}

export function estimateChatMessageTokens(message: ChatMessage): number {
	return renderChatMessage(message).reduce((sum, rendered) => sum + estimateSharedMessageTokens(rendered), 0);
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
 * Chooses the oldest user message whose tail still fits the target; everything before it is summarized.
 * Cutting only at user messages keeps every tool call next to its result.
 */
export function planChatCompaction(history: readonly ChatMessage[], limits: ChatCompactionLimits): ChatCompactionPlan | undefined {
	const active = activeCompaction(history);
	const start = active?.start ?? 0;
	const window = history.slice(start);
	const costs = window.map(estimateChatMessageTokens);
	const fixed = limits.fixedTokens ?? 0;
	const summaryCost = active ? estimateTextTokens(compactionSummaryText(active.part)) : 0;
	const tokensBefore = fixed + summaryCost + costs.reduce((sum, cost) => sum + cost, 0);
	if (tokensBefore <= limits.triggerTokens) {
		return undefined;
	}
	const budget = limits.targetTokens - fixed - CHAT_COMPACTION_SUMMARY_RESERVE_TOKENS;
	let keepFrom = -1;
	let latestUser = -1;
	let suffix = 0;
	let keptCost = 0;
	let latestUserCost = 0;
	for (let index = window.length - 1; index > 0; index--) {
		suffix += costs[index];
		if (window[index].role !== "user") {
			continue;
		}
		if (latestUser < 0) {
			latestUser = index;
			latestUserCost = suffix;
		}
		if (suffix <= budget) {
			keepFrom = index;
			keptCost = suffix;
		}
	}
	if (keepFrom < 0) {
		// Even the current turn alone is over the target; keep it whole and summarize the rest.
		keepFrom = latestUser;
		keptCost = latestUserCost;
	}
	if (keepFrom <= 0) {
		return undefined;
	}
	const dropped = window.slice(0, keepFrom);
	return {
		keepFrom: start + keepFrom,
		dropped,
		previousSummary: active?.part.summary,
		summarizedMessages: (active?.part.summarizedMessages ?? 0) + dropped.length,
		tokensBefore,
		keptTokens: fixed + keptCost,
	};
}

function stringifyInput(input: unknown): string {
	try {
		return JSON.stringify(input ?? {});
	} catch {
		return "{}";
	}
}

/** Chat messages in the OpenAI shape the DeepSeek summarizer and the extractive fallback read. */
export function toOpenAIMessages(messages: readonly ChatMessage[]): OpenAIChatMessage[] {
	const converted: OpenAIChatMessage[] = [];
	for (const message of messages) {
		if (message.role === "user") {
			const text = userRequestText(message);
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
	/** Test hook; defaults to the DeepSeek request. */
	request?: typeof requestDeepSeekCompactionSummary;
}

/** DeepSeek writes the summary when a key is set; otherwise, or when it fails, the extractive summary stands in. */
export function createChatSummarizer(deps: ChatSummarizerDeps): ChatSummarizer {
	const request = deps.request ?? requestDeepSeekCompactionSummary;
	return async (plan, token) => {
		const dropped = toOpenAIMessages(plan.dropped);
		const apiKey = await deps.apiKey().catch(() => undefined);
		if (apiKey) {
			try {
				const result = await request({
					apiKey,
					userAgent: deps.userAgent,
					previousSummary: plan.previousSummary,
					droppedMessages: dropped,
					maxSummaryChars: DEEPSEEK_COMPACTION_SUMMARY_MAX_CHARS,
					cancellation: token,
				});
				return { summary: result.content, method: "deepseek" };
			} catch (error) {
				if (token.isCancellationRequested) {
					throw new vscode.CancellationError();
				}
				deps.log?.("chat.compaction.deepseek_failed", { message: error instanceof Error ? error.message : String(error) });
			}
		}
		return { summary: extractiveChatSummary(plan.previousSummary, dropped), method: "extractive" };
	};
}

export interface CompactChatOptions {
	limits: ChatCompactionLimits;
	summarize: ChatSummarizer;
	token: vscode.CancellationToken;
	/** A plan already made for this history with the same limits. */
	plan?: ChatCompactionPlan;
}

/** A compaction part for the history, or undefined when the history already fits. */
export async function compactChatHistory(history: readonly ChatMessage[], options: CompactChatOptions): Promise<ChatCompactionPart | undefined> {
	const plan = options.plan ?? planChatCompaction(history, options.limits);
	if (!plan) {
		return undefined;
	}
	const { summary, method } = await options.summarize(plan, options.token);
	if (options.token.isCancellationRequested) {
		throw new vscode.CancellationError();
	}
	const part: ChatCompactionPart = {
		kind: "compaction",
		summary,
		keepFromMessageId: history[plan.keepFrom].id,
		summarizedMessages: plan.summarizedMessages,
		tokensBefore: plan.tokensBefore,
		tokensAfter: 0,
		method,
	};
	part.tokensAfter = plan.keptTokens + estimateTextTokens(compactionSummaryText(part));
	return part;
}
