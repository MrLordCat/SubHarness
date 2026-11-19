import * as vscode from "vscode";
import { CocoTerminalManager, type CocoTerminalRunInput, type CocoTerminalSnapshot } from "../../coco/terminal-manager";
import { findDangerousCommand, type DangerousCommandRule } from "./danger";
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
	const match = findDangerousCommand(text, rules);
	if (!match) {
		return undefined;
	}
	const directory = typeof cwd === "string" && cwd ? `\n\nDirectory: ${cwd}` : "";
	return { title, detail: `${text}${directory}`, reason: `Matches the dangerous-command rule for "${match.text}".` };
}

/** Terminal tools for the bridge chat; they reuse the Coco terminal manager under the name "Chat". */
export function createChatTerminalTools(options: ChatTerminalToolsOptions): ChatTool[] {
	const { manager, rules } = options;
	const isTrusted = options.isTrusted ?? (() => vscode.workspace.isTrusted);
	return [
		{
			name: "run_in_terminal",
			group: CHAT_TOOL_GROUPS.terminal,
			description: "Run a shell command in an interactive VS Code terminal that the user can see. Reuses the last idle chat terminal and keeps its shell state; when cwd names another directory the terminal changes into it first. Use mode sync for finite commands (waits up to timeoutMs, default 120000) and async for servers and watchers (returns after about a second). Returns terminalId, state, exitCode and bounded output; if state is running, read that terminal instead of rerunning. Uses the default terminal shell (PowerShell on Windows).",
			inputSchema: {
				type: "object",
				properties: {
					command: { type: "string", description: "Exact command for the default terminal shell." },
					cwd: { type: "string", description: "Directory for the command. Omit to keep the current directory of the reused shell." },
					mode: { type: "string", enum: ["sync", "async"], default: "sync" },
					timeoutMs: { type: "number", minimum: 0, maximum: 3_600_000, description: "Sync wait limit; a timeout leaves the command running." },
					terminalId: { type: "string", description: "Use this idle chat terminal. Omit to reuse the last idle one." },
					newTerminal: { type: "boolean", default: false, description: "Open a separate terminal even if one is idle." },
					maxChars: { type: "number", minimum: 1, maximum: 128_000, description: "Most recent output characters to return (default 30000)." },
				},
				required: ["command"],
				additionalProperties: false,
			},
			needsConfirmation: input => dangerous(record(input).command, record(input).cwd, rules(), "Run a dangerous command"),
			invoke: async (input, token) => {
				if (!isTrusted()) {
					throw new Error("Trust this workspace before running terminal commands.");
				}
				const value = record(input);
				const maxChars = terminalMaxChars(optionalNumber(value.maxChars), RUN_DEFAULT_MAX_CHARS);
				const run: CocoTerminalRunInput = {
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
			description: "Read the bounded output and state of a command started by run_in_terminal. Optional waitMs waits for the command to finish, up to 60000 ms; do not poll repeatedly.",
			inputSchema: {
				type: "object",
				properties: {
					terminalId: { type: "string" },
					waitMs: { type: "number", minimum: 0, maximum: 60_000 },
					maxChars: { type: "number", minimum: 1, maximum: 128_000, description: "Most recent output characters to return (default 30000)." },
				},
				required: ["terminalId"],
				additionalProperties: false,
			},
			invoke: async (input, token) => {
				const value = record(input);
				const maxChars = terminalMaxChars(optionalNumber(value.maxChars), RUN_DEFAULT_MAX_CHARS);
				const snapshot = await manager.read(requireString(value, "terminalId"), optionalNumber(value.waitMs), maxChars, token);
				return formatTerminalSnapshot(snapshot, maxChars);
			},
		},
		{
			name: "send_to_terminal",
			group: CHAT_TOOL_GROUPS.terminal,
			description: "Send input to a command that is running in a chat terminal. addNewLine defaults to true; for Ctrl+C send the text \\u0003 with addNewLine false. Never ask the user for passwords or tokens through this tool; they can type in the terminal themselves.",
			inputSchema: {
				type: "object",
				properties: {
					terminalId: { type: "string" },
					text: { type: "string" },
					addNewLine: { type: "boolean", default: true },
				},
				required: ["terminalId", "text"],
				additionalProperties: false,
			},
			needsConfirmation: input => dangerous(record(input).text, undefined, rules(), "Send a dangerous command to a terminal"),
			invoke: async (input, token) => {
				if (token.isCancellationRequested) {
					throw new vscode.CancellationError();
				}
				const value = record(input);
				if (typeof value.text !== "string") {
					throw new Error("text must be a string.");
				}
				return formatTerminalSnapshot(manager.send(requireString(value, "terminalId"), value.text, value.addNewLine !== false), MANAGER_DEFAULT_MAX_CHARS);
			},
		},
		{
			name: "kill_terminal",
			group: CHAT_TOOL_GROUPS.terminal,
			description: "Close a chat terminal and stop its shell. Settles any command still waiting on it as closed.",
			inputSchema: {
				type: "object",
				properties: { terminalId: { type: "string" } },
				required: ["terminalId"],
				additionalProperties: false,
			},
			invoke: async (input, token) => {
				if (token.isCancellationRequested) {
					throw new vscode.CancellationError();
				}
				return formatTerminalSnapshot(manager.kill(requireString(record(input), "terminalId")), MANAGER_DEFAULT_MAX_CHARS);
			},
		},
	];
}
