import * as assert from "node:assert";
import { chatExportFileName, renderChatMarkdown } from "../chat/chat-export";
import type { ChatMessage, ChatSessionMeta } from "../chat/shared/protocol";

suite("chat export", () => {
	test("renders messages and omits internal parts", () => {
		const meta: ChatSessionMeta = { id: "x", title: "Example", createdAt: 1, updatedAt: 1, messageCount: 2 };
		const messages: ChatMessage[] = [
			{ id: "u", role: "user", turn: 1, createdAt: 1, parts: [{ kind: "text", text: "Hello" }] },
			{ id: "a", role: "assistant", turn: 1, createdAt: 2, modelId: "model", parts: [
				{ kind: "thinking", text: "secret" }, { kind: "toolCall", callId: "c", name: "search", input: {} },
				{ kind: "text", text: "Done" }, { kind: "notice", level: "info", text: "Notice" },
			] },
		];
		assert.strictEqual(renderChatMarkdown(meta, messages), "# Example\n\n## You\n\nHello\n\n## Assistant (model)\n\n> Tool: search\n\nDone\n\n> Notice\n");
	});

	test("sanitizes export names", () => {
		assert.strictEqual(chatExportFileName('a<b>:c'), "abc.md");
		assert.strictEqual(chatExportFileName("???"), "chat.md");
		assert.strictEqual(chatExportFileName("x".repeat(100)), `${"x".repeat(80)}.md`);
	});
});
