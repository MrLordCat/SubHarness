import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import * as vscode from "vscode";

export interface PromptFolder {
	name: string;
	fsPath: string;
}

export interface PromptEnvironmentInfo {
	os: string;
	platform: string;
	shell?: string;
	appName: string;
}

export interface ActiveEditorInfo {
	filePath: string;
	selection?: { startLine: number; endLine: number };
}

export interface ChatPromptSourceOptions {
	folders: () => readonly PromptFolder[];
	environment?: () => PromptEnvironmentInfo;
	activeEditor?: () => ActiveEditorInfo | undefined;
	now?: () => Date;
}

export const BASE_CHAT_INSTRUCTIONS = `You are an expert AI programming assistant working in the user's workspace in Visual Studio Code through the AI Agent Bridge chat.
- Use the provided tools to read, search and edit files and to run commands; read the relevant code before changing it, keep changes focused, and check your work with builds, tests or get_errors when it makes sense.
- Edit existing files with replace_string_in_file and create new files with create_file; paths may be absolute or relative to the first workspace folder.
- File changes collect in a Keep/Undo panel that the user reviews, so you do not need to ask before editing files in the workspace.
- Terminal commands run in a terminal the user can see. Commands that match the user's dangerous-command rules wait for approval; if the user denies one, do not retry it and ask how to proceed.
- Do not commit, push, publish or delete branches unless the user asks for it.
- Answer in the language of the user's latest message. Use Markdown, and put file paths, commands and code identifiers in backticks.
- The user's request is inside <userRequest>; <context> holds host information such as the date and the open file.`;

export const INSTRUCTION_FILES: readonly string[] = ["AGENTS.md", "CLAUDE.md", ".github/copilot-instructions.md"];

const FILE_CHARACTER_LIMIT = 60_000;
const TOTAL_CHARACTER_LIMIT = 150_000;
const TRUNCATION_NOTICE = "\n[… truncated: the file is longer than 60000 characters]";
const SKIP_NOTICE = "[Further instruction files were skipped to keep the prompt small.]";

interface CachedInstruction {
	stamp: string;
	content: string;
}

/** Builds the stable system prompt and the per-turn host context for the chat window. */
export class ChatPromptSource {
	private readonly options: ChatPromptSourceOptions;
	private readonly cache = new Map<string, CachedInstruction>();

	constructor(options: ChatPromptSourceOptions) {
		this.options = options;
	}

	/** System message text. Re-reads instruction files only when their size or mtime changed. */
	async systemPrompt(): Promise<string> {
		const folders = this.options.folders();
		const environment = this.options.environment ? this.options.environment() : defaultEnvironment();
		const blocks = [BASE_CHAT_INSTRUCTIONS, environmentBlock(environment), workspaceBlock(folders)];
		const instructions = await this.instructionsBlock(folders);
		if (instructions !== undefined) {
			blocks.push(instructions);
		}
		return blocks.join("\n\n");
	}

	/** Host context for a new user message, wrapped in <context>…</context>. */
	turnContext(): string {
		const now = this.options.now ? this.options.now() : new Date();
		const editor = this.options.activeEditor ? this.options.activeEditor() : defaultActiveEditor();
		const lines = ["<context>", `The current date is ${formatLocalDate(now)}.`];
		if (editor !== undefined) {
			lines.push(`The user's current file is ${this.displayPath(editor.filePath)}.`);
			if (editor.selection !== undefined) {
				const start = editor.selection.startLine;
				const end = editor.selection.endLine;
				lines.push(start === end
					? `The current selection is line ${start}.`
					: `The current selection is lines ${start}-${end}.`);
			}
		}
		lines.push("</context>");
		return lines.join("\n");
	}

