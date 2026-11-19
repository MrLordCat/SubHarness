import * as path from "node:path";
import * as vscode from "vscode";
import { checkCancellation, inputRecord, integerField, optionalStringField, stringField } from "./core-tools";
import { CHAT_TOOL_GROUPS, type ChatTool, type ChatToolConfirmation } from "./types";
import {
	displayPath,
	isInsideWorkspace,
	resolveToolPath,
	vscodeWorkspaceRoots,
	type WorkspaceRoots,
} from "./workspace-paths";

const MAX_USAGE_LINES = 200;
const DEFAULT_SYMBOL_RESULTS = 50;
const MAX_SYMBOL_RESULTS = 200;
const WORD_CHARACTER = /[A-Za-z0-9_$]/;
const WORD_SYMBOL = /^[A-Za-z0-9_$]+$/;

type ProviderLocation = vscode.Location | vscode.LocationLink;

interface LocatedSymbol {
	symbol: string;
	uri: vscode.Uri;
	document: vscode.TextDocument;
	position: vscode.Position;
}

function occurrenceIn(line: string, symbol: string): number {
	if (!WORD_SYMBOL.test(symbol)) {
		return line.indexOf(symbol);
	}
	let index = line.indexOf(symbol);
	while (index !== -1) {
		const before = index === 0 ? "" : line.charAt(index - 1);
		const after = line.charAt(index + symbol.length);
		if (!WORD_CHARACTER.test(before) && !WORD_CHARACTER.test(after)) {
			return index;
		}
		index = line.indexOf(symbol, index + 1);
	}
	return -1;
}

function normalizeLocation(value: ProviderLocation): { uri: vscode.Uri; range: vscode.Range } {
	const link = value as vscode.LocationLink;
	if (link.targetUri !== undefined) {
		return { uri: link.targetUri, range: link.targetSelectionRange ?? link.targetRange };
	}
	const plain = value as vscode.Location;
	return { uri: plain.uri, range: plain.range };
}

function locationKey(value: ProviderLocation): string {
	const { uri, range } = normalizeLocation(value);
	return `${uri.toString()}:${range.start.line}:${range.start.character}`;
}

function uniqueLocations(values: readonly ProviderLocation[]): ProviderLocation[] {
	const seen = new Set<string>();
	const result: ProviderLocation[] = [];
	for (const value of values) {
		const key = locationKey(value);
		if (!seen.has(key)) {
			seen.add(key);
			result.push(value);
		}
	}
	return result;
}

async function executeLocationCommand(
	command: string,
	uri: vscode.Uri,
	position: vscode.Position
): Promise<ProviderLocation[]> {
	try {
		const result = await vscode.commands.executeCommand<ProviderLocation | ProviderLocation[] | undefined>(
			command,
			uri,
			position
		);
		if (result === undefined) {
			return [];
		}
		return Array.isArray(result) ? result : [result];
	} catch {
		return [];
	}
}

async function locateSymbol(
	input: unknown,
	roots: readonly string[],
	token: vscode.CancellationToken
): Promise<LocatedSymbol> {
	const record = inputRecord(input);
	const symbol = stringField(record, "symbol");
	const lineContent = optionalStringField(record, "lineContent");
	const file = resolveToolPath(record.filePath, roots);
	const shown = displayPath(file, roots);
	const uri = vscode.Uri.file(file);
	let document: vscode.TextDocument;
	try {
		document = await vscode.workspace.openTextDocument(uri);
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		throw new Error(`Could not open ${shown}: ${message}`, { cause: error });
	}
	checkCancellation(token);
	if (lineContent !== undefined) {
		const needles = [lineContent];
		const trimmed = lineContent.trim();
		if (trimmed.length > 0 && trimmed !== lineContent) {
			needles.push(trimmed);
		}
		for (let line = 0; line < document.lineCount; line++) {
			const text = document.lineAt(line).text;
			if (!needles.some(needle => text.includes(needle))) {
				continue;
			}
			const character = occurrenceIn(text, symbol);
			if (character !== -1) {
				return { symbol, uri, document, position: new vscode.Position(line, character) };
			}
		}
	}
	for (let line = 0; line < document.lineCount; line++) {
		const character = occurrenceIn(document.lineAt(line).text, symbol);
		if (character !== -1) {
			return { symbol, uri, document, position: new vscode.Position(line, character) };
		}
	}
	const context = lineContent === undefined ? "" : ` on a line containing "${lineContent}"`;
	throw new Error(`Could not find "${symbol}" in ${shown}${context}.`);
}

function usagePath(uri: vscode.Uri, roots: readonly string[]): string {
	return uri.scheme === "file" ? displayPath(uri.fsPath, roots) : uri.toString();
}

