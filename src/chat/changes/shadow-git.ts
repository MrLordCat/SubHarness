import { execFile, spawn } from "node:child_process";
import { lstat, mkdir, readdir, stat, unlink, writeFile } from "node:fs/promises";
import * as path from "node:path";
import * as vscode from "vscode";

export interface ShadowGitOptions {
	gitPath: string;
	gitDir: string;
	workTree: string;
	timeoutMs?: number;
	/** Upper bound on ignored files kept in the shadow index. */
	maxIgnoredFiles?: number;
}

export interface ShadowGitSnapshot {
	tree: string;
	/** A comparison with this baseline cannot admit more ignored files. */
	ignoredLimitReached: boolean;
}

/** One changed path between two trees. path is relative to workTree with forward slashes; a missing side is undefined. */
export interface ShadowTreeChange {
	path: string;
	before?: string;
	after?: string;
}

interface GitRunOptions {
	repo?: boolean;
	cwd?: string;
	input?: Buffer;
	label?: string;
	acceptFailure?: (code: number | null, stderr: string) => boolean;
}

const DEFAULT_TIMEOUT_MS = 60_000;
const STALE_LOCK_MS = 60_000;
const MAX_OUTPUT_BYTES = 512 * 1024 * 1024;
const EMPTY_BLOB = "e69de29bb2d1d6434b8b29ae775ad8c2e48c5391";
const BLOB_PATTERN = /^[0-9a-f]{40}([0-9a-f]{24})?$/;
const CLEARED_ENV_KEYS = [
	"GIT_DIR",
	"GIT_WORK_TREE",
	"GIT_INDEX_FILE",
	"GIT_OBJECT_DIRECTORY",
	"GIT_ALTERNATE_OBJECT_DIRECTORIES",
	"GIT_CEILING_DIRECTORIES",
];
const REPO_CONFIG: ReadonlyArray<readonly [string, string]> = [
	["core.autocrlf", "false"],
	["core.safecrlf", "false"],
	["core.quotepath", "false"],
	["core.longpaths", "true"],
	["core.fsmonitor", "false"],
	["gc.auto", "0"],
	["maintenance.auto", "false"],
];
const INFO_ATTRIBUTES = "* -text -filter -ident -working-tree-encoding\n";
const INFO_EXCLUDE = "node_modules/\n.venv/\n__pycache__/\n.vscode-test/\n";

/** Directory names whose ignored contents stay out of the snapshots: build output and dependencies. */
export const UNTRACKED_DIRECTORY_NAMES: ReadonlySet<string> = new Set([
	"node_modules",
	".git",
	"out",
	"dist",
	"build",
	"target",
	"coverage",
	".vscode-test",
	".venv",
	"venv",
	"__pycache__",
	".tox",
	".mypy_cache",
	".pytest_cache",
	".ruff_cache",
	".gradle",
	".next",
	".nuxt",
	".turbo",
	".cache",
	".parcel-cache",
	"obj",
]);
export const MAX_IGNORED_FILE_BYTES = 1_000_000;
export const MAX_IGNORED_FILES = 5_000;

function acceptIndexFailure(code: number | null, stderr: string): boolean {
	return code === 1 && stderr.includes("unable to index");
}

/** Ignored files worth recording: small regular files outside build and dependency folders. */
async function collectIgnoredFiles(workTree: string, listing: Buffer, indexed: ReadonlySet<string>, limit: number): Promise<string[]> {
	const files: string[] = [];
	const addIfSmall = async (relative: string): Promise<void> => {
		if (indexed.has(relative)) {
			return;
		}
		try {
			const info = await lstat(path.join(workTree, ...relative.split("/")));
			if (info.isFile() && info.size <= MAX_IGNORED_FILE_BYTES) {
				files.push(relative);
			}
		} catch {
			// The file vanished since the listing.
		}
	};
	const walk = async (relative: string): Promise<void> => {
		const entries = await readdir(path.join(workTree, ...relative.split("/")), { withFileTypes: true }).catch(() => undefined);
		if (!entries) {
			return;
		}
		for (const entry of entries) {
			if (files.length >= limit) {
				return;
			}
			if (entry.isSymbolicLink()) {
				continue;
			}
			const child = `${relative}/${entry.name}`;
			if (entry.isDirectory()) {
				if (!UNTRACKED_DIRECTORY_NAMES.has(entry.name)) {
					await walk(child);
				}
			} else if (entry.isFile()) {
				await addIfSmall(child);
			}
		}
	};
	for (const entry of listing.toString("utf8").split("\0")) {
		if (files.length >= limit) {
			break;
		}
		if (entry.length === 0 || entry.split("/").some(segment => UNTRACKED_DIRECTORY_NAMES.has(segment))) {
			continue;
		}
		if (entry.endsWith("/")) {
			await walk(entry.slice(0, -1));
		} else {
			await addIfSmall(entry);
		}
	}
	return files;
}

