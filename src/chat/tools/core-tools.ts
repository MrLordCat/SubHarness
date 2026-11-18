import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as fsp from "node:fs/promises";
import * as path from "node:path";
import * as vscode from "vscode";
import { CHAT_TOOL_GROUPS, type ChatTool, type ChatToolConfirmation } from "./types";
import {
	displayPath,
	isInsideWorkspace,
	resolveToolPath,
	vscodeWorkspaceRoots,
	type WorkspaceRoots,
} from "./workspace-paths";

const MAX_READ_LINES = 2000;
const MAX_READ_CHARS = 200_000;
const MAX_DIRECTORY_ENTRIES = 1000;
const MAX_SCAN_FILES = 5000;
const MAX_SCAN_BYTES = 1_000_000;
const MAX_DIAGNOSTICS = 200;
const BINARY_SAMPLE_BYTES = 8192;
const MAX_MATCH_COLUMN = 300;

interface GrepRequest {
	query: string;
	isRegexp: boolean;
	includePattern?: string;
	caseSensitive: boolean;
	maxResults: number;
	roots: readonly string[];
	token: vscode.CancellationToken;
}

function inputRecord(input: unknown): Record<string, unknown> {
	if (typeof input !== "object" || input === null || Array.isArray(input)) {
		throw new Error("Tool input must be an object.");
	}
	return input as Record<string, unknown>;
}

function stringField(record: Record<string, unknown>, key: string, allowEmpty = false): string {
	const value = record[key];
	if (typeof value !== "string") {
		throw new Error(`"${key}" must be a string.`);
	}
	if (!allowEmpty && value.length === 0) {
		throw new Error(`"${key}" must not be empty.`);
	}
	return value;
}

function optionalStringField(record: Record<string, unknown>, key: string): string | undefined {
	const value = record[key];
	if (value === undefined) {
		return undefined;
	}
	if (typeof value !== "string") {
		throw new Error(`"${key}" must be a string.`);
	}
	return value.length > 0 ? value : undefined;
}

function booleanField(record: Record<string, unknown>, key: string, fallback: boolean): boolean {
	const value = record[key];
	if (value === undefined) {
		return fallback;
	}
	if (typeof value !== "boolean") {
		throw new Error(`"${key}" must be a boolean.`);
	}
	return value;
}

function integerField(
	record: Record<string, unknown>,
	key: string,
	fallback: number,
	minimum: number,
	maximum?: number
): number {
	const value = record[key];
	if (value === undefined) {
		return fallback;
	}
	if (typeof value !== "number" || !Number.isInteger(value)) {
		throw new Error(`"${key}" must be an integer.`);
	}
	if (value < minimum) {
		throw new Error(`"${key}" must be at least ${minimum}.`);
	}
	return maximum === undefined ? value : Math.min(value, maximum);
}

function errorCode(error: unknown): string {
	if (typeof error === "object" && error !== null && "code" in error) {
		const code = (error as { code?: unknown }).code;
		return typeof code === "string" ? code : "";
	}
	return "";
}

function readFailure(error: unknown, shown: string): Error {
	if (errorCode(error) === "ENOENT") {
		return new Error(`File not found: ${shown}`);
	}
	const message = error instanceof Error ? error.message : String(error);
	return new Error(`Cannot read ${shown}: ${message}`);
}

function checkCancellation(token: vscode.CancellationToken): void {
	if (token.isCancellationRequested) {
		throw new vscode.CancellationError();
	}
}

function countLines(text: string): number {
	if (text.length === 0) {
		return 0;
	}
	const lines = text.split(/\r?\n/);
	if (lines[lines.length - 1] === "") {
		lines.pop();
	}
	return lines.length;
}

function countOccurrences(text: string, needle: string): number {
	let count = 0;
	let index = text.indexOf(needle);
	while (index !== -1) {
		count++;
		index = text.indexOf(needle, index + needle.length);
	}
	return count;
}

