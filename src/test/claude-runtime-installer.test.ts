import * as assert from "node:assert";
import { existsSync, readFileSync } from "node:fs";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import * as vscode from "vscode";

import { ClaudeChatModelProvider } from "../claude/claude-provider";
import {
	invalidateClaudeCodeBinaryCache,
	resolveClaudeCodeBinary,
	resolvePreferredClaudeCodeBinary,
	setClaudeRuntimeStorage,
} from "../claude/app-server-client";
import {
	CLAUDE_RUNTIME_MISSING_MESSAGE,
	chooseClaudeRuntimeBinary,
	claudeRuntimeCandidates,
	claudeRuntimeEntryPath,
	claudeRuntimeTarget,
	claudeSdkPackageRoot,
	downloadedClaudeRuntimeVersionForPath,
	installClaudeRuntime,
	installedClaudeRuntimePath,
	installedClaudeSdkVersion,
	latestInstalledClaudeRuntime,
	preferMuslRuntime,
	recordedClaudeRuntimeVersion,
	shouldAutoInstallClaudeRuntime,
	type ClaudeRuntimeAutoInstallInput,
	type ClaudeRuntimeTarget,
} from "../claude/runtime-installer";
import {
	fakeRegistry,
	jsonResponse,
	sri,
	tarFile as file,
	tarGzip as tarball,
	tarballResponse,
	type FakeRegistry,
} from "./npm-tar-fixtures";

const VERSION = "0.3.240";
const TARGET: ClaudeRuntimeTarget = claudeRuntimeTarget()!;
const EXECUTABLE = TARGET.executable;

function packageEntries(marker = "claude"): Buffer[] {
	return [
		file("package/package.json", "{}"),
		file("package/README.md", "readme"),
		file("package/LICENSE.md", "license"),
		file(`package/${EXECUTABLE}`, marker),
	];
}

function fakeRuntimeRegistry(
	tgz: Buffer,
	options: { version?: string; integrity?: string; tarballHost?: string } = {}
): FakeRegistry {
	const version = options.version ?? VERSION;
	const tarballName = `claude-agent-sdk-${TARGET.npmSuffix}-${version}.tgz`;
	return fakeRegistry([
		{
			suffix: `/${TARGET.packageName}/${version}`,
			respond: () => jsonResponse({
				dist: {
					tarball: `https://${options.tarballHost ?? "registry.npmjs.org"}/@anthropic-ai/claude-agent-sdk-${TARGET.npmSuffix}/-/${tarballName}`,
					integrity: options.integrity ?? sri(tgz),
				},
			}),
		},
		{ suffix: `/-/${tarballName}`, respond: () => tarballResponse(tgz) },
	]);
}

