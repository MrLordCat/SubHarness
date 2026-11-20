import * as assert from "node:assert";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { gzipSync } from "node:zlib";
import { codexCliTarget, installCodexCli, installedCodexCliPath, installedCodexCliVersion, type CodexCliTarget } from "../codex/cli-installer";

const TRIPLE = "x86_64-pc-windows-msvc";
const VENDOR = `package/vendor/${TRIPLE}`;
const TARGET: CodexCliTarget = { triple: TRIPLE, npmSuffix: "win32-x64", executable: "codex.exe" };

/** A ustar header; prefix carries the leading directories of a long name. */
function header(name: string, size: number, type = "0", prefix = ""): Buffer {
	const block = Buffer.alloc(512);
	block.write(name, 0, 100, "utf8");
	block.write("0000755\0", 100, 8, "latin1");
	block.write("0000000\0", 108, 8, "latin1");
	block.write("0000000\0", 116, 8, "latin1");
	block.write(`${size.toString(8).padStart(11, "0")}\0`, 124, 12, "latin1");
	block.write("00000000000\0", 136, 12, "latin1");
	block.write("        ", 148, 8, "latin1");
	block.write(type, 156, 1, "latin1");
	block.write("ustar\0", 257, 6, "latin1");
	block.write("00", 263, 2, "latin1");
	if (prefix) {
		block.write(prefix, 345, 155, "utf8");
	}
	let sum = 0;
	for (const byte of block) {
		sum += byte;
	}
	block.write(`${sum.toString(8).padStart(6, "0")}\0 `, 148, 8, "latin1");
	return block;
}

function padded(data: Buffer): Buffer {
	const rest = data.length % 512;
	return rest === 0 ? data : Buffer.concat([data, Buffer.alloc(512 - rest)]);
}

function file(name: string, content: string, prefix = ""): Buffer {
	const data = Buffer.from(content, "utf8");
	return Buffer.concat([header(name, data.length, "0", prefix), padded(data)]);
}

function directory(name: string): Buffer {
	return header(name, 0, "5");
}

/** A pax header naming the next entry; the record length counts its own digits. */
function paxPath(value: string): Buffer {
	const body = ` path=${value}\n`;
	let length = body.length + 1;
	while (`${length}${body}`.length !== length) {
		length += 1;
	}
	const data = Buffer.from(`${length}${body}`, "utf8");
	return Buffer.concat([header("PaxHeader", data.length, "x"), padded(data)]);
}

function tarball(entries: Buffer[]): Buffer {
	return gzipSync(Buffer.concat([...entries, Buffer.alloc(1024)]));
}

function sri(data: Buffer): string {
	return `sha512-${createHash("sha512").update(data).digest("base64")}`;
}

function packageEntries(marker = "codex"): Buffer[] {
	return [
		file("package/package.json", "{}"),
		file("package/README.md", "readme"),
		directory(`${VENDOR}/bin/`),
		file(`${VENDOR}/bin/codex.exe`, marker),
		file(`${VENDOR}/bin/codex-code-mode-host.exe`, "host"),
		file(`${VENDOR}/codex-path/rg.exe`, "rg"),
		file(`${VENDOR}/codex-package.json`, "{\"name\":\"codex\"}"),
		file(`${VENDOR}/codex-resources/voice/gst.dll`, "voice"),
	];
}

interface FakeRegistry {
	fetch: (url: string) => Promise<Response>;
	requests: string[];
}

function fakeRegistry(tgz: Buffer, options: { version?: string; integrity?: string; tarballHost?: string } = {}): FakeRegistry {
	const version = options.version ?? "0.171.0";
	const requests: string[] = [];
	const json = (value: unknown): Response => new Response(JSON.stringify(value), { headers: { "content-type": "application/json" } });
	return {
		requests,
		fetch: async url => {
			requests.push(url);
			if (url.endsWith("/@openai/codex/latest")) {
				return json({ version });
			}
			if (url.endsWith(`/@openai/codex/${version}-win32-x64`)) {
				return json({
					dist: {
						tarball: `https://${options.tarballHost ?? "registry.npmjs.org"}/@openai/codex/-/codex-${version}-win32-x64.tgz`,
						integrity: options.integrity ?? sri(tgz),
					},
				});
			}
			if (url.includes("/-/codex-")) {
				return new Response(new Uint8Array(tgz), { headers: { "content-length": String(tgz.length) } });
			}
			return new Response("not found", { status: 404 });
		},
	};
}

