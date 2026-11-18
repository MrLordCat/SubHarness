import * as vscode from "vscode";
import { toLanguageModelMessages } from "./lm-messages";
import { appendChatText, type ChatMessage, type ChatPart, type ChatStructuredPart, type ChatTextKind, type ChatUsage } from "./shared/protocol";

export interface AgentTurnSink {
	text(kind: ChatTextKind, text: string): void;
	part(part: ChatStructuredPart): void;
	usage(usage: ChatUsage): void;
}

export interface ChatToolExecutor {
	readonly tools: readonly vscode.LanguageModelChatTool[];
	invoke(name: string, input: unknown, token: vscode.CancellationToken, callId?: string): Promise<{ text: string; isError: boolean }>;
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
}

export const MAX_TOOL_RESULT_CHARS = 200_000;

const DEFAULT_MAX_ROUNDS = 100;
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

export async function runAgentTurn(request: AgentTurnRequest): Promise<{ rounds: number; stopReason: "done" | "maxRounds" }> {
	const maxRounds = request.maxRounds ?? DEFAULT_MAX_ROUNDS;
	const parts: ChatPart[] = [];
	const assistant: ChatMessage = { id: "agent-message", role: "assistant", turn: request.turn, createdAt: Date.now(), parts };
	for (let round = 1; round <= maxRounds; round++) {
		const calls: Array<{ callId: string; name: string; input: unknown }> = [];
		const progress: vscode.Progress<vscode.LanguageModelResponsePart> = {
			report: part => {
				if (part instanceof vscode.LanguageModelTextPart) {
					if (!part.value) {
						return;
					}
					request.sink.text("text", part.value);
					appendChatText(parts, "text", part.value);
				} else if (part instanceof vscode.LanguageModelToolCallPart) {
					const call: ChatStructuredPart = { kind: "toolCall", callId: part.callId, name: part.name, input: part.input };
					request.sink.part(call);
					parts.push(call);
					calls.push({ callId: part.callId, name: part.name, input: part.input });
				} else if (part instanceof vscode.LanguageModelDataPart) {
					const usage = parseUsage(part);
					if (usage) {
						request.sink.usage(usage);
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
		await request.backend.provideLanguageModelChatResponse(request.model, toLanguageModelMessages([...request.history, assistant]), {
			toolMode: vscode.LanguageModelChatToolMode.Auto,
			tools: request.tools.tools,
			modelOptions: { ...request.modelOptions, _conversationId: request.conversationId, _copilotTurnIndex: request.turn },
		}, progress, request.token);
		if (calls.length === 0) {
			return { rounds: round, stopReason: "done" };
		}
		for (const call of calls) {
			if (request.token.isCancellationRequested) {
				throw new vscode.CancellationError();
			}
			let outcome: { text: string; isError: boolean };
			try {
				outcome = await request.tools.invoke(call.name, call.input, request.token, call.callId);
			} catch (error) {
				outcome = { text: error instanceof Error ? error.message : String(error), isError: true };
			}
			const truncated = outcome.text.length > MAX_TOOL_RESULT_CHARS;
			const result: ChatStructuredPart = {
				kind: "toolResult",
				callId: call.callId,
				text: truncated ? `${outcome.text.slice(0, MAX_TOOL_RESULT_CHARS)}${TRUNCATION_NOTE}` : outcome.text,
				isError: outcome.isError,
				...(truncated ? { truncated: true } : {}),
			};
			request.sink.part(result);
			parts.push(result);
		}
		if (request.token.isCancellationRequested) {
			throw new vscode.CancellationError();
		}
	}
	const notice: ChatStructuredPart = { kind: "notice", level: "warning", text: `The turn stopped after ${maxRounds} tool rounds.` };
	request.sink.part(notice);
	parts.push(notice);
	return { rounds: maxRounds, stopReason: "maxRounds" };
}
