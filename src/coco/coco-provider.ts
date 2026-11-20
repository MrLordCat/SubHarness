import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as vscode from "vscode";
import { resolveProviderSwitchContextTokens, resolveSharedContextLimit, sharedContextBudget } from "../context/provider-handoff";
import { isProviderSwitch } from "../providers/provider-switch";
import { promptCacheSignalPart, PROMPT_CACHE_OPTION } from "../providers/prompt-cache-signal";

import { CocoAcpClient, type CocoSessionClient, type CocoAcpHandlers, type CocoPromptContent } from "./acp-client";
import { CocoSdkClient, cocoSdkAvailable, cocoSdkError } from "./sdk-client";
import { COCO_SDK_TOOL_PREFIX } from "./tool-names";
import {
	COCO_COMPACTION_THRESHOLD_ENV, decodeCocoModelId, mapCocoModel, parseCocoModels, parseCocoThinkingConfiguration,
	resolveCocoCompactionThreshold, resolveCocoReasoningEffort, type CocoModel, type CocoThinkingConfiguration,
} from "./model-adapter";
import { CocoTurnBridge, collectCocoToolResults, COCO_CHAT_TOOL_POLICY, COCO_TOOL_IMAGE_ROUNDS } from "./turn-bridge";
import { cocoToolImageNote } from "./tool-policy";
import { estimateCocoTokens } from "./message-adapter";
import { parseCocoContextUsage, parseCocoTokenUsage } from "./usage-adapter";
import { CocoSessionStore, cocoUserAnchors } from "./session-store";
import { CocoHistoryArchive } from "./history-transfer";
import { CocoTurnMetrics, type CocoLiveTurn, type CocoRecordedUsage } from "./turn-metrics";
import { classifyCocoDiscoveryError, cocoDiscoveryFailureSummary, redactCocoDiagnostic, type CocoDiscoveryFailureKind } from "./discovery-diagnostics";
import type { ProviderRuntimeMetrics } from "../provider-metrics";

/** Automatic checks run once per source; only a source without a recorded catalog starts a CLI process. */
const COCO_MANUAL_DISCOVERY_TIMEOUT_MS = 180_000;
const COCO_SIGN_IN_HINT_MS = 10_000;
const COCO_DISCOVERY_CLOSE_GRACE_MS = 5_000;
const COCO_CATALOG_SOURCES = 8;
export const COCO_CATALOG_KEY = "llamacpp.coco.catalog.v1";
/** A native turn that ends after reasoning alone is asked to continue at most this often. */
const COCO_EMPTY_TURN_NUDGES = 2;
const COCO_EMPTY_TURN_NUDGE = "Your previous reply ended after reasoning, without visible text or a tool call, so VS Code Chat received an empty response. "
	+ "Continue the task now: call the next vscode_chat_ tool or write the answer. Keep the reasoning short.";
/** Shared-context archives not rewritten for two weeks belong to finished chats. */
const COCO_ARCHIVE_RETENTION_MS = 14 * 24 * 60 * 60_000;
export const COCO_DISCOVERY_TIMEOUT_MS = 45_000;
const AUTO_MODEL: CocoModel = { id: "auto", name: "Auto", description: "Snowflake selects an available model" };

export interface CocoProviderStatus {
	state: "checking" | "connected" | "disabled" | "unconfigured" | "unavailable";
	summary: string;
	modelCount: number;
	connection?: string;
	checkedAt?: number;
}

export interface CocoProviderDependencies {
	isEnabled?: () => boolean;
	resolveCli?: () => string | undefined;
	resolveConnection?: () => string | undefined;
	createClient?: (...args: ConstructorParameters<typeof CocoAcpClient>) => CocoAcpClient;
	createSessionClient?: (executable: string, cwd: string, connection: string | undefined, model: string, handlers: CocoAcpHandlers) => CocoSessionClient;
	discoveryTimeoutMs?: number;
	signInHintMs?: number;
	state?: vscode.Memento;
	catalogState?: vscode.Memento;
	storageRoot?: string;
	log?: (event: string, data: Record<string,unknown>) => void;
}

export interface CocoCatalogRecord {
	source: string;
	models: CocoModel[];
	thinking?: CocoThinkingConfiguration;
	imageInput: boolean;
	state: "connected" | "unavailable";
	summary: string;
	modelCount: number;
	checkedAt: number;
}

interface CocoActiveTurn {
	modelId: string;
	executable: string;
	connection?: string;
	bridge: CocoTurnBridge;
	client: CocoSessionClient;
	sessionId?: string;
	conversationId?: string;
}

export function resolveCocoCli(): string | undefined {
	const configured = vscode.workspace.getConfiguration("llamacpp").get<string>("cocoCliPath", "").trim();
	if (configured) {
		return fs.existsSync(configured) ? configured : undefined;
	}
	const snowflake = vscode.extensions.getExtension("snowflake.snowflake-vsc");
	if (!snowflake) {
		return undefined;
	}
	const binary = path.join(snowflake.extensionPath, "bin", process.platform === "win32" ? "cortex.exe" : "cortex");
	return fs.existsSync(binary) ? binary : undefined;
}

