import { randomUUID } from "node:crypto";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { ChatMessage, ChatPart, ChatPromptCache, ChatSessionMeta, ChatUsage, ChatUsageTotals } from "./shared/protocol";

export const DEFAULT_CHAT_TITLE = "New chat";

/** Requests (user messages other than continuations) a chat keeps; older ones and their answers go when it is loaded. */
export const CHAT_MAX_REQUESTS = 1_000;
/** End marker of a trimmed log whose kept messages have no end marker of their own. */
const TRIMMED_END_MARKER = "trimmed";

const INDEX_VERSION = 1;
const INDEX_FILE = "index.json";
const INDEX_TEMP_FILE = "index.json.tmp";
const LOG_SUFFIX = ".jsonl";
const SUBAGENTS_SUFFIX = ".subagents.json";
const SESSION_ID = /^[A-Za-z0-9-]{1,64}$/;
const TITLE_MAX_CHARS = 60;
const INDEX_THROTTLE_MS = 1_000;

/** One event per line; load replays them in file order. */
type LogEvent =
	| { t: "message"; message: ChatMessage }
	| { t: "part"; messageId: string; part: ChatPart }
	| { t: "usage"; messageId: string; usage?: ChatUsage; totals?: ChatUsageTotals; promptCache?: ChatPromptCache }
	/** The turn finished, so a later load does not take the answer for a half-written one. */
	| { t: "end"; messageId: string }
	/** Drops the message and everything after it; an earlier message was edited. */
	| { t: "truncate"; messageId: string };

interface ReplayResult {
	messages: ChatMessage[];
	/** Messages whose end event survived truncation. */
	ended: Set<string>;
	/** The log holds at least one end event, so it was written after turns started ending. */
	hasEnd: boolean;
}

/** An open subagent persisted alongside its parent chat. */
export interface StoredSubagent {
	/** Stable identifier. */
	id: string;
	/** Display label. */
	description: string;
	/** Provider model identifier. */
	modelId: string;
	/** Display name of the model. */
	modelName: string;
	/** Creation time. */
	createdAt: number;
	/** Last update time. */
	updatedAt: number;
	/** First line of the last task, at most 200 characters. */
	task: string;
	/** First 300 characters of the last report. */
	report?: string;
	/** Conversation so far. */
	history: ChatMessage[];
}

export class ChatSessionStore {
	private readonly _root: string;
	private readonly _sessions = new Map<string, ChatSessionMeta>();
	private readonly _lastIndexWrite = new Map<string, number>();
	private readonly _safeTails = new Set<string>();
	private _indexLoaded = false;
	private _queue: Promise<unknown> = Promise.resolve();

	constructor(root: string) {
		this._root = root;
	}

	/** Loads valid open subagents from the sidecar. */
	async loadSubagents(sessionId: string): Promise<StoredSubagent[]> {
		assertSessionId(sessionId);
		return this._enqueue(async () => {
			let value: unknown;
			try {
				value = JSON.parse(await fs.readFile(path.join(this._root, `${sessionId}.subagents.json`), "utf8"));
			} catch (error) {
				if (error instanceof SyntaxError || (error as NodeJS.ErrnoException).code === "ENOENT") {
					return [];
				}
				throw error;
			}
			if (!isRecord(value) || value.version !== 1 || !Array.isArray(value.subagents)) {
				return [];
			}
			return value.subagents.filter(isStoredSubagent);
		});
	}

	/** Saves open subagents atomically without embedding image bytes. */
	async saveSubagents(sessionId: string, subagents: readonly StoredSubagent[]): Promise<void> {
		assertSessionId(sessionId);
		await this._enqueue(async () => {
			const file = path.join(this._root, `${sessionId}.subagents.json`);
			if (subagents.length === 0) {
				await fs.rm(file, { force: true });
				return;
			}
			await fs.mkdir(this._root, { recursive: true });
			const cleaned = subagents.map(agent => ({ ...agent, history: agent.history.map(message => ({ ...message, parts: message.parts.map(part => part.kind === "toolResult" && part.images ? { ...part, images: part.images.map(({ data: _data, ...image }) => image) } : part) })) }));
			await fs.writeFile(`${file}.tmp`, JSON.stringify({ version: 1, subagents: cleaned }), "utf8");
			await renameWithRetry(`${file}.tmp`, file);
		});
	}

