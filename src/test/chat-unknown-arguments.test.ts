import * as assert from "node:assert";
import * as vscode from "vscode";
import { createChatToolSource } from "../chat/tool-executor";
import { ignoredArgumentsNote, splitUnknownArguments, strictToolSchema } from "../chat/tools/unknown-arguments";
import type { ChatTool } from "../chat/tools/types";

const readTerminalSchema = {
	type: "object",
	properties: {
		terminalId: { type: "string", description: "Terminal id." },
		waitMs: { type: "number", description: "Wait." },
	},
	required: ["terminalId"],
};

function token(): vscode.CancellationToken {
	return new vscode.CancellationTokenSource().token;
}

suite("Unknown tool arguments", () => {
	test("the call keeps only the listed arguments and names the others", () => {
		assert.deepStrictEqual(
			splitUnknownArguments(readTerminalSchema, { terminalId: "t1", maxResults: 5, "-A": 2 }),
			{ input: { terminalId: "t1" }, ignored: ["maxResults", "-A"] }
		);
		assert.deepStrictEqual(splitUnknownArguments(readTerminalSchema, { terminalId: "t1" }), { input: { terminalId: "t1" }, ignored: [] });
		assert.strictEqual(
			ignoredArgumentsNote("read_terminal", ["maxResults"], readTerminalSchema),
			'Note: read_terminal ignored the unknown argument "maxResults"; it takes terminalId (required), waitMs.'
		);
	});

	test("schemas that allow other arguments, or declare none, pass every argument through", () => {
		const open = { ...readTerminalSchema, additionalProperties: true };
		assert.deepStrictEqual(splitUnknownArguments(open, { terminalId: "t1", extra: 1 }).ignored, []);
		const mapped = { ...readTerminalSchema, additionalProperties: { type: "string" } };
		assert.deepStrictEqual(splitUnknownArguments(mapped, { terminalId: "t1", extra: "x" }).ignored, []);
		// The catalog fills in this schema for an external tool that declared none.
		assert.deepStrictEqual(splitUnknownArguments({ type: "object", properties: {} }, { anything: 1 }).ignored, []);
		assert.deepStrictEqual(splitUnknownArguments({ type: "object", properties: {}, additionalProperties: false }, { anything: 1 }).ignored, ["anything"]);
		assert.deepStrictEqual(splitUnknownArguments(readTerminalSchema, "not an object"), { input: "not an object", ignored: [] });
	});

	test("models are offered strict schemas, the same object every time", () => {
		const strict = strictToolSchema(readTerminalSchema) as { additionalProperties?: unknown };
		assert.strictEqual(strict.additionalProperties, false);
		assert.strictEqual(strictToolSchema(readTerminalSchema), strict);
		assert.strictEqual((readTerminalSchema as { additionalProperties?: unknown }).additionalProperties, undefined, "the tool's own schema is not changed");
		const open = { ...readTerminalSchema, additionalProperties: true };
		assert.strictEqual(strictToolSchema(open), open);
		const empty = { type: "object", properties: {} };
		assert.strictEqual(strictToolSchema(empty), empty);
	});

	test("the chat runs the tool without unknown arguments and says so in the result and in an error", async () => {
		const received: unknown[] = [];
		let fail = false;
		const tool: ChatTool = {
			name: "read_terminal",
			description: "Read a terminal.",
			group: "terminal",
			inputSchema: readTerminalSchema,
			invoke: async input => {
				received.push(input);
				if (fail) {
					throw new Error("Unknown terminal ID t1.");
				}
				return "Terminal output";
			},
		};
		const source = createChatToolSource({ enabledTools: () => [tool], groups: () => [], setEnabled: async () => undefined });
		assert.strictEqual((source.tools[0].inputSchema as { additionalProperties?: unknown }).additionalProperties, false);

		const result = await source.invoke("read_terminal", { terminalId: "t1", maxResults: 5 }, token());
		assert.deepStrictEqual(received[0], { terminalId: "t1" });
		assert.strictEqual(result.isError, false);
		assert.strictEqual(result.text, 'Terminal output\n\nNote: read_terminal ignored the unknown argument "maxResults"; it takes terminalId (required), waitMs.');

		const clean = await source.invoke("read_terminal", { terminalId: "t1" }, token());
		assert.strictEqual(clean.text, "Terminal output");

		fail = true;
		await assert.rejects(source.invoke("read_terminal", { terminalId: "t1", maxResults: 5 }, token()), /Unknown terminal ID t1\.\n\nNote: read_terminal ignored the unknown argument "maxResults"/);
	});
});
