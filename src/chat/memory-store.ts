import type * as vscode from "vscode";
import { filterEntriesVisibleInWorkspace } from "../memory/scope";
import type { SharedMemoryService } from "../memory/shared-memory-service";
import type { SharedMemoryEntry, SharedMemoryKind } from "../memory/types";
import { ChatMemoryKinds, type ChatMemoryEntry, type ChatMemorySaveInput } from "./shared/protocol";

/** The shared memory visible in the chat panel, scoped to the current project. */
export interface ChatMemoryStore {
	/** The llamacpp.memoryEnabled setting; the panel works even when auto-inject is off. */
	enabled(): boolean;
	projectLabel(): string | undefined;
	list(): ChatMemoryEntry[];
	save(input: ChatMemorySaveInput): Promise<ChatMemoryEntry>;
	remove(id: string): Promise<boolean>;
	onDidChange?: vscode.Event<void>;
}

export interface ChatMemoryStoreOptions {
	enabled(): boolean;
	workspaceId(): string | undefined;
	projectLabel(): string | undefined;
}

function isKind(value: string): value is SharedMemoryKind {
	return (ChatMemoryKinds as readonly string[]).includes(value);
}

function isVisible(entry: SharedMemoryEntry, workspaceId: string | undefined): boolean {
	return entry.scope === "global"
		|| (entry.scope === "workspace" && workspaceId !== undefined && entry.scopeId === workspaceId);
}

function toChatEntry(entry: SharedMemoryEntry, now: number): ChatMemoryEntry {
	const expiresAt = entry.expiresAt === undefined ? undefined : Date.parse(entry.expiresAt);
	return {
		id: entry.id,
		title: entry.title,
		content: entry.content,
		kind: entry.kind,
		scope: entry.scope === "workspace" ? "workspace" : "global",
		pinned: entry.pinned,
		tags: [...entry.tags],
		updatedAt: Date.parse(entry.updatedAt),
		...(expiresAt === undefined ? {} : { expiresAt }),
		expired: expiresAt !== undefined && expiresAt <= now,
	};
}

export function createChatMemoryStore(memory: SharedMemoryService, options: ChatMemoryStoreOptions): ChatMemoryStore {
	return {
		enabled: () => options.enabled(),
		projectLabel: () => options.workspaceId() === undefined ? undefined : options.projectLabel(),
		onDidChange: listener => memory.onDidChange(() => listener()),
		list() {
			const now = Date.now();
			return filterEntriesVisibleInWorkspace(memory.list(), options.workspaceId())
				.map(entry => toChatEntry(entry, now))
				.sort((left, right) => right.updatedAt - left.updatedAt);
		},
		async save(input) {
			const title = input.title.trim();
			const content = input.content.trim();
			if (!title || !content) {
				throw new Error("Memory title and content must not be empty.");
			}
			if (!isKind(input.kind)) {
				throw new Error(`Unknown memory kind "${input.kind}".`);
			}
			const id = input.id?.trim() || undefined;
			const existing = id ? memory.get(id) : undefined;
			if (existing?.scope === "model") {
				throw new Error("This entry is not visible in this project.");
			}
			const workspaceId = options.workspaceId();
			if (id && (!existing || !isVisible(existing, workspaceId))) {
				throw new Error("This entry is not visible in this project.");
			}
			if (input.scope === "workspace" && !workspaceId) {
				throw new Error("Project memory needs an open workspace folder.");
			}
			const saved = await memory.upsert({
				...(id ? { id } : {}),
				title,
				content,
				kind: input.kind,
				scope: input.scope,
				...(input.scope === "workspace" && workspaceId ? { scopeId: workspaceId } : {}),
				pinned: input.pinned,
			});
			return toChatEntry(saved, Date.now());
		},
		async remove(id) {
			const normalized = id.trim();
			const existing = memory.get(normalized);
			if (!existing || !isVisible(existing, options.workspaceId())) {
				return false;
			}
			return memory.remove(normalized);
		},
	};
}
