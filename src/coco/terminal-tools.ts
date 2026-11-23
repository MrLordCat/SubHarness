import type * as vscode from "vscode";

const HEADLESS_SHELL_TOOLS = new Set([
	"powershell", "bash", "read_powershell", "write_powershell", "stop_powershell", "list_powershell", "powershell_shutdown",
	"read_bash", "write_bash", "stop_bash", "list_bash", "bash_shutdown",
]);

/** Drops agent-host shell tools that run headless; the chat's own terminal tools stay, under their caller names. */
export function selectCocoChatTools(tools: readonly vscode.LanguageModelChatTool[]): vscode.LanguageModelChatTool[] {
	return tools.filter(tool => !HEADLESS_SHELL_TOOLS.has(tool.name));
}
