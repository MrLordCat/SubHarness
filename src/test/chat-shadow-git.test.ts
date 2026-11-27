import * as assert from "node:assert";
import { execFile } from "node:child_process";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

import { MAX_IGNORED_FILE_BYTES, ShadowGitRepo, findGitExecutable } from "../chat/changes/shadow-git";

function runGit(gitPath: string, args: string[]): Promise<void> {
	return new Promise<void>((resolve, reject) => {
		execFile(gitPath, args, { windowsHide: true, encoding: "utf8" }, error => {
			if (error) {
				reject(error);
			} else {
				resolve();
			}
		});
	});
}

suite("Shadow git repository", () => {
	let gitPath: string | undefined;
	let tempRoot = "";
	let project = "";
	let shadowDir = "";
	let repo: ShadowGitRepo | undefined;

	const getRepo = (): ShadowGitRepo => {
		assert.ok(repo);
		return repo;
	};

	setup(async function () {
		this.timeout(60_000);
		gitPath = await findGitExecutable();
		if (!gitPath) {
			return;
		}
		tempRoot = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "llama-shadow-git-")));
		project = path.join(tempRoot, "project");
		shadowDir = path.join(tempRoot, "shadow");
		await fs.mkdir(path.join(project, "node_modules"), { recursive: true });
		await fs.writeFile(path.join(project, ".gitattributes"), "* text=auto\n");
		await fs.writeFile(path.join(project, ".gitignore"), "ignored.txt\n");
		await fs.writeFile(path.join(project, "a.txt"), "one\r\ntwo\r\n");
		await fs.writeFile(path.join(project, "c.txt"), "see\n");
		await runGit(gitPath, ["init", "--quiet", project]);
		await runGit(gitPath, [
			"-C",
			project,
			"-c",
			"user.name=Shadow Test",
			"-c",
			"user.email=shadow@example.com",
			"add",
			"-A",
		]);
		await runGit(gitPath, [
			"-C",
			project,
			"-c",
			"user.name=Shadow Test",
			"-c",
			"user.email=shadow@example.com",
			"commit",
			"--quiet",
			"-m",
			"initial",
		]);
		await fs.writeFile(path.join(project, "node_modules", "x.js"), "x\n");
		repo = new ShadowGitRepo({ gitPath, gitDir: shadowDir, workTree: project, timeoutMs: 60_000 });
	});

	teardown(async function () {
		this.timeout(60_000);
		if (tempRoot.length > 0) {
			await fs.rm(tempRoot, { recursive: true, force: true }).catch(() => undefined);
		}
	});

	test("keeps the same tree for unchanged snapshots and links project objects", async function () {
		if (!gitPath) {
			this.skip();
			return;
		}
		this.timeout(60_000);
		const shadow = getRepo();
		const first = await shadow.snapshot();
		const second = await shadow.snapshot();
		assert.deepStrictEqual(first, second);

		const alternatesFile = path.join(shadowDir, "objects", "info", "alternates");
		const alternates = await fs.readFile(alternatesFile, "utf8");
		assert.ok(alternates.endsWith("\n"));
		assert.ok(!alternates.includes("\r"));
		assert.strictEqual(await fs.realpath(alternates.trim()), await fs.realpath(path.join(project, ".git", "objects")));
	});

	test("does not report existing ignored files after git status when the baseline hits the cap", async function () {
		if (!gitPath) {
			this.skip();
			return;
		}
		this.timeout(60_000);
		await fs.writeFile(path.join(project, ".gitignore"), "*.cache\n");
		for (const name of ["a.cache", "b.cache", "existing.cache"]) {
			await fs.writeFile(path.join(project, name), "already present\n");
		}
		const shadow = new ShadowGitRepo({ gitPath, gitDir: shadowDir, workTree: project, maxIgnoredFiles: 2 });
		const before = await shadow.snapshot();
		await runGit(gitPath, ["-C", project, "status", "--short"]);
		assert.deepStrictEqual(await shadow.snapshot(before), before);
		assert.deepStrictEqual(await shadow.snapshot(), before);

		await fs.rm(path.join(project, "a.cache"));
		await fs.writeFile(path.join(project, "created.txt"), "agent change\n");
		for (let refresh = 0; refresh < 2; refresh++) {
			const after = await shadow.snapshot(before);
			const changes = await shadow.diff(before, after);
			assert.deepStrictEqual(changes.map(change => [change.path, Boolean(change.before), Boolean(change.after)]), [
				["a.cache", true, false],
				["created.txt", false, true],
			]);
		}
	});

	test("diffs modified, added and deleted files and adds small ignored files", async function () {
		if (!gitPath) {
			this.skip();
			return;
		}
		this.timeout(60_000);
		const shadow = getRepo();
		const before = await shadow.snapshot();
		await fs.writeFile(path.join(project, "a.txt"), "one\r\ntwo\r\nthree\r\n");
		await fs.writeFile(path.join(project, "b.txt"), "b1\nb2\n");
		await fs.rm(path.join(project, "c.txt"));
		await fs.writeFile(path.join(project, "ignored.txt"), "ignored\n");
		await fs.writeFile(path.join(project, "node_modules", "x.js"), "x changed\n");
		const after = await shadow.snapshot();

		const changes = await shadow.diff(before, after);
		assert.deepStrictEqual(
			changes.map(change => change.path).sort(),
			["a.txt", "b.txt", "c.txt", "ignored.txt"],
		);
		const byPath = new Map(changes.map(change => [change.path, change]));
		const modified = byPath.get("a.txt");
		assert.ok(modified?.before);
		assert.ok(modified?.after);
		const added = byPath.get("b.txt");
		assert.strictEqual(added?.before, undefined);
		assert.ok(added?.after);
		const deleted = byPath.get("c.txt");
		assert.ok(deleted?.before);
		assert.strictEqual(deleted?.after, undefined);
	});

	test("tracks ignored files but skips build folders and big files", async function () {
		if (!gitPath) {
			this.skip();
			return;
		}
		this.timeout(60_000);
		const workTree = path.join(tempRoot, "ignored-project");
		await fs.mkdir(path.join(workTree, "ignored"), { recursive: true });
		await fs.mkdir(path.join(workTree, "node_modules"), { recursive: true });
		await fs.mkdir(path.join(workTree, "out"), { recursive: true });
		await fs.writeFile(path.join(workTree, ".gitignore"), "ignored/\n*.log\nout/\n");
		await fs.writeFile(path.join(workTree, "node_modules", "a.js"), "a\n");
		await fs.writeFile(path.join(workTree, "out", "b.js"), "b\n");
		await fs.writeFile(path.join(workTree, "ignored", "keep.txt"), "keep\n");
		const ignoredRepo = new ShadowGitRepo({ gitPath, gitDir: path.join(tempRoot, "ignored-shadow"), workTree, timeoutMs: 60_000 });
		const before = await ignoredRepo.snapshot();

		await fs.writeFile(path.join(workTree, "ignored", "new.txt"), "new\n");
		await fs.writeFile(path.join(workTree, "x.log"), "log\n");
		await fs.writeFile(path.join(workTree, "ignored", "big.bin"), Buffer.alloc(MAX_IGNORED_FILE_BYTES + 1, 1));
		await fs.writeFile(path.join(workTree, "node_modules", "c.js"), "c\n");
		await fs.writeFile(path.join(workTree, "out", "d.js"), "d\n");
		await fs.writeFile(path.join(workTree, "ignored", "keep.txt"), "keep edited\n");
		const after = await ignoredRepo.snapshot();

		const changes = await ignoredRepo.diff(before, after);
		assert.deepStrictEqual(changes.map(change => change.path).sort(), ["ignored/keep.txt", "ignored/new.txt", "x.log"]);
		const byPath = new Map(changes.map(change => [change.path, change]));
		assert.strictEqual(byPath.get("ignored/new.txt")?.before, undefined);
		assert.ok(byPath.get("ignored/new.txt")?.after);
		assert.strictEqual(byPath.get("x.log")?.before, undefined);
		assert.ok(byPath.get("x.log")?.after);
		assert.ok(byPath.get("ignored/keep.txt")?.before);
		assert.ok(byPath.get("ignored/keep.txt")?.after);

		await fs.rm(path.join(workTree, "ignored", "new.txt"));
		const last = await ignoredRepo.snapshot();
		const removed = await ignoredRepo.diff(after, last);
		assert.deepStrictEqual(removed.map(change => [change.path, change.before !== undefined, change.after !== undefined]), [["ignored/new.txt", true, false]]);
	});

	test("reads raw blobs and hashes files without filters", async function () {
		if (!gitPath) {
			this.skip();
			return;
		}
		this.timeout(60_000);
		const shadow = getRepo();
		const before = await shadow.snapshot();
		await fs.writeFile(path.join(project, "a.txt"), "one\r\ntwo\r\nthree\r\n");
		const after = await shadow.snapshot();
		const changes = await shadow.diff(before, after);
		const modified = changes.find(change => change.path === "a.txt");
		assert.ok(modified?.before);
		assert.ok(modified?.after);

		const original = Buffer.from("one\r\ntwo\r\n", "utf8");
		assert.deepStrictEqual(await shadow.readBlob(modified.before), original);
		assert.strictEqual(await shadow.hashFile("a.txt"), modified.after);
		assert.strictEqual(await shadow.hashFile(path.join("nested", "missing.txt")), undefined);
		await assert.rejects(shadow.hashFile(path.join("..", "outside.txt")), /work tree/);
	});

	test("counts added and deleted lines and detects binary content", async function () {
		if (!gitPath) {
			this.skip();
			return;
		}
		this.timeout(60_000);
		const shadow = getRepo();
		const before = await shadow.snapshot();
		await fs.writeFile(path.join(project, "a.txt"), "one\r\ntwo\r\nthree\r\n");
		await fs.writeFile(path.join(project, "b.txt"), "b1\nb2\n");
		const after = await shadow.snapshot();
		const changes = await shadow.diff(before, after);
		const byPath = new Map(changes.map(change => [change.path, change]));
		const modified = byPath.get("a.txt");
		const added = byPath.get("b.txt");
		assert.ok(modified?.before);
		assert.ok(modified?.after);
		assert.ok(added?.after);

		assert.deepStrictEqual(await shadow.numstat(modified.before, modified.after), {
			additions: 1,
			deletions: 0,
		});
		assert.deepStrictEqual(await shadow.numstat(undefined, added.after), { additions: 2, deletions: 0 });
		assert.deepStrictEqual(await shadow.numstat(modified.after, modified.after), {
			additions: 0,
			deletions: 0,
		});

		await fs.writeFile(path.join(project, "binary.bin"), Buffer.from([0, 1, 2, 0, 3]));
		await shadow.snapshot();
		const binaryBlob = await shadow.hashFile("binary.bin");
		assert.ok(binaryBlob);
		assert.strictEqual(await shadow.numstat(undefined, binaryBlob), undefined);
	});

	test("snapshots a plain folder without alternates", async function () {
		if (!gitPath) {
			this.skip();
			return;
		}
		this.timeout(60_000);
		const plain = path.join(tempRoot, "plain");
		const plainShadowDir = path.join(tempRoot, "plain-shadow");
		await fs.mkdir(plain, { recursive: true });
		await fs.writeFile(path.join(plain, "f.txt"), "one\n");
		const plainRepo = new ShadowGitRepo({ gitPath, gitDir: plainShadowDir, workTree: plain });
		const first = await plainRepo.snapshot();
		await fs.writeFile(path.join(plain, "g.txt"), "two\n");
		const second = await plainRepo.snapshot();
		const changes = await plainRepo.diff(first, second);
		assert.deepStrictEqual(
			changes.map(change => change.path),
			["g.txt"],
		);
		await assert.rejects(fs.stat(path.join(plainShadowDir, "objects", "info", "alternates")));
	});

	test("removes a stale index lock before snapshotting", async function () {
		if (!gitPath) {
			this.skip();
			return;
		}
		this.timeout(60_000);
		const shadow = getRepo();
		await shadow.init();
		const lockFile = path.join(shadowDir, "index.lock");
		await fs.writeFile(lockFile, "");
		const stale = new Date(Date.now() - 120_000);
		await fs.utimes(lockFile, stale, stale);
		const tree = await shadow.snapshot();
		assert.match(tree.tree, /^[0-9a-f]{40}([0-9a-f]{24})?$/);
		await assert.rejects(fs.stat(lockFile));
	});

	test("packs every loose object without deleting trees or blobs kept only in chat state", async function () {
		if (!gitPath) {
			this.skip();
			return;
		}
		this.timeout(60_000);
		const shadow = getRepo();
		const before = await shadow.snapshot();
		await fs.writeFile(path.join(project, "a.txt"), "one\r\ntwo\r\nthree\r\nfour\r\n");
		const after = await shadow.snapshot();
		const modified = (await shadow.diff(before, after)).find(change => change.path === "a.txt");
		assert.ok(modified?.before, "the first version must have a blob id");
		const original = await shadow.readBlob(modified.before);

		const first = await shadow.maintain(1);
		assert.strictEqual(first.packed, true);
		assert.ok(first.looseObjects > 1);
		assert.deepStrictEqual(await shadow.readBlob(modified.before), original);
		await assert.rejects(fs.stat(path.join(shadowDir, "aab-pack.lock")), "the maintenance lock is released");
		const packs = async (): Promise<string[]> => (await fs.readdir(path.join(shadowDir, "objects", "pack"))).filter(name => name.endsWith(".pack"));
		assert.strictEqual((await packs()).length, 1, "all objects live in one pack");

		// New snapshots add loose objects; the next pack replaces the old pack instead of
		// accumulating one per run, and the earlier snapshot stays readable.
		await fs.writeFile(path.join(project, "a.txt"), "one\r\ntwo\r\nthree\r\nfour\r\nfive\r\n");
		await shadow.snapshot();
		const second = await shadow.maintain(1);
		assert.strictEqual(second.packed, true);
		assert.strictEqual((await packs()).length, 1);
		assert.deepStrictEqual(await shadow.readBlob(modified.before), original);
	});
});
