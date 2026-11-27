import * as assert from "node:assert";
import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as vscode from "vscode";
import { ConversationHistory } from "../providers/conversation-history";

const day = 24 * 60 * 60_000;

function user(text: string): vscode.LanguageModelChatMessage {
	return new vscode.LanguageModelChatMessage(vscode.LanguageModelChatMessageRole.User, [new vscode.LanguageModelTextPart(text)]);
}

suite("Conversation history retention", () => {
	let root = "";

	setup(async () => {
		root = await fs.mkdtemp(path.join(os.tmpdir(), "chat-history-retention-"));
	});

	teardown(async () => {
		await fs.rm(root, { recursive: true, force: true });
	});

	test("removes an idle transcript but never the one with an open lease", async () => {
		const history = new ConversationHistory(root);
		const idle = await history.begin("idle-chat", [user("OLD")]);
		await idle.complete([]);
		assert.ok(idle.transcriptPath);
		const idleFile = idle.transcriptPath;
		const past = new Date(Date.now() - 40 * day);
		await fs.utimes(idleFile, past, past);

		const open = await history.begin("open-chat", [user("CURRENT")]);
		assert.ok(open.transcriptPath);
		const openFile = open.transcriptPath;
		// Even an old-looking transcript stays while its lease is open.
		await fs.utimes(openFile, past, past);
		const result = await history.pruneHistory({ maxAgeMs: 30 * day, maxBytes: 100 * 1024 * 1024 });

		await assert.rejects(fs.stat(idleFile), "the idle transcript is removed");
		assert.strictEqual((await fs.stat(openFile)).isFile(), true, "the open conversation stays on disk");
		assert.strictEqual(result.removedConversations, 1);
		assert.ok(result.removedBytes > 0);
		await open.complete([]);
	});

	test("size cap deletes the oldest eligible transcript first and leaves recent files alone", async () => {
		const history = new ConversationHistory(root);
		const write = async (conversation: string, text: string): Promise<string> => {
			const lease = await history.begin(conversation, [user(text)]);
			await lease.complete([]);
			assert.ok(lease.transcriptPath);
			return lease.transcriptPath;
		};
		const older = await write("older-chat", "x".repeat(5_000));
		const newer = await write("newer-chat", "y".repeat(5_000));
		const open = await history.begin("open-chat", [user("z".repeat(5_000))]);
		assert.ok(open.transcriptPath);
		const past = new Date(Date.now() - 10 * day);
		const lessPast = new Date(Date.now() - 9 * day);
		await fs.utimes(older, past, past);
		await fs.utimes(newer, lessPast, lessPast);
		const perFile = (await fs.stat(newer)).size;

		const result = await history.pruneHistory({ maxAgeMs: 30 * day, maxBytes: 2 * perFile + 100, minCapAgeMs: 7 * day });
		await assert.rejects(fs.stat(older), "the oldest transcript goes first");
		assert.strictEqual((await fs.stat(newer)).isFile(), true, "the cap is reached before the next transcript");
		assert.strictEqual((await fs.stat(open.transcriptPath)).isFile(), true, "the active transcript is never capped");
		assert.strictEqual(result.removedConversations, 1);
		await open.complete([]);
	});
});
