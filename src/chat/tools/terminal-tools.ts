import * as vscode from "vscode";
import { CocoTerminalManager, type CocoTerminalRunInput, type CocoTerminalSnapshot } from "../../coco/terminal-manager";
import { commandKind } from "../approvals";
import { findDangerousCommands, type DangerousCommandRule } from "./danger";
import { CHAT_TOOL_GROUPS, type ChatTool, type ChatToolConfirmation } from "./types";

export interface ChatTerminalToolsOptions {
	manager: Pick<CocoTerminalManager, "run" | "read" | "send" | "kill">;
	/** Read on every call so edits to the setting apply to the next command. */
	rules: () => readonly DangerousCommandRule[];
	isTrusted?: () => boolean;
}

function record(input: unknown): Record<string, unknown> {
	return typeof input === "object" && input !== null ? input as Record<string, unknown> : {};
}

function requireString(input: Record<string, unknown>, key: string): string {
	const value = input[key];
	if (typeof value !== "string" || !value) {
		throw new Error(`${key} must be a non-empty string.`);
	}
	return value;
}

const optionalNumber = (value: unknown): number | undefined => typeof value === "number" && Number.isFinite(value) ? value : undefined;
const optionalString = (value: unknown): string | undefined => typeof value === "string" && value ? value : undefined;

const OUTPUT_LIMIT = 128_000;
const RUN_DEFAULT_MAX_CHARS = 30_000;
/** send and kill return a snapshot with the manager's own default limit. */
const MANAGER_DEFAULT_MAX_CHARS = 12_000;

/** The same clamp the manager applies, so the truncation note names the limit actually used. */
function terminalMaxChars(value: number | undefined, fallback: number): number {
	return Math.min(OUTPUT_LIMIT, Math.max(1, Math.round(value ?? fallback)));
}

/** Plain text keeps newlines readable instead of routing every line through JSON escapes. */
export function formatTerminalSnapshot(snapshot: CocoTerminalSnapshot, limit: number): string {
	const state = snapshot.exitCode === undefined ? snapshot.state : `${snapshot.state}, exit code ${snapshot.exitCode}`;
	const lines = [`Terminal: ${snapshot.terminalName} (terminalId: ${snapshot.terminalId})`, `State: ${state}`];
	if (snapshot.state === "waiting for input") { lines.push("The command is waiting for input. Answer with send_to_terminal, or interrupt it with send_to_terminal { interrupt: true }."); }
	if (snapshot.outputError) { lines.push(`Note: ${snapshot.outputError}`); }
	if (!snapshot.output) {
		lines.push("Output: (none)");
	} else if (snapshot.truncated) {
		lines.push(`Output (the last ${limit.toLocaleString("en-US")} characters; earlier output was cut, so redirect long output to a file and read it with read_file):`);
		lines.push(snapshot.output);
	} else {
		lines.push("Output:");
		lines.push(snapshot.output);
	}
	return lines.join("\n");
}

function dangerous(text: unknown, cwd: unknown, rules: readonly DangerousCommandRule[], title: string): ChatToolConfirmation | undefined {
	if (typeof text !== "string") {
		return undefined;
	}
	const matches = findDangerousCommands(text, rules);
	if (!matches.length) {
		return undefined;
	}
	const directory = typeof cwd === "string" && cwd ? `\n\nDirectory: ${cwd}` : "";
	return { title, detail: `${text}${directory}`, reason: matches.map(match => `Matches the dangerous-command rule for "${match.text}".`).join("\n"), kinds: matches.map(commandKind) };
}

function isInterruptText(value: unknown): boolean {
	return typeof value === "string" && ["\u0003", "\\U0003", "\\X03", "^C"].includes(value.trim().toUpperCase());
}

