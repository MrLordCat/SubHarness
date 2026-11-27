import type { LocalAgentDocument, LocalAgentRunDocument } from "@cursor/sdk";
import { promises as fs } from "node:fs";
import * as path from "node:path";
import { openIndexedLocalAgentStore } from "./indexed-store";
import type { CursorLocalStore } from "./native-store";
import { cursorSdkRuntimeAvailable } from "./sdk-transport";

/** Conversations whose last run/update is older than this are removed, index and blobs together. */
export const CURSOR_STORE_RETENTION_MS = 30 * 24 * 60 * 60_000;
/** Archive files of chats not written for this long are removed; they are reference material only. */
export const CURSOR_HISTORY_RETENTION_MS = 30 * 24 * 60 * 60_000;

const COMPLETED_SESSIONS_FILE = "completed-sessions.json";
const HISTORY_DIR = "history";
const PAGE_SIZE = 1_000;

/** The parts of the native store retention reads and deletes through; IndexedLocalAgentStore satisfies it. */
export interface CursorRetentionStore {
	agents: Pick<CursorLocalStore["agents"], "list" | "delete">;
	runs: Pick<CursorLocalStore["runs"], "list" | "delete">;
	checkpoints: Pick<CursorLocalStore["checkpoints"], "list" | "delete">;
}

export interface CursorStoreRetentionOptions {
	root: string;
	store: CursorRetentionStore;
	now?: number;
	maxAgeMs?: number;
	historyMaxAgeMs?: number;
	/** Agents a saved session still points at; they are kept even when old. */
	protectedAgentIds?: Iterable<string>;
	log?: (event: string, data: Record<string, unknown>) => void;
}

export interface CursorStoreRetentionResult {
	store: "cursor-sdk";
	removedFiles: number;
	removedBytes: number;
	durationMs: number;
	removedConversations: number;
	removedHistoryFiles: number;
	errors: number;
}

export interface CursorStoreRetentionScheduleOptions {
	root: string;
	log?: (event: string, data: Record<string, unknown>) => void;
	delayMs?: number;
	now?: () => number;
	/** Tests can pass a fake or already-open store. */
	loadStore?: () => Promise<CursorRetentionStore | undefined>;
}

async function listAgents(store: CursorRetentionStore): Promise<LocalAgentDocument[]> {
	const agents: LocalAgentDocument[] = [];
	const seen = new Set<string>();
	let cursor: string | undefined;
	do {
		const page = await store.agents.list({ filter: { cursor, limit: PAGE_SIZE } });
		agents.push(...page.items);
		cursor = page.nextCursor && !seen.has(page.nextCursor) ? page.nextCursor : undefined;
		if (cursor) {
			seen.add(cursor);
		}
	} while (cursor);
	return agents;
}

async function listRuns(store: CursorRetentionStore): Promise<LocalAgentRunDocument[]> {
	const runs: LocalAgentRunDocument[] = [];
	const seen = new Set<string>();
	let cursor: string | undefined;
	do {
		const page = await store.runs.list({ filter: { cursor, limit: PAGE_SIZE } });
		runs.push(...page.items);
		cursor = page.nextCursor && !seen.has(page.nextCursor) ? page.nextCursor : undefined;
		if (cursor) {
			seen.add(cursor);
		}
	} while (cursor);
	return runs;
}

function lastActivity(agent: LocalAgentDocument, runs: readonly LocalAgentRunDocument[]): number {
	let last = typeof agent.updatedAt === "number" && Number.isFinite(agent.updatedAt) ? agent.updatedAt : 0;
	if (typeof agent.createdAt === "number" && Number.isFinite(agent.createdAt)) {
		last = Math.max(last, agent.createdAt);
	}
	for (const run of runs) {
		for (const value of [run.updatedAt, run.endedAt, run.startedAt, run.createdAt]) {
			if (typeof value === "number" && Number.isFinite(value)) {
				last = Math.max(last, value);
			}
		}
	}
	return last;
}

/** Session bindings that still point at a recently used native agent, so a saved chat is never deleted. */
async function protectedAgents(root: string, now: number, maxAgeMs: number): Promise<Set<string>> {
	const ids = new Set<string>();
	try {
		const value = JSON.parse(await fs.readFile(path.join(root, COMPLETED_SESSIONS_FILE), "utf8")) as { sessions?: unknown };
		for (const session of Array.isArray(value.sessions) ? value.sessions : []) {
			const agentId = (session as { agentId?: unknown; updatedAt?: unknown } | null)?.agentId;
			const updatedAt = (session as { updatedAt?: unknown } | null)?.updatedAt;
			if (typeof agentId === "string" && agentId.length > 0
				&& (typeof updatedAt !== "number" || now - updatedAt <= maxAgeMs)) {
				ids.add(agentId);
			}
		}
	} catch {
		// No saved bindings yet, or the file is being replaced.
	}
	return ids;
}

