import * as assert from "node:assert";
import { CHAT_OPEN_URI_PATH, CHAT_REVEALED_KEY, chatSessionFromUri, revealChatOnce } from "../chat/index";

/** A memento that keeps values in a map. */
function memento(): { values: Map<string, unknown>; get(key: string): unknown; update(key: string, value: unknown): Promise<void> } {
	const values = new Map<string, unknown>();
	return {
		values,
		get: key => values.get(key),
		update: async (key, value) => { values.set(key, value); },
	};
}

suite("chat reveal", () => {
	test("shows the chat once and gives focus back to the editor", async () => {
		const state = memento();
		const commands: string[] = [];
		const run = async (command: string) => { commands.push(command); };
		assert.strictEqual(await revealChatOnce(state, run), true);
		assert.strictEqual(await revealChatOnce(state, run), false);
		assert.deepStrictEqual(commands, ["llamacpp.chat.focus", "workbench.action.focusActiveEditorGroup"]);
		assert.strictEqual(state.values.get(CHAT_REVEALED_KEY), true);
	});

	test("a failing command does not retry on every start", async () => {
		const state = memento();
		assert.strictEqual(await revealChatOnce(state, async () => { throw new Error("no view"); }), true);
		assert.strictEqual(await revealChatOnce(state, async () => undefined), false);
	});

	test("a notification URI names the chat to open", () => {
		assert.strictEqual(chatSessionFromUri({ path: CHAT_OPEN_URI_PATH, query: "session=abc-1&windowId=2" }), "abc-1");
		assert.strictEqual(chatSessionFromUri({ path: CHAT_OPEN_URI_PATH, query: "windowId=2" }), undefined);
		assert.strictEqual(chatSessionFromUri({ path: "/other", query: "session=abc-1" }), undefined);
	});
});
