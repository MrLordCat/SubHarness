import * as path from "node:path";
import * as vscode from "vscode";
import { parseFileReference, type FileReference } from "./shared/file-reference";

/** What opening a file reference from a chat message needs from VS Code. */
export interface FileReferenceOpener {
	/** Workspace folder paths; relative references are tried against each. */
	folders(): readonly string[];
	stat(fsPath: string): Promise<"file" | "directory" | undefined>;
	/** Workspace files whose path ends with the relative path, at most limit. */
	find(relative: string, limit: number): Promise<string[]>;
	openFile(fsPath: string, reference: FileReference): Promise<void>;
	reveal(fsPath: string): Promise<void>;
	/** Lets the user choose among several matches; undefined when cancelled. */
	pick(candidates: readonly string[]): Promise<string | undefined>;
	notFound(reference: FileReference): Promise<void>;
}

export type FileReferenceOutcome = "opened" | "revealed" | "picked" | "cancelled" | "notFound" | "invalid";

const SEARCH_LIMIT = 20;
const WINDOWS_ABSOLUTE = /^[A-Za-z]:[\\/]/;
const GLOB_CHARACTERS = /[*?[\]{}!]/;

function isAbsolutePath(value: string): boolean {
	return WINDOWS_ABSOLUTE.test(value) || path.isAbsolute(value);
}

/** The relative path as a search suffix; undefined when it cannot be searched safely. */
function searchSuffix(relative: string): string | undefined {
	const segments = relative.replace(/\\/g, "/").split("/").filter(segment => segment.length > 0 && segment !== ".");
	if (segments.length === 0 || segments.includes("..") || segments.some(segment => GLOB_CHARACTERS.test(segment))) {
		return undefined;
	}
	return segments.join("/");
}

/**
 * Opens what a message names: an existing file (at its line), a folder in the Explorer,
 * or the only workspace file whose path ends with the reference. Several matches ask the user.
 */
export async function openFileReference(target: string, opener: FileReferenceOpener): Promise<FileReferenceOutcome> {
	const reference = parseFileReference(target);
	if (!reference) {
		return "invalid";
	}
	const absolute = isAbsolutePath(reference.path);
	const candidates = absolute
		? [path.resolve(reference.path)]
		: opener.folders().map(folder => path.resolve(folder, reference.path));
	for (const candidate of candidates) {
		const kind = await opener.stat(candidate);
		if (kind === "file") {
			await opener.openFile(candidate, reference);
			return "opened";
		}
		if (kind === "directory") {
			await opener.reveal(candidate);
			return "revealed";
		}
	}
	const suffix = absolute ? undefined : searchSuffix(reference.path);
	const found = suffix ? [...new Set(await opener.find(suffix, SEARCH_LIMIT))] : [];
	if (found.length === 1) {
		await opener.openFile(found[0], reference);
		return "opened";
	}
	if (found.length > 1) {
		const chosen = await opener.pick(found);
		if (!chosen) {
			return "cancelled";
		}
		await opener.openFile(chosen, reference);
		return "picked";
	}
	await opener.notFound(reference);
	return "notFound";
}

/** The selection for a reference: the cursor at its line and column, or whole lines for a range. */
export function referenceSelection(reference: FileReference): vscode.Range | undefined {
	if (reference.line === undefined) {
		return undefined;
	}
	const line = reference.line - 1;
	if (reference.endLine !== undefined) {
		return new vscode.Range(line, 0, reference.endLine, 0);
	}
	const start = new vscode.Position(line, Math.max(0, (reference.column ?? 1) - 1));
	return new vscode.Range(start, start);
}

/** Opens files beside the chat when the chat itself is an editor tab, so the chat stays visible. */
function targetColumn(chatPanelViewType: string): vscode.ViewColumn {
	const isChat = (tab: vscode.Tab | undefined): boolean =>
		tab?.input instanceof vscode.TabInputWebview && tab.input.viewType.endsWith(chatPanelViewType);
	const active = vscode.window.tabGroups.activeTabGroup;
	if (!isChat(active.activeTab)) {
		return vscode.ViewColumn.Active;
	}
	return vscode.window.tabGroups.all.find(group => group !== active)?.viewColumn ?? vscode.ViewColumn.Beside;
}

export function createVscodeFileReferenceOpener(folders: () => readonly string[], chatPanelViewType: string): FileReferenceOpener {
	return {
		folders,
		async stat(fsPath) {
			try {
				const stat = await vscode.workspace.fs.stat(vscode.Uri.file(fsPath));
				return (stat.type & vscode.FileType.Directory) !== 0 ? "directory" : "file";
			} catch {
				return undefined;
			}
		},
		async find(relative, limit) {
			const uris = await vscode.workspace.findFiles(`**/${relative}`, "**/{node_modules,.git}/**", limit);
			return uris.filter(uri => uri.scheme === "file").map(uri => uri.fsPath);
		},
		async openFile(fsPath, reference) {
			const selection = referenceSelection(reference);
			await vscode.commands.executeCommand("vscode.open", vscode.Uri.file(fsPath), {
				viewColumn: targetColumn(chatPanelViewType),
				...(selection ? { selection } : {}),
			} satisfies vscode.TextDocumentShowOptions);
		},
		async reveal(fsPath) {
			await vscode.commands.executeCommand("revealInExplorer", vscode.Uri.file(fsPath));
		},
		async pick(candidates) {
			const items = candidates.map(fsPath => ({ label: path.basename(fsPath), description: vscode.workspace.asRelativePath(fsPath), fsPath }));
			return (await vscode.window.showQuickPick(items, { title: "Open File", placeHolder: "Several files match this reference" }))?.fsPath;
		},
		async notFound(reference) {
			const search = "Search Files";
			const choice = await vscode.window.showWarningMessage(`File not found: ${reference.path}`, search);
			if (choice === search) {
				await vscode.commands.executeCommand("workbench.action.quickOpen", path.basename(reference.path.replace(/\\/g, "/")));
			}
		},
	};
}