suite("Claude runtime installer", () => {
	let root = "";

	setup(async () => {
		root = await fs.mkdtemp(path.join(os.tmpdir(), "claude-runtime-installer-"));
	});

	teardown(async () => {
		await fs.rm(root, { recursive: true, force: true });
		setClaudeRuntimeStorage(undefined);
		invalidateClaudeCodeBinaryCache();
	});

	const verify = async (): Promise<string> => "2.0.42 (Claude Code)\n";

	test("selects the platform package and the musl variant like the Agent SDK", () => {
		assert.deepStrictEqual(claudeRuntimeTarget("win32", "x64", false), {
			npmSuffix: "win32-x64",
			packageName: "@anthropic-ai/claude-agent-sdk-win32-x64",
			folderName: "claude-agent-sdk-win32-x64",
			executable: "claude.exe",
		});
		assert.deepStrictEqual(claudeRuntimeTarget("win32", "arm64", false), {
			npmSuffix: "win32-arm64",
			packageName: "@anthropic-ai/claude-agent-sdk-win32-arm64",
			folderName: "claude-agent-sdk-win32-arm64",
			executable: "claude.exe",
		});
		assert.strictEqual(claudeRuntimeTarget("darwin", "arm64", false)?.executable, "claude");
		assert.deepStrictEqual(
			claudeRuntimeCandidates("linux", "x64", true).map(target => target.npmSuffix),
			["linux-x64-musl", "linux-x64"]
		);
		assert.deepStrictEqual(
			claudeRuntimeCandidates("linux", "arm64", false).map(target => target.npmSuffix),
			["linux-arm64", "linux-arm64-musl"]
		);
		assert.deepStrictEqual(claudeRuntimeCandidates("aix", "ppc64", false), []);
		assert.strictEqual(claudeRuntimeTarget("aix", "ppc64", false), undefined);
	});

	test("prefers musl only on Linux without glibc", () => {
		assert.strictEqual(preferMuslRuntime("linux", { header: { glibcVersionRuntime: "2.31" } }), false);
		assert.strictEqual(preferMuslRuntime("linux", { header: {} }), true);
		assert.strictEqual(preferMuslRuntime("win32", { header: {} }), false);
		assert.strictEqual(preferMuslRuntime("darwin", { header: {} }), false);
	});

	test("pins the runtime to the installed Agent SDK version", () => {
		const sdkRoot = claudeSdkPackageRoot();
		assert.ok(sdkRoot, "the Agent SDK is installed next to the extension");
		const pkg = JSON.parse(readFileSync(path.join(sdkRoot!, "package.json"), "utf8")) as { version: string };
		assert.strictEqual(installedClaudeSdkVersion(), pkg.version);
		assert.match(pkg.version, /^\d+\.\d+\.\d+/);
	});

	test("downloads the exact version, verifies it and keeps only the executable and license", async () => {
		const tgz = tarball(packageEntries());
		const registry = fakeRuntimeRegistry(tgz);
		const progress: Array<[number, number | undefined]> = [];
		const verified: string[] = [];
		const result = await installClaudeRuntime({
			root,
			version: VERSION,
			target: TARGET,
			fetch: registry.fetch,
			verify: async executable => {
				verified.push(executable);
				return verify();
			},
			onProgress: (received, total) => progress.push([received, total]),
		});
		const versionDir = path.join(root, VERSION);
		assert.deepStrictEqual(result, {
			version: VERSION,
			executable: path.join(versionDir, EXECUTABLE),
			reportedVersion: "2.0.42 (Claude Code)",
		});
		assert.deepStrictEqual(verified, [result.executable]);
		assert.strictEqual(await fs.readFile(result.executable, "utf8"), "claude");
		assert.strictEqual(await fs.readFile(path.join(versionDir, "LICENSE.md"), "utf8"), "license");
		assert.ok(!existsSync(path.join(versionDir, "README.md")), "the readme is left out");
		assert.ok(!existsSync(path.join(versionDir, "package.json")), "the package metadata is left out");
		assert.ok(!existsSync(path.join(root, "package")), "the package folder is not unpacked");
		assert.strictEqual(installedClaudeRuntimePath(root, VERSION), result.executable);
		assert.strictEqual(recordedClaudeRuntimeVersion(root), VERSION);
		assert.deepStrictEqual(latestInstalledClaudeRuntime(root), { version: VERSION, path: result.executable });
		assert.strictEqual(downloadedClaudeRuntimeVersionForPath(root, result.executable), VERSION);
		assert.deepStrictEqual((await fs.readdir(root)).sort(), [VERSION, "current.json"]);
		assert.deepStrictEqual(progress.at(-1), [tgz.length, tgz.length]);
		assert.ok(registry.requests.every(url => !url.endsWith("/latest")), "the installer never asks for latest");
		assert.ok(registry.requests.some(url => url.endsWith(`/${TARGET.packageName}/${VERSION}`)), "the metadata is for the exact version");
	});

	test("rejects a download whose checksum does not match", async () => {
		const tgz = tarball(packageEntries());
		const registry = fakeRuntimeRegistry(tgz, { integrity: sri(Buffer.from("other")) });
		await assert.rejects(
			installClaudeRuntime({ root, version: VERSION, target: TARGET, fetch: registry.fetch, verify }),
			/integrity check/
		);
		assert.deepStrictEqual(await fs.readdir(root), []);
		assert.strictEqual(installedClaudeRuntimePath(root, VERSION), undefined);
	});

	test("rejects an entry that leaves the install folder", async () => {
		const tgz = tarball([...packageEntries(), file("package/../../evil.txt", "evil")]);
		await assert.rejects(
			installClaudeRuntime({ root, version: VERSION, target: TARGET, fetch: fakeRuntimeRegistry(tgz).fetch, verify }),
			/unsafe path/
		);
		assert.deepStrictEqual(await fs.readdir(root), []);
		assert.ok(!existsSync(path.join(root, "evil.txt")));
		assert.ok(!existsSync(path.join(path.dirname(root), "evil.txt")));
	});

	test("keeps nothing when the downloaded runtime does not start or reports no version", async () => {
		const tgz = tarball(packageEntries());
		await assert.rejects(
			installClaudeRuntime({
				root,
				version: VERSION,
				target: TARGET,
				fetch: fakeRuntimeRegistry(tgz).fetch,
				verify: async () => {
					throw new Error("bad binary");
				},
			}),
			/does not start: bad binary/
		);
		assert.deepStrictEqual(await fs.readdir(root), []);
		await assert.rejects(
			installClaudeRuntime({
				root,
				version: VERSION,
				target: TARGET,
				fetch: fakeRuntimeRegistry(tgz).fetch,
				verify: async () => "   ",
			}),
			/did not report a version/
		);
		assert.deepStrictEqual(await fs.readdir(root), []);
	});

	test("removes older versions but keeps the one still in use", async () => {
		await installClaudeRuntime({
			root,
			version: "0.3.239",
			target: TARGET,
			fetch: fakeRuntimeRegistry(tarball(packageEntries("old")), { version: "0.3.239" }).fetch,
			verify,
		});
		await installClaudeRuntime({
			root,
			version: VERSION,
			target: TARGET,
			fetch: fakeRuntimeRegistry(tarball(packageEntries("kept")), { version: VERSION }).fetch,
			verify,
			keepVersions: ["0.3.239"],
		});
		assert.deepStrictEqual((await fs.readdir(root)).sort(), ["0.3.239", VERSION, "current.json"]);
		assert.strictEqual(await fs.readFile(installedClaudeRuntimePath(root, "0.3.239")!, "utf8"), "old");
		await installClaudeRuntime({
			root,
			version: "0.3.241",
			target: TARGET,
			fetch: fakeRuntimeRegistry(tarball(packageEntries("new")), { version: "0.3.241" }).fetch,
			verify,
		});
		assert.deepStrictEqual((await fs.readdir(root)).sort(), ["0.3.241", "current.json"]);
	});

	test("refuses a download address on another host", async () => {
		const registry = fakeRuntimeRegistry(tarball(packageEntries()), { tarballHost: "evil.example.com" });
		await assert.rejects(
			installClaudeRuntime({ root, version: VERSION, target: TARGET, fetch: registry.fetch, verify }),
			/not on registry\.npmjs\.org/
		);
		assert.ok(!registry.requests.some(url => url.includes("/-/")), "the tarball is never requested");
		assert.deepStrictEqual(await fs.readdir(root), []);
	});

	test("builds package entries safely", () => {
		const destination = path.join(root, "unpacked");
		assert.strictEqual(claudeRuntimeEntryPath(`package/${EXECUTABLE}`, destination, EXECUTABLE), path.join(destination, EXECUTABLE));
		assert.strictEqual(claudeRuntimeEntryPath("package/LICENSE.md", destination, EXECUTABLE), path.join(destination, "LICENSE.md"));
		assert.strictEqual(claudeRuntimeEntryPath("package/README.md", destination, EXECUTABLE), undefined);
		assert.strictEqual(claudeRuntimeEntryPath("package", destination, EXECUTABLE), undefined);
		assert.throws(() => claudeRuntimeEntryPath("package/../../evil.txt", destination, EXECUTABLE), /unsafe path/);
	});
});

