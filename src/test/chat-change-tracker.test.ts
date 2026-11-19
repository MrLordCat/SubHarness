import * as assert from "node:assert";
import { execFile } from "node:child_process";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { promisify } from "node:util";
import { ChatChangeTracker } from "../chat/changes/change-tracker";
import { findGitExecutable } from "../chat/changes/shadow-git";

const run = promisify(execFile);
const SESSION = "session-1";

suite("chat change tracker", () => {
	let git: string | undefined;
	let temp = "";
	let project = "";
	let storage = "";

	const tracker = (): ChatChangeTracker => new ChatChangeTracker({
		storageDir: storage,
		folders: () => [{ name: "project", fsPath: project }],
		findGit: async () => git,
	});
	const file = (name: string): string => path.join(project, name);
	const read = (name: string): Promise<string> => fs.readFile(file(name), "utf8");
	const exists = (name: string): Promise<boolean> => fs.access(file(name)).then(() => true, () => false);

	async function turn(current: ChatChangeTracker, number: number, change: () => Promise<void>): Promise<void> {
		const begin = await current.beginTurn();
		assert.ok(begin, "the turn snapshot must exist");
		await change();
		await current.endTurn(SESSION, number, begin);
	}

	const stored = async (): Promise<Record<string, unknown>> =>
		JSON.parse(await fs.readFile(path.join(storage, "sessions", `${SESSION}.json`), "utf8")) as Record<string, unknown>;

	suiteSetup(async () => {
		git = await findGitExecutable();
	});

	setup(async function () {
		if (!git) {
			this.skip();
		}
		temp = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "chat-changes-")));
		project = path.join(temp, "project");
		storage = path.join(temp, "storage");
		await fs.mkdir(project, { recursive: true });
		await fs.writeFile(file(".gitattributes"), "* text=auto\n");
		await fs.writeFile(file("a.txt"), "one\r\ntwo\r\n");
		await fs.writeFile(file("c.txt"), "keep me\n");
		const gitArgs = ["-c", "user.name=Test", "-c", "user.email=test@example.com", "-c", "core.autocrlf=false"];
		await run(git!, ["init", "--quiet"], { cwd: project });
		await run(git!, [...gitArgs, "add", "-A"], { cwd: project });
		await run(git!, [...gitArgs, "commit", "--quiet", "-m", "base"], { cwd: project });
	});

	teardown(async () => {
		if (temp) {
			await fs.rm(temp, { recursive: true, force: true }).catch(() => undefined);
		}
	});

	test("collects the files of several turns into one pending set", async () => {
		const current = tracker();
		await turn(current, 1, async () => {
			await fs.writeFile(file("a.txt"), "one\r\ntwo\r\nthree\r\n");
			await fs.writeFile(file("b.txt"), "new\n");
		});
		await turn(current, 2, async () => {
			await fs.writeFile(file("a.txt"), "one\r\nTWO\r\nthree\r\n");
			await fs.rm(file("c.txt"));
		});
		const set = await current.changeSet(SESSION);
		assert.deepStrictEqual(set.files.map(entry => [entry.path, entry.status]).sort(), [["a.txt", "modified"], ["b.txt", "added"], ["c.txt", "deleted"]]);
		assert.deepStrictEqual(set.files.find(entry => entry.path === "a.txt")?.additions, 2);
		assert.deepStrictEqual(set.sinceTurn, [{ turn: 1, files: 3 }, { turn: 2, files: 2 }]);
		assert.strictEqual(set.unavailable, undefined);

		const reloaded = await tracker().changeSet(SESSION);
		assert.deepStrictEqual(reloaded.files.map(entry => entry.id).sort(), set.files.map(entry => entry.id).sort());
	});

	test("a live change set merges the running turn with pending files and saves nothing", async () => {
		const current = tracker();
		await turn(current, 1, async () => fs.writeFile(file("b.txt"), "turn one\n"));
		const begin = await current.beginTurn();
		assert.ok(begin, "the turn snapshot must exist");
		await fs.writeFile(file("a.txt"), "turn two\n");

		const live = await current.liveChangeSet(SESSION, 2, begin, [file("a.txt")]);
		assert.deepStrictEqual(live.files.map(entry => entry.path).sort(), ["a.txt", "b.txt"]);
		assert.deepStrictEqual(live.sinceTurn, [{ turn: 1, files: 2 }, { turn: 2, files: 1 }]);

		const saved = await current.changeSet(SESSION);
		assert.deepStrictEqual(saved.files.map(entry => entry.path), ["b.txt"]);
		assert.deepStrictEqual(saved.sinceTurn, [{ turn: 1, files: 1 }]);

		await current.endTurn(SESSION, 2, begin, [file("a.txt")]);
		assert.deepStrictEqual(await current.changeSet(SESSION), live);
	});

	test("a live change set shows ignored files written during the turn", async () => {
		const current = tracker();
		await fs.writeFile(file(".gitignore"), "ignored/\n*.log\n");
		const begin = await current.beginTurn();
		assert.ok(begin, "the turn snapshot must exist");
		await fs.mkdir(file("ignored"), { recursive: true });
		await fs.writeFile(file("ignored/live.txt"), "ignored\n");
		await fs.writeFile(file("trace.log"), "log\n");

		const live = await current.liveChangeSet(SESSION, 1, begin);
		assert.deepStrictEqual(live.files.map(entry => entry.path).sort(), ["ignored/live.txt", "trace.log"]);
		assert.deepStrictEqual((await current.changeSet(SESSION)).files, []);

		await current.endTurn(SESSION, 1, begin);
		assert.deepStrictEqual(await current.changeSet(SESSION), live);
	});

	test("a turn that changes nothing and a file changed back leave no pending entry", async () => {
		const current = tracker();
		await turn(current, 1, async () => undefined);
		await turn(current, 2, async () => fs.writeFile(file("c.txt"), "changed\n"));
		await turn(current, 3, async () => fs.writeFile(file("c.txt"), "keep me\n"));
		assert.deepStrictEqual((await current.changeSet(SESSION)).files, []);
	});

	test("undo restores the exact original bytes, removes created files and recreates deleted ones", async () => {
		const current = tracker();
		await turn(current, 1, async () => {
			await fs.writeFile(file("a.txt"), "rewritten\n");
			await fs.mkdir(file("new"), { recursive: true });
			await fs.writeFile(file("new/b.txt"), "new\n");
			await fs.rm(file("c.txt"));
		});
		await current.undo(SESSION);
		assert.strictEqual(await read("a.txt"), "one\r\ntwo\r\n");
		assert.strictEqual(await exists("new/b.txt"), false);
		assert.strictEqual(await read("c.txt"), "keep me\n");
		const set = await current.changeSet(SESSION);
		assert.deepStrictEqual(set.files, []);
		assert.deepStrictEqual(set.sinceTurn, []);
		assert.strictEqual(set.notice, "Undid 3 files.");
	});

	test("undo leaves a file alone when it was edited by hand after the agent", async () => {
		const current = tracker();
		await turn(current, 1, async () => {
			await fs.writeFile(file("a.txt"), "agent\n");
			await fs.writeFile(file("c.txt"), "agent\n");
		});
		await fs.writeFile(file("a.txt"), "hand edit\n");
		await current.undo(SESSION);
		assert.strictEqual(await read("a.txt"), "hand edit\n");
		assert.strictEqual(await read("c.txt"), "keep me\n");
		const set = await current.changeSet(SESSION);
		assert.deepStrictEqual(set.files, []);
		assert.strictEqual(set.notice, "Undid 1 file. 1 file changed by hand afterwards was left as is.");
	});

	test("keep and undo can target single files", async () => {
		const current = tracker();
		await turn(current, 1, async () => {
			await fs.writeFile(file("a.txt"), "agent\n");
			await fs.writeFile(file("b.txt"), "new\n");
		});
		const ids = new Map((await current.changeSet(SESSION)).files.map(entry => [entry.path, entry.id]));
		await current.keep(SESSION, [ids.get("a.txt")!]);
		let set = await current.changeSet(SESSION);
		assert.deepStrictEqual(set.files.map(entry => entry.path), ["b.txt"]);
		assert.strictEqual(set.notice, "Kept 1 file.");
		assert.deepStrictEqual(set.sinceTurn, [{ turn: 1, files: 1 }]);
		await current.undo(SESSION, [ids.get("b.txt")!]);
		set = await current.changeSet(SESSION);
		assert.deepStrictEqual(set.files, []);
		assert.strictEqual(await read("a.txt"), "agent\n");
		assert.strictEqual(await exists("b.txt"), false);
	});

	test("undoing since a turn restores the files to their state before that turn only", async () => {
		const current = tracker();
		await turn(current, 1, async () => {
			await fs.writeFile(file("a.txt"), "turn one\n");
			await fs.writeFile(file("b.txt"), "from turn one\n");
		});
		await turn(current, 2, async () => {
			await fs.writeFile(file("a.txt"), "turn two\n");
			await fs.rm(file("c.txt"));
		});
		await current.undoSinceTurn(SESSION, 2);
		assert.strictEqual(await read("a.txt"), "turn one\n");
		assert.strictEqual(await read("c.txt"), "keep me\n");
		assert.strictEqual(await read("b.txt"), "from turn one\n");
		const set = await current.changeSet(SESSION);
		assert.deepStrictEqual(set.files.map(entry => entry.path).sort(), ["a.txt", "b.txt"]);
		assert.deepStrictEqual(set.sinceTurn, [{ turn: 1, files: 2 }]);
		assert.strictEqual(set.notice, "Undid 2 files.");
	});

	test("forgetting later turns keeps their files pending", async () => {
		const current = tracker();
		await turn(current, 1, async () => fs.writeFile(file("a.txt"), "turn one\n"));
		await turn(current, 2, async () => fs.writeFile(file("b.txt"), "turn two\n"));
		await current.forgetTurnsFrom(SESSION, 2);
		const set = await current.changeSet(SESSION);
		assert.deepStrictEqual(set.files.map(entry => entry.path).sort(), ["a.txt", "b.txt"]);
		assert.deepStrictEqual(set.sinceTurn, [{ turn: 1, files: 1 }]);
	});

	test("forgetSession drops a deleted chat's changes", async () => {
		const current = tracker();
		await turn(current, 1, async () => fs.writeFile(file("a.txt"), "agent\n"));
		assert.strictEqual((await current.changeSet(SESSION)).files.length, 1);
		const stored = path.join(storage, "sessions", `${SESSION}.json`);
		await fs.access(stored);

		await current.forgetSession(SESSION);
		const set = await current.changeSet(SESSION);
		assert.deepStrictEqual(set.files, []);
		assert.deepStrictEqual(set.sinceTurn, []);
		assert.strictEqual(await fs.access(stored).then(() => true, () => false), false);
	});

	test("the original content feeds the diff view", async () => {
		const current = tracker();
		await turn(current, 1, async () => {
			await fs.writeFile(file("a.txt"), "agent\n");
			await fs.writeFile(file("b.txt"), "new\n");
		});
		const ids = new Map((await current.changeSet(SESSION)).files.map(entry => [entry.path, entry.id]));
		const modified = await current.original(SESSION, ids.get("a.txt")!);
		assert.strictEqual(modified?.before?.toString("utf8"), "one\r\ntwo\r\n");
		assert.strictEqual(modified?.exists, true);
		const added = await current.original(SESSION, ids.get("b.txt")!);
		assert.strictEqual(added?.before, undefined);
		assert.strictEqual(await current.original(SESSION, "missing"), undefined);
	});

	test("a turn without a parallel turn keeps every changed file", async () => {
		const current = tracker();
		const begin = await current.beginTurn();
		assert.ok(begin, "the turn snapshot must exist");
		await fs.writeFile(file("a.txt"), "agent\n");
		await fs.writeFile(file("b.txt"), "new\n");
		await current.endTurn(SESSION, 1, begin, [file("a.txt")]);
		const set = await current.changeSet(SESSION);
		assert.deepStrictEqual(set.files.map(entry => entry.path).sort(), ["a.txt", "b.txt"]);
		assert.strictEqual(set.notice, undefined);
	});

	test("overlapping turns keep only the files their own tools wrote", async () => {
		const current = tracker();
		const beginA = await current.beginTurn();
		const beginB = await current.beginTurn();
		assert.ok(beginA, "the first turn snapshot must exist");
		assert.ok(beginB, "the second turn snapshot must exist");
		await fs.writeFile(file("a.txt"), "from chat A\n");
		await fs.writeFile(file("b.txt"), "from chat B\n");
		await fs.writeFile(file("c.txt"), "from a terminal\n");
		await current.endTurn("session-a", 1, beginA, [file("a.txt")]);
		let set = await current.changeSet("session-a");
		assert.deepStrictEqual(set.files.map(entry => entry.path), ["a.txt"]);
		assert.strictEqual(set.notice, "Another chat was working at the same time, so 2 files changed by other means are not listed here.");
		await current.endTurn("session-b", 1, beginB, [file("b.txt")]);
		set = await current.changeSet("session-b");
		assert.deepStrictEqual(set.files.map(entry => entry.path), ["b.txt"]);
		assert.strictEqual(set.notice, "Another chat was working at the same time, so 2 files changed by other means are not listed here.");
	});

	test("an overlapped turn that claims nothing reports the overlap without turn records", async () => {
		const current = tracker();
		const beginA = await current.beginTurn();
		const beginB = await current.beginTurn();
		assert.ok(beginA, "the first turn snapshot must exist");
		assert.ok(beginB, "the second turn snapshot must exist");
		await fs.writeFile(file("a.txt"), "from chat A\n");
		await current.endTurn("session-a", 1, beginA, [file("a.txt")]);
		await current.endTurn("session-b", 1, beginB);
		const set = await current.changeSet("session-b");
		assert.deepStrictEqual(set.files, []);
		assert.deepStrictEqual(set.sinceTurn, []);
		assert.strictEqual(set.notice, "Another chat was working at the same time, so 1 file changed by other means is not listed here.");
	});

	test("a turn that starts after the other one ended is not overlapped", async () => {
		const current = tracker();
		const first = await current.beginTurn();
		assert.ok(first, "the first turn snapshot must exist");
		await fs.writeFile(file("a.txt"), "first\n");
		await current.endTurn("session-a", 1, first);
		const second = await current.beginTurn();
		assert.ok(second, "the second turn snapshot must exist");
		await fs.writeFile(file("b.txt"), "second\n");
		await current.endTurn("session-b", 1, second);
		const set = await current.changeSet("session-b");
		assert.deepStrictEqual(set.files.map(entry => entry.path), ["b.txt"]);
		assert.strictEqual(set.notice, undefined);
	});

	test("without git the tracker reports why and takes no snapshots", async () => {
		const current = new ChatChangeTracker({ storageDir: storage, folders: () => [{ name: "project", fsPath: project }], findGit: async () => undefined });
		assert.strictEqual(await current.beginTurn(), undefined);
		assert.strictEqual((await current.changeSet(SESSION)).unavailable, "git was not found.");
	});

	test("an open turn left by a crash becomes a notice once", async () => {
		const current = tracker();
		await current.markOpen(SESSION, 3);
		assert.strictEqual((await stored()).open, 3);

		await current.recoverInterrupted(SESSION);
		const set = await current.changeSet(SESSION);
		assert.deepStrictEqual(set.files, []);
		assert.deepStrictEqual(set.sinceTurn, []);
		assert.strictEqual(set.notice, "A turn was interrupted before its file changes were recorded; files it changed are not listed here.");
		assert.strictEqual((await stored()).open, undefined);

		await current.recoverInterrupted(SESSION);
		assert.deepStrictEqual(await current.changeSet(SESSION), set);
	});

	test("endTurn clears the open turn so recovery stays quiet", async () => {
		const current = tracker();
		const begin = await current.beginTurn();
		assert.ok(begin, "the turn snapshot must exist");
		await current.markOpen(SESSION, 1);
		assert.strictEqual((await stored()).open, 1);
		await fs.writeFile(file("a.txt"), "agent\n");
		await current.endTurn(SESSION, 1, begin);
		assert.strictEqual((await stored()).open, undefined);

		await current.recoverInterrupted(SESSION);
		const set = await current.changeSet(SESSION);
		assert.deepStrictEqual(set.files.map(entry => entry.path), ["a.txt"]);
		assert.strictEqual(set.notice, undefined);
	});
});
