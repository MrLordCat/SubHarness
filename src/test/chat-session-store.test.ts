import * as assert from "node:assert";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { ChatSessionStore, DEFAULT_CHAT_TITLE } from "../chat/session-store";
import type { ChatMessage, ChatPart } from "../chat/shared/protocol";

const delay = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));

function chatMessage(id: string, role: ChatMessage["role"], parts: ChatPart[], extra: Partial<ChatMessage> = {}): ChatMessage {
	return { id, role, turn: 1, createdAt: 1, parts, ...extra };
}

function textMessage(id: string, role: ChatMessage["role"], text: string): ChatMessage {
	return chatMessage(id, role, [{ kind: "text", text }]);
}

async function exists(file: string): Promise<boolean> {
	return fs.access(file).then(() => true, () => false);
}

suite("Chat session store", () => {
	let root = "";
	setup(async () => {
		root = await fs.mkdtemp(path.join(os.tmpdir(), "chat-store-"));
	});
	teardown(async () => {
		await fs.rm(root, { recursive: true, force: true });
	});

	test("creates sessions and lists them newest first", async () => {
		const store = new ChatSessionStore(root);
		const first = await store.create("model-a");
		assert.strictEqual(first.title, DEFAULT_CHAT_TITLE);
		assert.strictEqual(first.messageCount, 0);
		assert.strictEqual(first.modelId, "model-a");
		await delay(5);
		const second = await store.create("model-b");

		const listed = await store.list();
		assert.deepStrictEqual(listed.map(meta => meta.id), [second.id, first.id]);
		assert.deepStrictEqual(await store.get(first.id), first);
		assert.deepStrictEqual(await store.get(second.id), second);
		assert.strictEqual(await store.get("missing"), undefined);
	});

	test("updates the title and model of an existing session", async () => {
		const store = new ChatSessionStore(root);
		const session = await store.create("model-a");
		const updated = await store.updateMeta(session.id, { title: "Renamed", modelId: "model-b" });
		assert.strictEqual(updated?.title, "Renamed");
		assert.strictEqual(updated?.modelId, "model-b");
		assert.deepStrictEqual(await store.get(session.id), updated);
		assert.strictEqual(await store.updateMeta("missing", { title: "x" }), undefined);
	});

	test("persists messages, streamed parts and usage across store instances", async () => {
		const store = new ChatSessionStore(root);
		const session = await store.create("model-a");
		const user = textMessage("m1", "user", "Hello there");
		await store.appendMessage(session.id, user);
		await store.appendPart(session.id, "m1", { kind: "thinking", text: "working" });
		await store.setUsage(session.id, "m1", { promptTokens: 3, completionTokens: 4, totalTokens: 7 });
		await store.flush();

		const reopened = new ChatSessionStore(root);
		assert.deepStrictEqual(await reopened.load(session.id), [{
			...user,
			parts: [{ kind: "text", text: "Hello there" }, { kind: "thinking", text: "working" }],
			usage: { promptTokens: 3, completionTokens: 4, totalTokens: 7 },
		}]);
		const meta = await reopened.get(session.id);
		assert.strictEqual(meta?.title, "Hello there");
		assert.strictEqual(meta?.messageCount, 1);
		assert.strictEqual(meta?.modelId, "model-a");
	});

	test("derives the title from the first user message and cuts it at 60 characters", async () => {
		const store = new ChatSessionStore(root);
		const firstLine = "A request that is comfortably longer than sixty characters so the title gets cut";
		assert.ok(firstLine.length > 60);
		const session = await store.create();
		await store.appendMessage(session.id, chatMessage("m1", "user", [
			{ kind: "thinking", text: "not a title" },
			{ kind: "text", text: `\n \t \n  ${firstLine}  \nsecond line` },
		]));
		const meta = await store.get(session.id);
		assert.strictEqual(meta?.title, `${firstLine.slice(0, 60)}…`);
		await store.appendMessage(session.id, textMessage("m2", "user", "A later request"));
		assert.strictEqual((await store.get(session.id))?.title, `${firstLine.slice(0, 60)}…`);

		const short = await store.create();
		await store.appendMessage(short.id, textMessage("m3", "user", " \n\n  Short title  \nrest"));
		assert.strictEqual((await store.get(short.id))?.title, "Short title");
	});

	test("flushes unawaited part writes in call order", async () => {
		const store = new ChatSessionStore(root);
		const session = await store.create();
		await store.appendMessage(session.id, chatMessage("m1", "assistant", []));
		const parts: ChatPart[] = Array.from({ length: 50 }, (_, index) => ({ kind: "text", text: `chunk-${index}` }));
		const pending = parts.map(part => store.appendPart(session.id, "m1", part));
		await store.flush();
		await Promise.all(pending);

		const loaded = await store.load(session.id);
		assert.deepStrictEqual(loaded[0].parts, parts);
	});

	test("ignores a partial last line and repairs it before the next append", async () => {
		const store = new ChatSessionStore(root);
		const session = await store.create();
		await store.appendMessage(session.id, textMessage("m1", "user", "kept"));
		await store.flush();
		await fs.appendFile(path.join(root, `${session.id}.jsonl`), "{\"t\":\"part\",\"messageId\":\"m1\",\"part\":{\"kind\":\"text\",\"te", "utf8");

		const reopened = new ChatSessionStore(root);
		const messages = await reopened.load(session.id);
		assert.deepStrictEqual(messages.map(message => message.id), ["m1"]);
		assert.deepStrictEqual(messages[0].parts, [{ kind: "text", text: "kept" }]);

		await reopened.appendPart(session.id, "m1", { kind: "notice", level: "info", text: "after" });
		assert.deepStrictEqual((await reopened.load(session.id))[0].parts.map(part => part.kind), ["text", "notice"]);
	});

	test("rebuilds a corrupt or missing index from the event logs", async () => {
		const store = new ChatSessionStore(root);
		const first = await store.create("model-a");
		const second = await store.create("model-b");
		await store.appendMessage(first.id, textMessage("u1", "user", "First request"));
		await store.appendMessage(first.id, chatMessage("a1", "assistant", [{ kind: "text", text: "Answer" }], { modelId: "model-c" }));
		await store.appendMessage(second.id, textMessage("u2", "user", "Second request"));
		await store.flush();
		const firstLog = path.join(root, `${first.id}.jsonl`);
		const firstStat = await fs.stat(firstLog);
		const secondLog = path.join(root, `${second.id}.jsonl`);
		const secondSize = (await fs.stat(secondLog)).size;
		await fs.writeFile(path.join(root, "index.json"), "{ broken", "utf8");

		const rebuilt = new ChatSessionStore(root);
		assert.deepStrictEqual((await rebuilt.list()).map(meta => meta.id).sort(), [first.id, second.id].sort());
		const meta = await rebuilt.get(first.id);
		assert.strictEqual(meta?.title, "First request");
		assert.strictEqual(meta?.messageCount, 2);
		assert.strictEqual(meta?.modelId, "model-c");
		assert.strictEqual(meta?.updatedAt, firstStat.mtimeMs);
		assert.strictEqual(meta?.createdAt, firstStat.birthtimeMs > 0 ? firstStat.birthtimeMs : firstStat.mtimeMs);
		assert.strictEqual((await rebuilt.get(second.id))?.title, "Second request");

		await fs.rm(path.join(root, "index.json"));
		const again = new ChatSessionStore(root);
		assert.strictEqual((await again.list()).length, 2);
		assert.strictEqual((await fs.stat(secondLog)).size, secondSize);
		assert.match(await fs.readFile(path.join(root, "index.json"), "utf8"), /"version":1/);
	});

	test("deletes the session entry and its event log", async () => {
		const store = new ChatSessionStore(root);
		const session = await store.create();
		await store.appendMessage(session.id, textMessage("m1", "user", "Delete me"));
		const file = path.join(root, `${session.id}.jsonl`);
		assert.strictEqual(await exists(file), true);
		await store.delete(session.id);
		assert.strictEqual(await store.get(session.id), undefined);
		assert.deepStrictEqual(await store.list(), []);
		assert.strictEqual(await exists(file), false);
		await store.delete(session.id);
	});

	test("rejects invalid session ids", async () => {
		const store = new ChatSessionStore(root);
		const invalid = "../escape";
		const message = textMessage("m1", "user", "x");
		await assert.rejects(store.get(invalid), /Invalid chat session id/);
		await assert.rejects(store.load(invalid), /Invalid chat session id/);
		await assert.rejects(store.appendMessage(invalid, message), /Invalid chat session id/);
		await assert.rejects(store.appendPart(invalid, "m1", { kind: "text", text: "x" }), /Invalid chat session id/);
		await assert.rejects(store.setUsage(invalid, "m1", {}), /Invalid chat session id/);
		await assert.rejects(store.updateMeta(invalid, { title: "x" }), /Invalid chat session id/);
		await assert.rejects(store.delete(invalid), /Invalid chat session id/);
		assert.deepStrictEqual(await fs.readdir(root), []);
	});

	test("a failed write does not break the queue", async () => {
		const store = new ChatSessionStore(root);
		await assert.rejects(store.appendMessage("11111111-1111-1111-1111-111111111111", textMessage("m1", "user", "x")), /Unknown chat session/);
		const session = await store.create();
		await store.appendMessage(session.id, textMessage("m1", "user", "still works"));
		assert.deepStrictEqual((await store.load(session.id)).map(message => message.id), ["m1"]);
	});
});