	private displayPath(filePath: string): string {
		for (const folder of this.options.folders()) {
			const relative = path.relative(folder.fsPath, filePath);
			if (relative !== "" && relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative)) {
				return relative.split(path.sep).join("/");
			}
		}
		return filePath;
	}

	private async instructionsBlock(folders: readonly PromptFolder[]): Promise<string | undefined> {
		const entries: string[] = [];
		let total = 0;
		let skipped = false;
		for (const folder of folders) {
			if (skipped) {
				break;
			}
			for (const relativePath of INSTRUCTION_FILES) {
				const content = await this.instruction(path.join(folder.fsPath, ...relativePath.split("/")));
				if (content === undefined) {
					continue;
				}
				if (total + content.length > TOTAL_CHARACTER_LIMIT) {
					skipped = true;
					break;
				}
				total += content.length;
				entries.push(`<instruction file="${folder.name}/${relativePath}">\n${content}\n</instruction>`);
			}
		}
		if (entries.length === 0 && !skipped) {
			return undefined;
		}
		const lines = [
			"<instructions>",
			"The repository contains instructions for AI agents. Follow them; they take precedence over the general guidance above when they conflict.",
			...entries,
		];
		if (skipped) {
			lines.push(SKIP_NOTICE);
		}
		lines.push("</instructions>");
		return lines.join("\n");
	}

	private async instruction(filePath: string): Promise<string | undefined> {
		try {
			const stat = await fs.stat(filePath);
			if (!stat.isFile()) {
				return undefined;
			}
			const stamp = `${stat.size}:${stat.mtimeMs}`;
			const cached = this.cache.get(filePath);
			if (cached !== undefined && cached.stamp === stamp) {
				return cached.content;
			}
			const content = normalizeInstruction(await fs.readFile(filePath, "utf8"));
			this.cache.set(filePath, { stamp, content });
			return content;
		} catch {
			return undefined;
		}
	}
}

function normalizeInstruction(raw: string): string {
	const withoutBom = raw.startsWith("\uFEFF") ? raw.slice(1) : raw;
	const content = withoutBom.replace(/\r\n/g, "\n").trimEnd();
	if (content.length <= FILE_CHARACTER_LIMIT) {
		return content;
	}
	return content.slice(0, FILE_CHARACTER_LIMIT) + TRUNCATION_NOTICE;
}

function environmentBlock(info: PromptEnvironmentInfo): string {
	const lines = [
		"<environment_info>",
		`The user's current OS is: ${info.os} (${info.platform})`,
	];
	if (info.shell !== undefined) {
		lines.push(`The user's default shell is: "${info.shell}"`);
	}
	lines.push(`The editor is: ${info.appName}`, "</environment_info>");
	return lines.join("\n");
}

function workspaceBlock(folders: readonly PromptFolder[]): string {
	if (folders.length === 0) {
		return "<workspace_info>\nNo workspace folder is open.\n</workspace_info>";
	}
	return [
		"<workspace_info>",
		"The workspace has these folders:",
		...folders.map(folder => `- ${folder.name}: ${folder.fsPath}`),
		"</workspace_info>",
	].join("\n");
}

function formatLocalDate(date: Date): string {
	const month = String(date.getMonth() + 1).padStart(2, "0");
	const day = String(date.getDate()).padStart(2, "0");
	return `${date.getFullYear()}-${month}-${day}`;
}

function defaultEnvironment(): PromptEnvironmentInfo {
	const shellPath = vscode.env.shell;
	return {
		os: process.platform === "win32" ? `Windows ${os.release()}` : `${os.type()} ${os.release()}`,
		platform: process.platform,
		shell: shellPath ? path.parse(shellPath).name : undefined,
		appName: vscode.env.appName,
	};
}

function defaultActiveEditor(): ActiveEditorInfo | undefined {
	const editor = vscode.window.activeTextEditor;
	if (editor === undefined || editor.document.uri.scheme !== "file") {
		return undefined;
	}
	const filePath = editor.document.uri.fsPath;
	if (editor.selection.isEmpty) {
		return { filePath };
	}
	const endLine = editor.selection.end.character === 0 ? editor.selection.end.line : editor.selection.end.line + 1;
	return {
		filePath,
		selection: {
			startLine: editor.selection.start.line + 1,
			endLine: Math.max(editor.selection.start.line + 1, endLine),
		},
	};
}
