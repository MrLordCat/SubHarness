import * as assert from "node:assert";
import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { IndexedLocalAgentStore, type CursorStorePagination } from "../cursor/indexed-store";
import { pruneCursorStore } from "../cursor/retention";

/** Only the two paginators are used by the indexed store; a local stub keeps the test independent of the SDK runtime. */
function pagination(): CursorStorePagination {
	const page = <T>(items: readonly T[], filter: { cursor?: string; limit?: number } | undefined, id: (item: T) => string) => {
		const sorted = [...items].sort((left, right) => id(left).localeCompare(id(right)));
		const cursor = filter?.cursor;
		const rest = cursor ? sorted.filter(item => id(item) > cursor) : sorted;
		const limit = filter?.limit ?? 50;
		const itemsPage = rest.slice(0, limit);
		return { items: itemsPage, ...(rest.length > limit ? { nextCursor: id(itemsPage[itemsPage.length - 1]) } : {}) };
	};
	return {
		paginateAgentDocuments: (items: readonly never[], filter?: { cursor?: string; limit?: number }) => page(items, filter, item => (item as { agentId: string }).agentId),
		paginateRunDocuments: (items: readonly never[], filter?: { cursor?: string; limit?: number }) => page(items, filter, item => (item as { runId: string }).runId),
	} as unknown as CursorStorePagination;
}

suite("Cursor store retention", () => {
	let root = "";
	let store: IndexedLocalAgentStore | undefined;
	const now = Date.now();
	const day = 24 * 60 * 60_000;

	setup(async () => {
		root = await fs.mkdtemp(path.join(os.tmpdir(), "cursor-retention-"));
		store = new IndexedLocalAgentStore(root, pagination(), 0);
	});

	teardown(async () => {
		await store?.dispose();
		store = undefined;
		await fs.rm(root, { recursive: true, force: true });
	});

	test("removes old conversations with their runs, events and checkpoints and keeps saved ones", async () => {
		const current = store;
		assert.ok(current);
		const agent = (agentId: string, ageMs: number) => ({
			agentId, cwd: root, status: "idle" as const, createdAt: now - ageMs, updatedAt: now - ageMs,
		});
		await current.agents.create({ agent: agent("old", 40 * day) });
		await current.agents.create({ agent: agent("recent", 2 * day) });
		await current.agents.create({ agent: agent("saved", 40 * day) });
		await current.agents.create({ agent: agent("stale-saved", 40 * day) });
		await current.agents.create({ agent: { agentId: "running", cwd: root, status: "running", createdAt: now - 40 * day, updatedAt: now - 40 * day } });
		await current.runs.create({ run: { agentId: "old", runId: "old-run", turnNumber: 1, status: "finished", createdAt: now - 40 * day, updatedAt: now - 40 * day } });
		await current.runs.create({ run: { agentId: "recent", runId: "recent-run", turnNumber: 1, status: "finished", createdAt: now - 2 * day, updatedAt: now - 2 * day } });
		await current.checkpoints.create({ agentId: "old", blobId: "old-blob", data: Buffer.from("old checkpoint") });
		await current.checkpoints.create({ agentId: "recent", blobId: "recent-blob", data: Buffer.from("recent checkpoint") });
		await current.runEvents.append({ runId: "old-run", eventType: "run_stream_event", payload: { text: "old" } });
		await current.runEvents.append({ runId: "recent-run", eventType: "run_stream_event", payload: { text: "recent" } });
		await fs.writeFile(
			path.join(root, "completed-sessions.json"),
			JSON.stringify({ version: 1, sessions: [
				{ agentId: "saved", updatedAt: now - day },
				{ agentId: "stale-saved", updatedAt: now - 40 * day },
			], failures: [] }),
			"utf8"
		);

		const oldHistory = path.join(root, "history", "a".repeat(64));
		await fs.mkdir(oldHistory, { recursive: true });
		const oldArchive = path.join(oldHistory, "old.txt");
		const newArchive = path.join(oldHistory, "new.txt");
		await fs.writeFile(oldArchive, "old archive", "utf8");
		await fs.writeFile(newArchive, "new archive", "utf8");
		const past = new Date(now - 40 * day);
		await fs.utimes(oldArchive, past, past);

		const events: Array<{ event: string; data: Record<string, unknown> }> = [];
		const result = await pruneCursorStore({
			root,
			store: current,
			now,
			log: (event, data) => events.push({ event, data }),
		});

		assert.strictEqual(await current.agents.get({ agentId: "old" }), null);
		assert.strictEqual(await current.agents.get({ agentId: "stale-saved" }), null);
		assert.strictEqual(await current.agents.get({ agentId: "recent" }) === null, false);
		assert.strictEqual(await current.agents.get({ agentId: "saved" }) === null, false);
		assert.strictEqual(await current.agents.get({ agentId: "running" }) === null, false, "a running agent is never removed");
		assert.strictEqual(await current.runs.get({ agentId: "old", runId: "old-run" }), null);
		assert.strictEqual(await current.checkpoints.get({ agentId: "old", blobId: "old-blob" }), null);
		assert.strictEqual((await current.runEvents.list({ runId: "old-run" })).items.length, 0);
		assert.strictEqual(await current.checkpoints.get({ agentId: "recent", blobId: "recent-blob" }) !== null, true);
		await assert.rejects(fs.stat(oldArchive), "the old archive is removed");
		assert.strictEqual((await fs.stat(newArchive)).isFile(), true, "the recent archive stays");

		assert.strictEqual(result.removedConversations, 2);
		assert.strictEqual(result.removedHistoryFiles, 1);
		assert.ok(result.removedBytes > 0);
		assert.strictEqual(result.errors, 0);
		assert.deepStrictEqual(events.map(entry => entry.event), ["storage.retention.done"]);
		assert.strictEqual(events[0].data.store, "cursor-sdk");
	});
});