	async list(): Promise<ChatSessionMeta[]> {
		return this._enqueue(async () => {
			await this._ensureIndex();
			return [...this._sessions.values()]
				.map(meta => ({ ...meta }))
				.sort((a, b) => b.updatedAt - a.updatedAt || b.createdAt - a.createdAt || a.id.localeCompare(b.id));
		});
	}

	async get(sessionId: string): Promise<ChatSessionMeta | undefined> {
		assertSessionId(sessionId);
		return this._enqueue(async () => {
			await this._ensureIndex();
			const meta = this._sessions.get(sessionId);
			return meta ? { ...meta } : undefined;
		});
	}

	async create(modelId?: string): Promise<ChatSessionMeta> {
		return this._enqueue(async () => {
			await this._ensureIndex();
			const now = Date.now();
			const meta: ChatSessionMeta = { id: randomUUID(), title: DEFAULT_CHAT_TITLE, createdAt: now, updatedAt: now, messageCount: 0 };
			if (modelId !== undefined) {
				meta.modelId = modelId;
			}
			this._sessions.set(meta.id, meta);
			await this._writeIndex();
			this._lastIndexWrite.set(meta.id, now);
			return { ...meta };
		});
	}

	async load(sessionId: string): Promise<ChatMessage[]> {
		return (await this.loadSession(sessionId)).messages;
	}

	async loadSession(sessionId: string, options?: { maxRequests?: number }): Promise<{ messages: ChatMessage[]; interruptedMessageId?: string }> {
		assertSessionId(sessionId);
		return this._enqueue(async () => {
			const replay = await this._replaySession(this._logFile(sessionId));
			if (!replay) {
				return { messages: [] };
			}
			const interrupted = interruptedMessageId(replay);
			const limit = options?.maxRequests;
			if (limit !== undefined && Number.isSafeInteger(limit) && limit > 0) {
				const requests = replay.messages.flatMap((message, index) => message.role === "user" && !message.continuation ? [index] : []);
				if (requests.length > limit) {
					replay.messages = replay.messages.slice(requests[requests.length - limit]);
					await this._rewriteLog(sessionId, replay);
				}
			}
			return interrupted ? { messages: replay.messages, interruptedMessageId: interrupted } : { messages: replay.messages };
		});
	}

	/**
	 * Replaces the log with one event per kept message and its end marker. A failed write keeps the old log;
	 * the chat then holds the trimmed messages until the next load trims again.
	 */
	private async _rewriteLog(sessionId: string, replay: ReplayResult): Promise<void> {
		const events: LogEvent[] = [];
		if (replay.hasEnd && !replay.messages.some(message => replay.ended.has(message.id))) {
			// Keeps the log marked as one written with end markers, so an unfinished last answer still reads as interrupted.
			events.push({ t: "end", messageId: TRIMMED_END_MARKER });
		}
		for (const message of replay.messages) {
			events.push({ t: "message", message });
			if (replay.ended.has(message.id)) {
				events.push({ t: "end", messageId: message.id });
			}
		}
		const file = this._logFile(sessionId);
		const temporary = `${file}.tmp`;
		try {
			await fs.writeFile(temporary, events.map(event => `${JSON.stringify(event)}\n`).join(""), "utf8");
			await renameWithRetry(temporary, file);
			this._safeTails.add(sessionId);
			await this._ensureIndex();
			const meta = this._sessions.get(sessionId);
			if (meta) {
				meta.messageCount = replay.messages.length;
				await this._writeIndex();
			}
		} catch {
			await fs.rm(temporary, { force: true }).catch(() => undefined);
		}
	}

	async appendMessage(sessionId: string, message: ChatMessage): Promise<void> {
		assertSessionId(sessionId);
		const event: LogEvent = { t: "message", message };
		const line = `${JSON.stringify(event)}\n`;
		await this._enqueue(async () => {
			await this._ensureIndex();
			const meta = this._requireSession(sessionId);
			await this._appendLine(sessionId, line);
			const now = Date.now();
			meta.updatedAt = now;
			meta.messageCount += 1;
			if (!meta.customTitle && meta.title === DEFAULT_CHAT_TITLE && message.role === "user") {
				const title = titleFromParts(message.parts);
				if (title) {
					meta.title = title;
				}
			}
			await this._writeIndex();
			this._lastIndexWrite.set(sessionId, now);
		});
	}

