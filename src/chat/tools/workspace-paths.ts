import * as path from "node:path";
import * as vscode from "vscode";

export interface WorkspaceRoots {
	roots(): readonly string[];
}

export const vscodeWorkspaceRoots: WorkspaceRoots = {
	roots: () => vscode.workspace.workspaceFolders?.map(folder => folder.uri.fsPath) ?? [],
};

const caseInsensitive = process.platform === "win32";

function comparable(value: string): string {
	return caseInsensitive ? value.toLowerCase() : value;
}

function relativeInside(file: string, root: string): string | undefined {
	const relative = path.relative(comparable(path.resolve(root)), comparable(path.resolve(file)));
	if (relative === "") {
		return "";
	}
	if (path.isAbsolute(relative) || relative === ".." || relative.startsWith(`..${path.sep}`)) {
		return undefined;
	}
	return relative;
}

export function resolveToolPath(value: unknown, roots: readonly string[]): string {
	if (typeof value !== "string") {
		throw new Error("A file path must be a string.");
	}
	if (value.trim() === "") {
		throw new Error("A file path must not be empty.");
	}
	if (path.isAbsolute(value)) {
		return path.resolve(value);
	}
	const root = roots[0];
	if (root === undefined) {
		throw new Error("A workspace folder is required for relative paths.");
	}
	return path.resolve(root, value);
}

export function isInsideWorkspace(file: string, roots: readonly string[]): boolean {
	return roots.some(root => relativeInside(file, root) !== undefined);
}

export function displayPath(file: string, roots: readonly string[]): string {
	const absolute = path.resolve(file);
	for (const root of roots) {
		if (relativeInside(absolute, root) === undefined) {
			continue;
		}
		const relative = path.relative(path.resolve(root), absolute);
		return relative === "" ? "." : relative.split(path.sep).join("/");
	}
	return absolute;
}