function lineNumberAt(text: string, offset: number): number {
	return text.slice(0, Math.min(offset, text.length)).split("\n").length;
}

function sameFile(left: string, right: string): boolean {
	const first = path.resolve(left);
	const second = path.resolve(right);
	return process.platform === "win32"
		? first.toLowerCase() === second.toLowerCase()
		: first === second;
}

function escapeRegExp(value: string): string {
	return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function formatDiagnostic(shown: string, diagnostic: vscode.Diagnostic): string {
	const severity = diagnostic.severity === vscode.DiagnosticSeverity.Error ? "error" : "warning";
	const message = diagnostic.message.replace(/\r?\n/g, " ");
	const tags: string[] = [];
	if (diagnostic.source) {
		tags.push(diagnostic.source);
	}
	if (diagnostic.code !== undefined) {
		tags.push(typeof diagnostic.code === "object" ? String(diagnostic.code.value) : String(diagnostic.code));
	}
	const suffix = tags.length > 0 ? ` [${tags.join(" ")}]` : "";
	return `${shown}:${diagnostic.range.start.line + 1}:${diagnostic.range.start.character + 1} ${severity} ${message}${suffix}`;
}

function formatMatches(matches: readonly string[], maxResults: number, stopped: boolean): string {
	if (matches.length === 0) {
		return "No matches.";
	}
	return stopped ? `${matches.join("\n")}\n… stopped at ${maxResults} matches` : matches.join("\n");
}

function ripgrepArgs(request: GrepRequest): string[] {
	const args = ["--line-number", "--no-heading", "--color", "never", "--max-columns", "300", "--max-columns-preview"];
	if (!request.isRegexp) {
		args.push("--fixed-strings");
	}
	if (!request.caseSensitive) {
		args.push("--ignore-case");
	}
	if (request.includePattern) {
		args.push("--glob", request.includePattern);
	}
	args.push("-e", request.query, "--", ...request.roots);
	return args;
}

function grepWithRipgrep(executable: string, request: GrepRequest): Promise<string> {
	return new Promise<string>((resolve, reject) => {
		const matches: string[] = [];
		let remainder = "";
		let stderr = "";
		let stopped = false;
		let settled = false;
		const state: { subscription?: vscode.Disposable } = {};
		const settle = (action: () => void): void => {
			if (settled) {
				return;
			}
			settled = true;
			state.subscription?.dispose();
			action();
		};
		const child = spawn(executable, ripgrepArgs(request), { windowsHide: true });
		const handleLine = (raw: string): void => {
			if (stopped || matches.length >= request.maxResults) {
				stopped = true;
				return;
			}
			const line = raw.endsWith("\r") ? raw.slice(0, -1) : raw;
			const match = /^((?:[A-Za-z]:)?[^:]*):(\d+):(.*)$/.exec(line);
			if (!match) {
				return;
			}
			matches.push(`${displayPath(match[1], request.roots)}:${match[2]}: ${match[3].trim().slice(0, MAX_MATCH_COLUMN)}`);
			if (matches.length >= request.maxResults) {
				stopped = true;
				child.kill();
			}
		};
		child.stdout.setEncoding("utf8");
		child.stdout.on("data", (chunk: string) => {
			remainder += chunk;
			let newline = remainder.indexOf("\n");
			while (newline >= 0) {
				const line = remainder.slice(0, newline);
				remainder = remainder.slice(newline + 1);
				handleLine(line);
				if (stopped) {
					remainder = "";
					return;
				}
				newline = remainder.indexOf("\n");
			}
		});
		child.stderr.setEncoding("utf8");
		child.stderr.on("data", (chunk: string) => {
			stderr = (stderr + chunk).slice(0, 2000);
		});
		child.on("error", error => {
			settle(() => reject(new Error(`Failed to run ripgrep: ${error.message}`)));
		});
		child.on("close", code => {
			settle(() => {
				if (remainder.length > 0) {
					handleLine(remainder);
				}
				if (stopped) {
					resolve(formatMatches(matches, request.maxResults, true));
					return;
				}
				if (matches.length === 0 && code === 1) {
					resolve("No matches.");
					return;
				}
				if (matches.length === 0 && code !== 0) {
					const detail = stderr.trim().slice(0, 500);
					reject(new Error(detail.length > 0 ? `ripgrep failed: ${detail}` : `ripgrep exited with code ${code ?? "unknown"}.`));
					return;
				}
				resolve(formatMatches(matches, request.maxResults, false));
			});
		});
		state.subscription = request.token.onCancellationRequested(() => {
			child.kill();
			settle(() => reject(new vscode.CancellationError()));
		});
	});
}

async function grepWithScan(request: GrepRequest): Promise<string> {
	let matcher: RegExp;
	try {
		matcher = new RegExp(
			request.isRegexp ? request.query : escapeRegExp(request.query),
			request.caseSensitive ? "" : "i"
		);
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		throw new Error(`Invalid regular expression: ${message}`, { cause: error });
	}
	const uris = await vscode.workspace.findFiles(
		request.includePattern ?? "**/*",
		undefined,
		MAX_SCAN_FILES,
		request.token
	);
	const output: string[] = [];
	let stopped = false;
	for (const uri of uris) {
		if (request.token.isCancellationRequested) {
			throw new vscode.CancellationError();
		}
		if (output.length >= request.maxResults) {
			stopped = true;
			break;
		}
		let buffer: Buffer;
		try {
			const stats = await fsp.stat(uri.fsPath);
			if (!stats.isFile() || stats.size > MAX_SCAN_BYTES) {
				continue;
			}
			buffer = await fsp.readFile(uri.fsPath);
		} catch {
			continue;
		}
		if (buffer.subarray(0, BINARY_SAMPLE_BYTES).includes(0)) {
			continue;
		}
		const lines = buffer.toString("utf8").split(/\r?\n/);
		for (let index = 0; index < lines.length; index++) {
			if (!matcher.test(lines[index])) {
				continue;
			}
			output.push(`${displayPath(uri.fsPath, request.roots)}:${index + 1}: ${lines[index].trim().slice(0, MAX_MATCH_COLUMN)}`);
			if (output.length >= request.maxResults) {
				stopped = true;
				break;
			}
		}
	}
	if (output.length === 0) {
		return "No matches.";
	}
	return stopped ? `${output.join("\n")}\n… stopped at ${request.maxResults} matches` : output.join("\n");
}

export function findBundledRipgrep(appRoot: string = vscode.env.appRoot): string | undefined {
	const exe = process.platform === "win32" ? "rg.exe" : "rg";
	const plat = `${process.platform}-${process.arch}`;
	const candidates = [
		path.join(appRoot, "node_modules.asar.unpacked", "@vscode", "ripgrep-universal", "bin", plat, exe),
		path.join(appRoot, "node_modules", "@vscode", "ripgrep-universal", "bin", plat, exe),
		path.join(appRoot, "node_modules.asar.unpacked", "@vscode", "ripgrep", "bin", exe),
		path.join(appRoot, "node_modules", "@vscode", "ripgrep", "bin", exe),
	];
	return candidates.find(candidate => fs.existsSync(candidate));
}

export function createCoreTools(options: {
	roots?: WorkspaceRoots;
	ripgrepPath?: () => string | undefined;
} = {}): ChatTool[] {
	const rootProvider = options.roots ?? vscodeWorkspaceRoots;
	const roots = (): readonly string[] => rootProvider.roots().filter(root => root.length > 0);
	const outsideWorkspace = (input: unknown, title: string): ChatToolConfirmation | undefined => {
		try {
			const value = inputRecord(input).filePath;
			const currentRoots = roots();
			if (currentRoots.length === 0) {
				if (typeof value !== "string" || value.trim() === "") {
					return undefined;
				}
				return {
					title,
					detail: path.resolve(value),
					reason: "The path is outside the open workspace folders.",
				};
			}
			const file = resolveToolPath(value, currentRoots);
			if (!isInsideWorkspace(file, currentRoots)) {
				return {
					title,
					detail: file,
					reason: "The path is outside the open workspace folders.",
				};
			}
			return undefined;
		} catch {
			return undefined;
		}
	};

	const readFile: ChatTool = {
		name: "read_file",
		group: CHAT_TOOL_GROUPS.files,
		readOnly: true,
		description: "Reads a text file from the workspace. Returns at most 2000 lines or 200,000 characters; use startLine and endLine to page through larger files.",
		inputSchema: {
			type: "object",
			properties: {
				filePath: { type: "string", description: "Absolute path or a path relative to the workspace folder." },
				startLine: { type: "integer", minimum: 1, description: "First line to return (1-based)." },
				endLine: { type: "integer", minimum: 1, description: "Last line to return (1-based, inclusive)." },
			},
			required: ["filePath"],
		},
		async invoke(input: unknown, token: vscode.CancellationToken): Promise<string> {
			checkCancellation(token);
			const record = inputRecord(input);
			const file = resolveToolPath(record.filePath, roots());
			const shown = displayPath(file, roots());
			const startLine = integerField(record, "startLine", 1, 1);
			const endLineSpecified = record.endLine !== undefined;
			const endLine = integerField(record, "endLine", startLine + MAX_READ_LINES - 1, 1);
			if (endLine < startLine) {
				throw new Error('"endLine" must be greater than or equal to "startLine".');
			}
			const stats = await fsp.stat(file).catch((error: unknown) => {
				throw readFailure(error, shown);
			});
			if (stats.isDirectory()) {
				throw new Error(`${shown} is a directory; use list_dir to list it.`);
			}
			const buffer = await fsp.readFile(file).catch((error: unknown) => {
				throw readFailure(error, shown);
			});
			checkCancellation(token);
			if (buffer.subarray(0, BINARY_SAMPLE_BYTES).includes(0)) {
				throw new Error(`${shown} looks like a binary file.`);
			}
			const allLines = buffer.toString("utf8").split(/\r?\n/);
			if (allLines.length > 0 && allLines[allLines.length - 1] === "") {
				allLines.pop();
			}
			if (allLines.length === 0) {
				return `File: ${shown} (lines 0-0 of 0)`;
			}
			if (startLine > allLines.length) {
				return `File: ${shown} (lines ${startLine}-${startLine} of ${allLines.length})\n(startLine is past the end of the file)`;
			}
			const requestedEnd = Math.min(endLine, allLines.length);
			const cappedEnd = Math.min(requestedEnd, startLine + MAX_READ_LINES - 1);
			const truncatedForLines = requestedEnd > cappedEnd || (!endLineSpecified && cappedEnd < allLines.length);
			const rendered: string[] = [];
			let characters = 0;
			let truncatedForChars = false;
			for (let line = startLine; line <= cappedEnd; line++) {
				const text = allLines[line - 1];
				const addition = text.length + (rendered.length > 0 ? 1 : 0);
				if (characters + addition > MAX_READ_CHARS) {
					truncatedForChars = true;
					break;
				}
				rendered.push(text);
				characters += addition;
			}
			const lastLine = rendered.length > 0 ? startLine + rendered.length - 1 : startLine;
			let output = `File: ${shown} (lines ${startLine}-${lastLine} of ${allLines.length})`;
			if (rendered.length > 0) {
				output += `\n${rendered.join("\n")}`;
			}
			if (truncatedForLines) {
				output += `\n… (truncated at ${MAX_READ_LINES} lines)`;
			}
			if (truncatedForChars) {
				output += `\n… (truncated at ${MAX_READ_CHARS} characters)`;
			}
			return output;
		},
	};

	const listDir: ChatTool = {
		name: "list_dir",
		group: CHAT_TOOL_GROUPS.files,
		readOnly: true,
		description: "Lists the entries of a directory in the workspace. Directories end with a slash and come before files, each group sorted alphabetically.",
		inputSchema: {
			type: "object",
			properties: {
				path: { type: "string", description: "Absolute path or a path relative to the workspace folder." },
			},
			required: ["path"],
		},
		async invoke(input: unknown, token: vscode.CancellationToken): Promise<string> {
			checkCancellation(token);
			const record = inputRecord(input);
			const directory = resolveToolPath(record.path, roots());
			const shown = displayPath(directory, roots());
			const stats = await fsp.stat(directory).catch((error: unknown) => {
				throw readFailure(error, shown);
			});
			if (!stats.isDirectory()) {
				throw new Error(`${shown} is not a directory.`);
			}
			const entries = await fsp.readdir(directory, { withFileTypes: true }).catch((error: unknown) => {
				throw readFailure(error, shown);
			});
			checkCancellation(token);
			entries.sort((left, right) => {
				if (left.isDirectory() !== right.isDirectory()) {
					return left.isDirectory() ? -1 : 1;
				}
				return left.name.localeCompare(right.name);
			});
			const lines = entries
				.slice(0, MAX_DIRECTORY_ENTRIES)
				.map(entry => entry.isDirectory() ? `${entry.name}/` : entry.name);
			if (entries.length > MAX_DIRECTORY_ENTRIES) {
				lines.push(`… ${entries.length - MAX_DIRECTORY_ENTRIES} more`);
			}
			return lines.length > 0 ? lines.join("\n") : "(empty directory)";
		},
	};

	const fileSearch: ChatTool = {
		name: "file_search",
		group: CHAT_TOOL_GROUPS.search,
		readOnly: true,
		description: "Finds files in the workspace by a glob pattern such as **/*.ts or src/**/test*. Returns workspace-relative paths, one per line.",
		inputSchema: {
			type: "object",
			properties: {
				query: { type: "string", description: "Glob pattern to match file paths." },
				maxResults: { type: "integer", minimum: 1, maximum: 2000, description: "Maximum number of files to return (default 200)." },
			},
			required: ["query"],
		},
		async invoke(input: unknown, token: vscode.CancellationToken): Promise<string> {
			checkCancellation(token);
			const record = inputRecord(input);
			const query = stringField(record, "query");
			const maxResults = integerField(record, "maxResults", 200, 1, 2000);
			const currentRoots = roots();
			if (currentRoots.length === 0) {
				throw new Error("Open a workspace folder to search files.");
			}
			const uris = await vscode.workspace.findFiles(query, undefined, maxResults, token);
			checkCancellation(token);
			if (uris.length === 0) {
				return "No files matched.";
			}
			return uris
				.map(uri => displayPath(uri.fsPath, currentRoots))
				.sort((left, right) => left.localeCompare(right))
				.join("\n");
		},
	};

	const grepSearch: ChatTool = {
		name: "grep_search",
		group: CHAT_TOOL_GROUPS.search,
		readOnly: true,
		description: "Searches text in the workspace and returns matching lines with their file and line number. Use isRegexp for a regular expression; otherwise the query is matched literally.",
		inputSchema: {
			type: "object",
			properties: {
				query: { type: "string", description: "Text or regular expression to search for." },
				isRegexp: { type: "boolean", description: "Treat the query as a regular expression (default false)." },
				includePattern: { type: "string", description: "Glob limiting which files are searched, for example src/**/*.ts." },
				caseSensitive: { type: "boolean", description: "Match case exactly (default false)." },
				maxResults: { type: "integer", minimum: 1, maximum: 1000, description: "Maximum number of matching lines (default 100)." },
			},
			required: ["query"],
		},
		async invoke(input: unknown, token: vscode.CancellationToken): Promise<string> {
			checkCancellation(token);
			const record = inputRecord(input);
			const currentRoots = roots();
			if (currentRoots.length === 0) {
				throw new Error("Open a workspace folder to search text.");
			}
			const request: GrepRequest = {
				query: stringField(record, "query"),
				isRegexp: booleanField(record, "isRegexp", false),
				includePattern: optionalStringField(record, "includePattern"),
				caseSensitive: booleanField(record, "caseSensitive", false),
				maxResults: integerField(record, "maxResults", 100, 1, 1000),
				roots: currentRoots,
				token,
			};
			const executable = options.ripgrepPath?.() ?? findBundledRipgrep();
			return executable ? grepWithRipgrep(executable, request) : grepWithScan(request);
		},
	};

	const createFile: ChatTool = {
		name: "create_file",
		group: CHAT_TOOL_GROUPS.files,
		description: "Creates a new text file with the given content, creating missing parent directories. Fails if the file already exists; use replace_string_in_file to change an existing file.",
		inputSchema: {
			type: "object",
			properties: {
				filePath: { type: "string", description: "Absolute path or a path relative to the workspace folder." },
				content: { type: "string", description: "Full UTF-8 content of the new file." },
			},
			required: ["filePath", "content"],
		},
		needsConfirmation(input: unknown): ChatToolConfirmation | undefined {
			return outsideWorkspace(input, "Create a file outside the workspace");
		},
		async invoke(input: unknown, token: vscode.CancellationToken): Promise<string> {
			checkCancellation(token);
			const record = inputRecord(input);
			const file = resolveToolPath(record.filePath, roots());
			const content = stringField(record, "content", true);
			const shown = displayPath(file, roots());
			const exists = await fsp.stat(file).then(
				() => true,
				(error: unknown) => {
					if (errorCode(error) === "ENOENT") {
						return false;
					}
					throw readFailure(error, shown);
				}
			);
			if (exists) {
				throw new Error(`${shown} already exists; use replace_string_in_file to change it.`);
			}
			await fsp.mkdir(path.dirname(file), { recursive: true });
			checkCancellation(token);
			await fsp.writeFile(file, content, "utf8");
			return `Created ${shown} (${countLines(content)} lines).`;
		},
	};

	const replaceString: ChatTool = {
		name: "replace_string_in_file",
		group: CHAT_TOOL_GROUPS.files,
		description: "Replaces one exact occurrence of oldString in a file. oldString must match the file text exactly and must be unique; include surrounding lines to disambiguate.",
		inputSchema: {
			type: "object",
			properties: {
				filePath: { type: "string", description: "Absolute path or a path relative to the workspace folder." },
				oldString: { type: "string", description: "Exact text to replace, including whitespace." },
				newString: { type: "string", description: "Replacement text; may be empty to delete." },
			},
			required: ["filePath", "oldString", "newString"],
		},
		needsConfirmation(input: unknown): ChatToolConfirmation | undefined {
			return outsideWorkspace(input, "Edit a file outside the workspace");
		},
		async invoke(input: unknown, token: vscode.CancellationToken): Promise<string> {
			checkCancellation(token);
			const record = inputRecord(input);
			const file = resolveToolPath(record.filePath, roots());
			const oldRaw = stringField(record, "oldString");
			const newRaw = stringField(record, "newString", true);
			const shown = displayPath(file, roots());
			const diskText = await fsp.readFile(file, "utf8").catch((error: unknown) => {
				throw readFailure(error, shown);
			});
			checkCancellation(token);
			const hadBom = diskText.startsWith("\uFEFF");
			const diskBody = hadBom ? diskText.slice(1) : diskText;
			const document = vscode.workspace.textDocuments.find(candidate => sameFile(candidate.uri.fsPath, file));
			const base = document?.getText() ?? diskBody;
			const crlf = base.includes("\r\n");
			const oldString = crlf ? oldRaw.replace(/\r?\n/g, "\r\n") : oldRaw;
			const newString = crlf ? newRaw.replace(/\r?\n/g, "\r\n") : newRaw;
			const occurrences = countOccurrences(base, oldString);
			if (occurrences === 0) {
				throw new Error(`oldString was not found in ${shown}. Read the file again and copy the exact text, including whitespace.`);
			}
			if (occurrences > 1) {
				throw new Error(`oldString occurs ${occurrences} times in ${shown}; include more surrounding lines so it is unique.`);
			}
			const offset = base.indexOf(oldString);
			const startLine = lineNumberAt(base, offset);
			const endLine = lineNumberAt(base, offset + oldString.length);
			if (document) {
				const edit = new vscode.WorkspaceEdit();
				edit.replace(
					document.uri,
					new vscode.Range(document.positionAt(offset), document.positionAt(offset + oldString.length)),
					newString
				);
				if (!(await vscode.workspace.applyEdit(edit))) {
					throw new Error(`Could not apply the edit to ${shown}.`);
				}
				await document.save();
			} else {
				const updated = base.slice(0, offset) + newString + base.slice(offset + oldString.length);
				await fsp.writeFile(file, hadBom ? `\uFEFF${updated}` : updated, "utf8");
			}
			return `Edited ${shown}: replaced 1 occurrence (lines ${startLine}-${endLine}).`;
		},
	};

	const getErrors: ChatTool = {
		name: "get_errors",
		group: CHAT_TOOL_GROUPS.diagnostics,
		readOnly: true,
		description: "Returns the errors and warnings that VS Code reports for the given files, or for the whole workspace when filePaths is omitted. Each line gives the file, position, severity, message and the source code.",
		inputSchema: {
			type: "object",
			properties: {
				filePaths: {
					type: "array",
					items: { type: "string" },
					description: "Files to inspect; omit to inspect everything VS Code has diagnostics for.",
				},
			},
		},
		async invoke(input: unknown, token: vscode.CancellationToken): Promise<string> {
			checkCancellation(token);
			const record = inputRecord(input);
			const currentRoots = roots();
			const rawPaths = record.filePaths;
			let files: string[] | undefined;
			if (rawPaths !== undefined) {
				if (!Array.isArray(rawPaths)) {
					throw new Error('"filePaths" must be an array of strings.');
				}
				files = rawPaths.map((value, index) => {
					if (typeof value !== "string" || value.trim() === "") {
						throw new Error(`"filePaths[${index}]" must be a non-empty string.`);
					}
					return resolveToolPath(value, currentRoots);
				});
			}
			const found: Array<{ shown: string; diagnostic: vscode.Diagnostic }> = [];
			const collect = (uri: vscode.Uri, diagnostics: readonly vscode.Diagnostic[]): void => {
				const shown = uri.scheme === "file" ? displayPath(uri.fsPath, currentRoots) : uri.toString();
				for (const diagnostic of diagnostics) {
					if (diagnostic.severity === vscode.DiagnosticSeverity.Error || diagnostic.severity === vscode.DiagnosticSeverity.Warning) {
						found.push({ shown, diagnostic });
					}
				}
			};
			if (files) {
				for (const file of files) {
					const uri = vscode.Uri.file(file);
					collect(uri, vscode.languages.getDiagnostics(uri));
				}
			} else {
				for (const [uri, diagnostics] of vscode.languages.getDiagnostics()) {
					collect(uri, diagnostics);
				}
			}
			checkCancellation(token);
			if (found.length === 0) {
				return "No errors or warnings.";
			}
			const lines = found.slice(0, MAX_DIAGNOSTICS).map(({ shown, diagnostic }) => formatDiagnostic(shown, diagnostic));
			if (found.length > MAX_DIAGNOSTICS) {
				lines.push(`… ${found.length - MAX_DIAGNOSTICS} more`);
			}
			return lines.join("\n");
		},
	};

	return [readFile, listDir, fileSearch, grepSearch, createFile, replaceString, getErrors];
}