	async appendPart(sessionId: string, messageId: string, part: ChatPart): Promise<void> {
		assertSessionId(sessionId);
		const event: LogEvent = { t: "part", messageId, part };
		const line = `${JSON.stringify(event)}\n`;
		await this._enqueue(async () => {
			await this._ensureIndex();
			const meta = this._requireSession(sessionId);
			await this._appendLine(sessionId, line);
			await this._touchIndex(sessionId, meta);
		});
	}

	async endMessage(sessionId: string, messageId: string): Promise<void> {
		assertSessionId(sessionId);
		const event: LogEvent = { t: "end", messageId };
		const line = `${JSON.stringify(event)}\n`;
		await this._enqueue(async () => {
			await this._ensureIndex();
			const meta = this._requireSession(sessionId);
			await this._appendLine(sessionId, line);
			await this._touchIndex(sessionId, meta);
		});
	}

	async setUsage(sessionId: string, messageId: string, usage: ChatUsage | undefined, totals?: ChatUsageTotals, promptCache?: ChatPromptCache): Promise<void> {
		assertSessionId(sessionId);
		const event: LogEvent = {
			t: "usage", messageId,
			...(usage ? { usage } : {}),
			...(totals ? { totals } : {}),
			...(promptCache ? { promptCache } : {}),
		};
		const line = `${JSON.stringify(event)}\n`;
		await this._enqueue(async () => {
			await this._ensureIndex();
			const meta = this._requireSession(sessionId);
			await this._appendLine(sessionId, line);
			await this._touchIndex(sessionId, meta);
		});
	}

	/** Removes the message and every later one; returns the number of messages left. */
	async truncateFrom(sessionId: string, messageId: string): Promise<number> {
		assertSessionId(sessionId);
		const event: LogEvent = { t: "truncate", messageId };
		const line = `${JSON.stringify(event)}\n`;
		return this._enqueue(async () => {
			await this._ensureIndex();
			const meta = this._requireSession(sessionId);
			await this._appendLine(sessionId, line);
			const messages = (await this._replay(this._logFile(sessionId))) ?? [];
			const now = Date.now();
			meta.updatedAt = now;
			meta.messageCount = messages.length;
			const firstUser = messages.find(message => message.role === "user");
			if (!meta.customTitle) {
				meta.title = (firstUser ? titleFromParts(firstUser.parts) : undefined) ?? DEFAULT_CHAT_TITLE;
			}
			await this._writeIndex();
			this._lastIndexWrite.set(sessionId, now);
			return messages.length;
		});
	}

	async updateMeta(sessionId: string, patch: { title?: string; modelId?: string; customTitle?: boolean; autoContinue?: ChatSessionMeta["autoContinue"] | null }): Promise<ChatSessionMeta | undefined> {
		assertSessionId(sessionId);
		return this._enqueue(async () => {
			await this._ensureIndex();
			const meta = this._sessions.get(sessionId);
			if (!meta) {
				return undefined;
			}
			let changed = false;
			if (patch.title !== undefined && patch.title !== meta.title) {
				meta.title = patch.title;
				changed = true;
			}
			if (patch.customTitle !== undefined && patch.customTitle !== meta.customTitle) {
				meta.customTitle = patch.customTitle;
				changed = true;
			}
			if (patch.modelId !== undefined && patch.modelId !== meta.modelId) {
				meta.modelId = patch.modelId;
				changed = true;
			}
			const updateTimestamp = changed;
			if (patch.autoContinue !== undefined) {
				if (patch.autoContinue === null) {
					delete meta.autoContinue;
				} else {
					meta.autoContinue = { ...patch.autoContinue };
				}
				changed = true;
			}
			if (changed) {
				if (updateTimestamp) {
					const now = Date.now();
					meta.updatedAt = now;
					this._lastIndexWrite.set(sessionId, now);
				}
				await this._writeIndex();
			}
			return { ...meta };
		});
	}

	async delete(sessionId: string): Promise<void> {
		assertSessionId(sessionId);
		await this._enqueue(async () => {
			await this._ensureIndex();
			const existed = this._sessions.delete(sessionId);
			this._lastIndexWrite.delete(sessionId);
			this._safeTails.delete(sessionId);
			await fs.rm(this._logFile(sessionId), { force: true });
			await fs.rm(path.join(this._root, `${sessionId}.subagents.json`), { force: true });
			if (existed) {
				await this._writeIndex();
			}
		});
	}

