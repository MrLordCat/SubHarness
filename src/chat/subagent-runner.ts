import * as vscode from "vscode";
import { runAgentTurn, type AgentTurnSink, type ChatToolExecutor } from "./agent-loop";
import { appendChatText, type ChatMessage, type ChatSubagentRun, type ChatSubagentStep } from "./shared/protocol";
import { estimateChatMessageTokens, estimateTextTokens } from "./compaction";
import { cleaningPaysOff, estimateRequestTokens, planContextCleaning, staleOnlyCompaction } from "./context-cleaning";
import { shortenToolResults, type ChatCompactionPart } from "./lm-messages";
import type { ChatMemoryContext } from "./memory-context";
import type { SubagentRequest } from "./tools/types";

export const SUBAGENT_INSTRUCTIONS = `<subagent>
You are a subagent that another AI agent started for one subtask. That agent sees only your final message, not your tool calls or intermediate text.
- Do the task with the tools and stay within its scope. Do not ask questions: when something is unclear, choose the most reasonable option and say which.
- You cannot turn on more tools: if one you need is missing, do what you can and name it in the report.
- Finish with a concise report: what you did or found, the files you changed, and anything left open. Include the exact paths, names and short code excerpts the other agent needs.
</subagent>`;

const MAX_STEPS = 200;
/** A safety net against a looping subagent; a long review or refactoring needs a few hundred rounds. */
const SUBAGENT_MAX_ROUNDS = 1000;
const MAX_TEXT_STEP_CHARS = 4_000;
const MAX_SUMMARY_CHARS = 160;
const MAX_INPUT_CHARS = 4_000;
const MAX_OUTPUT_CHARS = 2_000;
const UPDATE_INTERVAL_MS = 150;

export interface SubagentRunOptions {
	backend: Pick<vscode.LanguageModelChatProvider, "provideLanguageModelChatResponse">;
	model: vscode.LanguageModelChatInformation;
	request: SubagentRequest;
	/** The open subagent's conversation so far; absent for a new subagent. */
	history?: ChatMessage[];
	/** Stable id for the provider; an open subagent keeps one across its tasks. Default chat-subagent-<callId>. */
	invocationId?: string;
	/** Receives the history even when the run fails or stops. */
	onHistory?(history: ChatMessage[]): void;
	/** The subagent tool call this run answers. */
	callId: string;
	conversationId: string;
	tools: ChatToolExecutor;
	token: vscode.CancellationToken;
	/** The parent's system prompt; the subagent instructions are added to it. */
	system?: string;
	hostContext?: string;
	/** Memory for this task. It goes into the task message once, so every tool round sends the same prompt prefix. */
	memory?: ChatMemoryContext;
	/**
	 * The chat context budget in provider tokens (llamacpp.chatContextBudget). An open subagent whose earlier tasks
	 * take more cleans them like the chat does; 0 or absent turns that off.
	 */
	cleaningBudget?: number;
	/** Live state, at most every UPDATE_INTERVAL_MS. */
	onUpdate(run: ChatSubagentRun): void;
	/** Final state, also after a failure or Stop. */
	onFinish(run: ChatSubagentRun): void;
}

function summarizeInput(input: unknown): string {
	let text: string;
	try {
		text = typeof input === "string" ? input : JSON.stringify(input) ?? "";
	} catch {
		text = String(input);
	}
	const line = text.replace(/\s+/g, " ").trim();
	return line.length > MAX_SUMMARY_CHARS ? `${line.slice(0, MAX_SUMMARY_CHARS - 1)}…` : line;
}

function formatInput(input: unknown): string {
	let text: string;
	try {
		text = JSON.stringify(input, null, 2) ?? "";
	} catch {
		text = String(input);
	}
	return text.length > MAX_INPUT_CHARS ? `${text.slice(0, MAX_INPUT_CHARS - 1)}…` : text;
}

function snapshot(run: ChatSubagentRun): ChatSubagentRun {
	return { ...run, steps: run.steps.map(step => ({ ...step })), ...(run.usage ? { usage: { ...run.usage } } : {}) };
}

/** A subagent report and the conversation that produced it. */
export interface SubagentRunResult {
	/** The final report. */
	report: string;
	/** The conversation including the new task and answer. */
	history: ChatMessage[];
}