suite("Codex CLI installer", () => {
	let root = "";

	setup(async () => {
		root = await fs.mkdtemp(path.join(os.tmpdir(), "codex-cli-installer-"));
	});

	teardown(async () => {
		await fs.rm(root, { recursive: true, force: true });
	});

	const verify = async (): Promise<string> => "codex-cli 0.171.0\n";

	test("maps platforms to npm packages and target triples", () => {
		assert.deepStrictEqual(codexCliTarget("win32", "x64"), { triple: "x86_64-pc-windows-msvc", npmSuffix: "win32-x64", executable: "codex.exe" });
		assert.deepStrictEqual(codexCliTarget("win32", "arm64"), { triple: "aarch64-pc-windows-msvc", npmSuffix: "win32-arm64", executable: "codex.exe" });
		assert.deepStrictEqual(codexCliTarget("linux", "x64"), { triple: "x86_64-unknown-linux-musl", npmSuffix: "linux-x64", executable: "codex" });
		assert.deepStrictEqual(codexCliTarget("linux", "arm64"), { triple: "aarch64-unknown-linux-musl", npmSuffix: "linux-arm64", executable: "codex" });
		assert.deepStrictEqual(codexCliTarget("darwin", "x64"), { triple: "x86_64-apple-darwin", npmSuffix: "darwin-x64", executable: "codex" });
		assert.deepStrictEqual(codexCliTarget("darwin", "arm64"), { triple: "aarch64-apple-darwin", npmSuffix: "darwin-arm64", executable: "codex" });
		assert.strictEqual(codexCliTarget("aix", "ppc64"), undefined);
		assert.strictEqual(installedCodexCliPath(path.join(os.tmpdir(), "codex-cli-missing-root")), undefined);
	});

	test("downloads the latest package, verifies it and keeps only the CLI files", async () => {
		const tgz = tarball(packageEntries());
		const registry = fakeRegistry(tgz);
		const progress: Array<[number, number | undefined]> = [];
		const verified: string[] = [];
		const result = await installCodexCli({
			root,
			target: TARGET,
			fetch: registry.fetch,
			verify: async executable => {
				verified.push(executable);
				return verify();
			},
			onProgress: (received, total) => progress.push([received, total]),
		});
		const version = path.join(root, "0.171.0");
		assert.deepStrictEqual(result, { version: "0.171.0", executable: path.join(version, "bin", "codex.exe"), reportedVersion: "codex-cli 0.171.0" });
		assert.deepStrictEqual(verified, [result.executable]);
		assert.strictEqual(await fs.readFile(path.join(version, "bin", "codex.exe"), "utf8"), "codex");
		assert.strictEqual(await fs.readFile(path.join(version, "bin", "codex-code-mode-host.exe"), "utf8"), "host");
		assert.strictEqual(await fs.readFile(path.join(version, "codex-path", "rg.exe"), "utf8"), "rg");
		assert.strictEqual(await fs.readFile(path.join(version, "codex-package.json"), "utf8"), "{\"name\":\"codex\"}");
		assert.ok(!existsSync(path.join(version, "codex-resources", "voice")), "the voice runtime is left out");
		assert.ok(!existsSync(path.join(version, "README.md")) && !existsSync(path.join(root, "package")));
		assert.strictEqual(installedCodexCliPath(root), result.executable);
		assert.strictEqual(installedCodexCliVersion(root), "0.171.0");
		assert.deepStrictEqual((await fs.readdir(root)).sort(), ["0.171.0", "current.json"]);
		assert.deepStrictEqual(progress.at(-1), [tgz.length, tgz.length]);
	});

	test("reads long names from the ustar prefix and from pax headers", async () => {
		const longName = `${"n".repeat(120)}.txt`;
		const tgz = tarball([
			...packageEntries(),
			file("codex-command-runner.exe", "runner", `${VENDOR}/codex-resources`),
			paxPath(`${VENDOR}/codex-resources/${longName}`),
			file("cut-name", "long"),
		]);
		await installCodexCli({ root, target: TARGET, fetch: fakeRegistry(tgz).fetch, verify });
		const resources = path.join(root, "0.171.0", "codex-resources");
		assert.strictEqual(await fs.readFile(path.join(resources, "codex-command-runner.exe"), "utf8"), "runner");
		assert.strictEqual(await fs.readFile(path.join(resources, longName), "utf8"), "long");
		assert.ok(!existsSync(path.join(root, "0.171.0", "cut-name")));
	});

	test("rejects a download whose checksum does not match", async () => {
		const tgz = tarball(packageEntries());
		await assert.rejects(
			installCodexCli({ root, target: TARGET, fetch: fakeRegistry(tgz, { integrity: sri(Buffer.from("other")) }).fetch, verify }),
			/integrity check/,
		);
		assert.deepStrictEqual(await fs.readdir(root), []);
		assert.strictEqual(installedCodexCliPath(root), undefined);
	});

	test("rejects an entry that leaves the install folder", async () => {
		const tgz = tarball([...packageEntries(), file(`${VENDOR}/../../evil.txt`, "evil")]);
		await assert.rejects(installCodexCli({ root, target: TARGET, fetch: fakeRegistry(tgz).fetch, verify }), /unsafe path/);
		assert.deepStrictEqual(await fs.readdir(root), []);
		assert.ok(!existsSync(path.join(root, "evil.txt")) && !existsSync(path.join(path.dirname(root), "evil.txt")));
	});

	test("keeps nothing when the downloaded CLI does not start", async () => {
		const tgz = tarball(packageEntries());
		await assert.rejects(
			installCodexCli({ root, target: TARGET, fetch: fakeRegistry(tgz).fetch, verify: async () => { throw new Error("bad binary"); } }),
			/does not start: bad binary/,
		);
		assert.deepStrictEqual(await fs.readdir(root), []);
	});

	test("replaces an older version", async () => {
		await installCodexCli({ root, target: TARGET, fetch: fakeRegistry(tarball(packageEntries("old"))).fetch, verify });
		const result = await installCodexCli({ root, target: TARGET, fetch: fakeRegistry(tarball(packageEntries("new")), { version: "0.172.0" }).fetch, verify });
		assert.strictEqual(result.version, "0.172.0");
		assert.deepStrictEqual((await fs.readdir(root)).sort(), ["0.172.0", "current.json"]);
		assert.strictEqual(await fs.readFile(installedCodexCliPath(root) ?? "", "utf8"), "new");
	});

	test("refuses a download address on another host", async () => {
		const registry = fakeRegistry(tarball(packageEntries()), { tarballHost: "evil.example.com" });
		await assert.rejects(installCodexCli({ root, target: TARGET, fetch: registry.fetch, verify }), /not on registry\.npmjs\.org/);
		assert.ok(!registry.requests.some(url => url.includes("/-/codex-")), "the tarball is never requested");
		assert.deepStrictEqual(await fs.readdir(root), []);
	});
});
