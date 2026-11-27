import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import * as fs from "node:fs/promises";
import { createRequire } from "node:module";
import * as path from "node:path";

import {
	downloadWithIntegrity,
	extractTarEntries,
	removeInstallLeftovers,
	type FetchLike,
} from "../codex/cli-installer";

// No `vscode` import: the installer also runs under plain node for smoke tests.

/**
 * The Claude Agent SDK starts `claude` from a platform package whose version must match the SDK
 * exactly, because the two speak the same private protocol. The extension therefore downloads that
 * package from npm instead of shipping its 300+ MB executable in the VSIX.
 */
export interface ClaudeRuntimeTarget {
	/** Suffix of the npm package, e.g. win32-x64 or linux-x64-musl. */
	npmSuffix: string;
	/** Full npm package name, e.g. @anthropic-ai/claude-agent-sdk-win32-x64. */
	packageName: string;
	/** Folder name beside the SDK under node_modules/@anthropic-ai. */
	folderName: string;
	executable: string;
}

const VERSION_PATTERN = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.]+)?$/;
const CURRENT_FILE = "current.json";
const VERIFY_TIMEOUT_MS = 30_000;
const SDK_PACKAGE = "@anthropic-ai/claude-agent-sdk";
const PLATFORM_PACKAGE_PREFIX = `${SDK_PACKAGE}-`;

/** Used in chat and Quick Access when no runtime resolves; names the command that fixes it. */
export const CLAUDE_RUNTIME_MISSING_MESSAGE =
	'The Claude runtime is not installed yet. Run "SubHarness: Install Claude Runtime" (or sign in) to download it.';

/** What the modal download prompt says, from the win32-x64 tarball (about 100 MB) and disk use. */
export const CLAUDE_RUNTIME_DOWNLOAD_ESTIMATE = "About 100 MB to download and 330 MB on disk";

export function claudeRuntimeExecutableName(platform: NodeJS.Platform = process.platform): string {
	return platform === "win32" ? "claude.exe" : "claude";
}

/**
 * The Agent SDK prefers a musl build on Linux when the process report has no glibc runtime.
 * Mirrors the SDK's own platform-package search.
 */
export function preferMuslRuntime(
	platform: NodeJS.Platform = process.platform,
	report?: { header?: { glibcVersionRuntime?: string } }
): boolean {
	if (platform !== "linux") {
		return false;
	}
	try {
		const value = report ?? (typeof process.report?.getReport === "function"
			? process.report.getReport() as { header?: { glibcVersionRuntime?: string } }
			: undefined);
		return value !== undefined && value.header?.glibcVersionRuntime === undefined;
	} catch {
		return false;
	}
}

function targetForSuffix(npmSuffix: string, platform: NodeJS.Platform): ClaudeRuntimeTarget {
	return {
		npmSuffix,
		packageName: `${PLATFORM_PACKAGE_PREFIX}${npmSuffix}`,
		folderName: `claude-agent-sdk-${npmSuffix}`,
		executable: claudeRuntimeExecutableName(platform),
	};
}

/**
 * Platform packages in the order the SDK tries them: the musl build first on musl Linux, the glibc
 * build first elsewhere, with the other Linux variant as a fallback.
 */
export function claudeRuntimeCandidates(
	platform: NodeJS.Platform = process.platform,
	arch: string = process.arch,
	preferMusl = preferMuslRuntime(platform)
): ClaudeRuntimeTarget[] {
	const base = `${platform}-${arch}`;
	if (base !== "win32-x64" && base !== "win32-arm64" && base !== "darwin-x64"
		&& base !== "darwin-arm64" && base !== "linux-x64" && base !== "linux-arm64") {
		return [];
	}
	const suffixes = platform !== "linux"
		? [base]
		: preferMusl
			? [`${base}-musl`, base]
			: [base, `${base}-musl`];
	return suffixes.map(suffix => targetForSuffix(suffix, platform));
}

export function claudeRuntimeTarget(
	platform: NodeJS.Platform = process.platform,
	arch: string = process.arch,
	preferMusl = preferMuslRuntime(platform)
): ClaudeRuntimeTarget | undefined {
	return claudeRuntimeCandidates(platform, arch, preferMusl)[0];
}

