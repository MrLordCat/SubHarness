import * as path from "node:path";
import * as vscode from "vscode";
import { CocoTerminalManager } from "../coco/terminal-manager";
import { resolveProviderSwitchContextTokens } from "../context/provider-handoff";
import { ChatAttachmentSource } from "./attachment-source";
import { ChatChangeTracker } from "./changes/change-tracker";
import { findGitExecutable } from "./changes/shadow-git";
import { ChatController, type ChatQuotaSource } from "./chat-controller";
import { registerChatView } from "./chat-view";
import { CHAT_COMPACTION_TARGET_TOKENS, createChatSummarizer } from "./compaction";
import { ChatPromptSource } from "./prompt/instructions";
import { ChatSessionStore } from "./session-store";
import { createChatToolSource } from "./tool-executor";
import { ChatToolCatalog } from "./tools/catalog";
import { getSubagentModelProfiles } from "../subagent-guidance";
import { createCoreTools } from "./tools/core-tools";
import { createSubagentTool } from "./tools/subagent-tool";
import { createSymbolTools } from "./tools/symbol-tools";
import { configuredDangerousCommandRules } from "./tools/danger";
import { createChatTerminalTools } from "./tools/terminal-tools";
import { createWebTools } from "./tools/web-tools";

type CompositeChatProvider = Pick<vscode.LanguageModelChatProvider, "provideLanguageModelChatResponse" | "provideLanguageModelChatInformation"> & {
	onDidChangeLanguageModelChatInformation?: vscode.Event<void>;
	abandonConversation?: (conversationId: string) => Promise<void>;
};

export interface ChatWindowDeps {
	composite: CompositeChatProvider;
	log?: (event: string, data: Record<string, unknown>) => void;
	/** Sent with DeepSeek summary requests. */
	userAgent?: string;
	quota?: ChatQuotaSource;
}

const DEEPSEEK_KEY_SECRET = "llamacpp.deepSeekApiKey";

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
	const folders = () => (vscode.workspace.workspaceFolders ?? [])
		.filter(folder => folder.uri.scheme === "file")
		.map(folder => ({ name: folder.name, fsPath: folder.uri.fsPath }));
	const changes = new ChatChangeTracker({
		storageDir: path.join(storage, "chat-changes"),
		folders,
		findGit: findGitExecutable,
		log: deps.log,
	});
	const terminals = new CocoTerminalManager(vscode.window, undefined, deps.log, "Chat");
	const reportInvalidRule = (pattern: string, error: string) => deps.log?.("chat.dangerous_rule_invalid", { pattern, error });
	const catalog = new ChatToolCatalog({
		builtins: [
			...createCoreTools(),
			...createWebTools(),
			...createSymbolTools(),
			...createChatTerminalTools({ manager: terminals, rules: () => configuredDangerousCommandRules(reportInvalidRule) }),
			createSubagentTool({
				// The bridge's subagent catalog: cheapest first, premium flagships and exhausted subscriptions left out.
				models: () => getSubagentModelProfiles()
					.filter(profile => profile.availability !== "unavailable")
					.map(profile => ({ id: profile.id, label: profile.label, useWhen: profile.useWhen })),
			}),
		],
		state: context.globalState,
	});
	const attachments = new ChatAttachmentSource({ log: deps.log });
	const controller = new ChatController({
		backend: deps.composite,
		onDidChangeModels: deps.composite.onDidChangeLanguageModelChatInformation ?? NEVER_FIRES,
		store: new ChatSessionStore(root),
		tools: createChatToolSource(catalog),
		state: context.workspaceState,
		log: deps.log,
		changes,
		openChange: registerChangeDiff(context, changes),
		prompt: new ChatPromptSource({ folders }),
		attachments,
		abandonConversation: async id => { await deps.composite.abandonConversation?.(id); },
		confirm: async (message, action) => (await vscode.window.showWarningMessage(message, { modal: true }, action)) === action,
		notify: async (message, action) => {
			const choice = await vscode.window.showInformationMessage(message, action);
			if (choice === action) {
				// VS Code generates "<viewId>.focus" for every contributed view.
				await Promise.resolve(vscode.commands.executeCommand("llamacpp.chat.focus")).catch(() => undefined);
			}
			return choice === action;
		},
		quota: deps.quota,
		compaction: {
			summarize: createChatSummarizer({
				apiKey: async () => (await context.secrets.get(DEEPSEEK_KEY_SECRET))?.trim() || undefined,
				userAgent: deps.userAgent ?? "ai-agent-bridge",
				log: deps.log,
			}),
			limits: () => {
				const trigger = resolveProviderSwitchContextTokens();
				// A lowered switch limit lowers the target too, so the compacted chat stays well under it.
				return { triggerTokens: trigger, targetTokens: Math.min(CHAT_COMPACTION_TARGET_TOKENS, Math.floor(trigger / 2)) };
			},
		},
	});
	const host = registerChatView(context, controller);
	const focusChat = async (): Promise<void> => {
		await Promise.resolve(vscode.commands.executeCommand("llamacpp.chat.focus")).catch(() => undefined);
	};
	context.subscriptions.push(
		terminals,
		controller,
		vscode.commands.registerCommand("llamacpp.chat.new", () => controller.newChat()),
		vscode.commands.registerCommand("llamacpp.chat.history", () => controller.showSessions()),
		vscode.commands.registerCommand("llamacpp.chat.openInEditor", () => host.openInEditor()),
		vscode.commands.registerCommand("llamacpp.chat.addSelection", async () => {
			const selection = attachments.selection();
			if (!selection) {
				await vscode.window.showInformationMessage("Select some text first.");
				return;
			}
			controller.addAttachments([selection]);
			await focusChat();
		}),
		vscode.commands.registerCommand("llamacpp.chat.addFile", async (uri?: vscode.Uri, uris?: vscode.Uri[]) => {
			const editorUri = vscode.window.activeTextEditor?.document.uri;
			const targets = uris && uris.length > 0 ? uris : uri ? [uri] : editorUri ? [editorUri] : [];
			const files = await attachments.fromUris(targets.map(target => target.toString()));
			if (files.length === 0) {
				return;
			}
			controller.addAttachments(files);
			await focusChat();
		}),
	);
}
