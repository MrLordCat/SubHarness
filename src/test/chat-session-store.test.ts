import * as assert from "node:assert";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { ChatSessionStore, DEFAULT_CHAT_TITLE } from "../chat/session-store";
import type { ChatAttachment, ChatMessage, ChatPart } from "../chat/shared/protocol";

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
		await store.setUsage(
			session.id,
			"m1",
			{ promptTokens: 3, completionTokens: 4, totalTokens: 7 },
			{ requests: 2, promptTokens: 6, cachedTokens: 2, completionTokens: 8, cacheReported: 1 },
		);
		await store.flush();

		const reopened = new ChatSessionStore(root);
		assert.deepStrictEqual(await reopened.load(session.id), [{
			...user,
			parts: [{ kind: "text", text: "Hello there" }, { kind: "thinking", text: "working" }],
			usage: { promptTokens: 3, completionTokens: 4, totalTokens: 7 },
			usageTotals: { requests: 2, promptTokens: 6, cachedTokens: 2, completionTokens: 8, cacheReported: 1 },
		}]);
		const meta = await reopened.get(session.id);
		assert.strictEqual(meta?.title, "Hello there");
		assert.strictEqual(meta?.messageCount, 1);
		assert.strictEqual(meta?.modelId, "model-a");
	});

	test("loads a usage line with malformed totals without totals", async () => {
		const store = new ChatSessionStore(root);
		const session = await store.create();
		await store.appendMessage(session.id, textMessage("m1", "user", "kept"));
		const usage = { promptTokens: 5, completionTokens: 6, totalTokens: 11 };
		await store.setUsage(session.id, "m1", usage);
		await store.flush();
		const line = JSON.stringify({
			t: "usage",
			messageId: "m1",
			usage,
			totals: { requests: 1, promptTokens: 5, cachedTokens: -1, completionTokens: 6, cacheReported: 1 },
		});
		await fs.appendFile(path.join(root, `${session.id}.jsonl`), `${line}\n`, "utf8");

		const reopened = new ChatSessionStore(root);
		const loaded = (await reopened.load(session.id))[0];
		assert.deepStrictEqual(loaded.usage, usage);
		assert.strictEqual(loaded.usageTotals, undefined);
	});

	test("loads an old usage line without totals", async () => {
		const store = new ChatSessionStore(root);
		const session = await store.create();
		await store.appendMessage(session.id, textMessage("m1", "user", "old"));
		await store.flush();
		const line = JSON.stringify({ t: "usage", messageId: "m1", usage: { promptTokens: 3, cachedTokens: 1 } });
		await fs.appendFile(path.join(root, `${session.id}.jsonl`), `${line}\n`, "utf8");

		const reopened = new ChatSessionStore(root);
		const loaded = (await reopened.load(session.id))[0];
		assert.deepStrictEqual(loaded.usage, { promptTokens: 3, cachedTokens: 1 });
		assert.strictEqual(loaded.usageTotals, undefined);
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

	test("replays host context and appended compaction parts from a new store", async () => {
		const store = new ChatSessionStore(root);
		const session = await store.create("model-a");
		const user = chatMessage("u1", "user", [{ kind: "text", text: "Hello" }], { hostContext: "<context>\nnow\n</context>" });
		const assistant = chatMessage("a1", "assistant", [{ kind: "text", text: "Answer" }], { modelId: "model-a" });
		const compaction: ChatPart = {
			kind: "compaction",
			summary: "Earlier turns",
			keepFromMessageId: "u1",
			summarizedMessages: 2,
			tokensBefore: 400,
			tokensAfter: 120,
			method: "extractive",
		};
		await store.appendMessage(session.id, user);
		await store.appendMessage(session.id, assistant);
		await store.appendPart(session.id, "a1", compaction);
		await store.flush();

		const reopened = new ChatSessionStore(root);
		assert.deepStrictEqual(await reopened.load(session.id), [
			user,
			{ ...assistant, parts: [...assistant.parts, compaction] },
		]);
	});

	test("round-trips attachments and drops a message with an invalid attachment", async () => {
		const store = new ChatSessionStore(root);
		const session = await store.create("model-a");
		const attachments: ChatAttachment[] = [
			{ id: "a1", kind: "file", path: "src/a.ts", uri: "file:///src/a.ts", languageId: "typescript" },
			{ id: "a2", kind: "selection", path: "src/b.ts", uri: "file:///src/b.ts", startLine: 2, endLine: 4 },
		];
		const user = chatMessage("u1", "user", [{ kind: "text", text: "Look" }], {
			attachments,
			attachmentContext: '<attachments>\n<attachment path="src/a.ts">\n```\nx\n```\n</attachment>\n</attachments>',
		});
		await store.appendMessage(session.id, user);
		await store.flush();
		await fs.appendFile(path.join(root, `${session.id}.jsonl`), `${JSON.stringify({
			t: "message",
			message: { id: "u2", role: "user", turn: 2, createdAt: 2, parts: [{ kind: "text", text: "bad" }], attachments: [{ id: "x", kind: "file", path: "p" }] },
		})}\n`, "utf8");

		const reopened = new ChatSessionStore(root);
		assert.deepStrictEqual(await reopened.load(session.id), [user]);
	});

	test("replays a notice with its limit info", async () => {
		const store = new ChatSessionStore(root);
		const session = await store.create("model-a");
		const notice: ChatPart = {
			kind: "notice",
			level: "warning",
			text: "Codex 5-hour limit reached.",
			limit: { kind: "limit", provider: "Codex", window: "5-hour", resetAt: 1_700_000_000_000 },
		};
		await store.appendMessage(session.id, chatMessage("a1", "assistant", [notice]));
		await store.flush();

		const reopened = new ChatSessionStore(root);
		assert.deepStrictEqual((await reopened.load(session.id))[0].parts, [notice]);
	});

	test("skips a log line whose notice limit is malformed", async () => {
		const store = new ChatSessionStore(root);
		const session = await store.create();
		await store.appendMessage(session.id, textMessage("m1", "user", "kept"));
		await store.flush();
		const line = JSON.stringify({
			t: "part",
			messageId: "m1",
			part: { kind: "notice", level: "warning", text: "bad limit", limit: { kind: "limit", provider: 5 } },
		});
		await fs.appendFile(path.join(root, `${session.id}.jsonl`), `${line}\n`, "utf8");

		const reopened = new ChatSessionStore(root);
		assert.deepStrictEqual((await reopened.load(session.id))[0].parts, [{ kind: "text", text: "kept" }]);
	});

	test("replays a subagent part from a new store", async () => {
		const store = new ChatSessionStore(root);
		const session = await store.create("model-a");
		const subagent: ChatPart = {
			kind: "subagent",
			callId: "call-sub",
			description: "Check",
			modelId: "claude::smart",
			modelName: "Smart (Claude)",
			status: "done",
			steps: [
				{ kind: "text", text: "Looking." },
				{ kind: "tool", name: "read", summary: "{\"path\":\"a.txt\"}", input: "{\n  \"path\": \"a.txt\"\n}", output: "ok", outputChars: 2, isError: true },
				{ kind: "notice", level: "info", text: "note" },
			],
			startedAt: 1_700_000_000_000,
			durationMs: 1_200,
			usage: { promptTokens: 3, completionTokens: 4, totalTokens: 7 },
		};
		await store.appendMessage(session.id, chatMessage("a1", "assistant", [subagent]));
		await store.flush();

		const reopened = new ChatSessionStore(root);
		assert.deepStrictEqual((await reopened.load(session.id))[0].parts, [subagent]);
	});

	test("skips a log line whose subagent step is malformed", async () => {
		const store = new ChatSessionStore(root);
		const session = await store.create();
		await store.appendMessage(session.id, textMessage("m1", "user", "kept"));
		await store.flush();
		const line = JSON.stringify({
			t: "part",
			messageId: "m1",
			part: {
				kind: "subagent",
				callId: "call-sub",
				description: "Check",
				modelId: "claude::smart",
				modelName: "Smart (Claude)",
				status: "done",
				startedAt: 1_700_000_000_000,
				steps: [{ kind: "tool", name: "read" }],
			},
		});
		await fs.appendFile(path.join(root, `${session.id}.jsonl`), `${line}\n`, "utf8");

		const reopened = new ChatSessionStore(root);
		assert.deepStrictEqual((await reopened.load(session.id))[0].parts, [{ kind: "text", text: "kept" }]);
	});

	test("skips a subagent step whose new fields have the wrong type", async () => {
		const store = new ChatSessionStore(root);
		const session = await store.create();
		await store.appendMessage(session.id, textMessage("m1", "user", "kept"));
		await store.flush();
		const steps = [
			{ kind: "tool", name: "read", summary: "{}", input: 7 },
			{ kind: "tool", name: "read", summary: "{}", output: 7 },
			{ kind: "tool", name: "read", summary: "{}", outputChars: "7" },
		];
		for (const [index, step] of steps.entries()) {
			const line = JSON.stringify({
				t: "part",
				messageId: "m1",
				part: {
					kind: "subagent",
					callId: `call-${index}`,
					description: "Check",
					modelId: "claude::smart",
					modelName: "Smart (Claude)",
					status: "done",
					startedAt: 1_700_000_000_000,
					steps: [step],
				},
			});
			await fs.appendFile(path.join(root, `${session.id}.jsonl`), `${line}\n`, "utf8");
		}

		const reopened = new ChatSessionStore(root);
		assert.deepStrictEqual((await reopened.load(session.id))[0].parts, [{ kind: "text", text: "kept" }]);
	});

	test("keeps a tool result's fullLength and drops a wrong-typed one", async () => {
		const store = new ChatSessionStore(root);
		const session = await store.create();
		const valid: ChatPart = { kind: "toolResult", callId: "c1", text: "short", preview: true, fullLength: 25_431 };
		await store.appendMessage(session.id, chatMessage("a1", "assistant", [valid]));
		await store.flush();
		const line = JSON.stringify({
			t: "part",
			messageId: "a1",
			part: { kind: "toolResult", callId: "c2", text: "short", fullLength: "long" },
		});
		await fs.appendFile(path.join(root, `${session.id}.jsonl`), `${line}\n`, "utf8");

		const reopened = new ChatSessionStore(root);
		assert.deepStrictEqual((await reopened.load(session.id))[0].parts, [valid]);
	});

	test("round-trips tool result images and drops malformed ones", async () => {
		const store = new ChatSessionStore(root);
		const session = await store.create();
		const valid: ChatPart = {
			kind: "toolResult",
			callId: "c1",
			text: "Image a.png",
			images: [{ mimeType: "image/png", data: "iVBORw0KGgo=", byteLength: 8, name: "a.png" }],
		};
		await store.appendMessage(session.id, chatMessage("a1", "assistant", [valid]));
		await store.flush();
		const lines = [
			JSON.stringify({ t: "part", messageId: "a1", part: { kind: "toolResult", callId: "c2", text: "bad size", images: [{ mimeType: "image/png", byteLength: "8" }] } }),
			JSON.stringify({ t: "part", messageId: "a1", part: { kind: "toolResult", callId: "c3", text: "not a list", images: "png" } }),
		];
		await fs.appendFile(path.join(root, `${session.id}.jsonl`), `${lines.join("\n")}\n`, "utf8");

		const reopened = new ChatSessionStore(root);
		assert.deepStrictEqual((await reopened.load(session.id))[0].parts, [valid]);
	});

	test("endMessage marks an answer complete", async () => {
		const store = new ChatSessionStore(root);
		const session = await store.create();
		await store.appendMessage(session.id, textMessage("u1", "user", "Question"));
		await store.appendMessage(session.id, textMessage("a1", "assistant", "Answer"));
		await store.endMessage(session.id, "a1");

		const loaded = await new ChatSessionStore(root).loadSession(session.id);
		assert.deepStrictEqual(loaded.messages.map(message => message.id), ["u1", "a1"]);
		assert.strictEqual(loaded.interruptedMessageId, undefined);
	});

	test("reports an unfinished last answer when the log has end markers", async () => {
		const store = new ChatSessionStore(root);
		const session = await store.create();
		await store.appendMessage(session.id, textMessage("u1", "user", "One"));
		await store.appendMessage(session.id, textMessage("a1", "assistant", "First"));
		await store.endMessage(session.id, "a1");
		await store.appendMessage(session.id, textMessage("u2", "user", "Two"));
		await store.appendMessage(session.id, textMessage("a2", "assistant", "Second"));

		const loaded = await new ChatSessionStore(root).loadSession(session.id);
		assert.deepStrictEqual(loaded.messages.map(message => message.id), ["u1", "a1", "u2", "a2"]);
		assert.strictEqual(loaded.interruptedMessageId, "a2");
	});

	test("flags only an empty or dangling last answer in a log without end markers", async () => {
		const store = new ChatSessionStore(root);
		const complete = await store.create();
		await store.appendMessage(complete.id, textMessage("u1", "user", "Question"));
		await store.appendMessage(complete.id, textMessage("a1", "assistant", "Answer"));
		const empty = await store.create();
		await store.appendMessage(empty.id, textMessage("u1", "user", "Question"));
		await store.appendMessage(empty.id, chatMessage("a1", "assistant", []));
		const dangling = await store.create();
		await store.appendMessage(dangling.id, textMessage("u1", "user", "Question"));
		await store.appendMessage(dangling.id, chatMessage("a1", "assistant", [{ kind: "toolCall", callId: "call-1", name: "read", input: {} }]));

		assert.strictEqual((await store.loadSession(complete.id)).interruptedMessageId, undefined);
		assert.strictEqual((await store.loadSession(empty.id)).interruptedMessageId, "a1");
		assert.strictEqual((await store.loadSession(dangling.id)).interruptedMessageId, "a1");
	});

	test("truncate drops the end markers of the removed messages", async () => {
		const store = new ChatSessionStore(root);
		const reused = await store.create();
		await store.appendMessage(reused.id, textMessage("u1", "user", "One"));
		await store.appendMessage(reused.id, textMessage("a1", "assistant", "First"));
		await store.endMessage(reused.id, "a1");
		await store.truncateFrom(reused.id, "u1");
		await store.appendMessage(reused.id, textMessage("u1b", "user", "Two"));
		await store.appendMessage(reused.id, textMessage("a1", "assistant", "Second"));
		assert.deepStrictEqual((await store.loadSession(reused.id)).messages.map(message => message.id), ["u1b", "a1"]);
		assert.strictEqual((await store.loadSession(reused.id)).interruptedMessageId, "a1");

		const truncated = await store.create();
		await store.appendMessage(truncated.id, textMessage("u2", "user", "One"));
		await store.appendMessage(truncated.id, textMessage("a2", "assistant", "First"));
		await store.endMessage(truncated.id, "a2");
		await store.truncateFrom(truncated.id, "u2");
		await store.appendMessage(truncated.id, textMessage("u3", "user", "Two"));
		await store.appendMessage(truncated.id, textMessage("a3", "assistant", "Second"));
		// The log still holds an end event, so a text answer without one stays unfinished.
		assert.strictEqual((await store.loadSession(truncated.id)).interruptedMessageId, "a3");
	});

	test("skips an invalid end event without breaking replay", async () => {
		const store = new ChatSessionStore(root);
		const session = await store.create();
		await store.appendMessage(session.id, textMessage("u1", "user", "Question"));
		await store.appendMessage(session.id, textMessage("a1", "assistant", "Answer"));
		const invalid = `${JSON.stringify({ t: "end" })}\n${JSON.stringify({ t: "end", messageId: 7 })}\n`;
		await fs.appendFile(path.join(root, `${session.id}.jsonl`), invalid, "utf8");

		const loaded = await store.loadSession(session.id);
		assert.deepStrictEqual(loaded.messages.map(message => message.id), ["u1", "a1"]);
		assert.strictEqual(loaded.interruptedMessageId, undefined);
		await store.endMessage(session.id, "a1");
		assert.strictEqual((await store.loadSession(session.id)).interruptedMessageId, undefined);
	});
});