function isZeroBlobId(blobId: string): boolean {
	return /^0+$/.test(blobId);
}

function parseDiff(raw: Buffer): ShadowTreeChange[] {
	const tokens = raw.toString("utf8").split("\0");
	const changes: ShadowTreeChange[] = [];
	for (let index = 0; index + 1 < tokens.length; index += 2) {
		const header = tokens[index];
		const filePath = tokens[index + 1];
		if (!header.startsWith(":")) {
			continue;
		}
		const fields = header.slice(1).split(" ");
		if (fields.length < 5) {
			continue;
		}
		const [oldMode, newMode, oldBlob, newBlob] = fields;
		if (oldMode === "160000" || newMode === "160000") {
			continue;
		}
		const change: ShadowTreeChange = { path: filePath };
		if (!isZeroBlobId(oldBlob)) {
			change.before = oldBlob;
		}
		if (!isZeroBlobId(newBlob)) {
			change.after = newBlob;
		}
		changes.push(change);
	}
	return changes;
}

async function isFile(filePath: string): Promise<boolean> {
	try {
		return (await stat(filePath)).isFile();
	} catch {
		return false;
	}
}

async function isDirectory(directoryPath: string): Promise<boolean> {
	try {
		return (await stat(directoryPath)).isDirectory();
	} catch {
		return false;
	}
}

async function removeFileIfPresent(filePath: string): Promise<void> {
	try {
		await unlink(filePath);
	} catch {
		// The file is already gone.
	}
}

function readGitExtensionPath(exportsValue: unknown): string | undefined {
	if (typeof exportsValue !== "object" || exportsValue === null) {
		return undefined;
	}
	const getApi = (exportsValue as { getAPI?: unknown }).getAPI;
	if (typeof getApi !== "function") {
		return undefined;
	}
	const api: unknown = Reflect.apply(getApi, exportsValue, [1]);
	if (typeof api !== "object" || api === null) {
		return undefined;
	}
	const git: unknown = (api as { git?: unknown }).git;
	if (typeof git !== "object" || git === null) {
		return undefined;
	}
	const gitPath: unknown = (git as { path?: unknown }).path;
	return typeof gitPath === "string" && gitPath.trim().length > 0 ? gitPath : undefined;
}

export class ShadowGitRepo {
	private readonly options: Required<ShadowGitOptions>;
	private readonly environment: NodeJS.ProcessEnv;
	private queue: Promise<void> = Promise.resolve();
	private initPromise: Promise<void> | undefined;

	constructor(options: ShadowGitOptions) {
		this.options = { ...options, timeoutMs: options.timeoutMs ?? DEFAULT_TIMEOUT_MS, maxIgnoredFiles: options.maxIgnoredFiles ?? MAX_IGNORED_FILES };
		const environment: NodeJS.ProcessEnv = { ...process.env };
		for (const key of CLEARED_ENV_KEYS) {
			delete environment[key];
		}
		environment.GIT_TERMINAL_PROMPT = "0";
		environment.GIT_OPTIONAL_LOCKS = "0";
		environment.LC_ALL = "C";
		this.environment = environment;
	}

	init(): Promise<void> {
		if (!this.initPromise) {
			this.initPromise = this.enqueue(() => this.runInit()).catch(error => {
				this.initPromise = undefined;
				throw error;
			});
		}
		return this.initPromise;
	}

	async snapshot(baseline?: ShadowGitSnapshot): Promise<ShadowGitSnapshot> {
		await this.init();
		return this.enqueue(async () => {
			await this.removeStaleIndexLock();
			await this.execGit(["add", "-A", "--ignore-errors", "--", "."], {
				cwd: this.options.workTree,
				label: "add",
				acceptFailure: acceptIndexFailure,
			});
			// Forced entries remain in the shadow index. Count them toward the cap so a
			// later snapshot cannot mistake the next batch of existing files for edits.
			const ignoredLimitReached = baseline?.ignoredLimitReached || await this.stageIgnoredFiles();
			const tree = await this.execGit(["write-tree"], { label: "write-tree" });
			return { tree: tree.toString("utf8").trim(), ignoredLimitReached };
		});
	}