/** Terminal tools for the bridge chat; they reuse the Coco terminal manager under the name "Chat". */
export function createChatTerminalTools(options: ChatTerminalToolsOptions): ChatTool[] {
	const { manager, rules } = options;
	const isTrusted = options.isTrusted ?? (() => vscode.workspace.isTrusted);
	return [
		{
			name: "run_in_terminal",
			group: CHAT_TOOL_GROUPS.terminal,
			description: "Run a shell command in a VS Code terminal the user can see. Reuses an idle terminal of this chat or subagent, each subagent having its own; cwd changes its directory first. A terminal whose sync command timed out and printed nothing for a minute is closed and replaced. mode sync waits up to timeoutMs (default 120000); async returns after about a second, for servers and watchers. If the result's state is running, read that terminal instead of rerunning.",
			inputSchema: {
				type: "object",
				properties: {
					command: { type: "string", description: "Exact command for the default terminal shell." },
					cwd: { type: "string", description: "Directory for the command. Omit to keep the current directory of the reused shell." },
					mode: { type: "string", enum: ["sync", "async"], default: "sync", description: "\"sync\" waits for the command and returns its output; \"async\" returns after about a second, for servers and watchers." },
					timeoutMs: { type: "number", minimum: 0, maximum: 3_600_000, description: "Sync wait limit; a timeout leaves the command running." },
					terminalId: { type: "string", description: "Use this idle chat terminal. Omit to reuse the last idle one." },
					newTerminal: { type: "boolean", default: false, description: "Open a separate terminal even if one is idle." },
					maxChars: { type: "number", minimum: 1, maximum: 128_000, description: "Most recent output characters to return (default 30000)." },
				},
				required: ["command"],
				additionalProperties: false,
			},
			needsConfirmation: input => dangerous(record(input).command, record(input).cwd, rules(), "Run a dangerous command"),
			invoke: async (input, token, context) => {
				if (!isTrusted()) {
					throw new Error("Trust this workspace before running terminal commands.");
				}
				const value = record(input);
				const maxChars = terminalMaxChars(optionalNumber(value.maxChars), RUN_DEFAULT_MAX_CHARS);
				const run: CocoTerminalRunInput = {
					owner: context?.terminalOwner?.id,
					ownerLabel: context?.terminalOwner?.label,
					command: requireString(value, "command"),
					cwd: optionalString(value.cwd),
					mode: value.mode === "async" ? "async" : "sync",
					timeoutMs: optionalNumber(value.timeoutMs),
					terminalId: optionalString(value.terminalId),
					newTerminal: value.newTerminal === true,
					maxChars,
				};
				return formatTerminalSnapshot(await manager.run(run, token), maxChars);
			},
		},
		{
			name: "read_terminal",
			group: CHAT_TOOL_GROUPS.terminal,
			readOnly: true,
			description: "Read the bounded output and state of a command started by run_in_terminal. Without waitMs or with 0, returns the current output at once. A positive waitMs (up to 60000) waits for the running command to finish; use it after run_in_terminal returns state running.",
			inputSchema: {
				type: "object",
				properties: {
					terminalId: { type: "string", description: "Id of the terminal to read, as shown in run_in_terminal's result." },
					waitMs: { type: "number", minimum: 0, maximum: 60_000, description: "Wait this many milliseconds for a running command to finish; 0 returns immediately." },
					maxChars: { type: "number", minimum: 1, maximum: 128_000, description: "Most recent output characters to return (default 30000)." },
				},
				required: ["terminalId"],
				additionalProperties: false,
			},
			invoke: async (input, token, context) => {
				const value = record(input);
				const maxChars = terminalMaxChars(optionalNumber(value.maxChars), RUN_DEFAULT_MAX_CHARS);
				const snapshot = await manager.read(requireString(value, "terminalId"), optionalNumber(value.waitMs), maxChars, token, context?.terminalOwner?.id);
				return formatTerminalSnapshot(snapshot, maxChars);
			},
		},
		{
			name: "send_to_terminal",
			group: CHAT_TOOL_GROUPS.terminal,
			description: "Send input to a command that is running in a chat terminal. text is required unless interrupt is true. addNewLine defaults to true; use interrupt: true to send Ctrl+C. Never ask the user for passwords or tokens through this tool; they can type in the terminal themselves. kill_terminal closes the shell instead.",
			inputSchema: {
				type: "object",
				properties: {
					terminalId: { type: "string", description: "Id of the chat terminal to send to, as shown in run_in_terminal's result." },
					text: { type: "string", description: "Text to send. Required unless interrupt is true; empty text is rejected." },
					interrupt: { type: "boolean", description: "Send Ctrl+C to stop the running command; text and addNewLine are then ignored." },
					addNewLine: { type: "boolean", default: true, description: "Press Enter after the text (default true); false types it without running it." },
				},
				required: ["terminalId"],
				additionalProperties: false,
			},
			needsConfirmation: input => record(input).interrupt === true || isInterruptText(record(input).text) ? undefined : dangerous(record(input).text, undefined, rules(), "Send a dangerous command to a terminal"),
			invoke: async (input, token, context) => {
				if (token.isCancellationRequested) {
					throw new vscode.CancellationError();
				}
				const value = record(input);
				const terminalId = requireString(value, "terminalId");
				if (value.interrupt === true || isInterruptText(value.text)) {
					return formatTerminalSnapshot(manager.send(terminalId, "\u0003", false, context?.terminalOwner?.id), MANAGER_DEFAULT_MAX_CHARS);
				}
				if (typeof value.text !== "string" || value.text.trim() === "") {
					throw new Error("text must be a non-empty string; use interrupt: true to stop a command.");
				}
				return formatTerminalSnapshot(manager.send(terminalId, value.text, value.addNewLine !== false, context?.terminalOwner?.id), MANAGER_DEFAULT_MAX_CHARS);
			},
		},
		{
			name: "kill_terminal",
			group: CHAT_TOOL_GROUPS.terminal,
			description: "Close a chat terminal and stop its shell. Settles any command still waiting on it as closed.",
			inputSchema: {
				type: "object",
				properties: { terminalId: { type: "string", description: "Id of the chat terminal to close; its command is settled as closed." } },
				required: ["terminalId"],
				additionalProperties: false,
			},
			invoke: async (input, token, context) => {
				if (token.isCancellationRequested) {
					throw new vscode.CancellationError();
				}
				return formatTerminalSnapshot(manager.kill(requireString(record(input), "terminalId"), context?.terminalOwner?.id), MANAGER_DEFAULT_MAX_CHARS);
			},
		},
	];
}
