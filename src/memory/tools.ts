import { CHAT_TOOL_GROUPS, type ChatTool } from "../chat/tools/types";
import { getCurrentWorkspaceScopeId } from "./scope";
import type { SharedMemoryService } from "./shared-memory-service";
import type { SharedMemoryKind } from "./types";

type AgentMemoryScope = "global" | "workspace";

interface StoreMemoryInput {
	id?: string;
	title: string;
	content: string;
	tags?: string[];
	pinned?: boolean;
	scope: AgentMemoryScope;
	kind?: SharedMemoryKind;
	sourceUrl?: string;
	verifiedAt?: string;
	expiresAt?: string;
}

interface SearchMemoryInput {
	query?: string;
	limit?: number;
	includeExpired?: boolean;
	scope?: AgentMemoryScope;
	/** Return every character of matching entries (default clips long content). */
	full?: boolean;
}

interface DeleteMemoryInput {
	id: string;
	scope: AgentMemoryScope;
}

/** Names of the chat's memory tools; saved on/off choices in the tool picker are keyed by them. */
export const MEMORY_TOOL_NAMES = {
	store: "llamacpp_store_memory",
	search: "llamacpp_search_memory",
	delete: "llamacpp_delete_memory",
} as const;

const SCOPE_ENUM = ["global", "workspace"];

const STORE_SCHEMA = {
	type: "object",
	properties: {
		id: { type: "string", description: "Existing memory entry id to update. Omit to create a new entry." },
		title: { type: "string", description: "Short descriptive title for the durable fact or decision." },
		content: { type: "string", description: "Self-contained memory content that remains understandable in a future chat." },
		tags: { type: "array", items: { type: "string" }, description: "Optional lowercase search tags." },
		pinned: { type: "boolean", description: "Prioritize this entry after it passes scope, expiry, and relevance checks." },
		scope: {
			type: "string",
			enum: SCOPE_ENUM,
			description: "Required destination. Use global only when useful in every project; use workspace for the current project. The workspace identity is filled securely by the extension.",
		},
		kind: {
			type: "string",
			enum: ["preference", "decision", "environment", "workflow", "externalFact", "other"],
			description: "Semantic type. externalFact requires sourceUrl and verifiedAt.",
		},
		sourceUrl: { type: "string", description: "Primary source URL for an externally verified fact." },
		verifiedAt: { type: "string", description: "ISO date/time when the external fact was verified." },
		expiresAt: { type: "string", description: "Optional ISO date/time after which the entry is excluded from automatic retrieval." },
	},
	required: ["title", "content", "scope"],
	additionalProperties: false,
};

const SEARCH_SCHEMA = {
	type: "object",
	properties: {
		query: { type: "string", description: "Keywords describing the memory to retrieve." },
		limit: { type: "number", minimum: 1, maximum: 50, description: "Maximum number of entries to return." },
		includeExpired: { type: "boolean", description: "Include expired entries for maintenance and review." },
		scope: { type: "string", enum: SCOPE_ENUM, description: "Optionally restrict results to global memory or memory owned by the current project." },
		full: { type: "boolean", description: "Return the complete text of every entry instead of clipping long ones (default false)." },
	},
	additionalProperties: false,
};

const DELETE_SCHEMA = {
	type: "object",
	properties: {
		id: { type: "string", description: "Exact id of the memory entry to delete." },
		scope: { type: "string", enum: SCOPE_ENUM, description: "Required scope of the entry. Workspace deletion is restricted to the current project." },
	},
	required: ["id", "scope"],
	additionalProperties: false,
};

function resolveScope(scope: AgentMemoryScope): { scope: AgentMemoryScope; scopeId?: string } {
	if (scope === "global") {
		return { scope };
	}
	if (scope !== "workspace") {
		throw new Error('Memory scope must be either "global" or "workspace".');
	}
	const scopeId = getCurrentWorkspaceScopeId();
	if (!scopeId) {
		throw new Error("Project memory requires an open VS Code workspace.");
	}
	return { scope, scopeId };
}

function inputObject<T>(input: unknown): T {
	return (typeof input === "object" && input !== null ? input : {}) as T;
}

async function storeMemory(memory: SharedMemoryService, input: StoreMemoryInput): Promise<string> {
	const destination = resolveScope(input.scope);
	const existing = input.id ? memory.get(input.id) : undefined;
	if (existing?.scope === "workspace" && existing.scopeId !== getCurrentWorkspaceScopeId()) {
		throw new Error("Cannot update memory owned by another project.");
	}
	if (existing?.scope === "model") {
		throw new Error("Legacy model-scoped memory cannot be changed through the two-scope memory tool.");
	}
	const entry = await memory.upsert({ ...input, ...destination });
	const label = entry.scope === "global" ? "global" : "project";
	const estimatedTokens = Math.ceil(entry.content.length / 4);
	const lines = [
		`Saved ${label}/${entry.kind} memory ${entry.id}: ${entry.title}`,
		`Size: ${entry.content.length} chars (~${estimatedTokens} tokens).`,
	];
	for (const candidate of memory.similarEntries(entry, 2)) {
		lines.push(
			`Warning: close to existing ${candidate.id} "${candidate.title}" (similarity ${candidate.similarity.toFixed(2)}). ` +
			`Update that id if this is the same fact; keep each entry one thought.`
		);
	}
	return lines.join("\n");
}

