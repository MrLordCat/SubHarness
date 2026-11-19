import * as vscode from "vscode";
import { runAgentTurn, type AgentTurnSink, type ChatToolExecutor } from "./agent-loop";
import type { ChatMessage, ChatSubagentRun, ChatSubagentStep } from "./shared/protocol";
import type { SubagentRequest } from "./tools/types";

export const SUBAGENT_INSTRUCTIONS = `<subagent>
You are a subagent that another AI agent started for one subtask. That agent sees only your final message, not your tool calls or intermediate text.
- Do the task with the tools and stay within its scope. Do not ask questions: when something is unclear, choose the most reasonable option and say which.
- Finish with a concise report: what you did or found, the files you changed, and anything left open. Include the exact paths, names and short code excerpts the other agent needs.
</subagent>`;

const MAX_STEPS = 200;
const MAX_TEXT_STEP_CHARS = 4_000;
const MAX_SUMMARY_CHARS = 160;
const UPDATE_INTERVAL_MS = 150;

export interface SubagentRunOptions {
	backend: Pick<vscode.LanguageModelChatProvider, "provideLanguageModelChatResponse">;
	model: vscode.LanguageModelChatInformation;
	request: SubagentRequest;
	/** The subagent tool call this run answers. */
	callId: string;
	conversationId: string;
	tools: ChatToolExecutor;
	token: vscode.CancellationToken;
	/** The parent's system prompt; the subagent instructions are added to it. */
	system?: string;
	hostContext?: string;
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

function snapshot(run: ChatSubagentRun): ChatSubagentRun {
	return { ...run, steps: run.steps.map(step => ({ ...step })), ...(run.usage ? { usage: { ...run.usage } } : {}) };
}

/** Runs one subagent as a nested agent turn without the parent's history and resolves with its final report. */
export async function runChatSubagent(options: SubagentRunOptions): Promise<string> {
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
	const sink: AgentTurnSink = {
		text: (kind, text) => {
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
			if (part.kind === "toolCall") {
				report = "";
				const step: Extract<ChatSubagentStep, { kind: "tool" }> = { kind: "tool", name: part.name, summary: summarizeInput(part.input) };
				toolSteps.set(part.callId, step);
				addStep(step);
			} else if (part.kind === "toolResult") {
				const step = toolSteps.get(part.callId);
				if (step && part.isError) {
					step.isError = true;
				}
			} else if (part.kind === "notice") {
				notices.push(part.text);
				addStep({ kind: "notice", level: part.level, text: part.text });
			}
			publish();
		},
		usage: (usage, _totals) => {
			run.usage = usage;
		},
	};
	const task: ChatMessage = {
		id: `subagent-${options.callId}`,
		role: "user",
		turn: 1,
		createdAt: run.startedAt,
		parts: [{ kind: "text", text: request.prompt }],
		...(options.hostContext ? { hostContext: options.hostContext } : {}),
	};
	try {
		const result = await runAgentTurn({
			backend: options.backend,
			model,
			history: [task],
			conversationId: options.conversationId,
			turn: 1,
			tools: options.tools,
			sink,
			token,
			system: [options.system, SUBAGENT_INSTRUCTIONS].filter(Boolean).join("\n\n"),
			// The composite then keeps the run off the parent's conversation, journal and native session.
			modelOptions: { _copilotSubagentInvocationId: `chat-subagent-${options.callId}` },
		});
		const text = report.trim();
		if (!text && notices.length > 0) {
			throw new Error(`The subagent did not finish: ${notices.join(" ")}`);
		}
		run.status = "done";
		if (!text) {
			return "The subagent finished without a report.";
		}
		return result.stopReason === "maxRounds" ? `${text}\n\n[The subagent hit the tool round limit before it finished.]` : text;
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
		options.onFinish(snapshot(run));
	}
}
