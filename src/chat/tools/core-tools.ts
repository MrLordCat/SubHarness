import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as fsp from "node:fs/promises";
import * as path from "node:path";
import * as vscode from "vscode";
import { defaultEditDiagnosticsSource, reportEditErrors, snapshotDiagnostics, type EditDiagnosticsSource } from "./edit-diagnostics";
import { CHAT_TOOL_GROUPS, MAX_IMAGE_BYTES, type ChatTool, type ChatToolConfirmation, type ChatToolOutput } from "./types";
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
const EOL_SAMPLE_FILES = 5;
const EOL_SAMPLE_BYTES = 64 * 1024;

interface GrepRequest {
	query: string;
	isRegexp: boolean;
	includePattern?: string;
	/** Root of an absolute includePattern, for the workspace scan fallback. */
	patternRoot?: string;
	caseSensitive: boolean;
	maxResults: number;
	roots: readonly string[];
	token: vscode.CancellationToken;
}

export function inputRecord(input: unknown): Record<string, unknown> {
	if (typeof input !== "object" || input === null || Array.isArray(input)) {
		throw new Error("Tool input must be an object.");
	}
	return input as Record<string, unknown>;
}

export function stringField(record: Record<string, unknown>, key: string, allowEmpty = false): string {
	const value = record[key];
	if (typeof value !== "string") {
		throw new Error(`"${key}" must be a string.`);
	}
	if (!allowEmpty && value.length === 0) {
		throw new Error(`"${key}" must not be empty.`);
	}
	return value;
}

