import * as vscode from "vscode";
import { LIMIT_SIGNAL_OPTION, parseLimitSignal, type LimitSignal } from "../providers/limit-signal";
import { parsePromptCacheSignal, PROMPT_CACHE_OPTION } from "../providers/prompt-cache-signal";
import { toLanguageModelMessages } from "./lm-messages";
import { appendChatText, type ChatMessage, type ChatPart, type ChatPromptCache, type ChatStructuredPart, type ChatTextKind, type ChatToolImage, type ChatUsage, type ChatUsageTotals } from "./shared/protocol";
import { SUBAGENT_TOOL_NAME } from "./tools/subagent-tool";

export interface AgentTurnSink {
	text(kind: ChatTextKind, text: string): void;
	part(part: ChatStructuredPart): void;
	usage(usage: ChatUsage, totals: ChatUsageTotals): void;
	/** Cache counters of a provider prompt that reports them apart from context usage. */
	promptCache?(cache: ChatPromptCache, totals: ChatUsageTotals): void;
}

export interface ChatToolExecutor {
	readonly tools: readonly vscode.LanguageModelChatTool[];
	invoke(name: string, input: unknown, token: vscode.CancellationToken, callId?: string): Promise<{ text: string; isError: boolean; images?: ChatToolImage[] }>;
}

export interface AgentTurnRequest {
	backend: Pick<vscode.LanguageModelChatProvider, "provideLanguageModelChatResponse">;
	model: vscode.LanguageModelChatInformation;
	history: readonly ChatMessage[];
	conversationId: string;
	turn: number;
	tools: ChatToolExecutor;
	sink: AgentTurnSink;
	token: vscode.CancellationToken;
	maxRounds?: number;
	modelOptions?: Record<string, unknown>;
	/** System message text sent before the history. */
	system?: string;
	/** Parts the turn's assistant message already holds, e.g. a compaction made before the first request. */
	initialParts?: readonly ChatPart[];
	/** True when the user queued a message; the turn ends after the current tool round. */
	shouldYield?: () => boolean;
}

export const MAX_TOOL_RESULT_CHARS = 200_000;

/** A chat turn runs until the model stops calling tools or the user presses Stop. */
const DEFAULT_MAX_ROUNDS = Number.POSITIVE_INFINITY;
const TRUNCATION_NOTE = "\n\n[Tool result truncated.]";
const THINKING_PART = (vscode as unknown as Record<string, unknown>)["LanguageModelThinkingPart"] as
	(new (value: string | string[], id?: string) => vscode.LanguageModelResponsePart) | undefined;

function parseUsage(part: vscode.LanguageModelDataPart): ChatUsage | undefined {
	if (part.mimeType !== "usage") {
		return undefined;
	}
	let parsed: unknown;
	try {
		parsed = JSON.parse(new TextDecoder().decode(part.data));
	} catch {
		return undefined;
	}
	if (!parsed || typeof parsed !== "object") {
		return undefined;
	}
	const record = parsed as Record<string, unknown>;
	const details = typeof record.prompt_tokens_details === "object" && record.prompt_tokens_details !== null
		? record.prompt_tokens_details as Record<string, unknown>
		: undefined;
	const usage: ChatUsage = {};
	if (typeof record.prompt_tokens === "number") {
		usage.promptTokens = record.prompt_tokens;
	}
	if (typeof record.completion_tokens === "number") {
		usage.completionTokens = record.completion_tokens;
	}
	if (typeof record.total_tokens === "number") {
		usage.totalTokens = record.total_tokens;
	}
	if (typeof details?.cached_tokens === "number") {
		usage.cachedTokens = details.cached_tokens;
	}
	return Object.keys(usage).length > 0 ? usage : undefined;
}

function limitNotice(signal: LimitSignal): ChatStructuredPart {
	return {
		kind: "notice",
		level: "warning",
		text: signal.text,
		limit: {
			kind: signal.kind,
			provider: signal.provider,
			...(signal.window ? { window: signal.window } : {}),
			...(signal.resetAt !== undefined ? { resetAt: signal.resetAt } : {}),
		},
	};
}

function addUsage(totals: ChatUsageTotals, usage: ChatUsage): void {
	if (usage.promptTokens === undefined) {
		return;
	}
	totals.requests += 1;
	totals.promptTokens += usage.promptTokens;
	totals.completionTokens += usage.completionTokens ?? 0;
	if (usage.cachedTokens !== undefined) {
		totals.cachedTokens += usage.cachedTokens;
		totals.cacheReported += 1;
		totals.cachedPromptTokens = (totals.cachedPromptTokens ?? 0) + usage.promptTokens;
	}
}

function addPromptCache(totals: ChatUsageTotals, cache: ChatPromptCache): void {
	totals.requests += cache.requests;
	totals.promptTokens += cache.promptTokens;
	totals.completionTokens += cache.completionTokens;
	if (cache.cachedTokens !== undefined) {
		totals.cachedTokens += cache.cachedTokens;
		totals.cacheReported += cache.requests;
		totals.cachedPromptTokens = (totals.cachedPromptTokens ?? 0) + cache.promptTokens;
	}
}

function thinkingText(part: vscode.LanguageModelResponsePart): string {
	const value = (part as { value?: unknown }).value;
	if (typeof value === "string") {
		return value;
	}
	if (Array.isArray(value)) {
		return value.filter((item): item is string => typeof item === "string").join("");
	}
	return "";
}

