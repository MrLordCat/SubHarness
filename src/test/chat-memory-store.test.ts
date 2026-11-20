import * as assert from "node:assert";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { createChatMemoryStore, type ChatMemoryStore } from "../chat/memory-store";
import { ChatMemoryKinds } from "../chat/shared/protocol";
import { SharedMemoryService } from "../memory/shared-memory-service";
import type { SharedMemoryKind } from "../memory/types";

const WORKSPACE = "file:///workspace-a";
const OTHER_WORKSPACE = "file:///workspace-b";

suite("Chat memory store", () => {
	let root = "";
	let memory: SharedMemoryService;
	let enabled = true;

	setup(async () => {
		root = await fs.mkdtemp(path.join(os.tmpdir(), "chat-memory-store-"));
		memory = new SharedMemoryService(root);
		await memory.initialize();
		enabled = true;
	});

	teardown(async () => {
		await fs.rm(root, { recursive: true, force: true });
	});

	function store(workspaceId: string | null = WORKSPACE): ChatMemoryStore {
		const current = workspaceId ?? undefined;
		return createChatMemoryStore(memory, {
			enabled: () => enabled,
			workspaceId: () => current,
			projectLabel: () => "Project A",
		});
	}

	test("lists global and this project's entries only, newest first, with mapped fields", async () => {
		const global = await memory.upsert({
			title: "Global rule",
			content: "Use CRLF.",
			kind: "decision",
			tags: ["Style"],
			pinned: true,
		});
		await new Promise<void>(resolve => setTimeout(resolve, 5));
		const own = await memory.upsert({
			title: "Own fact",
			content: "Runs on Windows.",
			scope: "workspace",
			scopeId: WORKSPACE,
			kind: "environment",
			expiresAt: new Date(Date.now() + 60_000).toISOString(),
		});
		await memory.upsert({ title: "Other project", content: "Hidden.", scope: "workspace", scopeId: OTHER_WORKSPACE });
		await memory.upsert({ title: "Legacy model", content: "Hidden.", scope: "model", scopeId: "qwen-local" });

		const entries = store().list();
		assert.deepStrictEqual(entries.map(entry => entry.id), [own.id, global.id]);

		const mapped = entries[1];
		assert.strictEqual(mapped.scope, "global");
		assert.strictEqual(mapped.kind, "decision");
		assert.strictEqual(mapped.pinned, true);
		assert.deepStrictEqual(mapped.tags, ["style"]);
		assert.strictEqual(mapped.expired, false);
		assert.strictEqual(mapped.updatedAt, Date.parse(global.updatedAt));
		assert.strictEqual(mapped.expiresAt, undefined);
		assert.strictEqual(entries[0].scope, "workspace");
		assert.strictEqual(typeof entries[0].expiresAt, "number");

		const withoutWorkspace = store(null).list();
		assert.deepStrictEqual(withoutWorkspace.map(entry => entry.id), [global.id]);
	});

	test("marks past expiry dates as expired", async () => {
		const expired = await memory.upsert({
			title: "Old fact",
			content: "No longer current.",
			expiresAt: "2020-01-01T00:00:00.000Z",
		});
		const entry = store().list().find(candidate => candidate.id === expired.id);
		assert.strictEqual(entry?.expired, true);
		assert.strictEqual(entry?.expiresAt, Date.parse("2020-01-01T00:00:00.000Z"));
	});

	test("creates project and global entries and trims the input", async () => {
		const project = await store().save({
			title: " Build ",
			content: " npm run compile ",
			kind: "workflow",
			scope: "workspace",
			pinned: true,
		});
		assert.strictEqual(project.title, "Build");
		assert.strictEqual(project.content, "npm run compile");
		assert.strictEqual(project.scope, "workspace");
		assert.strictEqual(project.kind, "workflow");
		assert.strictEqual(project.pinned, true);
		assert.strictEqual(memory.get(project.id)?.scopeId, WORKSPACE);

		const global = await store().save({
			title: "Rule",
			content: "Use CRLF.",
			kind: "preference",
			scope: "global",
			pinned: false,
		});
		assert.strictEqual(global.scope, "global");
		assert.strictEqual(memory.get(global.id)?.scopeId, undefined);
	});

	test("an update keeps tags, sourceUrl, verifiedAt and expiresAt", async () => {
		const created = await memory.upsert({
			title: "External fact",
			content: "Old wording.",
			kind: "externalFact",
			sourceUrl: "https://example.com/doc",
			verifiedAt: "2026-01-01T00:00:00.000Z",
			expiresAt: "2030-01-01T00:00:00.000Z",
			tags: ["a", "b"],
		});

		const updated = await store().save({
			id: created.id,
			title: "External fact",
			content: "New wording.",
			kind: "externalFact",
			scope: "global",
			pinned: true,
		});

		assert.strictEqual(updated.id, created.id);
		assert.strictEqual(updated.content, "New wording.");
		assert.strictEqual(updated.pinned, true);
		const stored = memory.get(created.id);
		assert.deepStrictEqual(stored?.tags, ["a", "b"]);
		assert.strictEqual(stored?.sourceUrl, "https://example.com/doc");
		assert.strictEqual(stored?.verifiedAt, "2026-01-01T00:00:00.000Z");
		assert.strictEqual(stored?.expiresAt, "2030-01-01T00:00:00.000Z");
	});

	test("rejects an update of another project's entry", async () => {
		const other = await memory.upsert({
			title: "Theirs",
			content: "Hidden.",
			scope: "workspace",
			scopeId: OTHER_WORKSPACE,
			kind: "other",
		});
		await assert.rejects(
			() => store().save({ id: other.id, title: "Theirs", content: "Changed.", kind: "other", scope: "workspace", pinned: false }),
			/not visible in this project/,
		);
		await assert.rejects(
			() => store().save({ id: "missing-id", title: "Missing", content: "Changed.", kind: "other", scope: "global", pinned: false }),
			/not visible in this project/,
		);
		assert.strictEqual(memory.get(other.id)?.content, "Hidden.");
	});

	test("rejects project memory without an open workspace", async () => {
		const withoutWorkspace = store(null);
		await assert.rejects(
			() => withoutWorkspace.save({ title: "Project fact", content: "Runs here.", kind: "other", scope: "workspace", pinned: false }),
			/needs an open workspace folder/,
		);
		assert.strictEqual(withoutWorkspace.projectLabel(), undefined);
		assert.deepStrictEqual(withoutWorkspace.list(), []);
	});

	test("rejects an empty title or content and an unknown kind", async () => {
		await assert.rejects(
			() => store().save({ title: "   ", content: "Text.", kind: "other", scope: "global", pinned: false }),
			/must not be empty/,
		);
		await assert.rejects(
			() => store().save({ title: "Title", content: " ", kind: "other", scope: "global", pinned: false }),
			/must not be empty/,
		);
		await assert.rejects(
			() => store().save({ title: "Title", content: "Text.", kind: "nonsense", scope: "global", pinned: false }),
			/Unknown memory kind/,
		);
	});

	test("removes only visible entries", async () => {
		const global = await memory.upsert({ title: "Global", content: "Visible." });
		const own = await memory.upsert({ title: "Own", content: "Visible.", scope: "workspace", scopeId: WORKSPACE });
		const other = await memory.upsert({ title: "Other", content: "Hidden.", scope: "workspace", scopeId: OTHER_WORKSPACE });

		assert.strictEqual(await store().remove(other.id), false);
		assert.ok(memory.get(other.id));
		assert.strictEqual(await store().remove(global.id), true);
		assert.strictEqual(memory.get(global.id), undefined);
		assert.strictEqual(await store().remove(own.id), true);
		assert.strictEqual(memory.get(own.id), undefined);
	});

	test("reports the enabled setting and forwards service changes", async () => {
		let changes = 0;
		const subscription = store().onDidChange?.(() => {
			changes += 1;
		});
		assert.strictEqual(store().enabled(), true);
		enabled = false;
		assert.strictEqual(store().enabled(), false);

		await memory.upsert({ title: "Change", content: "Fires the listener." });
		assert.strictEqual(changes, 1);
		subscription?.dispose();
		await memory.upsert({ title: "Change again", content: "No listener any more." });
		assert.strictEqual(changes, 1);
	});

	test("every protocol kind round-trips through the service", async () => {
		const allKinds: Record<SharedMemoryKind, true> = {
			preference: true,
			decision: true,
			environment: true,
			workflow: true,
			externalFact: true,
			other: true,
		};
		assert.deepStrictEqual([...ChatMemoryKinds].sort(), Object.keys(allKinds).sort());

		for (const kind of ChatMemoryKinds) {
			const entry = await memory.upsert({
				title: `Kind ${kind}`,
				content: "Text.",
				kind,
				...(kind === "externalFact"
					? { sourceUrl: "https://example.com", verifiedAt: new Date().toISOString() }
					: {}),
			});
			assert.strictEqual(entry.kind, kind);
		}
	});
});