	private async stageIgnoredFiles(): Promise<boolean> {
		const indexedListing = await this.execGit(
			["ls-files", "--cached", "--ignored", "--exclude-standard", "-z"],
			{ label: "ls-files" },
		);
		const indexed = new Set(indexedListing.toString("utf8").split("\0").filter(Boolean));
		const available = this.options.maxIgnoredFiles - indexed.size;
		if (available <= 0) {
			return true;
		}
		const listing = await this.execGit(
			["ls-files", "--others", "--ignored", "--exclude-standard", "--directory", "-z"],
			{ label: "ls-files" },
		);
		const ignored = await collectIgnoredFiles(this.options.workTree, listing, indexed, available);
		if (ignored.length > 0) {
			await this.execGit(
				["--literal-pathspecs", "add", "-f", "--ignore-errors", "--pathspec-from-file=-", "--pathspec-file-nul"],
				{
					input: Buffer.from(ignored.join("\0"), "utf8"),
					label: "add-ignored",
					acceptFailure: acceptIndexFailure,
				},
			);
		}
		return ignored.length === available;
	}

	diff(from: ShadowGitSnapshot, to: ShadowGitSnapshot): Promise<ShadowTreeChange[]> {
		return this.enqueue(async () => {
			const raw = await this.execGit(
				["diff-tree", "-r", "-z", "--no-renames", "--no-commit-id", "--raw", from.tree, to.tree],
				{ label: "diff-tree" },
			);
			return parseDiff(raw);
		});
	}

	async readBlob(blob: string): Promise<Buffer> {
		if (!BLOB_PATTERN.test(blob)) {
			throw new Error(`invalid blob id: ${blob}`);
		}
		return this.enqueue(() => this.execGit(["cat-file", "blob", blob], { label: "cat-file" }));
	}

	async hashFile(relativePath: string): Promise<string | undefined> {
		const absolutePath = this.resolveWorkTreePath(relativePath);
		if (!(await isFile(absolutePath))) {
			return undefined;
		}
		return this.enqueue(async () => {
			const output = await this.execGit(["hash-object", "--no-filters", "--", absolutePath], {
				label: "hash-object",
			});
			return output.toString("utf8").trim();
		});
	}

	async numstat(
		before: string | undefined,
		after: string | undefined,
	): Promise<{ additions: number; deletions: number } | undefined> {
		await this.init();
		return this.enqueue(async () => {
			const output = await this.execGit(
				["diff", "--numstat", "--no-renames", before ?? EMPTY_BLOB, after ?? EMPTY_BLOB],
				{ label: "diff" },
			);
			const line = output
				.toString("utf8")
				.split("\n")
				.map(part => part.trim())
				.find(part => part.length > 0);
			if (!line) {
				return { additions: 0, deletions: 0 };
			}
			const [added, deleted] = line.split("\t");
			if (added === "-" || deleted === "-") {
				return undefined;
			}
			return { additions: Number.parseInt(added, 10), deletions: Number.parseInt(deleted, 10) };
		});
	}

	private enqueue<T>(operation: () => Promise<T>): Promise<T> {
		const result = this.queue.then(operation, operation);
		this.queue = result.then(
			() => undefined,
			() => undefined,
		);
		return result;
	}

	private async runInit(): Promise<void> {
		const { gitDir } = this.options;
		await mkdir(gitDir, { recursive: true });
		if (!(await isFile(path.join(gitDir, "HEAD")))) {
			await this.execGit(["init", "--quiet", "--bare", gitDir], { repo: false, label: "init" });
			await this.execGit(["config", "--local", "core.bare", "false"], { label: "config" });
		}
		for (const [key, value] of REPO_CONFIG) {
			await this.execGit(["config", "--local", key, value], { label: "config" });
		}
		const infoDir = path.join(gitDir, "info");
		await mkdir(infoDir, { recursive: true });
		await writeFile(path.join(infoDir, "attributes"), INFO_ATTRIBUTES, "utf8");
		await writeFile(path.join(infoDir, "exclude"), INFO_EXCLUDE, "utf8");
		await this.writeAlternates();
		await this.execGit(["hash-object", "-w", "--stdin"], { label: "hash-object", input: Buffer.alloc(0) });
	}