export async function runAgentTurn(request: AgentTurnRequest): Promise<{ rounds: number; stopReason: "done" | "maxRounds" | "yielded" }> {
	const maxRounds = request.maxRounds ?? DEFAULT_MAX_ROUNDS;
	const parts: ChatPart[] = [...(request.initialParts ?? [])];
	const assistant: ChatMessage = { id: "agent-message", role: "assistant", turn: request.turn, createdAt: Date.now(), parts };
	const completed: ChatUsageTotals = { requests: 0, promptTokens: 0, cachedTokens: 0, completionTokens: 0, cacheReported: 0, cachedPromptTokens: 0 };
	let roundUsage: ChatUsage | undefined;
	for (let round = 1; round <= maxRounds; round++) {
		if (request.token.isCancellationRequested) {
			throw new vscode.CancellationError();
		}
		roundUsage = undefined;
		const roundCache: ChatPromptCache[] = [];
		const calls: Array<{ callId: string; name: string; input: unknown }> = [];
		const roundTotals = (usage = roundUsage): ChatUsageTotals => {
			const totals = { ...completed };
			if (usage) {
				addUsage(totals, usage);
			}
			for (const cache of roundCache) {
				addPromptCache(totals, cache);
			}
			return totals;
		};
		// The notice text that follows a limit signal is already shown by the notice part.
		let signalledText = "";
		const progress: vscode.Progress<vscode.LanguageModelResponsePart> = {
			report: part => {
				if (part instanceof vscode.LanguageModelTextPart) {
					let value = part.value;
					if (signalledText) {
						if (signalledText.startsWith(value)) {
							signalledText = signalledText.slice(value.length);
							return;
						}
						value = value.startsWith(signalledText) ? value.slice(signalledText.length) : value;
						signalledText = "";
					}
					if (!value) {
						return;
					}
					request.sink.text("text", value);
					appendChatText(parts, "text", value);
				} else if (part instanceof vscode.LanguageModelToolCallPart) {
					const call: ChatStructuredPart = { kind: "toolCall", callId: part.callId, name: part.name, input: part.input };
					request.sink.part(call);
					parts.push(call);
					calls.push({ callId: part.callId, name: part.name, input: part.input });
				} else if (part instanceof vscode.LanguageModelDataPart) {
					const signal = parseLimitSignal(part);
					if (signal) {
						const notice = limitNotice(signal);
						request.sink.part(notice);
						parts.push(notice);
						signalledText = signal.text;
						return;
					}
					const cache = parsePromptCacheSignal(part);
					if (cache) {
						roundCache.push(cache);
						request.sink.promptCache?.(cache, roundTotals());
						return;
					}
					const usage = parseUsage(part);
					if (usage) {
						roundUsage = usage;
						request.sink.usage(usage, roundTotals(usage));
					}
				} else if (THINKING_PART && part instanceof THINKING_PART) {
					const text = thinkingText(part);
					if (text) {
						request.sink.text("thinking", text);
						appendChatText(parts, "thinking", text);
					}
				}
			},
		};
		await request.backend.provideLanguageModelChatResponse(request.model, toLanguageModelMessages([...request.history, assistant], { system: request.system, imageInput: request.model.capabilities?.imageInput === true }), {
			toolMode: vscode.LanguageModelChatToolMode.Auto,
			tools: request.tools.tools,
			modelOptions: { ...request.modelOptions, _conversationId: request.conversationId, _copilotTurnIndex: request.turn, [LIMIT_SIGNAL_OPTION]: true, [PROMPT_CACHE_OPTION]: true },
		}, progress, request.token);
		if (roundUsage) {
			addUsage(completed, roundUsage);
		}
		for (const cache of roundCache) {
			addPromptCache(completed, cache);
		}
		if (request.token.isCancellationRequested) {
			throw new vscode.CancellationError();
		}
		if (calls.length === 0) {
			return { rounds: round, stopReason: "done" };
		}
		const invoke = async (call: typeof calls[number]): Promise<void> => {
			if (request.token.isCancellationRequested) {
				throw new vscode.CancellationError();
			}
			let outcome: { text: string; isError: boolean; images?: ChatToolImage[] };
			try {
				outcome = await request.tools.invoke(call.name, call.input, request.token, call.callId);
			} catch (error) {
				outcome = { text: error instanceof Error ? error.message : String(error), isError: true };
			}
			const truncated = outcome.text.length > MAX_TOOL_RESULT_CHARS;
			const images = outcome.images && outcome.images.length > 0 ? outcome.images : undefined;
			const result: ChatStructuredPart = {
				kind: "toolResult",
				callId: call.callId,
				text: truncated ? `${outcome.text.slice(0, MAX_TOOL_RESULT_CHARS)}${TRUNCATION_NOTE}` : outcome.text,
				isError: outcome.isError,
				...(truncated ? { truncated: true } : {}),
				...(images ? { images } : {}),
			};
			request.sink.part(result);
			parts.push(result);
		};
		let subagents = Promise.resolve();
		try {
			for (const call of calls) {
				if (call.name === SUBAGENT_TOOL_NAME) {
					// Keep delegated calls ordered while letting the main agent's tools run.
					subagents = subagents.then(() => invoke(call));
					void subagents.catch(() => undefined);
				} else {
					await invoke(call);
				}
			}
		} finally {
			// The provider needs every result before it can continue this tool round.
			await subagents;
		}
		if (request.token.isCancellationRequested) {
			throw new vscode.CancellationError();
		}
		if (request.shouldYield?.()) {
			return { rounds: round, stopReason: "yielded" };
		}
	}
	const notice: ChatStructuredPart = { kind: "notice", level: "warning", text: `The turn stopped after ${maxRounds} tool rounds.` };
	request.sink.part(notice);
	parts.push(notice);
	return { rounds: maxRounds, stopReason: "maxRounds" };
}
