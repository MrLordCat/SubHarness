import { randomBytes } from "node:crypto";
import * as vscode from "vscode";

/** Connects a webview to the chat controller; the disposable detaches it. */
export interface ChatWebviewBridge {
	attach(webview: vscode.Webview): vscode.Disposable;
}

function webviewAsset(webview: vscode.Webview, extensionUri: vscode.Uri, fileName: string): vscode.Uri {
	return webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, "out", "webview", fileName));
}

export function renderChatHtml(webview: vscode.Webview, extensionUri: vscode.Uri, nonce: string): string {
	const script = webviewAsset(webview, extensionUri, "chat.js");
	const style = webviewAsset(webview, extensionUri, "chat.css");
	return `<!DOCTYPE html>
<html lang="en">
<head>
	<meta charset="UTF-8">
	<meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'nonce-${nonce}'; style-src ${webview.cspSource}; img-src ${webview.cspSource} data:; font-src ${webview.cspSource};">
	<meta name="viewport" content="width=device-width, initial-scale=1.0">
	<link rel="stylesheet" href="${style}">
	<title>SubHarness Chat</title>
</head>
<body>
	<div id="root"></div>
	<script nonce="${nonce}" src="${script}"></script>
</body>
</html>`;
}

export class ChatViewHost implements vscode.WebviewViewProvider, vscode.Disposable {
	static readonly viewId = "llamacpp.chat";
	static readonly panelViewType = "llamacpp.chatPanel";
	static readonly panelTitle = "SubHarness Chat";

	private readonly _extensionUri: vscode.Uri;
	private readonly _bridge: ChatWebviewBridge;
	private readonly _attachments = new Map<vscode.Webview, vscode.Disposable>();
	private _panel: vscode.WebviewPanel | undefined;
	private _disposed = false;

	constructor(extensionUri: vscode.Uri, bridge: ChatWebviewBridge) {
		this._extensionUri = extensionUri;
		this._bridge = bridge;
	}

	resolveWebviewView(view: vscode.WebviewView): void {
		const webview = view.webview;
		this._attach(webview);
		view.onDidDispose(() => this._detach(webview));
	}

	openInEditor(): void {
		if (this._disposed) {
			return;
		}
		if (this._panel) {
			this._panel.reveal(vscode.ViewColumn.Beside);
			return;
		}
		const panel = vscode.window.createWebviewPanel(
			ChatViewHost.panelViewType,
			ChatViewHost.panelTitle,
			vscode.ViewColumn.Beside,
			{ retainContextWhenHidden: true },
		);
		this._panel = panel;
		this._attach(panel.webview);
		panel.onDidDispose(() => {
			this._detach(panel.webview);
			if (this._panel === panel) {
				this._panel = undefined;
			}
		});
	}

	dispose(): void {
		if (this._disposed) {
			return;
		}
		this._disposed = true;
		for (const attachment of this._attachments.values()) {
			attachment.dispose();
		}
		this._attachments.clear();
		const panel = this._panel;
		this._panel = undefined;
		panel?.dispose();
	}

	private _attach(webview: vscode.Webview): void {
		if (this._disposed) {
			return;
		}
		this._detach(webview);
		webview.options = {
			enableScripts: true,
			localResourceRoots: [vscode.Uri.joinPath(this._extensionUri, "out", "webview")],
		};
		webview.html = renderChatHtml(webview, this._extensionUri, randomBytes(16).toString("hex"));
		this._attachments.set(webview, this._bridge.attach(webview));
	}

	private _detach(webview: vscode.Webview): void {
		const attachment = this._attachments.get(webview);
		if (!attachment) {
			return;
		}
		this._attachments.delete(webview);
		attachment.dispose();
	}
}

export function registerChatView(context: vscode.ExtensionContext, bridge: ChatWebviewBridge): ChatViewHost {
	const host = new ChatViewHost(context.extensionUri, bridge);
	context.subscriptions.push(
		host,
		vscode.window.registerWebviewViewProvider(ChatViewHost.viewId, host, {
			webviewOptions: { retainContextWhenHidden: true },
		}),
	);
	return host;
}