async function usage(directory: string): Promise<{ files: number; bytes: number }> {
	let files = 0, bytes = 0;
	const entries = await fs.readdir(directory, { withFileTypes: true }).catch(() => []);
	for (const entry of entries) {
		const full = path.join(directory, entry.name);
		if (entry.isDirectory()) {
			const nested = await usage(full);
			files += nested.files;
			bytes += nested.bytes;
		} else if (entry.isFile()) {
			const info = await fs.stat(full).catch(() => undefined);
			if (info) {
				files++;
				bytes += info.size;
			}
		}
	}
	return { files, bytes };
}

async function removeOldHistory(root: string, now: number, maxAgeMs: number): Promise<number> {
	let removed = 0;
	const historyDir = path.join(root, HISTORY_DIR);
	const scopes = await fs.readdir(historyDir, { withFileTypes: true }).catch(() => []);
	for (const scope of scopes) {
		if (!scope.isDirectory()) {
			continue;
		}
		const directory = path.join(historyDir, scope.name);
		const files = await fs.readdir(directory, { withFileTypes: true }).catch(() => []);
		let remaining = 0;
		for (const file of files) {
			if (!file.isFile()) {
				continue;
			}
			const full = path.join(directory, file.name);
			const info = await fs.stat(full).catch(() => undefined);
			if (!info) {
				continue;
			}
			if (now - info.mtimeMs > maxAgeMs) {
				try {
					await fs.unlink(full);
					removed++;
					continue;
				} catch {
					// Another window or the user removed it first.
				}
			}
			remaining++;
		}
		if (remaining === 0) {
			// A new archive writes its files right after creating the directory; only an
			// old empty directory is safe to remove.
			const info = await fs.stat(directory).catch(() => undefined);
			if (info && now - info.mtimeMs > maxAgeMs) {
				await fs.rmdir(directory).catch(() => undefined);
			}
		}
	}
	return removed;
}

/**
 * Removes native agents (with their runs, events and checkpoint blobs) whose last activity is
 * older than the retention window, and archive files of chats not written since then. The store's
 * own delete methods rewrite its NDJSON indexes, so the files stay consistent.
 */
export async function pruneCursorStore(options: CursorStoreRetentionOptions): Promise<CursorStoreRetentionResult> {
	const started = Date.now();
	const now = options.now ?? Date.now();
	const maxAgeMs = Math.max(0, options.maxAgeMs ?? CURSOR_STORE_RETENTION_MS);
	const historyMaxAgeMs = Math.max(0, options.historyMaxAgeMs ?? CURSOR_HISTORY_RETENTION_MS);
	const result: CursorStoreRetentionResult = {
		store: "cursor-sdk", removedFiles: 0, removedBytes: 0, durationMs: 0,
		removedConversations: 0, removedHistoryFiles: 0, errors: 0,
	};
	try {
		const before = await usage(options.root);
		const keep = await protectedAgents(options.root, now, maxAgeMs);
		for (const agentId of options.protectedAgentIds ?? []) {
			keep.add(agentId);
		}
		const agents = await listAgents(options.store);
		const runs = await listRuns(options.store);
		const runsByAgent = new Map<string, LocalAgentRunDocument[]>();
		for (const run of runs) {
			const list = runsByAgent.get(run.agentId) ?? [];
			list.push(run);
			runsByAgent.set(run.agentId, list);
		}
		const stale = agents.filter(agent => !keep.has(agent.agentId)
			&& agent.status !== "running" && !agent.activeRunId
			&& now - lastActivity(agent, runsByAgent.get(agent.agentId) ?? []) > maxAgeMs);
		if (stale.length > 0) {
			const ids = stale.map(agent => agent.agentId);
			try {
				const withRuns = ids.filter(id => (runsByAgent.get(id)?.length ?? 0) > 0);
				if (withRuns.length > 0) {
					await options.store.runs.delete({ filter: { agentIds: withRuns } });
				}
				const withCheckpoints: string[] = [];
				for (const id of ids) {
					const page = await options.store.checkpoints.list({ filter: { agentIds: [id], limit: 1 } });
					if (page.items.length > 0) {
						withCheckpoints.push(id);
					}
				}
				if (withCheckpoints.length > 0) {
					await options.store.checkpoints.delete({ filter: { agentIds: withCheckpoints } });
				}
				await options.store.agents.delete({ filter: { agentIds: ids } });
				result.removedConversations = ids.length;
			} catch {
				// A partial batch failure must not stop the remaining conversations.
				result.errors++;
				for (const agent of stale) {
					try {
						if ((runsByAgent.get(agent.agentId)?.length ?? 0) > 0) {
							await options.store.runs.delete({ filter: { agentIds: [agent.agentId] } });
						}
						const page = await options.store.checkpoints.list({ filter: { agentIds: [agent.agentId], limit: 1 } });
						if (page.items.length > 0) {
							await options.store.checkpoints.delete({ filter: { agentIds: [agent.agentId] } });
						}
						await options.store.agents.delete({ filter: { agentIds: [agent.agentId] } });
						result.removedConversations++;
					} catch {
						result.errors++;
					}
				}
			}
		}
		result.removedHistoryFiles = await removeOldHistory(options.root, now, historyMaxAgeMs);
		const after = await usage(options.root);
		result.removedFiles = Math.max(0, before.files - after.files);
		result.removedBytes = Math.max(0, before.bytes - after.bytes);
	} finally {
		result.durationMs = Date.now() - started;
	}
	options.log?.("storage.retention.done", { ...result });
	return result;
}