	private async writeAlternates(): Promise<void> {
		const alternatesFile = path.join(this.options.gitDir, "objects", "info", "alternates");
		let objectsDir: string | undefined;
		try {
			const output = await this.execGit(
				["-C", this.options.workTree, "rev-parse", "--path-format=absolute", "--git-common-dir"],
				{ repo: false, label: "rev-parse" },
			);
			const commonDir = output.toString("utf8").trim();
			if (commonDir.length > 0) {
				const candidate = path.resolve(this.options.workTree, commonDir, "objects");
				if (await isDirectory(candidate)) {
					objectsDir = candidate;
				}
			}
		} catch {
			objectsDir = undefined;
		}
		if (!objectsDir) {
			await removeFileIfPresent(alternatesFile);
			return;
		}
		await mkdir(path.dirname(alternatesFile), { recursive: true });
		await writeFile(alternatesFile, `${objectsDir}\n`, "utf8");
	}

	private async removeStaleIndexLock(): Promise<void> {
		const lockFile = path.join(this.options.gitDir, "index.lock");
		try {
			const info = await stat(lockFile);
			if (Date.now() - info.mtimeMs > STALE_LOCK_MS) {
				await unlink(lockFile);
			}
		} catch {
			// No lock file to clean up.
		}
	}

	private resolveWorkTreePath(relativePath: string): string {
		if (path.isAbsolute(relativePath)) {
			throw new Error(`path escapes the work tree: ${relativePath}`);
		}
		const resolved = path.resolve(this.options.workTree, relativePath);
		const relative = path.relative(this.options.workTree, resolved);
		if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
			throw new Error(`path escapes the work tree: ${relativePath}`);
		}
		return resolved;
	}

	private execGit(args: string[], options: GitRunOptions = {}): Promise<Buffer> {
		const repoArgs =
			options.repo === false
				? []
				: [`--git-dir=${this.options.gitDir}`, `--work-tree=${this.options.workTree}`];
		const commandArgs = [...repoArgs, ...args];
		const label = options.label ?? args[0];
		return new Promise<Buffer>((resolve, reject) => {
			const child = spawn(this.options.gitPath, commandArgs, {
				cwd: options.cwd ?? this.options.workTree,
				env: this.environment,
				windowsHide: true,
				stdio: ["pipe", "pipe", "pipe"],
			});
			const stdout: Buffer[] = [];
			const stderr: Buffer[] = [];
			let stdoutBytes = 0;
			let settled = false;
			const finish = (error: Error | undefined, result: Buffer): void => {
				if (settled) {
					return;
				}
				settled = true;
				clearTimeout(timer);
				if (error) {
					reject(error);
				} else {
					resolve(result);
				}
			};
			const timer = setTimeout(() => {
				child.kill();
				finish(new Error(`git ${label} timed out after ${this.options.timeoutMs} ms`), Buffer.alloc(0));
			}, this.options.timeoutMs);
			child.stdout?.on("data", (chunk: Buffer) => {
				stdoutBytes += chunk.length;
				if (stdoutBytes > MAX_OUTPUT_BYTES) {
					child.kill();
					finish(new Error(`git ${label} produced more than ${MAX_OUTPUT_BYTES} bytes`), Buffer.alloc(0));
					return;
				}
				stdout.push(chunk);
			});
			child.stderr?.on("data", (chunk: Buffer) => stderr.push(chunk));
			child.stdin?.on("error", () => undefined);
			child.on("error", error => {
				finish(new Error(`git ${commandArgs.join(" ")} failed to start: ${error.message}`), Buffer.alloc(0));
			});
			child.on("close", code => {
				const stderrText = Buffer.concat(stderr).toString("utf8");
				if (code === 0 || (options.acceptFailure?.(code, stderrText) ?? false)) {
					finish(undefined, Buffer.concat(stdout));
					return;
				}
				const detail = stderrText.trim().slice(0, 500);
				finish(
					new Error(`git ${commandArgs.join(" ")} failed (exit ${code ?? "signal"}): ${detail}`),
					Buffer.alloc(0),
				);
			});
			child.stdin?.end(options.input ?? Buffer.alloc(0));
		});
	}
}

/** git from the built-in vscode.git extension API (exports.getAPI(1).git.path) when available, else "git" if `git --version` succeeds, else undefined. */
export async function findGitExecutable(): Promise<string | undefined> {
	try {
		const extension = vscode.extensions.getExtension("vscode.git");
		if (extension) {
			try {
				if (!extension.isActive) {
					await extension.activate();
				}
			} catch {
				// Activation failed; try the exported API anyway.
			}
			const gitPath = readGitExtensionPath(extension.exports);
			if (gitPath) {
				return gitPath;
			}
		}
	} catch {
		// The built-in git extension is unavailable in this host.
	}
	return new Promise<string | undefined>(resolve => {
		execFile("git", ["--version"], { windowsHide: true, timeout: 10_000 }, error => {
			resolve(error ? undefined : "git");
		});
	});
}
