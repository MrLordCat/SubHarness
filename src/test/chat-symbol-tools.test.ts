import * as assert from "node:assert";
import * as fsp from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import * as vscode from "vscode";
import { createSymbolTools } from "../chat/tools/symbol-tools";
import type { ChatTool } from "../chat/tools/types";

const SELECTOR: vscode.DocumentSelector = { scheme: "file", pattern: "**/*.aabsym" };
const WORD = /[A-Za-z0-9_$]/;

const ALPHA = [
	"def aabsymFoo(value):",
	"    return aabsymFoo",
	"def aabsymFoobar():",
	"    return aabsymFoobar",
	"",
].join("\n");
const BETA = ["impl aabsymFoo", "beta uses aabsymFoo", ""].join("\n");
const DELTA = ["def aabsymFoo():", "    return aabsymFoo", ""].join("\n");
const GAMMA = ["lonelyAabsymSymbol", ""].join("\n");

interface Occurrence {
	file: string;
	line: number;
	character: number;
	text: string;
}

suite("Chat symbol tools", () => {
	let base = "";
	let root = "";
	let currentRoot = "";
	let outsideDir = "";
	let tools: ChatTool[] = [];
	const disposables: vscode.Disposable[] = [];
	const tokens: vscode.CancellationTokenSource[] = [];

	function samePath(left: string, right: string): boolean {
		const first = path.resolve(left);
		const second = path.resolve(right);
		return process.platform === "win32"
			? first.toLowerCase() === second.toLowerCase()
			: first === second;
	}

	function wordMatches(line: string, symbol: string): number[] {
		const result: number[] = [];
		let index = line.indexOf(symbol);
		while (index !== -1) {
			const before = index === 0 ? "" : line.charAt(index - 1);
			const after = line.charAt(index + symbol.length);
			if (!WORD.test(before) && !WORD.test(after)) {
				result.push(index);
			}
			index = line.indexOf(symbol, index + 1);
		}
		return result;
	}

	function wordAt(document: vscode.TextDocument, position: vscode.Position): string | undefined {
		const line = document.lineAt(position.line).text;
		let start = position.character;
		let end = position.character;
		while (start > 0 && WORD.test(line.charAt(start - 1))) {
			start -= 1;
		}
		while (end < line.length && WORD.test(line.charAt(end))) {
			end += 1;
		}
		return end > start ? line.slice(start, end) : undefined;
	}

	async function collectFiles(directory: string): Promise<string[]> {
		const entries = await fsp.readdir(directory, { withFileTypes: true });
		const files: string[] = [];
		for (const entry of entries) {
			const full = path.join(directory, entry.name);
			if (entry.isDirectory()) {
				files.push(...await collectFiles(full));
			} else if (entry.name.endsWith(".aabsym")) {
				files.push(full);
			}
		}
		return files.sort();
	}

	async function scan(symbol: string): Promise<Occurrence[]> {
		const found: Occurrence[] = [];
		for (const file of await collectFiles(currentRoot)) {
			const lines = (await fsp.readFile(file, "utf8")).split(/\r?\n/);
			for (let line = 0; line < lines.length; line++) {
				for (const character of wordMatches(lines[line], symbol)) {
					found.push({ file, line, character, text: lines[line] });
				}
			}
		}
		return found;
	}

	function locationOf(item: Occurrence, symbol: string): vscode.Location {
		const range = new vscode.Range(item.line, item.character, item.line, item.character + symbol.length);
		return new vscode.Location(vscode.Uri.file(item.file), range);
	}

	suiteSetup(async () => {
		base = await fsp.mkdtemp(path.join(os.tmpdir(), "chat-symbol-tools-"));
		outsideDir = await fsp.mkdtemp(path.join(os.tmpdir(), "chat-symbol-tools-outside-"));
		disposables.push(
			vscode.languages.registerDefinitionProvider(SELECTOR, {
				provideDefinition: async (document, position) => {
					const symbol = wordAt(document, position);
					if (symbol === undefined) {
						return [];
					}
					return (await scan(symbol))
						.filter(item => item.text.startsWith("def "))
						.map(item => locationOf(item, symbol));
				},
			}),
			vscode.languages.registerImplementationProvider(SELECTOR, {
				provideImplementation: async (document, position) => {
					const symbol = wordAt(document, position);
					if (symbol === undefined) {
						return [];
					}
					return (await scan(symbol))
						.filter(item => item.text.startsWith("impl "))
						.map(item => locationOf(item, symbol));
				},
			}),
			vscode.languages.registerReferenceProvider(SELECTOR, {
				provideReferences: async (document, position) => {
					const symbol = wordAt(document, position);
					if (symbol === undefined) {
						return [];
					}
					return (await scan(symbol))
						.filter(item => !(samePath(item.file, document.uri.fsPath)
							&& item.line === position.line
							&& item.character === position.character))
						.map(item => locationOf(item, symbol));
				},
			}),
			vscode.languages.registerRenameProvider(SELECTOR, {
				provideRenameEdits: async (document, position, newName) => {
					const symbol = wordAt(document, position);
					if (symbol === undefined) {
						return undefined;
					}
					const edit = new vscode.WorkspaceEdit();
					for (const item of await scan(symbol)) {
						const range = new vscode.Range(item.line, item.character, item.line, item.character + symbol.length);
						edit.replace(vscode.Uri.file(item.file), range, newName);
					}
					if (document.getText().includes("rename-outside")) {
						edit.replace(vscode.Uri.file(path.join(outsideDir, "outside.aabsym")), new vscode.Range(0, 0, 0, 1), newName);
					}
					return edit;
				},
			}),
			vscode.languages.registerWorkspaceSymbolProvider({
				provideWorkspaceSymbols: async (query: string) => {
					const needle = query.trim().toLowerCase();
					if (needle.length === 0 || currentRoot === "") {
						return [];
					}
					const symbols: vscode.SymbolInformation[] = [];
					for (const file of await collectFiles(currentRoot)) {
						const lines = (await fsp.readFile(file, "utf8")).split(/\r?\n/);
						for (let line = 0; line < lines.length; line++) {
							const match = /^(?:def|impl) ([A-Za-z0-9_$]+)/.exec(lines[line]);
							if (match === null || !match[1].toLowerCase().includes(needle)) {
								continue;
							}
							const location = new vscode.Location(
								vscode.Uri.file(file),
								new vscode.Position(line, lines[line].indexOf(match[1]))
							);
							symbols.push(new vscode.SymbolInformation(
								match[1],
								vscode.SymbolKind.Function,
								path.basename(file, ".aabsym"),
								location
							));
						}
					}
					return symbols;
				},
			})
		);
	});

	setup(async () => {
		root = await fsp.mkdtemp(path.join(base, "root-"));
		currentRoot = root;
		tools = createSymbolTools({ roots: { roots: () => [root] } });
		await fsp.writeFile(path.join(root, "alpha.aabsym"), ALPHA, "utf8");
		await fsp.writeFile(path.join(root, "beta.aabsym"), BETA, "utf8");
		await fsp.writeFile(path.join(root, "delta.aabsym"), DELTA, "utf8");
		await fsp.writeFile(path.join(root, "gamma.aabsym"), GAMMA, "utf8");
	});

	teardown(async () => {
		for (const token of tokens.splice(0)) {
			token.dispose();
		}
		await fsp.rm(root, { recursive: true, force: true });
	});

	suiteTeardown(async () => {
		for (const disposable of disposables.splice(0)) {
			disposable.dispose();
		}
		await fsp.rm(base, { recursive: true, force: true });
		await fsp.rm(outsideDir, { recursive: true, force: true });
	});

	function tool(name: string): ChatTool {
		const found = tools.find(candidate => candidate.name === name);
		assert.ok(found, `tool ${name} must exist`);
		return found;
	}

	async function invoke(name: string, input: unknown): Promise<string> {
		const source = new vscode.CancellationTokenSource();
		tokens.push(source);
		const result = await tool(name).invoke(input, source.token);
		return typeof result === "string" ? result : result.text;
	}

	test("list_code_usages uses the line content to pick the occurrence", async () => {
		const result = await invoke("list_code_usages", {
			symbol: "aabsymFoo",
			filePath: path.join(root, "alpha.aabsym"),
			lineContent: "return aabsymFoo",
		});
		assert.strictEqual(result, [
			"Definitions (2):",
			"alpha.aabsym:1:5: def aabsymFoo(value):",
			"delta.aabsym:1:5: def aabsymFoo():",
			"Implementations (1):",
			"beta.aabsym:1:6: impl aabsymFoo",
			"References (3):",
			"beta.aabsym:1:6: impl aabsymFoo",
			"beta.aabsym:2:11: beta uses aabsymFoo",
			"delta.aabsym:2:12: return aabsymFoo",
		].join("\n"));
	});

	test("list_code_usages locates the first whole word without line content", async () => {
		const result = await invoke("list_code_usages", {
			symbol: "aabsymFoo",
			filePath: path.join(root, "alpha.aabsym"),
		});
		assert.strictEqual(result, [
			"Definitions (2):",
			"alpha.aabsym:1:5: def aabsymFoo(value):",
			"delta.aabsym:1:5: def aabsymFoo():",
			"Implementations (1):",
			"beta.aabsym:1:6: impl aabsymFoo",
			"References (4):",
			"alpha.aabsym:2:12: return aabsymFoo",
			"beta.aabsym:1:6: impl aabsymFoo",
			"beta.aabsym:2:11: beta uses aabsymFoo",
			"delta.aabsym:2:12: return aabsymFoo",
		].join("\n"));
	});

	test("list_code_usages falls back when the line only holds a longer word", async () => {
		const result = await invoke("list_code_usages", {
			symbol: "aabsymFoo",
			filePath: path.join(root, "alpha.aabsym"),
			lineContent: "aabsymFoobar",
		});
		assert.match(result, /^Definitions \(2\):\nalpha\.aabsym:1:5:/);
		assert.match(result, /References \(4\):\nalpha\.aabsym:2:12:/);
	});

	test("locating reports a missing symbol with and without line content", async () => {
		const file = path.join(root, "gamma.aabsym");
		await assert.rejects(
			invoke("list_code_usages", { symbol: "aabsymFoo", filePath: file }),
			/Could not find "aabsymFoo" in gamma\.aabsym\./
		);
		await assert.rejects(
			invoke("list_code_usages", { symbol: "aabsymFoo", filePath: file, lineContent: "lonelyAabsymSymbol" }),
			/Could not find "aabsymFoo" in gamma\.aabsym on a line containing "lonelyAabsymSymbol"\./
		);
	});

	test("list_code_usages explains empty results", async () => {
		const result = await invoke("list_code_usages", {
			symbol: "lonelyAabsymSymbol",
			filePath: path.join(root, "gamma.aabsym"),
		});
		assert.strictEqual(
			result,
			'No definitions or references found for "lonelyAabsymSymbol". The language server for this file type may not be running or may not index it.'
		);
	});

	test("rename_symbol renames across files and saves them", async () => {
		const result = await invoke("rename_symbol", {
			symbol: "aabsymFoo",
			filePath: path.join(root, "alpha.aabsym"),
			lineContent: "def aabsymFoo",
			newName: "aabsymRenamed",
		});
		const lines = result.split("\n");
		assert.strictEqual(lines[0], 'Renamed "aabsymFoo" to "aabsymRenamed": 6 edits in 3 files:');
		assert.deepStrictEqual(lines.slice(1).sort(), [
			"- alpha.aabsym (2 edits)",
			"- beta.aabsym (2 edits)",
			"- delta.aabsym (2 edits)",
		]);
		const alpha = await fsp.readFile(path.join(root, "alpha.aabsym"), "utf8");
		const beta = await fsp.readFile(path.join(root, "beta.aabsym"), "utf8");
		assert.match(alpha, /def aabsymRenamed\(value\):/);
		assert.match(alpha, /^ {4}return aabsymRenamed$/m);
		assert.match(alpha, /def aabsymFoobar\(\):/);
		assert.match(beta, /^impl aabsymRenamed$/m);
	});

	test("rename_symbol rejects a new name that is empty or unchanged", async () => {
		const file = path.join(root, "alpha.aabsym");
		await assert.rejects(
			invoke("rename_symbol", { symbol: "aabsymFoo", filePath: file, newName: "aabsymFoo" }),
			/must be different/
		);
		await assert.rejects(
			invoke("rename_symbol", { symbol: "aabsymFoo", filePath: file, newName: " aabsymFoo " }),
			/must be different/
		);
		await assert.rejects(
			invoke("rename_symbol", { symbol: "aabsymFoo", filePath: file, newName: "   " }),
			/must not be empty/
		);
	});

	test("rename_symbol asks about paths outside the workspace and reports its write", () => {
		const rename = tool("rename_symbol");
		const outside = path.join(outsideDir, "outside.aabsym");
		assert.deepStrictEqual(rename.needsConfirmation?.({
			symbol: "aabsymFoo",
			filePath: outside,
			newName: "aabsymRenamed",
		}), {
			title: "Rename a symbol outside the workspace",
			detail: path.resolve(outside),
			reason: "The path is outside the open workspace folders.",
		});
		assert.strictEqual(rename.needsConfirmation?.({
			symbol: "aabsymFoo",
			filePath: path.join(root, "alpha.aabsym"),
			newName: "aabsymRenamed",
		}), undefined);
		assert.deepStrictEqual(rename.writes?.({ symbol: "aabsymFoo", filePath: "alpha.aabsym", newName: "aabsymRenamed" }), [
			path.resolve(root, "alpha.aabsym"),
		]);
	});

	test("rename_symbol refuses an edit outside the workspace and applies nothing", async () => {
		const epsilon = path.join(root, "epsilon.aabsym");
		const outside = path.join(outsideDir, "outside.aabsym");
		await fsp.writeFile(epsilon, ["def outsideAabsymSymbol():", "    rename-outside marker", ""].join("\n"), "utf8");
		await fsp.writeFile(outside, "outside\n", "utf8");
		await assert.rejects(invoke("rename_symbol", {
			symbol: "outsideAabsymSymbol",
			filePath: epsilon,
			lineContent: "def outsideAabsymSymbol",
			newName: "renamedOutsideAabsymSymbol",
		}), new RegExp(`outside the workspace.*${outside.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`, "i"));
		assert.match(await fsp.readFile(epsilon, "utf8"), /outsideAabsymSymbol/);
		assert.strictEqual(await fsp.readFile(outside, "utf8"), "outside\n");
	});

	test("workspace_symbols lists matching symbols with kind, container and location", async () => {
		const result = await invoke("workspace_symbols", { query: "aabsymfoo" });
		assert.deepStrictEqual(result.split("\n").sort(), [
			"Function aabsymFoo (in alpha) — alpha.aabsym:1",
			"Function aabsymFoobar (in alpha) — alpha.aabsym:3",
			"Function aabsymFoo (in beta) — beta.aabsym:1",
			"Function aabsymFoo (in delta) — delta.aabsym:1",
		].sort());
	});

	test("workspace_symbols cuts the list at maxResults", async () => {
		const result = await invoke("workspace_symbols", { query: "aabsymfoo", maxResults: 1 });
		const lines = result.split("\n");
		assert.strictEqual(lines.length, 2);
		assert.match(lines[0], /^Function aabsymFoo/);
		assert.strictEqual(lines[1], "(3 more not shown)");
	});

	test("workspace_symbols explains when nothing matches", async () => {
		const result = await invoke("workspace_symbols", { query: "aabsymNothing" });
		assert.strictEqual(
			result,
			'No symbols match "aabsymNothing". Language servers index only files of languages they have loaded; open a file of that language first or use grep_search.'
		);
	});
});
