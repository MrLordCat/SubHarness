import { execFile } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { createReadStream, existsSync, readFileSync } from "node:fs";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { Readable } from "node:stream";
import type { ReadableStream as WebReadableStream } from "node:stream/web";
import { createGunzip } from "node:zlib";

// No `vscode` import: the installer also runs under plain node for smoke tests.

export interface CodexCliTarget {
	/** Rust target triple, the folder name under vendor/ in the npm package. */
	triple: string;
	/** Version suffix of the platform package, e.g. 0.171.0-win32-x64. */
	npmSuffix: string;
	executable: string;
}

const TARGETS: Record<string, Omit<CodexCliTarget, "executable">> = {
	"win32-x64": { triple: "x86_64-pc-windows-msvc", npmSuffix: "win32-x64" },
	"win32-arm64": { triple: "aarch64-pc-windows-msvc", npmSuffix: "win32-arm64" },
	"linux-x64": { triple: "x86_64-unknown-linux-musl", npmSuffix: "linux-x64" },
	"linux-arm64": { triple: "aarch64-unknown-linux-musl", npmSuffix: "linux-arm64" },
	"darwin-x64": { triple: "x86_64-apple-darwin", npmSuffix: "darwin-x64" },
	"darwin-arm64": { triple: "aarch64-apple-darwin", npmSuffix: "darwin-arm64" },
};

export function codexCliTarget(platform: NodeJS.Platform = process.platform, arch: string = process.arch): CodexCliTarget | undefined {
	const target = TARGETS[`${platform}-${arch}`];
	return target ? { ...target, executable: platform === "win32" ? "codex.exe" : "codex" } : undefined;
}

const CURRENT_FILE = "current.json";
const VERSION_PATTERN = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.]+)?$/;
const VERIFY_TIMEOUT_MS = 30_000;

/** The executable the last install recorded under root, when it is still there. */
export function installedCodexCliPath(root: string): string | undefined {
	try {
		const record: unknown = JSON.parse(readFileSync(path.join(root, CURRENT_FILE), "utf8"));
		const executable = typeof record === "object" && record !== null ? (record as Record<string, unknown>).executable : undefined;
		if (typeof executable !== "string" || executable.split(/[\\/]/).includes("..")) {
			return undefined;
		}
		const resolved = path.resolve(root, executable);
		return resolved.startsWith(path.resolve(root) + path.sep) && existsSync(resolved) ? resolved : undefined;
	} catch {
		return undefined;
	}
}

/** The version the last install recorded, for "update available" checks. */
export function installedCodexCliVersion(root: string): string | undefined {
	try {
		const record: unknown = JSON.parse(readFileSync(path.join(root, CURRENT_FILE), "utf8"));
		const version = typeof record === "object" && record !== null ? (record as Record<string, unknown>).version : undefined;
		return typeof version === "string" && VERSION_PATTERN.test(version) ? version : undefined;
	} catch {
		return undefined;
	}
}

export type FetchLike = (url: string, init?: { signal?: AbortSignal }) => Promise<Response>;

export interface DownloadWithIntegrityOptions {
	signal?: AbortSignal;
	onProgress?: (receivedBytes: number, totalBytes: number | undefined) => void;
	/** Used in error messages; default "Codex CLI". */
	description?: string;
}

export interface CodexCliInstallOptions {
	/** The folder the installer owns, e.g. <globalStorage>/codex-cli. */
	root: string;
	/** Default: the registry's latest version. */
	version?: string;
	fetch?: FetchLike;
	/** Default https://registry.npmjs.org. */
	registry?: string;
	onProgress?: (receivedBytes: number, totalBytes: number | undefined) => void;
	signal?: AbortSignal;
	/** Default: `<executable> --version`; rejects when the binary does not run. */
	verify?: (executable: string) => Promise<string>;
	log?: (event: string, data: Record<string, unknown>) => void;
	target?: CodexCliTarget;
}

