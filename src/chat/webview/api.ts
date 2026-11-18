import type { WebviewMessage } from "../shared/protocol";

interface VsCodeApi {
	postMessage(message: WebviewMessage): void;
	getState(): unknown;
	setState(state: unknown): void;
}

declare function acquireVsCodeApi(): VsCodeApi;

/** The VS Code API object is claimed once per webview; importing this module claims it. */
export const vscode = acquireVsCodeApi();

export function postMessage(message: WebviewMessage): void {
	vscode.postMessage(message);
}