/**
 * Cleans an open subagent's earlier tasks before the next one, as the chat cleans its history: once the history with
 * the new task is over the budget (the chat's, or half the model's context when that is smaller), results, edit
 * arguments and memory indexes of earlier tasks that went stale become stubs. The part goes first into the task's
 * answer; the provider then starts its session again from the cleaned history, once. Undefined when nothing pays off.
 */
export function cleanSubagentHistory(history: readonly ChatMessage[], budgetTokens: number, maxInputTokens: number, fixedTokens = 0): ChatCompactionPart | undefined {
	const budget = Math.min(budgetTokens, maxInputTokens > 0 ? Math.floor(maxInputTokens / 2) : Number.POSITIVE_INFINITY);
	if (!(budget > 0) || history.length < 2) {
		return undefined;
	}
	const plan = planContextCleaning(history, { budgetTokens: budget, fixedTokens });
	if (!plan || (plan.newStale === 0 && plan.newStaleMemoryIndex === 0 && plan.freshArguments.length === 0)) {
		return undefined;
	}
	const part = staleOnlyCompaction(history, plan);
	return part && cleaningPaysOff(part, budget) ? part : undefined;
}

/** What the model receives of the history: with a cleaning part, its stubs count instead of the full results. */
function historyTokens(history: readonly ChatMessage[], cleaning: ChatCompactionPart | undefined): number {
	if (!cleaning) {
		return history.reduce((sum, message) => sum + estimateChatMessageTokens(message), 0);
	}
	const marker: ChatMessage = { id: "subagent-cleaning", role: "assistant", turn: 0, createdAt: 0, parts: [cleaning] };
	return estimateRequestTokens([...history, marker], 0);
}

/** Shortens old tool results and rejects a nearly full context; a cleaning part's stubs count as the model gets them. */
export function fitSubagentHistory(history: ChatMessage[], maxInputTokens: number, cleaning?: ChatCompactionPart): ChatMessage[] {
	let result = history;
	let total = historyTokens(result, cleaning);
	if (total > maxInputTokens / 2) {
		result = history.map((message, index) => index < history.length - 3 ? { ...message, parts: shortenToolResults(message.parts) } : message);
		total = historyTokens(result, cleaning);
	}
	if (total > maxInputTokens * 0.8) {
		throw new Error(`This subagent's context is nearly full (${total} of ${maxInputTokens} tokens). Close it with close_subagent and start a new subagent with a short summary of its work.`);
	}
	return result;
}