export interface CodexCliInstallResult {
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

async function writeAll(file: fs.FileHandle, data: Uint8Array): Promise<void> {
	let offset = 0;
	while (offset < data.length) {
		const { bytesWritten } = await file.write(data, offset, data.length - offset);
		offset += bytesWritten;
	}
}

function uniqueSuffix(): string {
	return randomBytes(6).toString("hex");
}

/** The newest published Codex CLI version. */
export async function latestCodexCliVersion(options: Pick<CodexCliInstallOptions, "fetch" | "registry" | "signal"> = {}): Promise<string> {
	const fetchImpl: FetchLike = options.fetch ?? ((url, init) => fetch(url, init));
	const registry = (options.registry ?? "https://registry.npmjs.org").replace(/\/+$/, "");
	const version = (await readJson(fetchImpl, `${registry}/@openai/codex/latest`, options.signal)).version;
	if (typeof version !== "string" || !VERSION_PATTERN.test(version)) {
		throw new Error("The npm registry did not name a valid Codex CLI version.");
	}
	return version;
}

/** Downloads, verifies and unpacks the platform package, then records it as the current CLI. */
export async function installCodexCli(options: CodexCliInstallOptions): Promise<CodexCliInstallResult> {
	const target = options.target ?? codexCliTarget();
	if (!target) {
		throw new Error(`Codex CLI is not published for ${process.platform}/${process.arch}.`);
	}
	const fetchImpl: FetchLike = options.fetch ?? ((url, init) => fetch(url, init));
	const registry = (options.registry ?? "https://registry.npmjs.org").replace(/\/+$/, "");
	const verify = options.verify ?? defaultVerify;
	const root = path.resolve(options.root);
	await fs.mkdir(root, { recursive: true });

	const version = options.version ?? await latestCodexCliVersion({ fetch: fetchImpl, registry, signal: options.signal });
	if (!VERSION_PATTERN.test(version)) {
		throw new Error("The npm registry did not name a valid Codex CLI version.");
	}
	const meta = await readJson(fetchImpl, `${registry}/@openai/codex/${version}-${target.npmSuffix}`, options.signal);
	const dist = typeof meta.dist === "object" && meta.dist !== null ? meta.dist as Record<string, unknown> : {};
	const tarball = typeof dist.tarball === "string" ? dist.tarball : "";
	const integrity = typeof dist.integrity === "string" ? dist.integrity : "";
	let tarballUrl: URL;
	try {
		tarballUrl = new URL(tarball);
	} catch {
		throw new Error("The npm registry sent no Codex CLI download address.");
	}
	if (tarballUrl.protocol !== "https:" || tarballUrl.host !== new URL(registry).host) {
		throw new Error(`The Codex CLI download address is not on ${new URL(registry).host}: ${tarball}`);
	}
	if (!integrity.startsWith("sha512-")) {
		throw new Error("The npm registry sent no sha512 checksum for the Codex CLI.");
	}
	options.log?.("codex.cli_install.start", { version, target: target.npmSuffix });

	const archive = path.join(root, `download-${uniqueSuffix()}.tgz`);
	const partial = path.join(root, `${version}.partial-${uniqueSuffix()}`);
	const destination = path.join(root, version);
	try {
		await downloadWithIntegrity(fetchImpl, tarballUrl.toString(), archive, integrity, {
			signal: options.signal,
			onProgress: options.onProgress,
		});
		await extractVendor(archive, partial, target.triple);
		const executableInPartial = path.join(partial, "bin", target.executable);
		if (!existsSync(executableInPartial)) {
			throw new Error(`The Codex CLI package has no bin/${target.executable}.`);
		}
		await fs.rm(destination, { recursive: true, force: true });
		await fs.rename(partial, destination);
		const executable = path.join(destination, "bin", target.executable);
		let reportedVersion: string;
		try {
			reportedVersion = (await verify(executable)).trim();
		} catch (error) {
			await fs.rm(destination, { recursive: true, force: true }).catch(() => undefined);
			throw new Error(`The downloaded Codex CLI does not start: ${error instanceof Error ? error.message : String(error)}`, { cause: error });
		}
		const record = `${JSON.stringify({ version, executable: `${version}/bin/${target.executable}`, installedAt: new Date().toISOString() }, undefined, 2)}\n`;
		const temporary = path.join(root, `${CURRENT_FILE}.${uniqueSuffix()}.tmp`);
		await fs.writeFile(temporary, record, "utf8");
		await fs.rename(temporary, path.join(root, CURRENT_FILE));
		await removeInstallLeftovers(root, version, { log: options.log });
		options.log?.("codex.cli_install.done", { version, reportedVersion });
		return { version, executable, reportedVersion };
	} finally {
		await fs.rm(archive, { force: true }).catch(() => undefined);
		await fs.rm(partial, { recursive: true, force: true }).catch(() => undefined);
	}
}

export async function downloadWithIntegrity(
	fetchImpl: FetchLike,
	url: string,
	file: string,
	integrity: string,
	options: DownloadWithIntegrityOptions = {}
): Promise<void> {
	const description = options.description ?? "Codex CLI";
	const response = await fetchImpl(url, { signal: options.signal });
	if (!response.ok || !response.body) {
		throw new Error(`The ${description} download failed: HTTP ${response.status}.`);
	}
	const length = Number(response.headers.get("content-length"));
	const total = Number.isFinite(length) && length > 0 ? length : undefined;
	const hash = createHash("sha512");
	const handle = await fs.open(file, "w");
	let received = 0;
	try {
		for await (const chunk of Readable.fromWeb(response.body as WebReadableStream<Uint8Array>)) {
			const bytes = chunk as Uint8Array;
			hash.update(bytes);
			await writeAll(handle, bytes);
			received += bytes.length;
			options.onProgress?.(received, total);
		}
	} finally {
		await handle.close();
	}
	if (`sha512-${hash.digest("base64")}` !== integrity) {
		throw new Error(`The ${description} download failed its integrity check.`);
	}
}

export interface InstallLeftoversOptions {
	log?: (event: string, data: Record<string, unknown>) => void;
	/** Log event for a version that could not be deleted; default "codex.cli_install.cleanup_skipped". */
	cleanupEvent?: string;
	/** Extra versions to keep because a running process may still use them. */
	keepVersions?: readonly string[];
}

/** Deletes older versions, interrupted downloads and partial folders; a running old binary may stay. */
export async function removeInstallLeftovers(root: string, keep: string, options: InstallLeftoversOptions = {}): Promise<void> {
	let names: string[];
	try {
		names = await fs.readdir(root);
	} catch {
		return;
	}
	const kept = new Set([keep, ...(options.keepVersions ?? [])]);
	for (const name of names) {
		if (kept.has(name) || name === CURRENT_FILE) {
			continue;
		}
		const stale = VERSION_PATTERN.test(name) || name.includes(".partial-") || name.startsWith("download-") || name.endsWith(".tmp");
		if (!stale) {
			continue;
		}
		try {
			await fs.rm(path.join(root, name), { recursive: true, force: true });
		} catch (error) {
			options.log?.(options.cleanupEvent ?? "codex.cli_install.cleanup_skipped", { name, message: error instanceof Error ? error.message : String(error) });
		}
	}
}

interface TarHeader {
	name: string;
	mode: number;
	size: number;
	type: string;
}

function cString(block: Buffer, start: number, length: number): string {
	const end = block.indexOf(0, start);
	return block.toString("utf8", start, end >= 0 && end < start + length ? end : start + length);
}

function octal(block: Buffer, start: number, length: number): number {
	if (block[start] & 0x80) {
		// Base-256: big-endian bytes after the marker bit.
		let value = block[start] & 0x7f;
		for (let index = start + 1; index < start + length; index++) {
			value = value * 256 + block[index];
		}
		return value;
	}
	const text = block.toString("latin1", start, start + length).replace(/[\0 ]+/g, " ").trim();
	return text ? parseInt(text, 8) : 0;
}

export function parseTarHeader(block: Buffer, description = "Codex CLI"): TarHeader {
	let checksum = 0;
	for (let index = 0; index < 512; index++) {
		checksum += index >= 148 && index < 156 ? 0x20 : block[index];
	}
	if (checksum !== octal(block, 148, 8)) {
		throw new Error(`The ${description} package is damaged: a tar header checksum does not match.`);
	}
	let name = cString(block, 0, 100);
	if (block.toString("latin1", 257, 262) === "ustar") {
		const prefix = cString(block, 345, 155);
		if (prefix) {
			name = `${prefix}/${name}`;
		}
	}
	const flag = block[156];
	return { name, mode: octal(block, 100, 8), size: octal(block, 124, 12), type: flag === 0 ? "0" : String.fromCharCode(flag) };
}

/** The "path" record of a pax extended header. */
export function paxPath(data: Buffer): string | undefined {
	let offset = 0;
	let found: string | undefined;
	while (offset < data.length) {
		const space = data.indexOf(0x20, offset);
		if (space < 0) {
			break;
		}
		const length = parseInt(data.toString("latin1", offset, space), 10);
		if (!Number.isFinite(length) || length <= 0) {
			break;
		}
		const record = data.toString("utf8", space + 1, offset + length - 1);
		const equals = record.indexOf("=");
		if (equals > 0 && record.slice(0, equals) === "path") {
			found = record.slice(equals + 1);
		}
		offset += length;
	}
	return found;
}

/** Where a wanted archive entry goes, or undefined for entries the CLI does not need. */
export function vendorEntryPath(name: string, triple: string, destination: string): string | undefined {
	const normalized = name.replace(/^\.\//, "");
	const prefix = `package/vendor/${triple}/`;
	if (!normalized.startsWith(prefix) || normalized.startsWith(`${prefix}codex-resources/voice/`)) {
		return undefined;
	}
	const relative = normalized.slice(prefix.length).replace(/\/+$/, "");
	if (!relative) {
		return undefined;
	}
	const segments = relative.split("/");
	if (relative.includes("\\") || /^[A-Za-z]:/.test(relative) || segments.includes("..")) {
		throw new Error(`The Codex CLI package contains an unsafe path: ${name}`);
	}
	const resolved = path.resolve(destination, ...segments.filter(segment => segment && segment !== "."));
	if (!resolved.startsWith(path.resolve(destination) + path.sep)) {
		throw new Error(`The Codex CLI package contains an unsafe path: ${name}`);
	}
	return resolved;
}

export interface TarExtractOptions {
	/** Used in error messages; default "Codex CLI". */
	description?: string;
}

/**
 * Streams a gzip tar and writes only the entries mapEntry selects. A mapper returns the destination
 * path of a wanted entry, returns undefined for entries to skip, and throws for unsafe names.
 */
export async function extractTarEntries(
	archive: string,
	destination: string,
	mapEntry: (name: string) => string | undefined,
	options: TarExtractOptions = {}
): Promise<void> {
	const description = options.description ?? "Codex CLI";
	await fs.mkdir(destination, { recursive: true });
	const header = Buffer.alloc(512);
	let headerFill = 0;
	let zeroBlocks = 0;
	let ended = false;
	let nextName: string | undefined;
	let remaining = 0;
	let padding = 0;
	let file: fs.FileHandle | undefined;
	let fileMode = 0;
	let filePath: string | undefined;
	let collect: Buffer[] | undefined;
	let collectType = "";

	const finishEntry = async (): Promise<void> => {
		if (file) {
			await file.close();
			file = undefined;
			if (process.platform !== "win32" && filePath) {
				await fs.chmod(filePath, fileMode & 0o777 || 0o644);
			}
		}
		if (collect) {
			const data = Buffer.concat(collect);
			nextName = collectType === "x" ? paxPath(data) ?? nextName : data.toString("utf8").replace(/\0+$/, "");
			collect = undefined;
		}
		filePath = undefined;
	};

	const source = createReadStream(archive);
	const gunzip = createGunzip();
	source.on("error", error => gunzip.destroy(error));
	try {
		for await (const chunk of source.pipe(gunzip)) {
			const bytes = chunk as Buffer;
			let offset = 0;
			while (offset < bytes.length && !ended) {
				if (remaining > 0) {
					const take = Math.min(remaining, bytes.length - offset);
					const slice = bytes.subarray(offset, offset + take);
					if (file) {
						await writeAll(file, slice);
					} else if (collect) {
						collect.push(Buffer.from(slice));
					}
					remaining -= take;
					offset += take;
					if (remaining === 0) {
						await finishEntry();
					}
					continue;
				}
				if (padding > 0) {
					const take = Math.min(padding, bytes.length - offset);
					padding -= take;
					offset += take;
					continue;
				}
				const take = Math.min(512 - headerFill, bytes.length - offset);
				bytes.copy(header, headerFill, offset, offset + take);
				headerFill += take;
				offset += take;
				if (headerFill < 512) {
					continue;
				}
				headerFill = 0;
				if (header.every(byte => byte === 0)) {
					zeroBlocks += 1;
					ended = zeroBlocks >= 2;
					continue;
				}
				zeroBlocks = 0;
				const entry = parseTarHeader(header, description);
				const name = nextName ?? entry.name;
				remaining = entry.size;
				padding = (512 - (entry.size % 512)) % 512;
				if (entry.type === "x" || entry.type === "L") {
					collect = [];
					collectType = entry.type;
				} else {
					nextName = undefined;
					const wanted = entry.type === "0" || entry.type === "5" ? mapEntry(name) : undefined;
					if (wanted && entry.type === "5") {
						await fs.mkdir(wanted, { recursive: true });
					} else if (wanted) {
						await fs.mkdir(path.dirname(wanted), { recursive: true });
						file = await fs.open(wanted, "w");
						filePath = wanted;
						fileMode = entry.mode;
					}
				}
				if (remaining === 0) {
					await finishEntry();
				}
			}
		}
		if (remaining > 0 || headerFill > 0) {
			throw new Error(`The ${description} package ended in the middle of a file.`);
		}
	} finally {
		await file?.close().catch(() => undefined);
		gunzip.destroy();
		source.destroy();
	}
}

/** Streams the gzip tar and writes only vendor/<triple>, without the voice runtime. */
export async function extractVendor(archive: string, destination: string, triple: string): Promise<void> {
	await extractTarEntries(archive, destination, name => vendorEntryPath(name, triple, destination));
}