	/**
	 * Removes subagent sidecars whose chat log is gone and stale temporary files, after a grace
	 * period. Chat logs are never removed here: deleting a chat removes its log at once, so a log the
	 * index does not list is one that could not be read, and scripts/repair-chat-sessions.cjs may
	 * still recover it. A chat in the index is never touched, so its log stays whole.
	 */
	async pruneOrphans(now = Date.now(), orphanMaxAgeMs = 7 * 86400_000): Promise<{ removedFiles: number; removedBytes: number }> {
		return this._enqueue(async () => {
			await this._ensureIndex();
			const entries = await fs.readdir(this._root, { withFileTypes: true }).catch(() => []);
			const logNames = new Set(entries.filter(entry => entry.isFile() && entry.name.endsWith(LOG_SUFFIX)).map(entry => entry.name));
			let removedFiles = 0, removedBytes = 0;
			for (const entry of entries) {
				if (!entry.isFile()) {
					continue;
				}
				const name = entry.name;
				let sessionId: string | undefined;
				let maxAgeMs = orphanMaxAgeMs;
				if (name.endsWith(SUBAGENTS_SUFFIX)) {
					sessionId = name.slice(0, -SUBAGENTS_SUFFIX.length);
					if (logNames.has(`${sessionId}${LOG_SUFFIX}`)) {
						continue;
					}
				} else if (name.endsWith(".tmp")) {
					maxAgeMs = 86400_000;
				} else {
					continue;
				}
				if (sessionId !== undefined && this._sessions.has(sessionId)) {
					continue;
				}
				const file = path.join(this._root, name);
				const info = await fs.stat(file).catch(() => undefined);
				if (!info || now - info.mtimeMs <= maxAgeMs) {
					continue;
				}
				try {
					await fs.rm(file, { force: true });
				} catch {
					continue;
				}
				removedFiles++;
				removedBytes += info.size;
			}
			return { removedFiles, removedBytes };
		});
	}

	async flush(): Promise<void> {
		await this._queue;
	}

	private _enqueue<T>(task: () => Promise<T>): Promise<T> {
		const result = this._queue.then(task, task);
		this._queue = result.then(() => undefined, () => undefined);
		return result;
	}

	private async _ensureIndex(): Promise<void> {
		if (this._indexLoaded) {
			return;
		}
		await this._loadIndex();
		this._indexLoaded = true;
	}

	private async _loadIndex(): Promise<void> {
		this._sessions.clear();
		this._lastIndexWrite.clear();
		let raw: string;
		try {
			raw = await fs.readFile(path.join(this._root, INDEX_FILE), "utf8");
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") {
				await this._rebuild(false);
				return;
			}
			throw error;
		}
		const sessions = parseIndex(raw);
		if (!sessions) {
			await this._rebuild(true);
			return;
		}
		for (const meta of sessions) {
			this._sessions.set(meta.id, meta);
			this._lastIndexWrite.set(meta.id, meta.updatedAt);
		}
	}

	private async _rebuild(forceWrite: boolean): Promise<void> {
		this._sessions.clear();
		this._lastIndexWrite.clear();
		let names: string[];
		try {
			names = await fs.readdir(this._root);
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
				throw error;
			}
			names = [];
		}
		for (const name of names) {
			if (!name.endsWith(LOG_SUFFIX)) {
				continue;
			}
			const id = name.slice(0, -LOG_SUFFIX.length);
			if (!SESSION_ID.test(id)) {
				continue;
			}
			const file = this._logFile(id);
			let createdAt: number;
			let updatedAt: number;
			try {
				const stat = await fs.stat(file);
				updatedAt = stat.mtimeMs;
				createdAt = stat.birthtimeMs > 0 ? stat.birthtimeMs : stat.mtimeMs;
			} catch (error) {
				if ((error as NodeJS.ErrnoException).code === "ENOENT") {
					continue;
				}
				throw error;
			}
			const messages = await this._replay(file);
			if (!messages) {
				continue;
			}
			const firstUser = messages.find(message => message.role === "user");
			const meta: ChatSessionMeta = {
				id,
				title: (firstUser ? titleFromParts(firstUser.parts) : undefined) ?? DEFAULT_CHAT_TITLE,
				createdAt,
				updatedAt,
				messageCount: messages.length,
			};
			const modelId = messages.findLast(message => message.modelId !== undefined)?.modelId;
			if (modelId !== undefined) {
				meta.modelId = modelId;
			}
			this._sessions.set(id, meta);
			this._lastIndexWrite.set(id, updatedAt);
		}
		if (forceWrite || this._sessions.size > 0) {
			await this._writeIndex();
		}
	}

	private async _writeIndex(): Promise<void> {
		const target = path.join(this._root, INDEX_FILE);
		const temporary = path.join(this._root, INDEX_TEMP_FILE);
		await fs.mkdir(this._root, { recursive: true });
		await fs.writeFile(temporary, JSON.stringify({ version: INDEX_VERSION, sessions: [...this._sessions.values()] }), "utf8");
		await fs.rename(temporary, target);
	}

	private async _touchIndex(sessionId: string, meta: ChatSessionMeta): Promise<void> {
		const now = Date.now();
		if (now - (this._lastIndexWrite.get(sessionId) ?? 0) < INDEX_THROTTLE_MS) {
			return;
		}
		meta.updatedAt = now;
		await this._writeIndex();
		this._lastIndexWrite.set(sessionId, now);
	}

	private async _appendLine(sessionId: string, line: string): Promise<void> {
		await fs.mkdir(this._root, { recursive: true });
		const file = this._logFile(sessionId);
		if (!this._safeTails.has(sessionId)) {
			await ensureTrailingNewline(file);
			this._safeTails.add(sessionId);
		}
		await fs.appendFile(file, line, "utf8");
	}

	private async _replay(file: string): Promise<ChatMessage[] | undefined> {
		return (await this._replaySession(file))?.messages;
	}

	private async _replaySession(file: string): Promise<ReplayResult | undefined> {
		let raw: string;
		try {
			raw = await fs.readFile(file, "utf8");
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") {
				return undefined;
			}
			throw error;
		}
		return replayEvents(raw);
	}

	private _requireSession(sessionId: string): ChatSessionMeta {
		const meta = this._sessions.get(sessionId);
		if (!meta) {
			throw new Error(`Unknown chat session: ${sessionId}`);
		}
		return meta;
	}

	/** The JSON Lines log that keeps every message of a chat; compaction names it so the model can look details up. */
	logPath(sessionId: string): string {
		assertSessionId(sessionId);
		return this._logFile(sessionId);
	}

	private _logFile(sessionId: string): string {
		return path.join(this._root, `${sessionId}${LOG_SUFFIX}`);
	}
}