export function createSymbolTools(options: { roots?: WorkspaceRoots } = {}): ChatTool[] {
	const rootProvider = options.roots ?? vscodeWorkspaceRoots;
	const roots = (): readonly string[] => rootProvider.roots().filter(root => root.length > 0);

	const listCodeUsages: ChatTool = {
		name: "list_code_usages",
		group: CHAT_TOOL_GROUPS.search,
		readOnly: true,
		description: "Finds where a symbol is defined, implemented and used, through the language servers of the open workspace. Give the file and, to pick the right occurrence, a piece of the line where the symbol appears.",
		inputSchema: {
			type: "object",
			properties: {
				symbol: { type: "string", description: "The symbol name, for example a function, class or variable." },
				filePath: { type: "string", description: "Absolute path or a path relative to the workspace folder." },
				lineContent: { type: "string", description: "Part of the line where the symbol appears, which picks the occurrence." },
			},
			required: ["symbol", "filePath"],
		},
		async invoke(input: unknown, token: vscode.CancellationToken): Promise<string> {
			checkCancellation(token);
			const currentRoots = roots();
			const located = await locateSymbol(input, currentRoots, token);
			const definitions = uniqueLocations(await executeLocationCommand("vscode.executeDefinitionProvider", located.uri, located.position));
			checkCancellation(token);
			const implementations = uniqueLocations(await executeLocationCommand("vscode.executeImplementationProvider", located.uri, located.position));
			checkCancellation(token);
			const references = uniqueLocations(await executeLocationCommand("vscode.executeReferenceProvider", located.uri, located.position));
			checkCancellation(token);
			const definitionKeys = new Set(definitions.map(locationKey));
			const usages = references.filter(value => !definitionKeys.has(locationKey(value)));
			const sections = [
				{ label: "Definitions", values: definitions },
				{ label: "Implementations", values: implementations },
				{ label: "References", values: usages },
			];
			const total = sections.reduce((sum, section) => sum + section.values.length, 0);
			if (total === 0) {
				return `No definitions or references found for "${located.symbol}". The language server for this file type may not be running or may not index it.`;
			}
			const documents = new Map<string, vscode.TextDocument | undefined>([[located.uri.toString(), located.document]]);
			const render = async (value: ProviderLocation): Promise<string> => {
				const { uri, range } = normalizeLocation(value);
				const prefix = `${usagePath(uri, currentRoots)}:${range.start.line + 1}:${range.start.character + 1}`;
				let document: vscode.TextDocument | undefined;
				if (documents.has(uri.toString())) {
					document = documents.get(uri.toString());
				} else {
					try {
						document = await vscode.workspace.openTextDocument(uri);
					} catch {
						document = undefined;
					}
					documents.set(uri.toString(), document);
				}
				if (document === undefined || range.start.line >= document.lineCount) {
					return prefix;
				}
				return `${prefix}: ${document.lineAt(range.start.line).text.trim()}`;
			};
			const output: string[] = [];
			let rendered = 0;
			for (const section of sections) {
				if (section.values.length === 0) {
					continue;
				}
				const lines: string[] = [];
				for (const value of section.values) {
					if (rendered >= MAX_USAGE_LINES) {
						break;
					}
					lines.push(await render(value));
					rendered += 1;
				}
				if (lines.length > 0) {
					output.push(`${section.label} (${section.values.length}):`, ...lines);
				}
			}
			if (rendered < total) {
				output.push(`(${total - rendered} more not shown)`);
			}
			return output.join("\n");
		},
	};

	const renameSymbol: ChatTool = {
		name: "rename_symbol",
		group: CHAT_TOOL_GROUPS.files,
		description: "Renames a symbol across the workspace through the language server's rename, then saves the changed files. Give the file and a piece of the line where the symbol appears.",
		inputSchema: {
			type: "object",
			properties: {
				symbol: { type: "string", description: "The current symbol name." },
				filePath: { type: "string", description: "Absolute path or a path relative to the workspace folder." },
				lineContent: { type: "string", description: "Part of the line where the symbol appears, which picks the occurrence." },
				newName: { type: "string", description: "The new symbol name." },
			},
			required: ["symbol", "filePath", "newName"],
		},
		needsConfirmation(input: unknown): ChatToolConfirmation | undefined {
			try {
				const record = inputRecord(input);
				const currentRoots = roots();
				if (currentRoots.length === 0) {
					const value = record.filePath;
					if (typeof value !== "string" || value.trim() === "") {
						return undefined;
					}
					return {
						title: "Rename a symbol outside the workspace",
						detail: path.resolve(value),
						reason: "The path is outside the open workspace folders.",
					};
				}
				const file = resolveToolPath(record.filePath, currentRoots);
				if (isInsideWorkspace(file, currentRoots)) {
					return undefined;
				}
				return {
					title: "Rename a symbol outside the workspace",
					detail: file,
					reason: "The path is outside the open workspace folders.",
				};
			} catch {
				return undefined;
			}
		},
		writes(input: unknown): string[] {
			try {
				return [resolveToolPath(inputRecord(input).filePath, roots())];
			} catch {
				return [];
			}
		},
		async invoke(input: unknown, token: vscode.CancellationToken): Promise<string> {
			checkCancellation(token);
			const record = inputRecord(input);
			const symbol = stringField(record, "symbol");
			const targetName = stringField(record, "newName").trim();
			if (targetName.length === 0) {
				throw new Error('"newName" must not be empty.');
			}
			if (targetName === symbol) {
				throw new Error(`"newName" must be different from "${symbol}".`);
			}
			const currentRoots = roots();
			const located = await locateSymbol(input, currentRoots, token);
			let edit: vscode.WorkspaceEdit | undefined;
			try {
				edit = await vscode.commands.executeCommand<vscode.WorkspaceEdit | undefined>(
					"vscode.executeDocumentRenameProvider",
					located.uri,
					located.position,
					targetName
				);
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				throw new Error(`Rename failed: ${message}`, { cause: error });
			}
			const entries = edit?.entries() ?? [];
			if (!edit || entries.length === 0) {
				throw new Error("The language server offers no rename for this symbol here.");
			}
			checkCancellation(token);
			// The named file itself was approved through needsConfirmation when it lies outside.
			const outside = entries
				.filter(([uri]) => uri.scheme !== "file" || (currentRoots.length > 0
					&& uri.toString() !== located.uri.toString()
					&& !isInsideWorkspace(uri.fsPath, currentRoots)))
				.map(([uri]) => (uri.scheme === "file" ? uri.fsPath : uri.toString()));
			if (outside.length > 0) {
				throw new Error(`The rename would change files outside the workspace: ${outside.join(", ")}.`);
			}
			if (!(await vscode.workspace.applyEdit(edit))) {
				throw new Error("VS Code could not apply the rename.");
			}
			let editCount = 0;
			const lines: string[] = [];
			for (const [uri, edits] of entries) {
				editCount += edits.length;
				const document = await vscode.workspace.openTextDocument(uri);
				await document.save();
				lines.push(`- ${displayPath(uri.fsPath, currentRoots)} (${edits.length} edits)`);
			}
			return `Renamed "${located.symbol}" to "${targetName}": ${editCount} edits in ${entries.length} files:\n${lines.join("\n")}`;
		},
	};

	const workspaceSymbols: ChatTool = {
		name: "workspace_symbols",
		group: CHAT_TOOL_GROUPS.search,
		readOnly: true,
		description: "Searches symbol names (classes, functions, variables…) across the workspace through the language servers. Returns kind, name, container and location.",
		inputSchema: {
			type: "object",
			properties: {
				query: { type: "string", description: "Part of a symbol name; most servers match fuzzily." },
				maxResults: { type: "integer", minimum: 1, maximum: 200, description: "Maximum number of symbols to return (default 50)." },
			},
			required: ["query"],
		},
		async invoke(input: unknown, token: vscode.CancellationToken): Promise<string> {
			checkCancellation(token);
			const record = inputRecord(input);
			const query = stringField(record, "query");
			const maxResults = integerField(record, "maxResults", DEFAULT_SYMBOL_RESULTS, 1, MAX_SYMBOL_RESULTS);
			let found: vscode.SymbolInformation[];
			try {
				found = await vscode.commands.executeCommand<vscode.SymbolInformation[]>(
					"vscode.executeWorkspaceSymbolProvider",
					query
				) ?? [];
			} catch {
				found = [];
			}
			checkCancellation(token);
			const currentRoots = roots();
			const kept = found.filter(symbol => symbol.location.uri.scheme === "file"
				&& (currentRoots.length === 0 || isInsideWorkspace(symbol.location.uri.fsPath, currentRoots)));
			if (kept.length === 0) {
				return `No symbols match "${query}". Language servers index only files of languages they have loaded; open a file of that language first or use grep_search.`;
			}
			const lines = kept.slice(0, maxResults).map(symbol => {
				const container = symbol.containerName ? ` (in ${symbol.containerName})` : "";
				return `${vscode.SymbolKind[symbol.kind]} ${symbol.name}${container} — ${displayPath(symbol.location.uri.fsPath, currentRoots)}:${symbol.location.range.start.line + 1}`;
			});
			if (kept.length > maxResults) {
				lines.push(`(${kept.length - maxResults} more not shown)`);
			}
			return lines.join("\n");
		},
	};

	return [listCodeUsages, renameSymbol, workspaceSymbols];
}