/** One cleanup at a time across windows that share the workspace storage. */
async function acquireRetentionLock(root: string): Promise<{ release(): Promise<void> } | undefined> {
	const file = path.join(root, "retention.lock");
	for (let attempt = 0; attempt < 2; attempt++) {
		try {
			const handle = await fs.open(file, "wx");
			try {
				await handle.writeFile(`${process.pid} ${Date.now()}\n`, "utf8");
			} finally {
				await handle.close();
			}
			return {
				release: async () => {
					await fs.unlink(file).catch(() => undefined);
				},
			};
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "EEXIST") {
				return undefined;
			}
			const info = await fs.stat(file).catch(() => undefined);
			if (!info || Date.now() - info.mtimeMs <= 10 * 60_000) {
				return undefined;
			}
			await fs.unlink(file).catch(() => undefined);
		}
	}
	return undefined;
}

/** Whether any file under root is older than maxAgeMs; a cheap check that keeps the SDK unloaded otherwise. */
async function hasFileOlderThan(directory: string, cutoff: number): Promise<boolean> {
	const entries = await fs.readdir(directory, { withFileTypes: true }).catch(() => []);
	for (const entry of entries) {
		const full = path.join(directory, entry.name);
		if (entry.isDirectory()) {
			if (await hasFileOlderThan(full, cutoff)) {
				return true;
			}
		} else if (entry.isFile() && entry.name !== "retention.lock") {
			const info = await fs.stat(full).catch(() => undefined);
			if (info && info.mtimeMs < cutoff) {
				return true;
			}
		}
	}
	return false;
}

/**
 * Starts the cleanup a few seconds after activation; never on the activation path itself. The Cursor SDK
 * (needed to open the store's index) is loaded only when some file is old enough to be removed.
 */
export function scheduleCursorStoreRetention(options: CursorStoreRetentionScheduleOptions): { dispose(): void } {
	let disposed = false;
	const timer = setTimeout(() => {
		void (async () => {
			if (disposed) {
				return;
			}
			try {
				const storeRoot = await fs.stat(options.root).catch(() => undefined);
				if (!storeRoot?.isDirectory()) {
					return;
				}
				const now = options.now?.() ?? Date.now();
				const cutoff = now - Math.min(CURSOR_STORE_RETENTION_MS, CURSOR_HISTORY_RETENTION_MS);
				if (!options.loadStore && !await hasFileOlderThan(options.root, cutoff)) {
					return;
				}
				const lock = await acquireRetentionLock(options.root);
				if (!lock) {
					return;
				}
				try {
					const store = options.loadStore ? await options.loadStore() : await loadIndexedStore(options.root);
					if (!store) {
						return;
					}
					await pruneCursorStore({
						root: options.root,
						store,
						now,
						log: options.log,
					});
				} finally {
					await lock.release();
				}
			} catch (error) {
				options.log?.("storage.retention.failed", {
					store: "cursor-sdk",
					message: error instanceof Error ? error.message : String(error),
				});
			}
		})();
	}, Math.max(0, options.delayMs ?? 9_000));
	timer.unref?.();
	return {
		dispose(): void {
			disposed = true;
			clearTimeout(timer);
		},
	};
}

async function loadIndexedStore(root: string): Promise<CursorRetentionStore | undefined> {
	if (!cursorSdkRuntimeAvailable()) {
		return undefined;
	}
	const sdk = await import("@cursor/sdk");
	return openIndexedLocalAgentStore(root, sdk);
}