/** Antivirus or an editor can hold the log for a moment on Windows. */
async function renameWithRetry(from: string, to: string): Promise<void> {
	for (const delay of [50, 100, 200, undefined]) {
		try {
			await fs.rename(from, to);
			return;
		} catch (error) {
			const code = (error as NodeJS.ErrnoException).code ?? "";
			if (delay === undefined || !["EPERM", "EBUSY", "EACCES"].includes(code)) {
				throw error;
			}
			await new Promise(resolve => setTimeout(resolve, delay));
		}
	}
}

function assertSessionId(sessionId: string): void {
	if (!SESSION_ID.test(sessionId)) {
		throw new Error(`Invalid chat session id: ${sessionId}`);
	}
}

/** Cuts at 60 characters and marks truncation, so the list stays readable. */
export function titleFromParts(parts: ChatPart[]): string | undefined {
	for (const part of parts) {
		if (part.kind !== "text") {
			continue;
		}
		for (const line of part.text.split("\n")) {
			const text = line.trim();
			if (text) {
				return text.length > TITLE_MAX_CHARS ? `${text.slice(0, TITLE_MAX_CHARS)}…` : text;
			}
		}
	}
	return undefined;
}

function parseIndex(raw: string): ChatSessionMeta[] | undefined {
	let value: unknown;
	try {
		value = JSON.parse(raw);
	} catch {
		return undefined;
	}
	if (!isRecord(value) || value.version !== INDEX_VERSION || !Array.isArray(value.sessions)) {
		return undefined;
	}
	const sessions: ChatSessionMeta[] = [];
	for (const entry of value.sessions) {
		const meta = asSessionMeta(entry);
		if (!meta) {
			return undefined;
		}
		sessions.push(meta);
	}
	return sessions;
}

