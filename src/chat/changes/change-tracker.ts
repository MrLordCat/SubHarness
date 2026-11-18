import { createHash } from "node:crypto";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { ChatChangedFile, ChatChangeSet } from "../shared/protocol";
import { ShadowGitRepo } from "./shadow-git";

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

/** Tree ids of every tracked folder before the turn's first writing tool ran. */
export type TurnSnapshot = ReadonlyMap<string, string>;

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
}

export interface ChatChangeTrackerLike {
	beginTurn(): Promise<TurnSnapshot | undefined>;
	endTurn(sessionId: string, turn: number, begin: TurnSnapshot): Promise<void>;
	changeSet(sessionId: string): Promise<ChatChangeSet>;
	keep(sessionId: string, ids?: readonly string[]): Promise<void>;
	undo(sessionId: string, ids?: readonly string[]): Promise<void>;
	undoSinceTurn(sessionId: string, turn: number): Promise<void>;
	forgetTurnsFrom(sessionId: string, turn: number): Promise<void>;
	/** Content of a file before the agent's pending change, for the diff editor; undefined when the agent created it. */
	original(sessionId: string, id: string): Promise<{ root: string; path: string; before?: Buffer; exists: boolean } | undefined>;
}

const FILE_VERSION = 1;
const SESSION_ID = /^[A-Za-z0-9-]{1,64}$/;
const MAX_TURN_RECORDS = 200;

function rootKey(root: string): string {
	const normalized = process.platform === "win32" ? root.toLowerCase() : root;
	return createHash("sha1").update(normalized).digest("hex").slice(0, 16);
}

function sameFile(left: FileChange, right: { root: string; path: string }): boolean {
	return left.root === right.root && left.path === right.path;
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
	return { turns, pending: (record.pending as unknown[]).filter(isFileChange) };
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
	private _gitPath: Promise<string | undefined> | undefined;
	private _queue: Promise<unknown> = Promise.resolve();

	constructor(options: ChatChangeTrackerOptions) {
		this._options = options;
	}

	async beginTurn(): Promise<TurnSnapshot | undefined> {
		const snapshot = new Map<string, string>();
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
		return snapshot.size > 0 ? snapshot : undefined;
	}

	async endTurn(sessionId: string, turn: number, begin: TurnSnapshot): Promise<void> {
		const files: FileChange[] = [];
		for (const [root, before] of begin) {
			const repo = this._repos.get(root);
			if (!repo || this._disabled.has(root)) {
				continue;
			}
			try {
				const after = await repo.snapshot();
				if (after === before) {
					continue;
				}
				for (const change of await repo.diff(before, after)) {
					files.push({ root, path: change.path, before: change.before, after: change.after });
				}
			} catch (error) {
				this._disable(root, error);
			}
		}
		if (files.length === 0) {
			return;
		}
		await this._update(sessionId, data => {
			data.turns.push({ turn, files });
			if (data.turns.length > MAX_TURN_RECORDS) {
				data.turns.splice(0, data.turns.length - MAX_TURN_RECORDS);
			}
			for (const file of files) {
				const pending = data.pending.find(candidate => sameFile(candidate, file));
				if (!pending) {
					data.pending.push({ ...file });
				} else {
					pending.after = file.after;
				}
			}
			data.pending = data.pending.filter(file => file.before !== file.after);
			data.notice = undefined;
		});
	}

	async changeSet(sessionId: string): Promise<ChatChangeSet> {
		const data = await this._enqueue(() => this._load(sessionId));
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
		const repo = new ShadowGitRepo({ gitPath, gitDir: path.join(this._options.storageDir, "shadow", rootKey(root)), workTree: root });
		this._repos.set(root, repo);
		return repo;
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

	private _enqueue<T>(operation: () => Promise<T>): Promise<T> {
		const result = this._queue.then(operation, operation);
		this._queue = result.catch(() => undefined);
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
		await fs.writeFile(temporary, JSON.stringify({ version: FILE_VERSION, turns: data.turns, pending: data.pending }), "utf8");
		await fs.rename(temporary, file);
	}
}
