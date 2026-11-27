import type * as vscode from "vscode";
import { estimateSharedTextTokens } from "../context/provider-handoff";
import { providerTokenScale } from "./context-cleaning";
import { compactionSummaryText, compactionWindow, hasCompactionSummary } from "./lm-messages";
import type { ChatMessage } from "./shared/protocol";

/** What one image costs in the chat's estimate (estimateSharedMessageTokens). */
const IMAGE_TOKENS = 4_096;

/** Tokens of one request by kind of content, as the model receives it after cleaning. */
export interface ChatRequestBreakdown {
	/** The system prompt. */
	system: number;
	/** Names, descriptions and schemas of the offered tools. */
	tools: number;
	/** The summary of compacted turns. */
	summary: number;
	/** <memory> blocks of user messages. */
	memory: number;
	/** User requests with their host context and attachments. */
	requests: number;
	/** The model's own text in earlier answers. */
	answers: number;
	/** Arguments of tool calls. */
	toolArguments: number;
	/** Text of tool results, stubs included. */
	toolResults: number;
	/** Images in user messages and tool results. */
	images: number;
}

export const CHAT_REQUEST_BREAKDOWN_KEYS: readonly (keyof ChatRequestBreakdown)[] = [
	"system", "tools", "summary", "memory", "requests", "answers", "toolArguments", "toolResults", "images",
];

/** One request's breakdown, for Session Quality and the log. Tokens are provider tokens. */
export interface ChatRequestBreakdownEvent {
	conversationId: string;
	modelId: string;
	/** Epoch milliseconds. */
	at: number;
	tokens: ChatRequestBreakdown;
	total: number;
	/** Provider tokens per estimated token that converted the chat's estimate. */
	scale: number;
	/** Messages after the summary. */
	messages: number;
	/** Tool results that reach the model as a stub. */
	stubbedResults: number;
	/** Tool calls whose long arguments reach the model shortened. */
	shortenedArguments: number;
}

function text(value: string | undefined): number {
	return value ? estimateSharedTextTokens(value) : 0;
}

function json(value: unknown): number {
	try {
		return text(JSON.stringify(value ?? {}));
	} catch {
		return 0;
	}
}

/**
 * The parts of a request with this history, in the chat's estimate units: the history goes through the same compaction
 * window as the request, so stubs, shortened arguments and stripped memory indexes count as the model gets them.
 */
export function estimateRequestBreakdown(
	history: readonly ChatMessage[],
	system: string | undefined,
	tools: readonly vscode.LanguageModelChatTool[],
	imageInput = true,
): { tokens: ChatRequestBreakdown; messages: number; stubbedResults: number; shortenedArguments: number } {
	const tokens: ChatRequestBreakdown = { system: 0, tools: 0, summary: 0, memory: 0, requests: 0, answers: 0, toolArguments: 0, toolResults: 0, images: 0 };
	tokens.system = text(system);
	tokens.tools = text(tools.map(tool => `${tool.name}\n${tool.description}\n${JSON.stringify(tool.inputSchema ?? {})}`).join("\n"));
	const view = compactionWindow(history);
	const part = view.compaction?.part;
	if (part && hasCompactionSummary(part)) {
		tokens.summary = text(compactionSummaryText(part));
	}
	const stale = new Set(part?.staleResults ?? []);
	const shortened = new Set(part?.staleArguments ?? []);
	let stubbedResults = 0;
	let shortenedArguments = 0;
	for (const message of view.messages) {
		if (message.role === "user") {
			const request = message.parts.filter(item => item.kind === "text").map(item => item.text).join("");
			if (!request) {
				continue;
			}
			tokens.requests += text(request) + text(message.hostContext) + text(message.attachmentContext);
			tokens.memory += text(message.memoryContext);
			if (imageInput) {
				tokens.images += (message.images ?? []).filter(image => image.data !== undefined).length * IMAGE_TOKENS;
			}
			continue;
		}
		for (const item of message.parts) {
			switch (item.kind) {
				case "text":
					tokens.answers += text(item.text);
					break;
				case "toolCall":
					tokens.toolArguments += json(item.input);
					if (shortened.has(item.callId)) {
						shortenedArguments++;
					}
					break;
				case "toolResult":
					tokens.toolResults += text(item.text);
					tokens.images += (item.images?.length ?? 0) * IMAGE_TOKENS;
					if (stale.has(item.callId)) {
						stubbedResults++;
					}
					break;
				default:
					break;
			}
		}
	}
	return { tokens, messages: view.messages.length, stubbedResults, shortenedArguments };
}

/** A request's breakdown in provider tokens, scaled by what the provider reported for the chat's last request. */
export function chatRequestBreakdown(
	history: readonly ChatMessage[],
	system: string | undefined,
	tools: readonly vscode.LanguageModelChatTool[],
	meta: {
		conversationId: string; modelId: string; imageInput?: boolean; at?: number;
		/** The ratio measured before this turn's cleaning; the last report covers the history it cleaned. */
		scale?: number;
	},
): ChatRequestBreakdownEvent {
	const estimate = estimateRequestBreakdown(history, system, tools, meta.imageInput ?? true);
	const scale = meta.scale ?? providerTokenScale(history, estimate.tokens.system + estimate.tokens.tools);
	const tokens = { ...estimate.tokens };
	let total = 0;
	for (const key of CHAT_REQUEST_BREAKDOWN_KEYS) {
		tokens[key] = Math.round(estimate.tokens[key] * scale);
		total += tokens[key];
	}
	return {
		conversationId: meta.conversationId,
		modelId: meta.modelId,
		at: meta.at ?? Date.now(),
		tokens,
		total,
		scale: Number(scale.toFixed(3)),
		messages: estimate.messages,
		stubbedResults: estimate.stubbedResults,
		shortenedArguments: estimate.shortenedArguments,
	};
}