/** The CLI uses its own credential cache; we only read connection names, never credentials. */
export function resolveCocoConnection(): string | undefined {
	const selected = vscode.workspace.getConfiguration("llamacpp").get<string>("cocoConnection", "").trim();
	if (selected) {
		return selected;
	}
	const names = listCocoConnections();
	return names.length === 1 ? names[0] : undefined;
}

export function listCocoConnections(): string[] {
	const configuredPath = vscode.workspace.getConfiguration("snowflake").get<string>("connectionsConfigFile", "").trim();
	const filePath = configuredPath
		? configuredPath.replace(/^~(?=[\\/])/, os.homedir())
		: path.join(os.homedir(), ".snowflake", "connections.toml");
	try {
		const names = [...fs.readFileSync(filePath, "utf8").matchAll(/^\s*\[([^\]\r\n]+)\]\s*(?:#.*)?$/gm)]
			.map(match => match[1].trim().replace(/^(["'])(.*)\1$/, "$2"));
		return [...new Set(names)];
	} catch {
		return [];
	}
}

function parseCocoCatalogThinking(value: unknown): CocoThinkingConfiguration | undefined {
	if (!value || typeof value !== "object") {
		return undefined;
	}
	const config = value as Partial<CocoThinkingConfiguration>;
	if (typeof config.configId !== "string" || !config.configId || typeof config.currentValue !== "string" || !Array.isArray(config.options)) {
		return undefined;
	}
	const options = config.options.filter(option => option && typeof option.value === "string" && option.value
		&& typeof option.label === "string" && typeof option.description === "string");
	return options.length ? { configId: config.configId, currentValue: config.currentValue, options } : undefined;
}

function parseCocoCatalogRecords(value: unknown): CocoCatalogRecord[] {
	const records: CocoCatalogRecord[] = [];
	for (const item of Array.isArray(value) ? value : []) {
		if (!item || typeof item !== "object") {
			continue;
		}
		const record = item as Partial<CocoCatalogRecord>;
		if (typeof record.source !== "string" || !record.source
			|| (record.state !== "connected" && record.state !== "unavailable")
			|| typeof record.summary !== "string" || typeof record.checkedAt !== "number" || !Number.isFinite(record.checkedAt)
			|| typeof record.modelCount !== "number" || !Number.isSafeInteger(record.modelCount) || record.modelCount < 0) {
			continue;
		}
		const models = (Array.isArray(record.models) ? record.models : []).filter((model): model is CocoModel =>
			Boolean(model) && typeof model.id === "string" && model.id.length > 0 && typeof model.name === "string");
		records.push({
			source: record.source, models, thinking: parseCocoCatalogThinking(record.thinking),
			imageInput: record.imageInput === true, state: record.state, summary: record.summary,
			modelCount: record.modelCount, checkedAt: record.checkedAt,
		});
	}
	return records;
}

export class CocoChatModelProvider implements vscode.LanguageModelChatProvider, vscode.Disposable {
	private readonly changes = new vscode.EventEmitter<void>();
	readonly onDidChangeLanguageModelChatInformation = this.changes.event;
	private readonly statusChanges = new vscode.EventEmitter<CocoProviderStatus>();
	readonly onDidChangeStatus = this.statusChanges.event;
	private status: CocoProviderStatus = { state: "checking", summary: "Checking...", modelCount: 0 };
	private disposed = false;
	private models: CocoModel[] = [AUTO_MODEL];
	private thinking?: CocoThinkingConfiguration;
	private imageInput = false;
	private readonly observedContextWindows = new Map<string, number>();
	/** Native compaction threshold each CLI process was started with. */
	private readonly spawnedThresholds = new WeakMap<CocoSessionClient, { modelId: string; threshold?: number }>();
	private discovery?: Promise<void>;
	private discoveryGeneration = 0;
	private catalogRecords = new Map<string, CocoCatalogRecord>();
	private readonly loggedCatalogSkips = new Set<string>();
	private readonly clients = new Set<CocoSessionClient>();
	private readonly activeTurns = new Set<CocoActiveTurn>();
	private readonly failedCallbacks = new Map<string, Error>();
	/** Why a turn without a native error stopped, for Chat retries that resend its tool results. */
	private readonly endedCallbacks = new Map<string, string>();
	private discoveryClient?: CocoAcpClient;
	private stopDiscovery?: () => void;
	private acceptDiscovery?: (modelCount: number) => void;
	private catalogSource?: string;
	private transport = vscode.workspace.getConfiguration("llamacpp").get<string>("cocoTransport", "auto");

	private readonly sessions: CocoSessionStore;
	private readonly archive: CocoHistoryArchive;
	private readonly usageEvents = new vscode.EventEmitter<CocoRecordedUsage>();
	readonly onDidRecordUsage = this.usageEvents.event;
	private readonly liveEvents = new vscode.EventEmitter<CocoLiveTurn>();
	readonly onDidUpdateLiveTurn = this.liveEvents.event;
	private metrics?: ProviderRuntimeMetrics;
	get runtimeMetrics(): ProviderRuntimeMetrics | undefined { return this.metrics ? { ...this.metrics } : undefined; }

	async onForeignRequest(conversationId?: unknown): Promise<void> {
		if (typeof conversationId !== "string" || !conversationId) { return; }
		for (const turn of [...this.activeTurns]) {
			if (turn.conversationId === conversationId) { turn.bridge.dispose(); }
		}
	}

	constructor(private readonly dependencies: CocoProviderDependencies = {}) {
		this.sessions = new CocoSessionStore(dependencies.state, dependencies.storageRoot ? path.join(dependencies.storageRoot, "sessions.json") : undefined);
		this.archive = new CocoHistoryArchive(dependencies.storageRoot ?? path.join(os.tmpdir(), "ai-agent-bridge", "coco-history"));
		for (const record of parseCocoCatalogRecords(dependencies.catalogState?.get<unknown>(COCO_CATALOG_KEY))) {
			this.catalogRecords.set(record.source, record);
		}
		void this.archive.prune(COCO_ARCHIVE_RETENTION_MS).catch(() => undefined);
	}

	private sessionIdentity(modelId: string): string {
		return CocoSessionStore.identity(this.resolveCli() ?? "", vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? process.cwd(), this.resolveConnection(), modelId);
	}

	get providerStatus(): CocoProviderStatus {
		return { ...this.status };
	}

	get thinkingLevels(): readonly string[] {
		return this.thinking?.options.map(option => option.label) ?? [];
	}

	async refreshStatus(force = false, token?: vscode.CancellationToken): Promise<CocoProviderStatus> {
		if (token?.isCancellationRequested) { return this.providerStatus; }
		const check = this.discover(force);
		// Capture this check's stop function: a late cancellation must not stop a replacement check.
		const stop = this.stopDiscovery;
		const cancellation = token?.onCancellationRequested(() => stop?.());
		try { await check; } finally { cancellation?.dispose(); }
		return this.providerStatus;
	}

	private catalogKey(executable: string | undefined, connection: string | undefined): string {
		return JSON.stringify([executable ?? "", connection ?? ""]);
	}

	private saveCatalogRecord(
		executable: string | undefined, connection: string | undefined,
		state: CocoCatalogRecord["state"], summary: string, modelCount: number
	): void {
		const record: CocoCatalogRecord = {
			source: this.catalogKey(executable, connection), models: this.models, thinking: this.thinking,
			imageInput: this.imageInput, state, summary, modelCount, checkedAt: Date.now(),
		};
		this.catalogRecords.delete(record.source);
		this.catalogRecords.set(record.source, record);
		const entries = [...this.catalogRecords.values()].sort((a, b) => b.checkedAt - a.checkedAt).slice(0, COCO_CATALOG_SOURCES);
		this.catalogRecords = new Map(entries.map(entry => [entry.source, entry]));
		try {
			const update = this.dependencies.catalogState?.update(COCO_CATALOG_KEY, entries);
			void Promise.resolve(update).catch(() => undefined);
		} catch { /* A catalog write must not fail a status check. */ }
	}

	/** Seeds the current source from its record; only an unknown source resets the catalog. */
	private syncCatalogSource(): boolean {
		const executable = this.resolveCli(), connection = this.resolveConnection();
		const source = JSON.stringify([this.enabled, executable, connection]);
		if (this.catalogSource === source) {
			return false;
		}
		if (this.catalogSource !== undefined) { this.sessions.dispose(); }
		this.discoveryGeneration++;
		this.stopDiscovery?.();
		this.catalogSource = source;
		this.observedContextWindows.clear();
		const record = this.catalogRecords.get(this.catalogKey(executable, connection));
		if (record) {
			this.models = record.models.length ? record.models : [AUTO_MODEL];
			this.thinking = record.thinking;
			this.imageInput = record.imageInput;
			this.setStatus(this.enabled ? record.state : "disabled", this.enabled ? record.summary : "Off", connection, record.modelCount, record.checkedAt);
			return true;
		}
		this.models = [AUTO_MODEL];
		this.thinking = undefined;
		this.imageInput = false;
		this.setStatus(this.enabled ? "checking" : "disabled", this.enabled ? "Checking..." : "Off", connection);
		return true;
	}

	private resolveCli(): string | undefined {
		return (this.dependencies.resolveCli ?? resolveCocoCli)();
	}

	private resolveConnection(): string | undefined {
		return (this.dependencies.resolveConnection ?? resolveCocoConnection)();
	}

	private createClient(...args: ConstructorParameters<typeof CocoAcpClient>): CocoAcpClient {
		return this.dependencies.createClient?.(...args) ?? new CocoAcpClient(...args);
	}
	private diagnostic(event: string, data: Record<string,unknown>): void {
		try { this.dependencies.log?.(event,data); } catch { /* Diagnostic storage must not fail a native turn. */ }
	}
	private nativeClient(executable: string, cwd: string, connection: string | undefined, model: string, handlers: CocoAcpHandlers, hasTools = false): CocoSessionClient {
		if (this.dependencies.createSessionClient) { return this.dependencies.createSessionClient(executable, cwd, connection, model, handlers); }
		if (this.dependencies.createClient) { return this.createClient(executable, cwd, connection, model, handlers); }
		const threshold = this.compactionThreshold(model);
		const environment: Record<string, string> = threshold === undefined ? {} : { [COCO_COMPACTION_THRESHOLD_ENV]: String(threshold) };
		const transport = vscode.workspace.getConfiguration("llamacpp").get<string>("cocoTransport", "auto");
		// The bundled CLI's SDK MCP control requests expire after 30 seconds.
		// ACP client tools can wait for Chat approvals and long commands while
		// retaining the same native session ID, including SDK-created sessions.
		const client = !hasTools && (transport === "sdk" || transport === "auto" && cocoSdkAvailable())
			? new CocoSdkClient(executable, cwd, connection, model, handlers, undefined, environment)
			: this.createClient(executable, cwd, connection, model, handlers, undefined, environment);
		this.spawnedThresholds.set(client, { modelId: model, threshold });
		return client;
	}
	/** Real model window when measured, then the saved, baseline or fallback window. */
	private modelWindow(modelId: string): number {
		const configured = vscode.workspace.getConfiguration("llamacpp");
		const windows = configured.get<Record<string, number>>("cocoModelContextLengths", { "claude-opus-5-5": 1_000_000 });
		const baseline = windows[modelId];
		return this.observedContextWindows.get(modelId) ?? this.sessions.window(this.sessionIdentity(modelId))
			?? (Number.isSafeInteger(baseline) && baseline >= 4096 && baseline <= 1048576 ? baseline : Math.max(4_096, configured.get<number>("cocoContextLength", 128_000)));
	}
	private compactionThreshold(modelId: string): number | undefined {
		return resolveCocoCompactionThreshold(resolveSharedContextLimit(), this.modelWindow(modelId));
	}
	/** Idle processes started with another threshold restart; the native session reloads. */
	private releaseStaleCompaction(): void {
		this.sessions.releaseIdle(session => {
			const spawned = this.spawnedThresholds.get(session.client);
			return spawned !== undefined && spawned.threshold !== this.compactionThreshold(spawned.modelId);
		});
	}
	async needsConversationHistory(model: vscode.LanguageModelChatInformation, messages: readonly vscode.LanguageModelChatRequestMessage[], options: vscode.ProvideLanguageModelChatResponseOptions): Promise<boolean> {
		const id = decodeCocoModelId(model.id);
		return !id || !await this.sessions.hasBinding(this.sessionIdentity(id), options.modelOptions?._copilotConversationId, cocoUserAnchors(messages));
	}

	private get enabled(): boolean {
		return this.dependencies.isEnabled?.()
			?? vscode.workspace.getConfiguration("llamacpp").get<boolean>("enableCoco", true);
	}

	refreshLanguageModelChatInformation(): void {
		const transport = vscode.workspace.getConfiguration("llamacpp").get<string>("cocoTransport", "auto");
		if (transport !== this.transport) {
			for (const turn of [...this.activeTurns]) { turn.bridge.dispose(); }
			this.sessions.dispose(); this.transport = transport;
		}
		this.syncCatalogSource();
		for (const turn of this.activeTurns) {
			if (!this.enabled || turn.connection !== this.resolveConnection() || turn.executable !== this.resolveCli()) {
				turn.bridge.dispose();
			}
		}
		this.releaseStaleCompaction();
		this.changes.fire();
	}

	async provideLanguageModelChatInformation(
		_options: { silent: boolean },
		token: vscode.CancellationToken
	): Promise<vscode.LanguageModelChatInformation[]> {
		if (token.isCancellationRequested || this.disposed) {
			return [];
		}
		this.syncCatalogSource();
		void this.discover();
		if (!this.enabled || !this.resolveCli()) {
			return [];
		}
		const shared = resolveSharedContextLimit();
		return this.models.map(model => mapCocoModel(model, Math.min(this.modelWindow(model.id), shared), this.thinking, this.imageInput));
	}

	async provideLanguageModelChatResponse(
		model: vscode.LanguageModelChatInformation,
		messages: readonly vscode.LanguageModelChatRequestMessage[],
		options: vscode.ProvideLanguageModelChatResponseOptions,
		progress: vscode.Progress<vscode.LanguageModelResponsePart>,
		token: vscode.CancellationToken
	): Promise<void> {
		if (!this.enabled || this.disposed) {
			throw new Error("Coco is disabled. Enable its source in Quick Access before sending a request.");
		}
		const modelId = decodeCocoModelId(model.id);
		if (!modelId) {
			throw new Error(`Invalid Coco model: ${model.id}`);
		}
		if (options.toolMode === vscode.LanguageModelChatToolMode.Required) {
			throw new Error("Coco cannot force a VS Code tool call. Use automatic tool mode.");
		}
		const executable = this.resolveCli();
		if (!executable) {
			throw new Error("Coco CLI not found. Install the Snowflake VS Code extension or set llamacpp.cocoCliPath.");
		}
		if (token.isCancellationRequested) {
			throw new vscode.CancellationError();
		}
		const results = collectCocoToolResults(messages);
		const conversationId = typeof options.modelOptions?._copilotConversationId === "string" ? options.modelOptions._copilotConversationId : undefined;
		const continuations = [...this.activeTurns].filter(turn => results.some(result => turn.bridge.pendingCallIds.has(result.callId)));
		if (continuations.length > 1) {
			throw new Error("Coco received tool results from different Chat conversations.");
		}
		const continuation = continuations[0];
		if (continuation) {
			if (continuation.modelId !== model.id || continuation.connection !== this.resolveConnection() || continuation.executable !== executable || continuation.conversationId !== conversationId) {
				continuation.bridge.dispose();
				throw new Error("The Coco model or Snowflake connection changed during tool execution. Start a new request.");
			}
			await continuation.bridge.resume(results, progress, token);
			return;
		}
		if (results.some(result => result.callId.startsWith("coco-"))) {
			const original = results.map(result => this.failedCallbacks.get(result.callId)).find(error => error !== undefined);
			if (original) { throw new Error(`Coco's native request was interrupted: ${original.message} Send a new user message to continue its saved session. Completed tools were not repeated.`); }
			const ended = results.map(result => this.endedCallbacks.get(result.callId)).find(reason => reason !== undefined);
			this.diagnostic("coco.request.stale_results", { results: results.length, reason: ended ?? "unknown" });
			throw new Error(`The Coco tool session is no longer active${ended ? `: ${ended}` : ""}. Send a new user message to continue its saved session. Completed tools were not repeated.`);
		}
		// An explicit new request supersedes an abandoned tool cycle in this chat.
		await this.onForeignRequest(conversationId);
		const cwd = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? process.cwd();
		const connection = this.resolveConnection();
		const generation = this.discoveryGeneration;
		const providerSwitched = isProviderSwitch(options.modelOptions);
		const anchors = cocoUserAnchors(messages);
		const metrics = new CocoTurnMetrics(model.id, messages.length, update => {
			this.metrics = update.runtime;
			this.liveEvents.fire(update);
		});
		const bridge = new CocoTurnBridge(options.tools ?? [], error => {
			if (error && !(error instanceof vscode.CancellationError)) {
				const safe = cocoSdkError(error);
				for (const id of bridge.issuedCallIds) { this.failedCallbacks.set(id, safe); }
				while (this.failedCallbacks.size > 256) { this.failedCallbacks.delete(this.failedCallbacks.keys().next().value!); }
				this.diagnostic("coco.turn.failed", { requestId: metrics.requestId, sessionId: turn.sessionId, durationMs: Date.now() - metrics.started, error: safe.message });
			} else {
				const reason = error ? "its turn was cancelled (Stop, a new request in this chat, or a model or connection change)" : "its native turn had already finished";
				for (const id of bridge.issuedCallIds) { this.endedCallbacks.set(id, reason); }
				while (this.endedCallbacks.size > 256) { this.endedCallbacks.delete(this.endedCallbacks.keys().next().value!); }
			}
			if (error && turn.sessionId) { client.cancel(turn.sessionId); }
			this.sessions.finish(slot, error);
			// A fallback window may have been replaced by the measured one during this turn.
			this.releaseStaleCompaction();
			this.clients.delete(client);
			this.activeTurns.delete(turn);
			const usage = metrics.finish(error);
			if (usage) { this.usageEvents.fire(usage); }
		}, undefined, result => this.archive.toolResult(result, slot.key));
		const slot = await this.sessions.acquire(this.sessionIdentity(modelId), conversationId, anchors,
			handlers => this.nativeClient(executable, cwd, connection, modelId, handlers, Boolean(options.tools?.length)), {
			onUpdate: update => {
				const usage = parseCocoContextUsage(update);
				if (usage) { slot.contextWindow = usage.contextWindowTokens; }
				metrics.accept(update, slot.importing);
				if (usage && generation === this.discoveryGeneration
					&& this.observedContextWindows.get(modelId) !== usage.contextWindowTokens) {
					this.observedContextWindows.set(modelId, usage.contextWindowTokens);
					this.changes.fire();
				}
				if (!slot.importing || update.sessionUpdate === "tool_call") { bridge.accept(update); }
				if (generation === this.discoveryGeneration && update.sessionUpdate === "config_option_update") {
					this.updateThinking(parseCocoThinkingConfiguration(update));
				}
			},
			onPermission: async request => {
				const option = bridge.permitImageRead(request);
				if (option) {
					this.diagnostic("coco.tool.image_read", { requestId: metrics.requestId });
					return option;
				}
				const denied = bridge.denyRead(request);
				if (denied) {
					this.diagnostic("coco.tool.read_denied", { requestId: metrics.requestId });
					return denied;
				}
				bridge.blockInternalAction(request.toolCall?.title ?? "permission request");
				return undefined;
			},
			onClientTool: async (name, input, nativeCallId) => {
				const started = Date.now(); metrics.tool();
				this.diagnostic("coco.tool.delegated", { requestId: metrics.requestId, name, transport: slot.client.transport ?? "acp" });
				try { return await bridge.delegate(name, input, nativeCallId); }
				finally { this.diagnostic("coco.tool.returned", { requestId: metrics.requestId, name, durationMs: Date.now() - started }); }
			},
		}, messages, !this.dependencies.createSessionClient && !this.dependencies.createClient && Boolean(options.tools?.length), providerSwitched);
		const client = slot.client;
		const turn: CocoActiveTurn = { modelId: model.id, executable, connection, bridge, client, conversationId };
		this.activeTurns.add(turn);
		this.clients.add(client);
		let sessionReady = false;
		try {
			bridge.rememberResults(messages);
			await bridge.start(async () => {
				const preparingSession = Date.now();
				const session = await this.sessions.prepare(slot, cwd, bridge.clientTools);
				const sessionPrepareMs = Date.now() - preparingSession;
				const imageInput = slot.initialized?.agentCapabilities?.promptCapabilities?.image === true;
				const sessionId = slot.sessionId;
				if (!sessionId) {
					throw new Error("Coco did not return a session ID. Check the Snowflake connection and Azure sign-in.");
				}
				turn.sessionId = sessionId;
				const discovered = parseCocoModels(session);
				const thinking = parseCocoThinkingConfiguration(session) ?? this.thinking;
				sessionReady = true;
				if (generation === this.discoveryGeneration) {
					// A ready native session is a fresh status check; no separate CLI process is needed.
					this.catalogSource = JSON.stringify([this.enabled, executable, connection]);
					if (discovered.length) { this.updateModels(discovered); }
					this.updateThinking(thinking);
					this.updateImageInput(imageInput);
					const modelCount = discovered.length || this.models.length;
					this.setStatus("connected", "Connected", connection, modelCount);
					this.saveCatalogRecord(executable, connection, "connected", "Connected", modelCount);
					this.acceptDiscovery?.(discovered.length);
				}
				const effort = resolveCocoReasoningEffort(
					options.modelOptions?.reasoningEffort ?? options.modelOptions?.reasoning_effort ?? options.modelOptions?.thinkingLevel,
					thinking
				);
				if (effort !== undefined && thinking) {
					await client.setSessionConfigOption(sessionId, thinking.configId, effort);
				}
				const hostBlocks = new Map<string, string>();
				if (!slot.fresh) {
					for (const part of messages[0]?.content ?? []) {
						if (part instanceof vscode.LanguageModelTextPart) {
							for (const match of part.value.matchAll(/<(context|environment_info|workspace_info|attachments|reminderInstructions)>[\s\S]*?<\/\1>/g)) { hostBlocks.set(match[1], match[0]); }
						}
					}
				}
				const host = [...hostBlocks.values()].join("\n");
				const delta = slot.fresh ? messages : [...(host ? [vscode.LanguageModelChatMessage.User(`Current VS Code environment (updated snapshot):\n${host}`)] : []), ...messages.slice(slot.deltaStart)];
				const tokenBudget = Math.min(sharedContextBudget(model.maxInputTokens + model.maxOutputTokens, options.tools),
					providerSwitched ? resolveProviderSwitchContextTokens() : Number.POSITIVE_INFINITY);
				const preparingHistory = Date.now();
				const transfer = await this.archive.prepare(delta, slot.key, tokenBudget);
				const historyPrepareMs = Date.now() - preparingHistory;
				if (transfer.compacted) {
					metrics.accept({sessionUpdate:"compaction"});
					progress.report(new vscode.LanguageModelTextPart(`Coco: shared context prepared (${transfer.estimatedTokens?.toLocaleString()} estimated history tokens, budget ${tokenBudget.toLocaleString()}). Complete history and earlier images: ${transfer.archivePath}. Sending the current request…\n\n`));
				}
				if (transfer.prompt.length === 0) { throw new Error("Coco received an empty conversation."); }
				if (!imageInput && [...transfer.prompt, ...transfer.imports.flat()].some(part => part.type === "image")) {
					throw new Error("This Coco ACP runtime does not support image input. Update the Snowflake extension and refresh Coco models.");
				}
				metrics.setSession(slot.mode, slot.key, slot.reason, client.transport === "sdk" && transfer.prompt.some(part => part.type === "image") ? "acp (same native session)" : client.transport ?? "acp");
				this.diagnostic("coco.request.prepared",{
					requestId:metrics.requestId,modelId,transport:client.transport ?? "acp",sessionMode:slot.mode,reason:slot.reason,
					sessionPrepareMs,historyPrepareMs,
					historyTokenBudget: tokenBudget, estimatedHistoryTokens: transfer.estimatedTokens,
					toolCount:bridge.clientTools.length,maxSdkWireToolNameLength:Math.max(0,...bridge.clientTools.map(tool => (COCO_SDK_TOOL_PREFIX + tool.name).length)),
					promptChars:transfer.prompt.reduce((n,part) => n + (part.type === "text" ? part.text.length : 0),0),
					imageCount:transfer.prompt.filter(part => part.type === "image").length,compacted:Boolean(transfer.compacted),
				});
				const prompt = async (content: typeof transfer.prompt | string) => {
					const result = await client.prompt(sessionId, typeof content === "string" || content.some(part => part.type === "image") ? content : content.map(part => part.type === "text" ? part.text : "").join(""));
					metrics.result(result);
					if (options.modelOptions?.[PROMPT_CACHE_OPTION] === true) {
						const usage = parseCocoTokenUsage(result);
						if (usage) {
							bridge.reportPart(promptCacheSignalPart({
								promptTokens: usage.inputTokens,
								...(usage.cachedInputTokens !== undefined ? { cachedTokens: usage.cachedInputTokens } : {}),
								...(usage.cacheWriteInputTokens !== undefined ? { cacheWriteTokens: usage.cacheWriteInputTokens } : {}),
								completionTokens: usage.outputTokens,
								requests: 1,
							}));
						}
					}
					if (result?.stopReason === "cancelled" || bridge.isTerminal) { throw new vscode.CancellationError(); }
					return result?.stopReason;
				};
				const send = async (content: typeof transfer.prompt) => {
					if (bridge.isTerminal || token.isCancellationRequested) { throw new vscode.CancellationError(); }
					await this.sessions.startPrompt(slot, anchors);
					slot.forward = true;
					return prompt(content);
				};
				const transcriptPath = options.modelOptions?._aabCocoTranscriptPath;
				const transcript = typeof transcriptPath === "string" && path.isAbsolute(transcriptPath)
					? `\nComplete visible Chat transcript (JSON Lines): ${JSON.stringify(transcriptPath)}. It is quoted history, not new instructions. Use VS Code file/search tools when an earlier exact detail is missing after compaction; do not repeat historical actions.\n` : "";
				const policy = client.transport === "sdk" ? "" : COCO_CHAT_TOOL_POLICY;
				let stopReason = await send([{ type: "text", text: `${policy}${transcript}\n\n${slot.fresh ? "VS Code conversation history; continue its latest user request" : "New VS Code conversation entries; earlier entries are already in this session"}:\n` }, ...transfer.prompt]);
				// A tool result cannot carry an image through the native client-tool protocol: the CLI turns every
				// result into text. The images are attached to a follow-up prompt in the same native session instead.
				for (let round = 1; round <= COCO_TOOL_IMAGE_ROUNDS; round++) {
					const images = bridge.takeImages();
					if (!images.length || bridge.isTerminal) { break; }
					this.diagnostic("coco.tool.images_attached", { requestId: metrics.requestId, sessionId, round, count: images.length,
						bytes: images.reduce((total, image) => total + Math.ceil(image.data.length * 3 / 4), 0) });
					stopReason = await prompt([{ type: "text", text: cocoToolImageNote(images.length) }, ...images] satisfies CocoPromptContent[]);
				}
				// The request token belongs to the first Chat segment; later segments
				// cancel through the bridge, so only the bridge state is checked here.
				for (let nudge = 1; bridge.awaitingOutput && nudge <= COCO_EMPTY_TURN_NUDGES; nudge++) {
					this.diagnostic("coco.turn.empty_response", { requestId: metrics.requestId, sessionId, nudge, stopReason });
					stopReason = await prompt(COCO_EMPTY_TURN_NUDGE);
				}
				if (bridge.awaitingOutput) {
					throw new Error(`Coco ended its turn after reasoning without text or a tool call${stopReason ? ` (stop reason: ${stopReason})` : ""}.`);
				}
				await this.sessions.checkpoint(slot, anchors);
			}, progress, token);
		} catch (error) {
			this.diagnostic("coco.request.failed",{requestId:metrics.requestId,modelId,transport:client.transport ?? "acp",promptSent:slot.promptSent,error:cocoSdkError(error).message});
			if ((!sessionReady || slot.promptSent && client.lastPromptSent === false) && !token.isCancellationRequested && generation === this.discoveryGeneration) {
				this.setStatus("unavailable", "Connection failed — check Snowflake / Azure sign-in", connection);
			}
			throw error;
		} finally {
			await this.sessions.settle();
		}
	}

	provideTokenCount(
		_model: vscode.LanguageModelChatInformation,
		value: string | vscode.LanguageModelChatRequestMessage,
		_token: vscode.CancellationToken
	): Thenable<number> {
		return Promise.resolve(estimateCocoTokens(value));
	}

	dispose(): void {
		this.disposed = true;
		this.discoveryGeneration++;
		this.stopDiscovery?.();
		for (const turn of this.activeTurns) { turn.bridge.dispose(); }
		for (const client of this.clients) {
			client.dispose();
		}
		this.clients.clear();
		this.sessions.dispose();
		this.usageEvents.dispose(); this.liveEvents.dispose();
		this.changes.dispose();
		this.statusChanges.dispose();
	}

	private discover(forced = false): Promise<void> {
		if (this.disposed) {
			return Promise.resolve();
		}
		this.syncCatalogSource();
		if (!this.enabled) {
			this.setStatus("disabled", "Off", this.resolveConnection());
			return Promise.resolve();
		}
		const executable = this.resolveCli();
		if (!executable) {
			this.setStatus("unconfigured", "Install Snowflake or configure the Coco CLI", this.resolveConnection());
			return Promise.resolve();
		}
		if (this.discovery) {
			return this.discovery;
		}
		const connection = this.resolveConnection();
		const source = this.catalogKey(executable, connection);
		const record = this.catalogRecords.get(source);
		if (!forced && record) {
			if (!this.loggedCatalogSkips.has(source)) {
				this.loggedCatalogSkips.add(source);
				this.diagnostic("coco.discovery.skipped", { reason: "recorded", state: record.state, ageMs: Math.max(0, Date.now() - record.checkedAt) });
			}
			return Promise.resolve();
		}
		const started = Date.now();
		this.diagnostic("coco.discovery.started", { forced, trigger: forced ? "manual" : "auto" });
		const generation = this.discoveryGeneration;
		const modelCount = this.status.modelCount;
		const timeoutMs = Math.max(1, this.dependencies.discoveryTimeoutMs ?? (forced ? COCO_MANUAL_DISCOVERY_TIMEOUT_MS : COCO_DISCOVERY_TIMEOUT_MS));
		const hintMs = Math.max(1, this.dependencies.signInHintMs ?? COCO_SIGN_IN_HINT_MS);
		let client: CocoAcpClient | undefined;
		let hintTimer: NodeJS.Timeout | undefined;
		let waitedForSignIn = false;
		let finished = false;
		let resolve!: () => void;
		const check = new Promise<void>(done => { resolve = done; });
		const finish = (
			state: "connected" | "unavailable", summary: string, count = modelCount,
			failure?: { kind: CocoDiscoveryFailureKind; message: unknown }
		): void => {
			if (finished) { return; }
			finished = true;
			clearTimeout(timer);
			clearTimeout(hintTimer);
			const durationMs = Date.now() - started;
			if (generation === this.discoveryGeneration) {
				this.setStatus(state, summary, connection, count);
			}
			if (failure?.kind !== "cancelled") {
				this.saveCatalogRecord(executable, connection, state, summary, count);
			}
			const checkedClient = client;
			try {
				if (state === "connected" && checkedClient?.close) {
					void checkedClient.close(COCO_DISCOVERY_CLOSE_GRACE_MS).catch(() => { try { checkedClient.dispose(); } catch { /* ignore */ } });
				} else if (checkedClient) {
					checkedClient.dispose();
				}
			} catch { /* A cleanup failure must not keep the status check pending. */ }
			if (checkedClient) { this.clients.delete(checkedClient); }
			if (this.discoveryClient === checkedClient) { this.discoveryClient = undefined; }
			if (this.discovery === check) { this.discovery = undefined; this.stopDiscovery = undefined; this.acceptDiscovery = undefined; }
			this.diagnostic("coco.discovery.finished", { state, models: count, durationMs, waitedForSignIn });
			if (failure) { this.diagnostic("coco.discovery.failed", { kind: failure.kind, message: redactCocoDiagnostic(failure.message) }); }
			resolve();
		};
		const timeoutSeconds = Math.ceil(timeoutMs / 1_000);
		const timer = setTimeout(() => finish("unavailable",
			cocoDiscoveryFailureSummary("timeout", timeoutSeconds), modelCount,
			{ kind: "timeout", message: `Connection check timed out after ${timeoutSeconds}s` }), timeoutMs);
		this.discovery = check;
		this.stopDiscovery = () => finish("unavailable", cocoDiscoveryFailureSummary("cancelled"), modelCount,
			{ kind: "cancelled", message: "Connection check cancelled" });
		this.acceptDiscovery = count => finish("connected", "Connected", count);
		this.setStatus("checking", "Starting Coco...", connection, modelCount);
		void (async () => {
			try {
				const cwd = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? process.cwd();
				client = this.createClient(executable, cwd, connection, undefined);
				this.discoveryClient = client;
				this.clients.add(client);
				if (hintMs < timeoutMs) {
					hintTimer = setTimeout(() => {
						if (finished || generation !== this.discoveryGeneration || this.discovery !== check) { return; }
						waitedForSignIn = true;
						this.setStatus("checking", "Waiting for Snowflake sign-in — finish it in the browser", connection, modelCount);
					}, hintMs);
				}
				const initialized = await client.initialize();
				if (finished || generation !== this.discoveryGeneration) { return; }
				this.setStatus("checking", "Loading models from Snowflake...", connection, modelCount);
				const session = await client.newSession(cwd);
				if (finished || generation !== this.discoveryGeneration) { return; }
				if (typeof session.sessionId !== "string" || !session.sessionId) {
					throw new Error("Coco did not return an ACP session ID.");
				}
				const models = parseCocoModels(session);
				this.updateModels(models);
				this.updateThinking(parseCocoThinkingConfiguration(session));
				this.updateImageInput(initialized?.agentCapabilities?.promptCapabilities?.image === true);
				finish("connected", "Connected", models.length);
			} catch (error) {
				const kind = classifyCocoDiscoveryError(error, client?.stderrTail ?? "");
				finish("unavailable", cocoDiscoveryFailureSummary(kind), modelCount, { kind, message: error });
			}
		})();
		return check;
	}

	private setStatus(
		state: CocoProviderStatus["state"], summary: string,
		connection?: string, modelCount = 0, checkedAt?: number
	): void {
		if (this.disposed) {
			return;
		}
		const next: CocoProviderStatus = {
			state, summary, connection, modelCount,
			checkedAt: checkedAt ?? (state === "connected" || state === "unavailable" ? Date.now() : undefined),
		};
		if (JSON.stringify(next) !== JSON.stringify(this.status)) {
			this.status = next;
			this.statusChanges.fire(this.providerStatus);
		}
	}

	private updateModels(discovered: CocoModel[]): void {
		if (discovered.length === 0) {
			return;
		}
		const unique = new Map<string, CocoModel>([[AUTO_MODEL.id, AUTO_MODEL]]);
		for (const model of discovered) {
			unique.set(model.id, model);
		}
		const next = [...unique.values()];
		if (JSON.stringify(next) !== JSON.stringify(this.models)) {
			this.models = next;
			this.changes.fire();
		}
	}

	private updateThinking(thinking: CocoThinkingConfiguration | undefined): void {
		if (JSON.stringify(thinking) !== JSON.stringify(this.thinking)) {
			this.thinking = thinking;
			this.changes.fire();
		}
	}

	private updateImageInput(imageInput: boolean): void {
		if (imageInput !== this.imageInput) {
			this.imageInput = imageInput;
			this.changes.fire();
		}
	}

}