/** Runs a nested agent turn and resolves with its report and conversation. */
export async function runChatSubagent(options: SubagentRunOptions): Promise<SubagentRunResult> {
	const { request, model, token } = options;
	const run: ChatSubagentRun = {
		callId: options.callId,
		description: request.description,
		modelId: model.id,
		modelName: model.name,
		status: "running",
		steps: [],
		startedAt: Date.now(),
	};
	const toolSteps = new Map<string, Extract<ChatSubagentStep, { kind: "tool" }>>();
	const notices: string[] = [];
	// Text after the last tool call is the report; earlier text was narration between tool rounds.
	let report = "";
	let timer: ReturnType<typeof setTimeout> | undefined;
	const publish = (): void => {
		timer ??= setTimeout(() => {
			timer = undefined;
			options.onUpdate(snapshot(run));
		}, UPDATE_INTERVAL_MS);
	};
	const addStep = (step: ChatSubagentStep): void => {
		if (run.steps.length >= MAX_STEPS) {
			run.steps.splice(0, 1);
		}
		run.steps.push(step);
	};
	const turn = Math.max(0, ...(options.history ?? []).map(message => message.turn)) + 1;
	const task: ChatMessage = {
		id: `subagent-${options.callId}`,
		role: "user",
		turn,
		createdAt: run.startedAt,
		parts: [{ kind: "text", text: request.prompt }],
		...(options.hostContext ? { hostContext: options.hostContext } : {}),
		...(options.memory ? { memoryContext: options.memory.text, memoryRevisions: options.memory.revisions.map(revision => ({ ...revision })) } : {}),
	};
	const answer: ChatMessage = { id: `subagent-answer-${options.callId}`, role: "assistant", turn, createdAt: Date.now(), modelId: model.id, parts: [] };
	// Until the task reaches the model, a failure leaves the subagent's conversation as it was.
	let history = options.history ?? [];
	const sink: AgentTurnSink = {
		text: (kind, text) => {
			appendChatText(answer.parts, kind, text);
			if (kind !== "text" || !text) {
				return;
			}
			report += text;
			const last = run.steps.at(-1);
			if (last?.kind === "text") {
				last.text = (last.text + text).slice(-MAX_TEXT_STEP_CHARS);
			} else {
				addStep({ kind: "text", text: text.slice(-MAX_TEXT_STEP_CHARS) });
			}
			publish();
		},
		part: part => {
			answer.parts.push(part);
			if (part.kind === "toolCall") {
				report = "";
				const step: Extract<ChatSubagentStep, { kind: "tool" }> = {
					kind: "tool",
					name: part.name,
					summary: summarizeInput(part.input),
					input: formatInput(part.input),
				};
				toolSteps.set(part.callId, step);
				addStep(step);
			} else if (part.kind === "toolResult") {
				const step = toolSteps.get(part.callId);
				if (step) {
					const images = (part.images ?? []).map(image => `[image: ${image.name ?? image.mimeType}]`);
					const output = [part.text, ...images].filter(text => text.length > 0).join("\n");
					step.output = output.slice(0, MAX_OUTPUT_CHARS);
					step.outputChars = output.length;
					if (part.isError) {
						step.isError = true;
					}
				}
			} else if (part.kind === "notice") {
				notices.push(part.text);
				addStep({ kind: "notice", level: part.level, text: part.text });
			}
			publish();
		},
		usage: (usage, _totals) => {
			run.usage = usage;
			answer.usage = usage;
		},
	};
	const system = [options.system, SUBAGENT_INSTRUCTIONS].filter(Boolean).join("\n\n");
	try {
		const withTask = [...(options.history ?? []), task];
		const cleaning = options.history?.length
			? cleanSubagentHistory(withTask, options.cleaningBudget ?? 0, model.maxInputTokens, estimateTextTokens(system))
			: undefined;
		if (cleaning) {
			answer.parts.push(cleaning);
			const cleaned = cleaning.cleaning;
			const what = [
				...(cleaned?.staleResults ? [`${cleaned.staleResults} stale tool ${cleaned.staleResults === 1 ? "result" : "results"} replaced with a stub`] : []),
				...(cleaned?.staleArguments ? [`arguments of ${cleaned.staleArguments} earlier ${cleaned.staleArguments === 1 ? "edit" : "edits"} shortened`] : []),
			].join(", ") || "older memory indexes removed";
			addStep({ kind: "notice", level: "info", text: `Earlier tasks cleaned: ${what}; about ${cleaning.tokensBefore.toLocaleString("en-US")} → ${cleaning.tokensAfter.toLocaleString("en-US")} tokens.` });
		}
		const inputHistory = options.history?.length ? fitSubagentHistory(withTask, model.maxInputTokens, cleaning) : [task];
		history = [...inputHistory, answer];
		const result = await runAgentTurn({
			backend: options.backend,
			model,
			history: inputHistory,
			conversationId: options.conversationId,
			turn,
			tools: options.tools,
			sink,
			token,
			system,
			...(cleaning ? { initialParts: [cleaning] } : {}),
			// A delegated task nobody watches step by step keeps a bound; the chat turn itself has none.
			maxRounds: SUBAGENT_MAX_ROUNDS,
			// The composite then keeps the run off the parent's conversation, journal and native session.
			// Without that conversation the provider cannot freeze its memory block, and a block picked
			// again every round lands right after the task and breaks the prompt cache.
			modelOptions: { _subagentInvocationId: options.invocationId ?? `chat-subagent-${options.callId}`, _aabSkipSharedMemory: true, _aabStrictTools: true },
		});
		const text = report.trim();
		if (!text && notices.length > 0) {
			throw new Error(`The subagent did not finish: ${notices.join(" ")}`);
		}
		run.status = "done";
		if (!text) {
			return { report: "The subagent finished without a report.", history };
		}
		return { report: result.stopReason === "maxRounds" ? `${text}\n\n[The subagent hit the tool round limit before it finished.]` : text, history };
	} catch (error) {
		const stopped = error instanceof vscode.CancellationError || token.isCancellationRequested;
		run.status = stopped ? "stopped" : "failed";
		if (!stopped) {
			addStep({ kind: "notice", level: "error", text: error instanceof Error ? error.message : String(error) });
		}
		throw error;
	} finally {
		if (timer) {
			clearTimeout(timer);
			timer = undefined;
		}
		run.durationMs = Date.now() - run.startedAt;
		options.onHistory?.(history);
		options.onFinish(snapshot(run));
	}
}