function asSessionMeta(value: unknown): ChatSessionMeta | undefined {
	if (!isRecord(value) || typeof value.id !== "string" || !SESSION_ID.test(value.id)
		|| typeof value.title !== "string" || typeof value.createdAt !== "number"
		|| typeof value.updatedAt !== "number" || typeof value.messageCount !== "number") {
		return undefined;
	}
	if (value.customTitle !== undefined && typeof value.customTitle !== "boolean") {
		return undefined;
	}
	if (value.modelId !== undefined && typeof value.modelId !== "string") {
		return undefined;
	}
	const meta: ChatSessionMeta = { id: value.id, title: value.title, createdAt: value.createdAt, updatedAt: value.updatedAt, messageCount: value.messageCount };
	if (typeof value.customTitle === "boolean") {
		meta.customTitle = value.customTitle;
	}
	if (typeof value.modelId === "string") {
		meta.modelId = value.modelId;
	}
	const auto = value.autoContinue;
	if (isRecord(auto) && typeof auto.messageId === "string" && auto.messageId.length > 0
		&& typeof auto.at === "number" && Number.isFinite(auto.at)
		&& typeof auto.enabled === "boolean" && typeof auto.attempts === "number"
		&& Number.isSafeInteger(auto.attempts) && auto.attempts >= 0) {
		meta.autoContinue = { messageId: auto.messageId, at: auto.at, enabled: auto.enabled, attempts: auto.attempts };
	}
	return meta;
}

function replayEvents(raw: string): ReplayResult {
	const messages: ChatMessage[] = [];
	const byId = new Map<string, ChatMessage>();
	const ended = new Set<string>();
	let hasEnd = false;
	for (const line of raw.split("\n")) {
		const event = asLogEvent(line);
		if (!event) {
			continue;
		}
		if (event.t === "message") {
			messages.push(event.message);
			byId.set(event.message.id, event.message);
		} else if (event.t === "part") {
			byId.get(event.messageId)?.parts.push(event.part);
		} else if (event.t === "end") {
			ended.add(event.messageId);
			hasEnd = true;
		} else if (event.t === "truncate") {
			const index = messages.findIndex(message => message.id === event.messageId);
			if (index >= 0) {
				for (const removed of messages.splice(index)) {
					byId.delete(removed.id);
					ended.delete(removed.id);
				}
			}
		} else {
			const message = byId.get(event.messageId);
			if (message) {
				if (event.usage) {
					message.usage = event.usage;
				}
				if (event.totals) {
					message.usageTotals = event.totals;
				}
				if (event.promptCache) {
					message.promptCache = event.promptCache;
				}
			}
		}
	}
	return { messages, ended, hasEnd };
}

/** Logs written before end events existed have none, so there an empty or dangling answer marks the interruption. */
function interruptedMessageId(replay: ReplayResult): string | undefined {
	const last = replay.messages.at(-1);
	if (!last || last.role !== "assistant" || replay.ended.has(last.id)) {
		return undefined;
	}
	const called = new Set(last.parts.flatMap(part => part.kind === "toolCall" ? [part.callId] : []));
	const answered = new Set(last.parts.flatMap(part => part.kind === "toolResult" ? [part.callId] : []));
	const dangling = [...called].some(callId => !answered.has(callId));
	return replay.hasEnd || last.parts.length === 0 || dangling ? last.id : undefined;
}

function asLogEvent(line: string): LogEvent | undefined {
	const text = line.trim();
	if (!text) {
		return undefined;
	}
	let value: unknown;
	try {
		value = JSON.parse(text);
	} catch {
		return undefined;
	}
	if (!isRecord(value)) {
		return undefined;
	}
	if (value.t === "message" && isChatMessage(value.message)) {
		return { t: "message", message: value.message };
	}
	if (value.t === "part" && typeof value.messageId === "string" && isChatPart(value.part)) {
		return { t: "part", messageId: value.messageId, part: value.part };
	}
	if (value.t === "usage" && typeof value.messageId === "string"
		&& (value.usage === undefined || isChatUsage(value.usage))
		&& (value.totals === undefined || isChatUsageTotals(value.totals))
		&& (value.promptCache === undefined || isChatPromptCache(value.promptCache))) {
		const totals = value.totals === undefined ? undefined : isChatUsageTotals(value.totals) ? value.totals : undefined;
		const promptCache = value.promptCache === undefined ? undefined : isChatPromptCache(value.promptCache) ? value.promptCache : undefined;
		return {
			t: "usage", messageId: value.messageId,
			...(value.usage ? { usage: value.usage } : {}),
			...(totals ? { totals } : {}),
			...(promptCache ? { promptCache } : {}),
		};
	}
	if (value.t === "end" && typeof value.messageId === "string") {
		return { t: "end", messageId: value.messageId };
	}
	if (value.t === "truncate" && typeof value.messageId === "string") {
		return { t: "truncate", messageId: value.messageId };
	}
	return undefined;
}

