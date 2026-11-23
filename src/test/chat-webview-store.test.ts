import * as assert from "node:assert";
import type { ChatAttachment, HostMessage } from "../chat/shared/protocol";
import type { ChatStore } from "../chat/webview/store";

suite("Chat webview attachment routing", () => {
	test("routes replies to their originating composer and preserves untargeted behavior", async () => {
		const globals = globalThis as typeof globalThis & { acquireVsCodeApi?: unknown };
		const previous = globals.acquireVsCodeApi;
		globals.acquireVsCodeApi = () => ({ postMessage: () => undefined, getState: () => undefined, setState: () => undefined });
		try {
			const Store = (await import("../chat/webview/store.js")).ChatStore;
			const store: ChatStore = new Store();
			const attachment = (id: string): ChatAttachment => ({ id, kind: "file", path: id, uri: `file:///${id}` });
			const send = (id: string, target?: "draft" | "edit"): void => {
				const update: HostMessage = { type: "attachmentsAdded", attachments: [attachment(id)], ...(target ? { target } : {}) };
				store.receive({ data: update } as MessageEvent);
			};
			store.editing = { messageId: "message", attachments: [attachment("original")] };
			send("draft", "draft");
			assert.deepStrictEqual(store.pendingAttachments.map(item => item.id), ["draft"]);
			assert.deepStrictEqual(store.editing?.attachments.map(item => item.id), ["original"]);
			send("edit", "edit");
			send("untargeted-edit");
			assert.deepStrictEqual(store.editing?.attachments.map(item => item.id), ["original", "edit", "untargeted-edit"]);
			store.cancelEdit();
			send("late", "edit");
			send("untargeted-draft");
			assert.deepStrictEqual(store.pendingAttachments.map(item => item.id), ["draft", "untargeted-draft"]);
			store.flushDraft();
		} finally {
			if (previous === undefined) {
				delete globals.acquireVsCodeApi;
			} else {
				globals.acquireVsCodeApi = previous;
			}
		}
	});
});