/** The folder of the installed Agent SDK, whose package.json names the exact runtime version. */
export function claudeSdkPackageRoot(): string | undefined {
	try {
		return path.dirname(createRequire(__filename).resolve(SDK_PACKAGE));
	} catch {
		return undefined;
	}
}

/** The installed Agent SDK version; the downloaded runtime must match it exactly. */
export function installedClaudeSdkVersion(): string | undefined {
	const root = claudeSdkPackageRoot();
	if (!root) {
		return undefined;
	}
	try {
		const parsed: unknown = JSON.parse(readFileSync(path.join(root, "package.json"), "utf8"));
		const version = typeof parsed === "object" && parsed !== null ? (parsed as Record<string, unknown>).version : undefined;
		return typeof version === "string" && VERSION_PATTERN.test(version) ? version : undefined;
	} catch {
		return undefined;
	}
}

/** The executable of one exact downloaded version, when it is still there. */
export function installedClaudeRuntimePath(root: string | undefined, version: string | undefined): string | undefined {
	if (!root || !version || !VERSION_PATTERN.test(version)) {
		return undefined;
	}
	const executable = path.join(path.resolve(root), version, claudeRuntimeExecutableName());
	return existsSync(executable) ? executable : undefined;
}

/** The version the last install recorded, for diagnostics and "update available" checks. */
export function recordedClaudeRuntimeVersion(root: string | undefined): string | undefined {
	if (!root) {
		return undefined;
	}
	try {
		const record: unknown = JSON.parse(readFileSync(path.join(root, CURRENT_FILE), "utf8"));
		const version = typeof record === "object" && record !== null ? (record as Record<string, unknown>).version : undefined;
		return typeof version === "string" && VERSION_PATTERN.test(version) ? version : undefined;
	} catch {
		return undefined;
	}
}

export interface InstalledClaudeRuntime {
	version: string;
	path: string;
}

function compareVersions(left: string, right: string): number {
	const parts = (value: string): number[] => value.split(/[.-]/).map(part => Number.parseInt(part, 10) || 0);
	const a = parts(left);
	const b = parts(right);
	for (let index = 0; index < Math.max(a.length, b.length); index++) {
		const difference = (a[index] ?? 0) - (b[index] ?? 0);
		if (difference !== 0) {
			return difference;
		}
	}
	return 0;
}

/** The newest downloaded version that still has its executable, including a mismatched SDK version. */
export function latestInstalledClaudeRuntime(root: string | undefined): InstalledClaudeRuntime | undefined {
	if (!root) {
		return undefined;
	}
	let names: string[];
	try {
		names = readdirSync(root);
	} catch {
		return undefined;
	}
	const executable = claudeRuntimeExecutableName();
	const versions = names
		.filter(name => VERSION_PATTERN.test(name) && existsSync(path.join(root, name, executable)))
		.sort(compareVersions);
	const version = versions.at(-1);
	return version ? { version, path: path.join(root, version, executable) } : undefined;
}

/** The resolution order: a configured/extension/SDK binary, the exact downloaded version, then the newest other download. */
export function chooseClaudeRuntimeBinary(
	preferred: string | undefined,
	exactDownloaded: string | undefined,
	fallbackDownloaded: InstalledClaudeRuntime | undefined
): string | undefined {
	return preferred ?? exactDownloaded ?? fallbackDownloaded?.path;
}

/** The downloaded version a resolved executable belongs to, if it is inside the runtime root. */
export function downloadedClaudeRuntimeVersionForPath(root: string | undefined, executable: string | undefined): string | undefined {
	if (!root || !executable) {
		return undefined;
	}
	const relative = path.relative(path.resolve(root), path.resolve(executable));
	if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) {
		return undefined;
	}
	const [version] = relative.split(path.sep);
	return version && VERSION_PATTERN.test(version) ? version : undefined;
}

/**
 * Where one package entry goes, or undefined for entries the runtime does not need. The package
 * holds only claude(.exe), README.md, LICENSE.md and package.json; the executable and license are
 * kept. Unsafe names throw instead of being skipped.
 */