function searchMemory(memory: SharedMemoryService, input: SearchMemoryInput): string {
	const selectedScope = input.scope ? resolveScope(input.scope) : undefined;
	const entries = memory.search(input.query ?? "", input.limit ?? 12, {
		workspaceId: selectedScope?.scopeId ?? getCurrentWorkspaceScopeId(),
		includeExpired: input.includeExpired === true,
		scope: selectedScope?.scope,
	});
	if (entries.length === 0) {
		return "No matching shared memory entries.";
	}
	return entries.map(entry => {
		const metadata = [
			`${entry.scope}/${entry.kind}`,
			entry.sourceUrl ? `source=${entry.sourceUrl}` : undefined,
			entry.verifiedAt ? `verified=${entry.verifiedAt}` : undefined,
			entry.expiresAt ? `expires=${entry.expiresAt}` : undefined,
			`chars=${entry.content.length}`,
		].filter(Boolean).join("; ");
		const body = input.full === true ? entry.content : clipMemoryContent(entry.content);
		return `- [${entry.id}] ${entry.title} (${metadata})\n${body}`;
	}).join("\n\n") + formatSearchMetrics(entries);
}

async function deleteMemory(memory: SharedMemoryService, input: DeleteMemoryInput): Promise<string> {
	const selected = resolveScope(input.scope);
	const removed = await memory.remove(input.id, {
		scope: selected.scope,
		...(selected.scopeId ? { workspaceId: selected.scopeId } : {}),
	});
	const label = selected.scope === "global" ? "global" : "project";
	return removed
		? `Deleted ${label} memory ${input.id}.`
		: `No ${label} memory ${input.id} is visible in the selected scope.`;
}

/** Long entries dominate the model context; show head+tail and the omitted size. */
export function clipMemoryContent(content: string, headChars = 600, tailChars = 300): string {
	if (content.length <= headChars + tailChars) {
		return content;
	}
	const omitted = content.length - headChars - tailChars;
	return `${content.slice(0, headChars)}\n…[${omitted} chars omitted — pass full: true if the exact text is required]…\n${content.slice(-tailChars)}`;
}

function formatSearchMetrics(entries: readonly { content: string }[]): string {
	if (entries.length === 0) {
		return "";
	}
	const totalChars = entries.reduce((sum, entry) => sum + entry.content.length, 0);
	return `\n\n-- ${entries.length} entries, ${totalChars} chars (~${Math.ceil(totalChars / 4)} tokens)`;
}

/**
 * The chat's shared-memory tools. They touch no workspace files, so the change
 * tracker skips them, and they run without any VS Code confirmation dialog.
 */
export function createMemoryTools(memory: SharedMemoryService): ChatTool[] {
	return [
		{
			name: MEMORY_TOOL_NAMES.store,
			description: "Create or update a durable, user-approved memory entry. Choose scope explicitly: workspace for this project's paths, commands, architecture, decisions and environment; global only for what helps in every project, such as stable user preferences and reusable workflows. Do not store secrets, transient chat details or guesses.",
			inputSchema: STORE_SCHEMA,
			group: CHAT_TOOL_GROUPS.bridge,
			readOnly: true,
			invoke: async input => storeMemory(memory, inputObject<StoreMemoryInput>(input)),
		},
		{
			name: MEMORY_TOOL_NAMES.search,
			description: "Search durable memory visible to the current project. Without scope, results include global memory plus memory belonging to the current project. Set global or workspace to restrict the search. An empty query lists recent and pinned entries.",
			inputSchema: SEARCH_SCHEMA,
			group: CHAT_TOOL_GROUPS.bridge,
			readOnly: true,
			invoke: async input => searchMemory(memory, inputObject<SearchMemoryInput>(input)),
		},
		{
			name: MEMORY_TOOL_NAMES.delete,
			description: "Delete one durable memory entry by exact id and explicit scope when it is obsolete or incorrect. Choose global only for a global entry, or workspace for an entry belonging to the current project. Never use this tool speculatively.",
			inputSchema: DELETE_SCHEMA,
			group: CHAT_TOOL_GROUPS.bridge,
			readOnly: true,
			invoke: async input => deleteMemory(memory, inputObject<DeleteMemoryInput>(input)),
		},
	];
}