function isStoredSubagent(value: unknown): value is StoredSubagent {
	return isRecord(value)
		&& typeof value.id === "string" && typeof value.description === "string"
		&& typeof value.modelId === "string" && typeof value.modelName === "string"
		&& typeof value.createdAt === "number" && Number.isFinite(value.createdAt)
		&& typeof value.updatedAt === "number" && Number.isFinite(value.updatedAt)
		&& typeof value.task === "string" && value.task.length <= 200
		&& (value.report === undefined || (typeof value.report === "string" && value.report.length <= 300))
		&& Array.isArray(value.history) && value.history.every(isChatMessage);
}

function isChatMessage(value: unknown): value is ChatMessage {
	if (!isRecord(value)) {
		return false;
	}
	return typeof value.id === "string"
		&& (value.role === "user" || value.role === "assistant")
		&& typeof value.turn === "number"
		&& typeof value.createdAt === "number"
		&& Array.isArray(value.parts)
		&& value.parts.every(isChatPart)
		&& (value.modelId === undefined || typeof value.modelId === "string")
		&& (value.hostContext === undefined || typeof value.hostContext === "string")
		&& (value.memoryContext === undefined || typeof value.memoryContext === "string")
		&& (value.memoryRevisions === undefined || (Array.isArray(value.memoryRevisions) && value.memoryRevisions.every(isMemoryRevision)))
		&& (value.attachments === undefined || (Array.isArray(value.attachments) && value.attachments.every(isChatAttachment)))
		&& (value.attachmentContext === undefined || typeof value.attachmentContext === "string")
		&& (value.images === undefined || (Array.isArray(value.images) && value.images.every(isChatToolImage)))
		&& (value.usage === undefined || isChatUsage(value.usage))
		&& (value.usageTotals === undefined || isChatUsageTotals(value.usageTotals))
		&& (value.promptCache === undefined || isChatPromptCache(value.promptCache))
		&& (value.continuation === undefined || (isRecord(value.continuation)
			&& (value.continuation.error === undefined || typeof value.continuation.error === "string")));
}

function isChatAttachment(value: unknown): boolean {
	return isRecord(value)
		&& typeof value.id === "string"
		&& (value.kind === "file" || value.kind === "selection")
		&& typeof value.path === "string"
		&& typeof value.uri === "string"
		&& (value.startLine === undefined || typeof value.startLine === "number")
		&& (value.endLine === undefined || typeof value.endLine === "number")
		&& (value.languageId === undefined || typeof value.languageId === "string")
		&& (value.error === undefined || typeof value.error === "string");
}

function isMemoryRevision(value: unknown): boolean {
	return isRecord(value) && typeof value.id === "string" && typeof value.revision === "string";
}

function isChatPart(value: unknown): value is ChatPart {
	if (!isRecord(value)) {
		return false;
	}
	switch (value.kind) {
		case "text":
		case "thinking":
			return typeof value.text === "string";
		case "toolCall":
			return typeof value.callId === "string" && typeof value.name === "string";
		case "toolResult":
			return typeof value.callId === "string"
				&& typeof value.text === "string"
				&& (value.fullLength === undefined || typeof value.fullLength === "number")
				&& (value.images === undefined || (Array.isArray(value.images) && value.images.every(isChatToolImage)));
		case "notice":
			return (value.level === "info" || value.level === "warning" || value.level === "error")
				&& typeof value.text === "string"
				&& (value.limit === undefined || isChatLimitInfo(value.limit))
				&& (value.retryable === undefined || typeof value.retryable === "boolean");
		case "compaction":
			return typeof value.summary === "string"
				&& typeof value.keepFromMessageId === "string"
				&& typeof value.summarizedMessages === "number"
				&& typeof value.tokensBefore === "number"
				&& typeof value.tokensAfter === "number"
				&& (value.method === "deepseek" || value.method === "model" || value.method === "extractive" || value.method === "none")
				&& (value.trimmedTurn === undefined || (isRecord(value.trimmedTurn) && typeof value.trimmedTurn.messageId === "string"
					&& Number.isSafeInteger(value.trimmedTurn.fromPart) && Number.isSafeInteger(value.trimmedTurn.rounds)))
				&& (value.abbreviatedUntil === undefined || typeof value.abbreviatedUntil === "string")
				&& (value.summaryModel === undefined || typeof value.summaryModel === "string")
				&& (value.fallbackReason === undefined || typeof value.fallbackReason === "string")
				&& (value.transcriptPath === undefined || typeof value.transcriptPath === "string")
				&& (value.requests === undefined || (Array.isArray(value.requests) && value.requests.every(request => typeof request === "string")))
				&& (value.staleResults === undefined || (Array.isArray(value.staleResults) && value.staleResults.every(callId => typeof callId === "string")))
				&& (value.staleMemoryIndex === undefined || (Array.isArray(value.staleMemoryIndex) && value.staleMemoryIndex.every(id => typeof id === "string")))
				&& (value.cleaning === undefined || (isRecord(value.cleaning) && typeof value.cleaning.staleResults === "number"
					&& typeof value.cleaning.summary === "boolean" && typeof value.cleaning.summarizedMessages === "number"
					&& typeof value.cleaning.budgetTokens === "number"));
		case "subagent":
			return typeof value.callId === "string"
				&& typeof value.description === "string"
				&& typeof value.modelId === "string"
				&& typeof value.modelName === "string"
				&& (value.status === "running" || value.status === "done" || value.status === "failed" || value.status === "stopped")
				&& typeof value.startedAt === "number"
				&& Array.isArray(value.steps)
				&& value.steps.every(isSubagentStep)
				&& (value.usage === undefined || isChatUsage(value.usage));
		default:
			return false;
	}
}

