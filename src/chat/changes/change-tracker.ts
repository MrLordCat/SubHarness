import { createHash } from "node:crypto";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { ChatChangedFile, ChatChangeSet } from "../shared/protocol";
import { ShadowGitRepo, type ShadowGitSnapshot } from "./shadow-git";

export interface TrackedFolder {
	name: string;
	fsPath: string;
}

export interface ChatChangeTrackerOptions {
	/** Holds the shadow repositories and one change file per chat session. */
	storageDir: string;
	folders: () => readonly TrackedFolder[];
	findGit: () => Promise<string | undefined>;
	log?: (event: string, data: Record<string, unknown>) => void;
}

export interface ChatChangeTrackerMaintenanceOptions {
	/** Pack a repository once it has more loose objects than this. */
	maxLooseObjects?: number;
	/** A shadow repository of a folder that no longer exists is removed after this idle time. */
	repoMaxAgeMs?: number;
}

export interface ChatChangeTrackerMaintenanceResult {
	store: "chat-changes";
	removedFiles: number;
	removedBytes: number;
	durationMs: number;
	packedRepos: number;
	removedRepos: number;
	looseObjects: number;
	errors: number;
}

/** Snapshot of each tracked folder before the turn's first writing tool ran. */
export type TurnSnapshot = ReadonlyMap<string, ShadowGitSnapshot>;

interface FileChange {
	root: string;
	/** Relative to root, forward slashes. */
	path: string;
	before?: string;
	after?: string;
}

interface TurnRecord {
	turn: number;
	files: FileChange[];
}

interface SessionChanges {
	turns: TurnRecord[];
	pending: FileChange[];
	notice?: string;
	/** Turn whose write window is open; a crash leaves it set. */
	open?: number;
}

/** What `diff` shows: the agent reviews its own changes with it. */
export interface ChatChangeDiffOptions {
	/** "turn": since the running turn began; "pending": everything waiting for Keep or Undo, the running turn included. */
	scope: "turn" | "pending";
	/** Files or folders, relative to the workspace folder or absolute; empty shows every file. */
	paths?: readonly string[];
	/** Unchanged lines around each change, 0-20; default 3. */
	contextLines?: number;
	/** Upper bound for the whole answer in characters; default 40,000. */
	maxChars?: number;
}

export const CHANGE_DIFF_DEFAULT_CHARS = 40_000;
export const CHANGE_DIFF_MAX_CHARS = 120_000;

export interface ChatChangeTrackerLike {
	beginTurn(): Promise<TurnSnapshot | undefined>;
	/** Unified diff of the agent's changes; begin is the running turn's snapshot, absent before its first write. */
	diff?(sessionId: string, begin: TurnSnapshot | undefined, claimed: readonly string[], options: ChatChangeDiffOptions): Promise<string>;
	endTurn(sessionId: string, turn: number, begin: TurnSnapshot, claimed?: readonly string[]): Promise<void>;
	/** Changes so far in a turn that is still running; nothing is saved. */
	liveChangeSet?(sessionId: string, turn: number, begin: TurnSnapshot, claimed?: readonly string[]): Promise<ChatChangeSet>;
	/** Records that the turn may write before its changes are known. */
	markOpen?(sessionId: string, turn: number): Promise<void>;
	/** Turns a turn left open by a crash into a notice. */
	recoverInterrupted?(sessionId: string): Promise<void>;
	changeSet(sessionId: string): Promise<ChatChangeSet>;
	keep(sessionId: string, ids?: readonly string[]): Promise<void>;
	undo(sessionId: string, ids?: readonly string[]): Promise<void>;
	undoSinceTurn(sessionId: string, turn: number): Promise<void>;
	forgetTurnsFrom(sessionId: string, turn: number): Promise<void>;
	/** Drops the Keep/Undo state of a deleted chat; the files stay as they are. */
	forgetSession?(sessionId: string): Promise<void>;
	/** Content of a file before the agent's pending change, for the diff editor; undefined when the agent created it. */
	original(sessionId: string, id: string): Promise<{ root: string; path: string; before?: Buffer; exists: boolean } | undefined>;
}

