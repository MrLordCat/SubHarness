import * as vscode from "vscode";

const localTools = new Map<string, vscode.LanguageModelTool<object>>();

/**
 * Registers a tool with VS Code and keeps its implementation so the bridge's own chat
 * can call it directly: vscode.lm.invokeTool without a Copilot session shows a modal
 * confirmation for every tool that prepares one.
 */
export function registerLocalTool<T extends object>(name: string, tool: vscode.LanguageModelTool<T>): vscode.Disposable {
	const implementation = tool as vscode.LanguageModelTool<object>;
	localTools.set(name, implementation);
	const registration = vscode.lm.registerTool(name, tool);
	return new vscode.Disposable(() => {
		if (localTools.get(name) === implementation) {
			localTools.delete(name);
		}
		registration.dispose();
	});
}

export function getLocalTool(name: string): vscode.LanguageModelTool<object> | undefined {
	return localTools.get(name);
}

export function localToolNames(): string[] {
	return [...localTools.keys()];
}