export function claudeRuntimeEntryPath(
	name: string,
	destination: string,
	executable: string = claudeRuntimeExecutableName()
): string | undefined {
	const normalized = name.replace(/^\.\//, "");
	if (!normalized.startsWith("package/")) {
		return undefined;
	}
	const relative = normalized.slice("package/".length).replace(/\/+$/, "");
	const segments = relative.split("/");
	if (normalized.includes("\\") || /^[A-Za-z]:/.test(normalized) || segments.includes("..")) {
		throw new Error(`The Claude runtime package contains an unsafe path: ${name}`);
	}
	if (relative !== "LICENSE.md" && relative !== "claude" && relative !== "claude.exe") {
		return undefined;
	}
	const file = relative === "LICENSE.md" ? "LICENSE.md" : executable;
	const resolved = path.resolve(destination, file);
	if (!resolved.startsWith(path.resolve(destination) + path.sep)) {
		throw new Error(`The Claude runtime package contains an unsafe path: ${name}`);
	}
	return resolved;
}

export interface ClaudeRuntimeInstallOptions {
	/** The folder the installer owns, e.g. <globalStorage>/claude-runtime. */
	root: string;
	/** Exact version of the installed Agent SDK, never "latest". */
	version: string;
	target?: ClaudeRuntimeTarget;
	fetch?: FetchLike;
	/** Default https://registry.npmjs.org. */
	registry?: string;
	onProgress?: (receivedBytes: number, totalBytes: number | undefined) => void;
	signal?: AbortSignal;
	/** Default: `<executable> --version`; rejects when the binary does not run. */
	verify?: (executable: string) => Promise<string>;
	log?: (event: string, data: Record<string, unknown>) => void;
	/** Downloaded versions to keep because a running process may still use them. */
	keepVersions?: readonly string[];
}

export interface ClaudeRuntimeInstallResult {
	version: string;
	executable: string;
	reportedVersion: string;
}

function defaultVerify(executable: string): Promise<string> {
	return new Promise((resolve, reject) => {
		execFile(executable, ["--version"], { timeout: VERIFY_TIMEOUT_MS, windowsHide: true }, (error, stdout) => {
			if (error) {
				reject(error);
				return;
			}
			resolve(String(stdout));
		});
	});
}

async function readJson(fetchImpl: FetchLike, url: string, signal: AbortSignal | undefined): Promise<Record<string, unknown>> {
	const response = await fetchImpl(url, { signal });
	if (!response.ok) {
		throw new Error(`The npm registry answered ${response.status} for ${url}.`);
	}
	const body: unknown = await response.json();
	if (typeof body !== "object" || body === null) {
		throw new Error(`The npm registry sent no package data for ${url}.`);
	}
	return body as Record<string, unknown>;
}

function uniqueSuffix(): string {
	return randomBytes(6).toString("hex");
}

/** Downloads the platform package for one exact SDK version and records it as current. */
export async function installClaudeRuntime(options: ClaudeRuntimeInstallOptions): Promise<ClaudeRuntimeInstallResult> {
	const target = options.target ?? claudeRuntimeTarget();
	if (!target) {
		throw new Error(`The Claude runtime is not published for ${process.platform}/${process.arch}.`);
	}
	if (!VERSION_PATTERN.test(options.version)) {
		throw new Error("The installed Claude Agent SDK did not name a valid runtime version.");
	}
	const fetchImpl: FetchLike = options.fetch ?? ((url, init) => fetch(url, init));
	const registry = (options.registry ?? "https://registry.npmjs.org").replace(/\/+$/, "");
	const verify = options.verify ?? defaultVerify;
	const root = path.resolve(options.root);
	await fs.mkdir(root, { recursive: true });

	const meta = await readJson(fetchImpl, `${registry}/${target.packageName}/${options.version}`, options.signal);
	const dist = typeof meta.dist === "object" && meta.dist !== null ? meta.dist as Record<string, unknown> : {};
	const tarball = typeof dist.tarball === "string" ? dist.tarball : "";
	const integrity = typeof dist.integrity === "string" ? dist.integrity : "";
	let tarballUrl: URL;
	try {
		tarballUrl = new URL(tarball);
	} catch {
		throw new Error("The npm registry sent no Claude runtime download address.");
	}
	if (tarballUrl.protocol !== "https:" || tarballUrl.host !== new URL(registry).host) {
		throw new Error(`The Claude runtime download address is not on ${new URL(registry).host}: ${tarball}`);
	}
	if (!integrity.startsWith("sha512-")) {
		throw new Error("The npm registry sent no sha512 checksum for the Claude runtime.");
	}
	options.log?.("claude.runtime_install.start", {
		version: options.version,
		target: target.npmSuffix,
	});

	const archive = path.join(root, `download-${uniqueSuffix()}.tgz`);
	const partial = path.join(root, `${options.version}.partial-${uniqueSuffix()}`);
	const destination = path.join(root, options.version);
	try {
		await downloadWithIntegrity(fetchImpl, tarballUrl.toString(), archive, integrity, {
			signal: options.signal,
			onProgress: options.onProgress,
			description: "Claude runtime",
		});
		await extractTarEntries(archive, partial, name => claudeRuntimeEntryPath(name, partial, target.executable), {
			description: "Claude runtime",
		});
		const executableInPartial = path.join(partial, target.executable);
		if (!existsSync(executableInPartial)) {
			throw new Error(`The Claude runtime package has no ${target.executable}.`);
		}
		await fs.rm(destination, { recursive: true, force: true });
		await fs.rename(partial, destination);
		const executable = path.join(destination, target.executable);
		let reportedVersion: string;
		try {
			reportedVersion = (await verify(executable)).trim();
		} catch (error) {
			await fs.rm(destination, { recursive: true, force: true }).catch(() => undefined);
			throw new Error(`The downloaded Claude runtime does not start: ${error instanceof Error ? error.message : String(error)}`, { cause: error });
		}
		if (!reportedVersion) {
			await fs.rm(destination, { recursive: true, force: true }).catch(() => undefined);
			throw new Error("The downloaded Claude runtime did not report a version.");
		}
		const record = `${JSON.stringify({
			version: options.version,
			executable: `${options.version}/${target.executable}`,
			reportedVersion,
			installedAt: new Date().toISOString(),
		}, undefined, 2)}\n`;
		const temporary = path.join(root, `${CURRENT_FILE}.${uniqueSuffix()}.tmp`);
		await fs.writeFile(temporary, record, "utf8");
		await fs.rename(temporary, path.join(root, CURRENT_FILE));
		await removeInstallLeftovers(root, options.version, {
			log: options.log,
			cleanupEvent: "claude.runtime_install.cleanup_skipped",
			keepVersions: options.keepVersions,
		});
		options.log?.("claude.runtime_install.done", { version: options.version, reportedVersion });
		return { version: options.version, executable, reportedVersion };
	} finally {
		await fs.rm(archive, { force: true }).catch(() => undefined);
		await fs.rm(partial, { recursive: true, force: true }).catch(() => undefined);
	}
}

/** The activation check that starts a background download without blocking startup. */
export interface ClaudeRuntimeAutoInstallInput {
	enabled: boolean;
	/** At least one configured Claude account has a login on disk. */
	signedIn: boolean;
	sdkVersion: string | undefined;
	target: ClaudeRuntimeTarget | undefined;
	root: string | undefined;
	/** A setting, the Anthropic extension or the SDK platform package already provides a binary. */
	preferredBinary: string | undefined;
	/** The runtime of this exact SDK version is already downloaded. */
	exactRuntime: string | undefined;
	/** An install was already started in this session. */
	attempted: boolean;
}

export function shouldAutoInstallClaudeRuntime(input: ClaudeRuntimeAutoInstallInput): boolean {
	return input.enabled
		&& input.signedIn
		&& Boolean(input.sdkVersion)
		&& Boolean(input.target)
		&& Boolean(input.root)
		&& !input.preferredBinary
		&& !input.exactRuntime
		&& !input.attempted;
}