export function optionalStringField(record: Record<string, unknown>, key: string): string | undefined {
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

export function integerField(
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

function formatSize(bytes: number): string {
	if (bytes < 1024) {
		return `${bytes} B`;
	}
	return bytes < 1024 * 1024 ? `${(bytes / 1024).toFixed(1)} KB` : `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

interface ImageSize {
	width?: number;
	height?: number;
}

function jpegSize(buffer: Buffer): ImageSize {
	let offset = 2;
	while (offset + 9 < buffer.length) {
		if (buffer[offset] !== 0xff || buffer[offset + 1] === 0xff) {
			offset += 1;
			continue;
		}
		const marker = buffer[offset + 1];
		if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
			offset += 2;
			continue;
		}
		if ((marker >= 0xc0 && marker <= 0xc3) || (marker >= 0xc5 && marker <= 0xc7) || (marker >= 0xc9 && marker <= 0xcb) || (marker >= 0xcd && marker <= 0xcf)) {
			return { width: buffer.readUInt16BE(offset + 7), height: buffer.readUInt16BE(offset + 5) };
		}
		const length = buffer.readUInt16BE(offset + 2);
		if (length < 2) {
			break;
		}
		offset += 2 + length;
	}
	return {};
}

function webpSize(buffer: Buffer): ImageSize {
	const chunk = buffer.toString("latin1", 12, 16);
	if (chunk === "VP8 " && buffer.length >= 30 && buffer[23] === 0x9d && buffer[24] === 0x01 && buffer[25] === 0x2a) {
		return { width: buffer.readUInt16LE(26) & 0x3fff, height: buffer.readUInt16LE(28) & 0x3fff };
	}
	if (chunk === "VP8L" && buffer.length >= 25 && buffer[20] === 0x2f) {
		const bits = buffer.readUInt32LE(21);
		return { width: (bits & 0x3fff) + 1, height: ((bits >> 14) & 0x3fff) + 1 };
	}
	if (chunk === "VP8X" && buffer.length >= 30) {
		return { width: buffer.readUIntLE(24, 3) + 1, height: buffer.readUIntLE(27, 3) + 1 };
	}
	return {};
}

function imageInfo(buffer: Buffer): (ImageSize & { mimeType: string }) | undefined {
	if (buffer.length >= 8 && buffer.subarray(0, 8).equals(PNG_SIGNATURE)) {
		return { mimeType: "image/png", ...(buffer.length >= 24 ? { width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20) } : {}) };
	}
	if (buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) {
		return { mimeType: "image/jpeg", ...jpegSize(buffer) };
	}
	const head = buffer.toString("latin1", 0, 6);
	if (head === "GIF87a" || head === "GIF89a") {
		return { mimeType: "image/gif", ...(buffer.length >= 10 ? { width: buffer.readUInt16LE(6), height: buffer.readUInt16LE(8) } : {}) };
	}
	if (buffer.length >= 12 && buffer.toString("latin1", 0, 4) === "RIFF" && buffer.toString("latin1", 8, 12) === "WEBP") {
		return { mimeType: "image/webp", ...webpSize(buffer) };
	}
	return undefined;
}

export function checkCancellation(token: vscode.CancellationToken): void {
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

function containingRoot(file: string, roots: readonly string[]): string | undefined {
	const absolute = path.resolve(file);
	for (const root of roots) {
		const resolved = path.resolve(root);
		const relative = path.relative(resolved, absolute);
		if (relative === "" || (!path.isAbsolute(relative) && relative !== ".." && !relative.startsWith(`..${path.sep}`))) {
			return resolved;
		}
	}
	return undefined;
}

function eolDirectories(file: string, roots: readonly string[]): string[] {
	const first = path.dirname(file);
	const root = containingRoot(file, roots);
	if (root === undefined) {
		return [first];
	}
	const directories: string[] = [];
	let current = first;
	while (directories.length < 64) {
		directories.push(current);
		const parent = path.dirname(current);
		if (sameFile(current, root) || parent === current) {
			break;
		}
		current = parent;
	}
	return directories;
}

async function readEolSample(file: string): Promise<string | undefined> {
	let handle: fsp.FileHandle | undefined;
	try {
		handle = await fsp.open(file, "r");
		const buffer = Buffer.alloc(EOL_SAMPLE_BYTES);
		const { bytesRead } = await handle.read(buffer, 0, EOL_SAMPLE_BYTES, 0);
		const sample = buffer.subarray(0, bytesRead);
		return sample.subarray(0, BINARY_SAMPLE_BYTES).includes(0) ? undefined : sample.toString("utf8");
	} catch {
		return undefined;
	} finally {
		await handle?.close();
	}
}

interface EolSample {
	files: number;
	eol?: "\r\n" | "\n";
}

async function sampleEols(directories: readonly string[], extension: string | undefined): Promise<EolSample> {
	let files = 0;
	let crlf = 0;
	let lf = 0;
	for (const directory of directories) {
		let entries: fs.Dirent[];
		try {
			entries = await fsp.readdir(directory, { withFileTypes: true });
		} catch {
			continue;
		}
		entries.sort((left, right) => left.name.localeCompare(right.name));
		for (const entry of entries) {
			if (files >= EOL_SAMPLE_FILES) {
				break;
			}
			if (!entry.isFile() || (extension !== undefined && path.extname(entry.name).toLowerCase() !== extension)) {
				continue;
			}
			const text = await readEolSample(path.join(directory, entry.name));
			if (text === undefined) {
				continue;
			}
			files++;
			const crlfCount = countOccurrences(text, "\r\n");
			crlf += crlfCount;
			lf += countOccurrences(text, "\n") - crlfCount;
		}
		if (files >= EOL_SAMPLE_FILES) {
			break;
		}
	}
	if (files === 0 || crlf === lf) {
		return { files };
	}
	return { files, eol: crlf > lf ? "\r\n" : "\n" };
}

async function eolForFile(file: string, roots: readonly string[]): Promise<"\r\n" | "\n"> {
	const sameExtension = await sampleEols(eolDirectories(file, roots), path.extname(file).toLowerCase());
	if (sameExtension.eol !== undefined) {
		return sameExtension.eol;
	}
	if (sameExtension.files === 0) {
		const anyExtension = await sampleEols([path.dirname(file)], undefined);
		if (anyExtension.eol !== undefined) {
			return anyExtension.eol;
		}
	}
	const configured = vscode.workspace.getConfiguration("files", vscode.Uri.file(file)).get<string>("eol");
	if (configured === "\r\n" || configured === "\n") {
		return configured;
	}
	return process.platform === "win32" ? "\r\n" : "\n";
}

function eolName(eol: string): string {
	return eol === "\r\n" ? "CRLF" : "LF";
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

interface NormalizedGrepPattern {
	includePattern?: string;
	patternRoot?: string;
	roots: readonly string[];
}

function normalizeGrepPattern(pattern: string | undefined, roots: readonly string[]): NormalizedGrepPattern {
	if (pattern === undefined) {
		return { roots };
	}
	if (!path.isAbsolute(pattern)) {
		// Models on Windows often write src\dir\*.ts; ripgrep globs need forward slashes.
		const slashed = pattern.replace(/\\/g, "/");
		const relative = slashed.startsWith("./") ? slashed.slice(2) : slashed;
		return relative.length > 0 ? { includePattern: relative, roots } : { roots };
	}
	const target = path.resolve(pattern);
	for (const root of roots) {
		const resolved = path.resolve(root);
		const relative = path.relative(resolved, target);
		if (relative !== "" && (path.isAbsolute(relative) || relative === ".." || relative.startsWith(`..${path.sep}`))) {
			continue;
		}
		if (relative === "") {
			return { includePattern: "**", patternRoot: resolved, roots: [resolved] };
		}
		let glob = relative.split(path.sep).join("/");
		let directory = false;
		try {
			directory = fs.statSync(target).isDirectory();
		} catch {
			// Missing or unreadable paths stay file globs.
		}
		if (directory) {
			glob = `${glob}/**`;
		}
		return { includePattern: glob, patternRoot: resolved, roots: [resolved] };
	}
	throw new Error("includePattern must be inside the workspace.");
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
	args.push("-e", request.query, "--", ".");
	return args;
}

function grepInRoot(executable: string, request: GrepRequest, root: string, matches: string[]): Promise<boolean> {
	return new Promise<boolean>((resolve, reject) => {
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
		const child = spawn(executable, ripgrepArgs(request), { cwd: root, windowsHide: true });
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
			const file = path.resolve(root, match[1]);
			matches.push(`${displayPath(file, request.roots)}:${match[2]}: ${match[3].trim().slice(0, MAX_MATCH_COLUMN)}`);
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
					resolve(true);
					return;
				}
				if (matches.length === 0 && code !== 0 && code !== 1) {
					const detail = stderr.trim().slice(0, 500);
					reject(new Error(detail.length > 0 ? `ripgrep failed: ${detail}` : `ripgrep exited with code ${code ?? "unknown"}.`));
					return;
				}
				resolve(false);
			});
		});
		state.subscription = request.token.onCancellationRequested(() => {
			child.kill();
			settle(() => reject(new vscode.CancellationError()));
		});
	});
}

async function grepWithRipgrep(executable: string, request: GrepRequest): Promise<string> {
	const matches: string[] = [];
	let stopped = false;
	for (const root of request.roots) {
		checkCancellation(request.token);
		stopped = await grepInRoot(executable, request, root, matches);
		if (stopped || matches.length >= request.maxResults) {
			stopped = true;
			break;
		}
	}
	return formatMatches(matches, request.maxResults, stopped);
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
		request.patternRoot === undefined
			? request.includePattern ?? "**/*"
			: new vscode.RelativePattern(vscode.Uri.file(request.patternRoot), request.includePattern ?? "**/*"),
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
	diagnostics?: EditDiagnosticsSource | false;
} = {}): ChatTool[] {
	const rootProvider = options.roots ?? vscodeWorkspaceRoots;
	const diagnostics = (): EditDiagnosticsSource | undefined => {
		if (options.diagnostics === false || !vscode.workspace.getConfiguration("llamacpp.chat").get<boolean>("diagnosticsAfterEdit", true)) {
			return undefined;
		}
		return options.diagnostics ?? defaultEditDiagnosticsSource;
	};
	const capture = (file: string, source: EditDiagnosticsSource | undefined, snapshots: Map<string, readonly vscode.Diagnostic[]>): void => {
		if (source && !snapshots.has(file)) {
			try {
				snapshots.set(file, snapshotDiagnostics(vscode.Uri.file(file), source));
			} catch {
				// Diagnostics are optional.
			}
		}
	};
	const report = (source: EditDiagnosticsSource | undefined, snapshots: Map<string, readonly vscode.Diagnostic[]>, token: vscode.CancellationToken): Promise<string> => {
		return source ? reportEditErrors(snapshots, source, token, file => displayPath(file, roots())) : Promise.resolve("");
	};
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

	const writtenPath = (input: unknown): string[] => {
		try {
			return [resolveToolPath(inputRecord(input).filePath, roots())];
		} catch {
			return [];
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
				filePath: { type: "string", description: "Absolute path or a path relative to the first workspace folder." },
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

	const viewImage: ChatTool = {
		name: "view_image",
		group: CHAT_TOOL_GROUPS.files,
		readOnly: true,
		description: "Shows an image file (PNG, JPEG, GIF or WebP, up to 3.75 MB) to the model, e.g. a screenshot or a diagram in the workspace. Use read_file for text files.",
		inputSchema: {
			type: "object",
			properties: {
				filePath: { type: "string", description: "Absolute path or a path relative to the workspace folder." },
			},
			required: ["filePath"],
		},
		async invoke(input: unknown, token: vscode.CancellationToken): Promise<ChatToolOutput> {
			checkCancellation(token);
			const record = inputRecord(input);
			const file = resolveToolPath(record.filePath, roots());
			const shown = displayPath(file, roots());
			const stats = await fsp.stat(file).catch((error: unknown) => {
				throw readFailure(error, shown);
			});
			if (stats.isDirectory()) {
				throw new Error(`${shown} is a directory; use list_dir to list it.`);
			}
			if (stats.size > MAX_IMAGE_BYTES) {
				throw new Error(`${shown} is ${formatSize(stats.size)}; view_image accepts up to 3.75 MB.`);
			}
			const buffer = await fsp.readFile(file).catch((error: unknown) => {
				throw readFailure(error, shown);
			});
			checkCancellation(token);
			const image = imageInfo(buffer);
			if (!image) {
				throw new Error(`${shown} is not a PNG, JPEG, GIF or WebP image.`);
			}
			const dimensions = image.width !== undefined && image.height !== undefined ? ` (${image.width}×${image.height})` : "";
			return {
				text: `Image ${shown}: ${image.mimeType}, ${formatSize(buffer.byteLength)}${dimensions}.`,
				images: [{ mimeType: image.mimeType, data: buffer.toString("base64"), byteLength: buffer.byteLength, name: path.basename(file) }],
			};
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
				path: { type: "string", description: "Absolute path or a path relative to the first workspace folder." },
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
				includePattern: { type: "string", description: "Glob relative to the first workspace folder that limits which files are searched, for example src/**/*.ts." },
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
			const query = stringField(record, "query");
			const normalized = normalizeGrepPattern(optionalStringField(record, "includePattern"), currentRoots);
			const request: GrepRequest = {
				query,
				isRegexp: booleanField(record, "isRegexp", false),
				includePattern: normalized.includePattern,
				patternRoot: normalized.patternRoot,
				caseSensitive: booleanField(record, "caseSensitive", false),
				maxResults: integerField(record, "maxResults", 100, 1, 1000),
				roots: normalized.roots,
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
		writes: writtenPath,
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
			const eol = await eolForFile(file, roots());
			const body = content.includes("\n") ? content.replace(/\r\n|\n/g, eol) : content;
			await fsp.mkdir(path.dirname(file), { recursive: true });
			checkCancellation(token);
			const source = diagnostics();
			const snapshots = new Map<string, readonly vscode.Diagnostic[]>();
			capture(file, source, snapshots);
			await fsp.writeFile(file, body, "utf8");
			return `Created ${shown} (${countLines(body)} lines, ${eolName(eol)}).` + await report(source, snapshots, token);
		},
	};

	const replaceOnce = async (file: string, oldRaw: string, newRaw: string, token: vscode.CancellationToken): Promise<string> => {
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
		writes: writtenPath,
		async invoke(input: unknown, token: vscode.CancellationToken): Promise<string> {
			checkCancellation(token);
			const record = inputRecord(input);
			const file = resolveToolPath(record.filePath, roots());
			const oldRaw = stringField(record, "oldString");
			const newRaw = stringField(record, "newString", true);
			const source = diagnostics();
			const snapshots = new Map<string, readonly vscode.Diagnostic[]>();
			capture(file, source, snapshots);
			const result = await replaceOnce(file, oldRaw, newRaw, token);
			return result + await report(source, snapshots, token);
		},
	};

	const multiReplaceString: ChatTool = {
		name: "multi_replace_string_in_file",
		group: CHAT_TOOL_GROUPS.files,
		description: "Applies several exact replacements, in order, across one or more files. Each oldString must match the current file text exactly once (earlier replacements in the same call already applied). Failed items are reported and the rest still run.",
		inputSchema: {
			type: "object",
			properties: {
				explanation: { type: "string", description: "Short note on what the edits do." },
				replacements: {
					type: "array",
					minItems: 1,
					maxItems: 50,
					items: {
						type: "object",
						properties: {
							filePath: { type: "string", description: "Absolute path or a path relative to the workspace folder." },
							oldString: { type: "string", description: "Exact text to replace, including whitespace." },
							newString: { type: "string", description: "Replacement text; may be empty to delete." },
						},
						required: ["filePath", "oldString", "newString"],
					},
				},
			},
			required: ["replacements"],
		},
		needsConfirmation(input: unknown): ChatToolConfirmation | undefined {
			try {
				const record = inputRecord(input);
				const items = record.replacements;
				if (!Array.isArray(items)) {
					return undefined;
				}
				const currentRoots = roots();
				const outside: string[] = [];
				for (const item of items) {
					try {
						const entry = inputRecord(item);
						if (currentRoots.length === 0) {
							if (typeof entry.filePath === "string" && entry.filePath.trim() !== "") {
								outside.push(path.resolve(entry.filePath));
							}
							continue;
						}
						const file = resolveToolPath(entry.filePath, currentRoots);
						if (!isInsideWorkspace(file, currentRoots)) {
							outside.push(file);
						}
					} catch {
						continue;
					}
				}
				if (outside.length === 0) {
					return undefined;
				}
				return {
					title: "Edit files outside the workspace",
					detail: outside.join("\n"),
					reason: "The path is outside the open workspace folders.",
				};
			} catch {
				return undefined;
			}
		},
		writes(input: unknown): string[] {
			try {
				const record = inputRecord(input);
				const items = record.replacements;
				if (!Array.isArray(items)) {
					return [];
				}
				const files = new Set<string>();
				for (const item of items) {
					try {
						files.add(resolveToolPath(inputRecord(item).filePath, roots()));
					} catch {
						continue;
					}
				}
				return [...files];
			} catch {
				return [];
			}
		},
		async invoke(input: unknown, token: vscode.CancellationToken): Promise<string> {
			checkCancellation(token);
			const record = inputRecord(input);
			const items = record.replacements;
			if (!Array.isArray(items) || items.length === 0) {
				throw new Error('"replacements" must be a non-empty array.');
			}
			if (items.length > 50) {
				throw new Error('"replacements" must have at most 50 items.');
			}
			const lines: string[] = [];
			const source = diagnostics();
			const snapshots = new Map<string, readonly vscode.Diagnostic[]>();
			const successful = new Set<string>();
			let applied = 0;
			for (let index = 0; index < items.length; index++) {
				checkCancellation(token);
				try {
					const entry = inputRecord(items[index]);
					const file = resolveToolPath(entry.filePath, roots());
					const oldRaw = stringField(entry, "oldString");
					const newRaw = stringField(entry, "newString", true);
					capture(file, source, snapshots);
					const result = await replaceOnce(file, oldRaw, newRaw, token);
					successful.add(file);
					applied += 1;
					lines.push(`${index + 1}. ${result}`);
				} catch (error) {
					if (error instanceof vscode.CancellationError) {
						throw error;
					}
					lines.push(`${index + 1}. Failed: ${error instanceof Error ? error.message : String(error)}`);
				}
			}
			if (applied === 0) {
				throw new Error(`None of the ${items.length} replacements applied:\n${lines.join("\n")}`);
			}
			for (const file of snapshots.keys()) {
				if (!successful.has(file)) {
					snapshots.delete(file);
				}
			}
			return `Applied ${applied} of ${items.length} replacements:\n${lines.join("\n")}` + await report(source, snapshots, token);
		},
	};

	const deleteFile: ChatTool = {
		name: "delete_file",
		group: CHAT_TOOL_GROUPS.files,
		description: "Deletes a file, or a folder when recursive is true. Changes inside the workspace can be undone from the chat's changes panel.",
		inputSchema: {
			type: "object",
			properties: {
				filePath: { type: "string", description: "Absolute path or a path relative to the workspace folder." },
				recursive: { type: "boolean", description: "Delete a folder and everything in it (default false)." },
			},
			required: ["filePath"],
		},
		needsConfirmation(input: unknown): ChatToolConfirmation | undefined {
			const outside = outsideWorkspace(input, "Delete outside the workspace");
			if (outside !== undefined) {
				return outside;
			}
			try {
				const record = inputRecord(input);
				if (record.recursive !== true) {
					return undefined;
				}
				const target = resolveToolPath(record.filePath, roots());
				return fs.statSync(target).isDirectory()
					? {
						title: "Delete a folder",
						detail: target,
						reason: "Deletes the folder and everything in it.",
					}
					: undefined;
			} catch {
				return undefined;
			}
		},
		writes: writtenPath,
		async invoke(input: unknown, token: vscode.CancellationToken): Promise<string> {
			checkCancellation(token);
			const record = inputRecord(input);
			const file = resolveToolPath(record.filePath, roots());
			const recursive = booleanField(record, "recursive", false);
			const shown = displayPath(file, roots());
			const stats = await fsp.stat(file).catch((error: unknown) => {
				throw readFailure(error, shown);
			});
			if (stats.isDirectory()) {
				if (roots().some(root => sameFile(root, file))) {
					throw new Error(`Cannot delete the workspace folder ${shown}.`);
				}
				if (!recursive && (await fsp.readdir(file)).length > 0) {
					throw new Error(`${shown} is not empty; pass recursive: true to delete the folder and everything in it.`);
				}
				checkCancellation(token);
				await fsp.rm(file, { recursive: true, force: false });
				return `Deleted folder ${shown}.`;
			}
			checkCancellation(token);
			await fsp.rm(file, { force: false });
			return `Deleted ${shown}.`;
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

	return [readFile, viewImage, listDir, fileSearch, grepSearch, createFile, replaceString, multiReplaceString, deleteFile, getErrors];
}