function isChatToolImage(value: unknown): boolean {
	return isRecord(value)
		&& typeof value.mimeType === "string"
		&& typeof value.byteLength === "number"
		&& (value.data === undefined || typeof value.data === "string")
		&& (value.name === undefined || typeof value.name === "string");
}

function isSubagentStep(value: unknown): boolean {
	if (!isRecord(value)) {
		return false;
	}
	switch (value.kind) {
		case "tool": return typeof value.name === "string"
			&& typeof value.summary === "string"
			&& (value.input === undefined || typeof value.input === "string")
			&& (value.output === undefined || typeof value.output === "string")
			&& (value.outputChars === undefined || typeof value.outputChars === "number");
		case "text": return typeof value.text === "string";
		case "notice": return typeof value.level === "string" && typeof value.text === "string";
		default: return false;
	}
}

function isChatLimitInfo(value: unknown): boolean {
	return isRecord(value)
		&& (value.kind === "limit" || value.kind === "balance")
		&& typeof value.provider === "string"
		&& (value.window === undefined || typeof value.window === "string")
		&& (value.resetAt === undefined || typeof value.resetAt === "number");
}

function isChatUsage(value: unknown): value is ChatUsage {
	if (!isRecord(value)) {
		return false;
	}
	return ["promptTokens", "completionTokens", "totalTokens", "cachedTokens"]
		.every(key => value[key] === undefined || typeof value[key] === "number");
}

function isChatUsageTotals(value: unknown): value is ChatUsageTotals {
	if (!isRecord(value)) {
		return false;
	}
	const optional = (entry: unknown): boolean => entry === undefined || typeof entry === "number" && Number.isFinite(entry) && entry >= 0;
	return ["requests", "promptTokens", "cachedTokens", "completionTokens", "cacheReported"]
		.every(key => {
			const entry = value[key];
			return typeof entry === "number" && Number.isFinite(entry) && entry >= 0;
		})
		&& optional(value.cachedPromptTokens);
}

function isChatPromptCache(value: unknown): value is ChatPromptCache {
	if (!isRecord(value)) {
		return false;
	}
	const token = (entry: unknown): boolean => typeof entry === "number" && Number.isSafeInteger(entry) && entry >= 0;
	return token(value.promptTokens)
		&& token(value.completionTokens)
		&& token(value.requests) && (value.requests as number) >= 1
		&& (value.cachedTokens === undefined || token(value.cachedTokens))
		&& (value.cacheWriteTokens === undefined || token(value.cacheWriteTokens));
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

/** A crash can leave a partial last line; a newline turns it into a skippable line. */
async function ensureTrailingNewline(file: string): Promise<void> {
	const handle = await fs.open(file, "r").catch((error: NodeJS.ErrnoException) => {
		if (error.code === "ENOENT") {
			return undefined;
		}
		throw error;
	});
	if (!handle) {
		return;
	}
	try {
		const { size } = await handle.stat();
		if (size === 0) {
			return;
		}
		const tail = Buffer.alloc(1);
		await handle.read(tail, 0, 1, size - 1);
		if (tail[0] !== 0x0a) {
			await fs.appendFile(file, "\n", "utf8");
		}
	} finally {
		await handle.close();
	}
}
