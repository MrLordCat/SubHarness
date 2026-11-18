import * as path from "node:path";
import * as vscode from "vscode";
import { CocoTerminalManager } from "../coco/terminal-manager";
import { ChatChangeTracker } from "./changes/change-tracker";
import { findGitExecutable } from "./changes/shadow-git";
import { ChatController } from "./chat-controller";
import { registerChatView } from "./chat-view";
import { ChatSessionStore } from "./session-store";
import { createChatToolSource } from "./tool-executor";
import { ChatToolCatalog } from "./tools/catalog";
import { createCoreTools } from "./tools/core-tools";
import { configuredDangerousCommandRules } from "./tools/danger";
import { createChatTerminalTools } from "./tools/terminal-tools";

type CompositeChatProvider = Pick<vscode.LanguageModelChatProvider, "provideLanguageModelChatResponse" | "provideLanguageModelChatInformation"> & {
	onDidChangeLanguageModelChatInformation?: vscode.Event<void>;
};

export interface ChatWindowDeps {
	composite: CompositeChatProvider;
	log?: (event: string, data: Record<string, unknown>) => void;
}

const NEVER_FIRES: vscode.Event<void> = () => new vscode.Disposable(() => undefined);
const CHANGE_SCHEME = "aab-chat-change";

function changeUri(filePath: string, sessionId: string, id: string, empty = false): vscode.Uri {
	// VS Code caches virtual documents by URI; the timestamp keeps a reopened diff current.
	const query = new URLSearchParams({ session: sessionId, id, v: String(Date.now()), ...(empty ? { empty: "1" } : {}) });
	return vscode.Uri.from({ scheme: CHANGE_SCHEME, path: `/${filePath}`, query: query.toString() });
}

/** Left side of the diff: the file before the agent's pending change; an empty document for new or deleted sides. */
function registerChangeDiff(context: vscode.ExtensionContext, tracker: ChatChangeTracker): (sessionId: string, id: string) => Promise<void> {
	context.subscriptions.push(vscode.workspace.registerTextDocumentContentProvider(CHANGE_SCHEME, {
		provideTextDocumentContent: async uri => {
			const query = new URLSearchParams(uri.query);
			const sessionId = query.get("session");
			const id = query.get("id");
			if (query.get("empty") === "1" || !sessionId || !id) {
				return "";
			}
			return (await tracker.original(sessionId, id))?.before?.toString("utf8") ?? "";
		},
	}));
	return async (sessionId, id) => {
		const original = await tracker.original(sessionId, id);
		if (!original) {
			return;
		}
		const left = changeUri(original.path, sessionId, id, original.before === undefined);
		const right = original.exists
			? vscode.Uri.file(path.join(original.root, ...original.path.split("/")))
			: changeUri(original.path, sessionId, id, true);
		await vscode.commands.executeCommand("vscode.diff", left, right, `${path.posix.basename(original.path)} (agent changes)`);
	};
}

/** Wires the chat webview to a controller that runs agent turns through the composite provider. */
export function registerChatWindow(context: vscode.ExtensionContext, deps: ChatWindowDeps): void {
	const storage = context.storageUri?.fsPath ?? context.globalStorageUri.fsPath;
	const root = path.join(storage, "chat-sessions");
	const changes = new ChatChangeTracker({
		storageDir: path.join(storage, "chat-changes"),
		folders: () => (vscode.workspace.workspaceFolders ?? [])
			.filter(folder => folder.uri.scheme === "file")
			.map(folder => ({ name: folder.name, fsPath: folder.uri.fsPath })),
		findGit: findGitExecutable,
		log: deps.log,
	});
	const terminals = new CocoTerminalManager(vscode.window, undefined, deps.log, "Chat");
	const reportInvalidRule = (pattern: string, error: string) => deps.log?.("chat.dangerous_rule_invalid", { pattern, error });
	const catalog = new ChatToolCatalog({
		builtins: [
			...createCoreTools(),
			...createChatTerminalTools({ manager: terminals, rules: () => configuredDangerousCommandRules(reportInvalidRule) }),
		],
		state: context.globalState,
	});
	const controller = new ChatController({
		backend: deps.composite,
		onDidChangeModels: deps.composite.onDidChangeLanguageModelChatInformation ?? NEVER_FIRES,
		store: new ChatSessionStore(root),
		tools: createChatToolSource(catalog),
		state: context.workspaceState,
		log: deps.log,
		changes,
		openChange: registerChangeDiff(context, changes),
	});
	const host = registerChatView(context, controller);
	context.subscriptions.push(
		terminals,
		controller,
		vscode.commands.registerCommand("llamacpp.chat.new", () => controller.newChat()),
		vscode.commands.registerCommand("llamacpp.chat.openInEditor", () => host.openInEditor()),
	);
}