suite("Claude runtime resolution", () => {
	let root = "";

	setup(async () => {
		root = await fs.mkdtemp(path.join(os.tmpdir(), "claude-runtime-resolution-"));
	});

	teardown(async () => {
		await fs.rm(root, { recursive: true, force: true });
		setClaudeRuntimeStorage(undefined);
		invalidateClaudeCodeBinaryCache();
	});

	test("prefers the configured path, then the Anthropic extension, then the downloaded runtime", async () => {
		const configured = path.join(root, "configured", EXECUTABLE);
		const extensionExecutable = path.join(root, "extension", "resources", "native-binary", EXECUTABLE);
		const downloaded = path.join(root, "downloaded", VERSION, EXECUTABLE);
		for (const executable of [configured, extensionExecutable, downloaded]) {
			await fs.mkdir(path.dirname(executable), { recursive: true });
			await fs.writeFile(executable, "fixture");
		}
		const config = vscode.workspace.getConfiguration("llamacpp");
		const original = config.get<string>("claudeCliPath", "");
		try {
			await config.update("claudeCliPath", configured, vscode.ConfigurationTarget.Global);
			invalidateClaudeCodeBinaryCache();
			assert.strictEqual(resolveClaudeCodeBinary({ extensionPath: path.join(root, "extension") }), configured);
			assert.strictEqual(resolvePreferredClaudeCodeBinary({ extensionPath: path.join(root, "extension") }), configured);

			await config.update("claudeCliPath", undefined, vscode.ConfigurationTarget.Global);
			invalidateClaudeCodeBinaryCache();
			assert.strictEqual(resolvePreferredClaudeCodeBinary({ extensionPath: path.join(root, "extension") }), extensionExecutable);
		} finally {
			await config.update("claudeCliPath", original || undefined, vscode.ConfigurationTarget.Global);
			invalidateClaudeCodeBinaryCache();
		}
	});

	test("keeps the preferred, exact and fallback order", () => {
		const exact = path.join(root, "exact", EXECUTABLE);
		const fallback = { version: "0.3.239", path: path.join(root, "fallback", EXECUTABLE) };
		assert.strictEqual(chooseClaudeRuntimeBinary("preferred", exact, fallback), "preferred");
		assert.strictEqual(chooseClaudeRuntimeBinary(undefined, exact, fallback), exact);
		assert.strictEqual(chooseClaudeRuntimeBinary(undefined, undefined, fallback), fallback.path);
		assert.strictEqual(chooseClaudeRuntimeBinary(undefined, undefined, undefined), undefined);
	});

	test("decides when to download in the background", () => {
		const base: ClaudeRuntimeAutoInstallInput = {
			enabled: true,
			signedIn: true,
			sdkVersion: VERSION,
			target: TARGET,
			root: "runtime-root",
			preferredBinary: undefined,
			exactRuntime: undefined,
			attempted: false,
		};
		assert.strictEqual(shouldAutoInstallClaudeRuntime(base), true);
		const blocked: Array<Partial<ClaudeRuntimeAutoInstallInput>> = [
			{ enabled: false },
			{ signedIn: false },
			{ sdkVersion: undefined },
			{ target: undefined },
			{ root: undefined },
			{ preferredBinary: "C:\\claude.exe" },
			{ exactRuntime: "C:\\runtime\\0.3.240\\claude.exe" },
			{ attempted: true },
		];
		for (const patch of blocked) {
			assert.strictEqual(shouldAutoInstallClaudeRuntime({ ...base, ...patch }), false, JSON.stringify(patch));
		}
	});

	test("fails fast with the install command when the runtime is missing", async () => {
		assert.strictEqual(
			CLAUDE_RUNTIME_MISSING_MESSAGE,
			'The Claude runtime is not installed yet. Run "SubHarness: Install Claude Runtime" (or sign in) to download it.'
		);
		const provider = new ClaudeChatModelProvider("test", undefined, undefined, { resolveExecutable: () => undefined });
		const tokenSource = new vscode.CancellationTokenSource();
		try {
			assert.strictEqual(provider.statusSummary, "Runtime not installed");
			const status = await provider.refreshStatus();
			assert.deepStrictEqual(status, { state: "signedOut", summary: "Runtime not installed" });
			const model = {
				id: "claude::claude-opus-5",
				name: "Claude",
				family: "claude",
				version: "1",
				maxInputTokens: 200_000,
				maxOutputTokens: 8_000,
				capabilities: { toolCalling: true },
			} as unknown as vscode.LanguageModelChatInformation;
			await assert.rejects(
				provider.provideLanguageModelChatResponse(
					model,
					[],
					{ toolMode: vscode.LanguageModelChatToolMode.Auto, tools: [] } as vscode.ProvideLanguageModelChatResponseOptions,
					{ report: () => undefined },
					tokenSource.token
				),
				error => error instanceof Error && error.message === CLAUDE_RUNTIME_MISSING_MESSAGE
			);
		} finally {
			tokenSource.dispose();
			provider.dispose();
		}
	});
});