const FILE_VERSION = 1;
const SESSION_ID = /^[A-Za-z0-9-]{1,64}$/;
const MAX_TURN_RECORDS = 200;
const ROOT_MARKER = "aab-root.json";

async function readRootMarker(file: string): Promise<string | undefined> {
	try {
		const value = JSON.parse(await fs.readFile(file, "utf8")) as { root?: unknown };
		return typeof value.root === "string" && path.isAbsolute(value.root) ? value.root : undefined;
	} catch {
		return undefined;
	}
}

async function isDirectory(directoryPath: string): Promise<boolean> {
	try {
		return (await fs.stat(directoryPath)).isDirectory();
	} catch {
		return false;
	}
}

async function directoryUsage(directory: string): Promise<{ files: number; bytes: number }> {
	let files = 0, bytes = 0;
	const entries = await fs.readdir(directory, { withFileTypes: true }).catch(() => []);
	for (const entry of entries) {
		const full = path.join(directory, entry.name);
		if (entry.isDirectory()) {
			const nested = await directoryUsage(full);
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

function rootKey(root: string): string {
	const normalized = process.platform === "win32" ? root.toLowerCase() : root;
	return createHash("sha1").update(normalized).digest("hex").slice(0, 16);
}

function sameFile(left: FileChange, right: { root: string; path: string }): boolean {
	return left.root === right.root && left.path === right.path;
}

/** Absolute path with Windows case folded away, for comparing claimed and changed files. */
function comparablePath(file: string): string {
	const resolved = path.resolve(file);
	return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}

function fileId(change: { root: string; path: string }): string {
	return `${rootKey(change.root)}:${change.path}`;
}

function plural(count: number, word: string): string {
	return `${count} ${word}${count === 1 ? "" : "s"}`;
}

function isFileChange(value: unknown): value is FileChange {
	if (typeof value !== "object" || value === null) {
		return false;
	}
	const record = value as Record<string, unknown>;
	return typeof record.root === "string" && typeof record.path === "string"
		&& (record.before === undefined || typeof record.before === "string")
		&& (record.after === undefined || typeof record.after === "string");
}

function parseSessionChanges(raw: string): SessionChanges | undefined {
	let value: unknown;
	try {
		value = JSON.parse(raw);
	} catch {
		return undefined;
	}
	if (typeof value !== "object" || value === null) {
		return undefined;
	}
	const record = value as Record<string, unknown>;
	if (record.version !== FILE_VERSION || !Array.isArray(record.turns) || !Array.isArray(record.pending)) {
		return undefined;
	}
	const turns: TurnRecord[] = [];
	for (const entry of record.turns as unknown[]) {
		const turn = entry as Record<string, unknown>;
		if (typeof turn?.turn === "number" && Array.isArray(turn.files)) {
			turns.push({ turn: turn.turn, files: (turn.files as unknown[]).filter(isFileChange) });
		}
	}
	return { turns, pending: (record.pending as unknown[]).filter(isFileChange), ...(typeof record.open === "number" ? { open: record.open } : {}) };
}

/**
 * Collects the files the agent changed per turn by diffing shadow-git snapshots, keeps them pending until
 * the user keeps or undoes them, and restores earlier content only when the file still holds the agent's version.
 */
export class ChatChangeTracker implements ChatChangeTrackerLike {
	private readonly _options: ChatChangeTrackerOptions;
	private readonly _repos = new Map<string, ShadowGitRepo>();
	private readonly _disabled = new Map<string, string>();
	private readonly _sessions = new Map<string, SessionChanges>();
	private readonly _numstat = new Map<string, { additions: number; deletions: number } | undefined>();
	private readonly _open = new Set<TurnSnapshot>();
	private readonly _overlapped = new WeakSet<TurnSnapshot>();
	private _gitPath: Promise<string | undefined> | undefined;
	private _queue: Promise<unknown> = Promise.resolve();
	private _gitQueue: Promise<unknown> = Promise.resolve();

	constructor(options: ChatChangeTrackerOptions) {
		this._options = options;
	}

	async beginTurn(): Promise<TurnSnapshot | undefined> {
		return this._enqueueGit(async () => {
			const snapshot = new Map<string, ShadowGitSnapshot>();
			for (const folder of this._options.folders()) {
				const repo = await this._repo(folder.fsPath);
				if (!repo) {
					continue;
				}
				try {
					snapshot.set(folder.fsPath, await repo.snapshot());
				} catch (error) {
					this._disable(folder.fsPath, error);
				}
			}
			if (snapshot.size === 0) {
				return undefined;
			}
			if (this._open.size > 0) {
				for (const open of this._open) {
					this._overlapped.add(open);
				}
				this._overlapped.add(snapshot);
			}
			this._open.add(snapshot);
			return snapshot;
		});
	}

	async endTurn(sessionId: string, turn: number, begin: TurnSnapshot, claimed?: readonly string[]): Promise<void> {
		const overlapped = this._overlapped.has(begin);
		this._open.delete(begin);
		const collected = await this._collectChanges(begin);
		const filtered = overlapped ? this._filterClaimed(collected, claimed) : { files: collected, dropped: 0 };
		const files = filtered.files;
		const dropped = filtered.dropped;
		const notice = dropped > 0
			? `Another chat was working at the same time, so ${plural(dropped, "file")} changed by other means ${dropped === 1 ? "is" : "are"} not listed here.`
			: undefined;
		if (notice) {
			this._options.log?.("chat.changes.overlap", { sessionId, kept: files.length, dropped });
		}
		if (files.length === 0) {
			if (notice) {
				await this._update(sessionId, data => {
					data.notice = notice;
					data.open = undefined;
				});
			} else {
				await this._clearOpen(sessionId);
			}
			return;
		}
		await this._update(sessionId, data => {
			data.turns.push({ turn, files });
			if (data.turns.length > MAX_TURN_RECORDS) {
				data.turns.splice(0, data.turns.length - MAX_TURN_RECORDS);
			}
			data.pending = this._mergePending(data.pending, files);
			data.notice = notice;
			data.open = undefined;
		});
	}

	async liveChangeSet(sessionId: string, turn: number, begin: TurnSnapshot, claimed?: readonly string[]): Promise<ChatChangeSet> {
		const collected = await this._collectChanges(begin);
		const filtered = this._overlapped.has(begin) ? this._filterClaimed(collected, claimed) : { files: collected, dropped: 0 };
		const data = await this._enqueue(() => this._load(sessionId));
		const turns = filtered.files.length > 0 ? [...data.turns, { turn, files: filtered.files }] : [...data.turns];
		const live: SessionChanges = {
			turns,
			pending: this._mergePending(data.pending, filtered.files),
			...(data.notice === undefined ? {} : { notice: data.notice }),
		};
		return this._buildChangeSet(live);
	}

	async diff(sessionId: string, begin: TurnSnapshot | undefined, claimed: readonly string[], options: ChatChangeDiffOptions): Promise<string> {
		let files: FileChange[] = [];
		if (begin) {
			const collected = await this._collectChanges(begin);
			files = this._overlapped.has(begin) ? this._filterClaimed(collected, claimed).files : collected;
		}
		if (options.scope === "pending") {
			const data = await this._enqueue(() => this._load(sessionId));
			files = this._mergePending(data.pending, files);
		}
		const folders = this._options.folders();
		const wanted = (options.paths ?? []).map(entry => entry.trim()).filter(Boolean);
		const shown = files
			.filter(file => wanted.length === 0 || wanted.some(entry => this._pathMatches(file, entry, folders)))
			.sort((left, right) => this._displayPath(left, folders).localeCompare(this._displayPath(right, folders)));
		const where = options.scope === "turn" ? "in this turn" : "waiting for Keep or Undo";
		if (shown.length === 0) {
			const unavailable = await this._unavailable(folders);
			if (unavailable) {
				return `Changes are not tracked: ${unavailable}`;
			}
			return files.length > 0 && wanted.length > 0
				? `None of the ${plural(files.length, "changed file")} ${where} matches ${wanted.join(", ")}.`
				: `No files changed ${where}.`;
		}
		const maxChars = Math.max(2_000, Math.min(CHANGE_DIFF_MAX_CHARS, Math.floor(options.maxChars ?? CHANGE_DIFF_DEFAULT_CHARS)));
		const entries = await Promise.all(shown.map(async file => {
			const counts = await this._counts(file);
			const status = file.before === undefined ? "added" : file.after === undefined ? "deleted" : "modified";
			const stat = counts ? ` +${counts.additions} -${counts.deletions}` : " binary";
			return { file, status, label: `${this._displayPath(file, folders)} (${status},${stat})`, counts };
		}));
		const additions = entries.reduce((sum, entry) => sum + (entry.counts?.additions ?? 0), 0);
		const deletions = entries.reduce((sum, entry) => sum + (entry.counts?.deletions ?? 0), 0);
		const lines = [
			`${plural(entries.length, "file")} changed ${where} (+${additions} -${deletions}):`,
			...entries.map(entry => `- ${entry.label}`),
		];
		let used = lines.join("\n").length;
		const skipped: string[] = [];
		for (const entry of entries) {
			if (used >= maxChars) {
				skipped.push(this._displayPath(entry.file, folders));
				continue;
			}
			const body = await this._diffBody(entry.file, entry.status, entry.counts?.deletions, options.contextLines);
			const section = `\n=== ${entry.label}\n${body}`;
			if (used + section.length <= maxChars) {
				lines.push(section.slice(1));
				used += section.length;
				continue;
			}
			const room = maxChars - used - entry.label.length - 80;
			if (room < 400) {
				skipped.push(this._displayPath(entry.file, folders));
				used = maxChars;
				continue;
			}
			const cut = body.lastIndexOf("\n", room);
			const head = body.slice(0, cut > 0 ? cut : room);
			const rest = body.slice(head.length).split("\n").filter(Boolean).length;
			lines.push(`=== ${entry.label}\n${head}\n… ${plural(rest, "more diff line")} of this file not shown.`);
			used = maxChars;
		}
		if (skipped.length > 0) {
			lines.push(`\nOver the ${maxChars}-character limit, not shown: ${skipped.join(", ")}. Call again with paths to see them.`);
		}
		return lines.join("\n");
	}

	/** The diff text of one file: hunks, or a line saying why there are none. */
	private async _diffBody(file: FileChange, status: string, deletedLines: number | undefined, contextLines: number | undefined): Promise<string> {
		if (status === "deleted") {
			return deletedLines === undefined ? "File deleted." : `File deleted (${plural(deletedLines, "line")}).`;
		}
		const repo = this._repos.get(file.root) ?? await this._repo(file.root);
		if (!repo) {
			return "Diff not available: the snapshot repository is missing.";
		}
		try {
			const hunks = await repo.diffBlobs(file.before, file.after, contextLines ?? 3);
			if (hunks === undefined) {
				return "Binary file; no text diff.";
			}
			return hunks.trimEnd() || "Only the file mode or line endings changed.";
		} catch (error) {
			return `Diff not available: ${error instanceof Error ? error.message.slice(0, 200) : String(error)}`;
		}
	}

	/** Path shown to the model: folder name first in a multi-root workspace, as in the Keep/Undo list. */
	private _displayPath(change: FileChange, folders: readonly TrackedFolder[]): string {
		const folder = folders.length > 1 ? folders.find(candidate => candidate.fsPath === change.root) : undefined;
		return folder ? `${folder.name}/${change.path}` : change.path;
	}

	/** A file matches an entry that names it or a folder above it, relative to its root, its display path or absolute. */
	private _pathMatches(change: FileChange, entry: string, folders: readonly TrackedFolder[]): boolean {
		const absolute = comparablePath(path.join(change.root, ...change.path.split("/")));
		const candidates = path.isAbsolute(entry)
			? [comparablePath(entry)]
			: [entry, `${path.basename(change.root)}/${entry}`].map(relative => comparablePath(path.join(change.root, ...relative.replace(/^\.?[\\/]+/, "").split(/[\\/]/))));
		const display = this._displayPath(change, folders);
		if (folders.length > 1 && (display === entry || display.startsWith(`${entry.replace(/[\\/]+$/, "")}/`))) {
			return true;
		}
		return candidates.some(candidate => absolute === candidate || absolute.startsWith(candidate.endsWith(path.sep) ? candidate : candidate + path.sep));
	}

	async markOpen(sessionId: string, turn: number): Promise<void> {
		await this._update(sessionId, data => {
			data.open = turn;
		});
	}

	async recoverInterrupted(sessionId: string): Promise<void> {
		const data = await this._enqueue(() => this._load(sessionId));
		if (data.open === undefined) {
			return;
		}
		await this._update(sessionId, current => {
			current.open = undefined;
			current.notice = "A turn was interrupted before its file changes were recorded; files it changed are not listed here.";
		});
	}

	async changeSet(sessionId: string): Promise<ChatChangeSet> {
		const data = await this._enqueue(() => this._load(sessionId));
		return this._buildChangeSet(data);
	}

	private async _buildChangeSet(data: SessionChanges): Promise<ChatChangeSet> {
		const folders = this._options.folders();
		const multiRoot = folders.length > 1;
		const files: ChatChangedFile[] = [];
		for (const change of data.pending) {
			const folder = folders.find(candidate => candidate.fsPath === change.root);
			const counts = await this._counts(change);
			files.push({
				id: fileId(change),
				path: multiRoot && folder ? `${folder.name}/${change.path}` : change.path,
				status: change.before === undefined ? "added" : change.after === undefined ? "deleted" : "modified",
				...(counts ?? {}),
			});
		}
		const turns = [...new Set(data.turns.map(record => record.turn))].sort((left, right) => left - right);
		const sinceTurn = turns.map(turn => {
			const distinct = new Set(data.turns.filter(record => record.turn >= turn).flatMap(record => record.files.map(fileId)));
			return { turn, files: distinct.size };
		});
		const set: ChatChangeSet = { files, sinceTurn };
		if (data.notice) {
			set.notice = data.notice;
		}
		const unavailable = await this._unavailable(folders);
		if (unavailable) {
			set.unavailable = unavailable;
		}
		return set;
	}

	async keep(sessionId: string, ids?: readonly string[]): Promise<void> {
		await this._update(sessionId, data => {
			const kept = this._select(data.pending, ids);
			this._resolve(data, kept);
			data.notice = kept.length > 0 ? `Kept ${plural(kept.length, "file")}.` : undefined;
		});
	}

	async undo(sessionId: string, ids?: readonly string[]): Promise<void> {
		await this._update(sessionId, async data => {
			const targets = this._select(data.pending, ids);
			const outcome = await this._restore(targets.map(file => ({ file, restore: file.before, expected: file.after })));
			// Files that could not be written stay pending so Undo can be retried.
			this._resolve(data, [...outcome.restored, ...outcome.skipped]);
			data.notice = this._undoNotice(outcome);
		});
	}

	async undoSinceTurn(sessionId: string, turn: number): Promise<void> {
		await this._update(sessionId, async data => {
			const later = data.turns.filter(record => record.turn >= turn);
			if (later.length === 0) {
				return;
			}
			// The earliest record of each file holds its content before the edited turn.
			const earliest = new Map<string, FileChange>();
			for (const record of later) {
				for (const file of record.files) {
					if (!earliest.has(fileId(file))) {
						earliest.set(fileId(file), file);
					}
				}
			}
			const plans = [...earliest.values()].map(file => {
				const pending = data.pending.find(candidate => sameFile(candidate, file));
				return { file, restore: file.before, expected: pending ? pending.after : undefined, pending };
			});
			const outcome = await this._restore(plans.filter(plan => plan.pending));
			for (const plan of plans) {
				if (plan.pending && outcome.restored.includes(plan.file)) {
					plan.pending.after = plan.restore;
				}
			}
			data.pending = data.pending.filter(file => file.before !== file.after);
			data.turns = data.turns.filter(record => record.turn < turn);
			data.notice = this._undoNotice(outcome);
		});
	}

	async forgetTurnsFrom(sessionId: string, turn: number): Promise<void> {
		await this._update(sessionId, data => {
			data.turns = data.turns.filter(record => record.turn < turn);
		});
	}

	async forgetSession(sessionId: string): Promise<void> {
		await this._enqueue(async () => {
			this._sessions.delete(sessionId);
			await fs.rm(this._file(sessionId), { force: true });
		});
	}

	async original(sessionId: string, id: string): Promise<{ root: string; path: string; before?: Buffer; exists: boolean } | undefined> {
		const data = await this._enqueue(() => this._load(sessionId));
		const change = data.pending.find(candidate => fileId(candidate) === id);
		const repo = change ? this._repos.get(change.root) : undefined;
		if (!change || !repo) {
			return undefined;
		}
		const before = change.before ? await repo.readBlob(change.before) : undefined;
		return { root: change.root, path: change.path, before, exists: change.after !== undefined };
	}

	private _select(pending: readonly FileChange[], ids?: readonly string[]): FileChange[] {
		return ids ? pending.filter(file => ids.includes(fileId(file))) : [...pending];
	}

	/** Snapshots the work trees again and lists what changed since the begin snapshot. */
	private async _collectChanges(begin: TurnSnapshot): Promise<FileChange[]> {
		return this._enqueueGit(async () => {
			const changed: FileChange[] = [];
			for (const [root, before] of begin) {
				const repo = this._repos.get(root);
				if (!repo || this._disabled.has(root)) {
					continue;
				}
				try {
					const after = await repo.snapshot(before);
					if (after.tree === before.tree) {
						continue;
					}
					for (const change of await repo.diff(before, after)) {
						changed.push({ root, path: change.path, before: change.before, after: change.after });
					}
				} catch (error) {
					this._disable(root, error);
				}
			}
			return changed;
		});
	}

	/** Drops the files another chat changed while this turn was open, keeping only the paths its tools wrote. */
	private _filterClaimed(files: readonly FileChange[], claimed?: readonly string[]): { files: FileChange[]; dropped: number } {
		const allowed = new Set((claimed ?? []).map(comparablePath));
		const kept = files.filter(file => allowed.has(comparablePath(path.join(file.root, ...file.path.split("/")))));
		return { files: kept, dropped: files.length - kept.length };
	}

	/** Adds the turn's files to a pending list copy: known files move to their new version, new files are appended. */
	private _mergePending(pending: readonly FileChange[], files: readonly FileChange[]): FileChange[] {
		const merged = pending.map(file => ({ ...file }));
		for (const file of files) {
			const existing = merged.find(candidate => sameFile(candidate, file));
			if (!existing) {
				merged.push({ ...file });
			} else {
				existing.after = file.after;
			}
		}
		return merged.filter(file => file.before !== file.after);
	}

	/** Kept or undone files leave the pending set and the per-turn history. */
	private _resolve(data: SessionChanges, files: readonly FileChange[]): void {
		data.pending = data.pending.filter(file => !files.some(resolved => sameFile(resolved, file)));
		for (const record of data.turns) {
			record.files = record.files.filter(file => !files.some(resolved => sameFile(resolved, file)));
		}
		data.turns = data.turns.filter(record => record.files.length > 0);
	}

	/** Restores a file only while it still holds the agent's version, so later hand edits survive. */
	private async _restore(plans: ReadonlyArray<{ file: FileChange; restore?: string; expected?: string }>): Promise<{ restored: FileChange[]; skipped: FileChange[]; failed: FileChange[] }> {
		const outcome = { restored: [] as FileChange[], skipped: [] as FileChange[], failed: [] as FileChange[] };
		for (const plan of plans) {
			const repo = this._repos.get(plan.file.root) ?? await this._repo(plan.file.root);
			if (!repo) {
				outcome.failed.push(plan.file);
				continue;
			}
			const target = path.join(plan.file.root, ...plan.file.path.split("/"));
			try {
				if (await repo.hashFile(plan.file.path) !== plan.expected) {
					outcome.skipped.push(plan.file);
					continue;
				}
				if (plan.restore) {
					const content = await repo.readBlob(plan.restore);
					await fs.mkdir(path.dirname(target), { recursive: true });
					await fs.writeFile(target, content);
				} else {
					await fs.rm(target, { force: true });
				}
				outcome.restored.push(plan.file);
			} catch (error) {
				this._options.log?.("chat.changes.restore_failed", { path: plan.file.path, message: error instanceof Error ? error.message : String(error) });
				outcome.failed.push(plan.file);
			}
		}
		return outcome;
	}

	private _undoNotice(outcome: { restored: FileChange[]; skipped: FileChange[]; failed: FileChange[] }): string {
		const parts = [`Undid ${plural(outcome.restored.length, "file")}.`];
		if (outcome.skipped.length > 0) {
			parts.push(`${plural(outcome.skipped.length, "file")} changed by hand afterwards ${outcome.skipped.length === 1 ? "was" : "were"} left as is.`);
		}
		if (outcome.failed.length > 0) {
			parts.push(`${plural(outcome.failed.length, "file")} could not be restored.`);
		}
		return parts.join(" ");
	}

	private async _counts(change: FileChange): Promise<{ additions: number; deletions: number } | undefined> {
		const key = `${change.before ?? ""}:${change.after ?? ""}`;
		if (this._numstat.has(key)) {
			return this._numstat.get(key);
		}
		const repo = this._repos.get(change.root) ?? await this._repo(change.root);
		let counts: { additions: number; deletions: number } | undefined;
		try {
			counts = repo ? await repo.numstat(change.before, change.after) : undefined;
		} catch {
			counts = undefined;
		}
		this._numstat.set(key, counts);
		return counts;
	}

	private async _unavailable(folders: readonly TrackedFolder[]): Promise<string | undefined> {
		if (folders.length === 0) {
			return "no workspace folder is open.";
		}
		if (this._gitPath && !(await this._gitPath)) {
			return "git was not found.";
		}
		const disabled = folders.filter(folder => this._disabled.has(folder.fsPath));
		return disabled.length === folders.length ? this._disabled.get(disabled[0].fsPath) : undefined;
	}

	private async _repo(root: string): Promise<ShadowGitRepo | undefined> {
		if (this._disabled.has(root)) {
			return undefined;
		}
		const existing = this._repos.get(root);
		if (existing) {
			return existing;
		}
		this._gitPath ??= this._options.findGit().catch(() => undefined);
		const gitPath = await this._gitPath;
		if (!gitPath) {
			return undefined;
		}
		const gitDir = path.join(this._options.storageDir, "shadow", rootKey(root));
		const repo = new ShadowGitRepo({ gitPath, gitDir, workTree: root });
		this._repos.set(root, repo);
		// The marker lets a later window tell an obsolete workspace root from one that
		// is merely not open here when it decides whether a shadow repository is stale.
		void fs.mkdir(gitDir, { recursive: true })
			.then(() => fs.writeFile(path.join(gitDir, ROOT_MARKER), JSON.stringify({ root }), "utf8"))
			.catch(() => undefined);
		return repo;
	}

	/**
	 * Packs loose objects in the shadow repositories and removes repositories whose
	 * workspace folder is gone and that have been idle past the retention window.
	 * Snapshot objects are never pruned: trees and blobs referenced only by chat
	 * state have no git ref, and packing keeps every object.
	 */
	async maintain(options: ChatChangeTrackerMaintenanceOptions = {}): Promise<ChatChangeTrackerMaintenanceResult> {
		const started = Date.now();
		const maxLooseObjects = Math.max(1, Math.floor(options.maxLooseObjects ?? 2_000));
		const repoMaxAgeMs = Math.max(0, options.repoMaxAgeMs ?? 30 * 86400_000);
		const result: ChatChangeTrackerMaintenanceResult = {
			store: "chat-changes", removedFiles: 0, removedBytes: 0, durationMs: 0,
			packedRepos: 0, removedRepos: 0, looseObjects: 0, errors: 0,
		};
		try {
			this._gitPath ??= this._options.findGit().catch(() => undefined);
			const gitPath = await this._gitPath;
			if (!gitPath) {
				return this._finishMaintenance(result, started);
			}
			const shadowRoot = path.join(this._options.storageDir, "shadow");
			const currentRoots = new Map(this._options.folders().map(folder => [rootKey(folder.fsPath), folder.fsPath]));
			const entries = await fs.readdir(shadowRoot, { withFileTypes: true }).catch(() => []);
			for (const entry of entries) {
				if (!entry.isDirectory() || !/^[0-9a-f]{16}$/.test(entry.name)) {
					continue;
				}
				try {
					const gitDir = path.join(shadowRoot, entry.name);
					const currentRoot = currentRoots.get(entry.name);
					const markerRoot = currentRoot ?? await readRootMarker(path.join(gitDir, ROOT_MARKER));
					if (markerRoot === undefined) {
						// A repository made before markers existed: without its root path it
						// cannot be proven obsolete, so it is left alone.
						continue;
					}
					if (await isDirectory(markerRoot)) {
						const repo = currentRoot !== undefined
							? await this._repo(markerRoot)
							: new ShadowGitRepo({ gitPath, gitDir, workTree: markerRoot });
						if (!repo) {
							continue;
						}
						const before = await directoryUsage(gitDir);
						const maintenance = await repo.maintain(maxLooseObjects);
						const after = await directoryUsage(gitDir);
						result.looseObjects += maintenance.looseObjects;
						if (maintenance.packed) {
							result.packedRepos++;
							result.removedFiles += Math.max(0, before.files - after.files);
							result.removedBytes += Math.max(0, before.bytes - after.bytes);
						}
						continue;
					}
					const info = await fs.stat(gitDir).catch(() => undefined);
					if (!info || Date.now() - info.mtimeMs <= repoMaxAgeMs) {
						continue;
					}
					const usage = await directoryUsage(gitDir);
					await fs.rm(gitDir, { recursive: true, force: true });
					this._repos.delete(markerRoot);
					this._disabled.delete(markerRoot);
					result.removedRepos++;
					result.removedFiles += usage.files;
					result.removedBytes += usage.bytes;
				} catch {
					// One unreadable repository must not stop the others; the summary counts it.
					result.errors++;
				}
			}
		} catch (error) {
			this._options.log?.("storage.retention.failed", {
				store: "chat-changes",
				message: error instanceof Error ? error.message : String(error),
			});
			result.durationMs = Date.now() - started;
			return result;
		}
		return this._finishMaintenance(result, started);
	}

	private _finishMaintenance(result: ChatChangeTrackerMaintenanceResult, started: number): ChatChangeTrackerMaintenanceResult {
		result.durationMs = Date.now() - started;
		this._options.log?.("storage.retention.done", { ...result });
		return result;
	}

	private _disable(root: string, error: unknown): void {
		const message = error instanceof Error ? error.message : String(error);
		this._disabled.set(root, `the snapshot of ${path.basename(root)} failed: ${message.slice(0, 200)}`);
		this._options.log?.("chat.changes.snapshot_failed", { root, message });
	}

	private async _update(sessionId: string, change: (data: SessionChanges) => void | Promise<void>): Promise<void> {
		await this._enqueue(async () => {
			const data = await this._load(sessionId);
			await change(data);
			await this._save(sessionId, data);
		});
	}

	private async _clearOpen(sessionId: string): Promise<void> {
		const data = await this._enqueue(() => this._load(sessionId));
		if (data.open === undefined) {
			return;
		}
		await this._update(sessionId, current => {
			current.open = undefined;
		});
	}

	private _enqueue<T>(operation: () => Promise<T>): Promise<T> {
		const result = this._queue.then(operation, operation);
		this._queue = result.catch(() => undefined);
		return result;
	}

	private _enqueueGit<T>(operation: () => Promise<T>): Promise<T> {
		const result = this._gitQueue.then(operation, operation);
		this._gitQueue = result.catch(() => undefined);
		return result;
	}

	private _file(sessionId: string): string {
		if (!SESSION_ID.test(sessionId)) {
			throw new Error(`Invalid chat session id: ${sessionId}`);
		}
		return path.join(this._options.storageDir, "sessions", `${sessionId}.json`);
	}

	private async _load(sessionId: string): Promise<SessionChanges> {
		const cached = this._sessions.get(sessionId);
		if (cached) {
			return cached;
		}
		let data: SessionChanges | undefined;
		try {
			data = parseSessionChanges(await fs.readFile(this._file(sessionId), "utf8"));
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
				this._options.log?.("chat.changes.load_failed", { message: error instanceof Error ? error.message : String(error) });
			}
		}
		const loaded = data ?? { turns: [], pending: [] };
		this._sessions.set(sessionId, loaded);
		return loaded;
	}

	private async _save(sessionId: string, data: SessionChanges): Promise<void> {
		const file = this._file(sessionId);
		await fs.mkdir(path.dirname(file), { recursive: true });
		const temporary = `${file}.tmp`;
		await fs.writeFile(temporary, JSON.stringify({ version: FILE_VERSION, turns: data.turns, pending: data.pending, open: data.open }), "utf8");
		await fs.rename(temporary, file);
	}
}
