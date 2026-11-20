import * as assert from "node:assert";
import * as vscode from "vscode";
import type { ChatToolGroup } from "../chat/shared/protocol";
import {
	createToolAccessTools,
	formatToolList,
	formatToolRequestResult,
	LIST_TOOLS_TOOL_NAME,
	REQUEST_TOOLS_TOOL_NAME,
	shortToolDescription,
	toolsArriveMidTurn,
} from "../chat/tools/tool-access-tools";
import type { ChatToolRequestResult } from "../chat/tools/types";

const HEADER = "Enabled tools are already available to you. To use disabled ones, call request_tools with their names and a reason; the user approves them.";
const DENIED = "The user denied the request. Continue with the enabled tools, or explain in your reply what you need.";

const GROUPS: ChatToolGroup[] = [
	{
		id: "files",
		label: "Files",
		tools: [
			{ name: "read_file", description: "Reads a file. Lines of it.", enabled: true },
			{ name: "write_file", description: "Writes a file.", enabled: false },
		],
	},
	{
		id: "ext:mcp",
		label: "MCP servers",
		note: "Run through VS Code.",
		tools: [{ name: "mcp_probe", description: "Probes things.", enabled: false }],
	},
];

function requestResult(overrides: Partial<ChatToolRequestResult> = {}): ChatToolRequestResult {
	return { enabled: [], declined: [], alreadyEnabled: [], unknown: [], dismissed: false, ...overrides };
}

suite("Chat tool access tools", () => {
	const tokens: vscode.CancellationTokenSource[] = [];

	teardown(() => {
		for (const source of tokens.splice(0)) {
			source.dispose();
		}
	});

	function token(): vscode.CancellationToken {
		const source = new vscode.CancellationTokenSource();
		tokens.push(source);
		return source.token;
	}

	function tool(name: string) {
		const found = createToolAccessTools().find(candidate => candidate.name === name);
		if (!found) {
			throw new Error(`missing tool ${name}`);
		}
		return found;
	}

	test("both tools are read-only planning tools with the expected names", () => {
		assert.strictEqual(LIST_TOOLS_TOOL_NAME, "list_tools");
		assert.strictEqual(REQUEST_TOOLS_TOOL_NAME, "request_tools");
		for (const name of [LIST_TOOLS_TOOL_NAME, REQUEST_TOOLS_TOOL_NAME]) {
			assert.strictEqual(tool(name).group, "planning");
			assert.strictEqual(tool(name).readOnly, true);
		}
	});

	test("formatToolList lists groups, counts, notes and on/off state", () => {
		assert.strictEqual(formatToolList(GROUPS), [
			HEADER,
			"## Files (1/2 enabled)",
			"- read_file [on]: Reads a file",
			"- write_file [off]: Writes a file.",
			"## MCP servers (0/1 enabled) — Run through VS Code.",
			"- mcp_probe [off]: Probes things.",
		].join("\n"));
	});

	test("formatToolList cuts descriptions at the first sentence and 160 characters", () => {
		assert.strictEqual(shortToolDescription("Reads a file. Lines of it."), "Reads a file");
		assert.strictEqual(shortToolDescription("First line.\nSecond line."), "First line.");
		assert.strictEqual(shortToolDescription("  padded  "), "padded");
		const long = "y".repeat(200);
		const groups: ChatToolGroup[] = [{ id: "g", label: "G", tools: [{ name: "long_tool", description: long, enabled: true }] }];
		const line = formatToolList(groups).split("\n")[2];
		assert.strictEqual(line, `- long_tool [on]: ${"y".repeat(159)}…`);
		assert.strictEqual(shortToolDescription(long).length, 160);
	});

	test("formatToolList filters case-insensitively with every term and keeps the match counts", () => {
		assert.strictEqual(formatToolList(GROUPS, { query: "FILE writes" }), [
			HEADER,
			"## Files (0/1 enabled)",
			"- write_file [off]: Writes a file.",
		].join("\n"));
		assert.strictEqual(formatToolList(GROUPS, { query: "MCP probe" }), [
			HEADER,
			"## MCP servers (0/1 enabled) — Run through VS Code.",
			"- mcp_probe [off]: Probes things.",
		].join("\n"));
		assert.strictEqual(formatToolList(GROUPS, { query: "  servers  " }), [
			HEADER,
			"## MCP servers (0/1 enabled) — Run through VS Code.",
			"- mcp_probe [off]: Probes things.",
		].join("\n"));
	});

	test("formatToolList with onlyDisabled leaves out the enabled tools", () => {
		assert.strictEqual(formatToolList(GROUPS, { onlyDisabled: true }), [
			HEADER,
			"## Files (0/1 enabled)",
			"- write_file [off]: Writes a file.",
			"## MCP servers (0/1 enabled) — Run through VS Code.",
			"- mcp_probe [off]: Probes things.",
		].join("\n"));
	});

	test("formatToolList stops at 300 tool lines", () => {
		const tools = Array.from({ length: 305 }, (_, index) => ({
			name: `tool_${index}`,
			description: "Does something.",
			enabled: true,
		}));
		const lines = formatToolList([{ id: "big", label: "Big", tools }]).split("\n");
		assert.strictEqual(lines.filter(line => line.startsWith("- ")).length, 300);
		assert.strictEqual(lines.length, 1 + 1 + 300 + 1);
		assert.strictEqual(lines.at(-1), "(5 more tools not shown; narrow the query.)");
	});

	test("formatToolList says when nothing matches", () => {
		assert.strictEqual(formatToolList(GROUPS, { query: "nothing-like-this" }), [HEADER, "No tools match."].join("\n"));
		assert.strictEqual(formatToolList([]), [HEADER, "No tools match."].join("\n"));
	});

	test("formatToolRequestResult reports every partition in order", () => {
		assert.strictEqual(formatToolRequestResult(requestResult({
			enabled: ["a", "b"],
			declined: ["c"],
			alreadyEnabled: ["d"],
			unknown: ["e"],
		})), [
			"Enabled: a, b. They are available from your next request.",
			"Declined by the user: c.",
			"Already enabled: d.",
			"Unknown tools (check list_tools): e.",
		].join("\n"));
		assert.strictEqual(formatToolRequestResult(requestResult({ enabled: ["a"] })), "Enabled: a. They are available from your next request.");
		assert.strictEqual(formatToolRequestResult(requestResult({ alreadyEnabled: ["d"] })), "Already enabled: d.");
	});

	test("formatToolRequestResult explains a denial and an empty request", () => {
		assert.strictEqual(formatToolRequestResult(requestResult({ dismissed: true })), DENIED);
		assert.strictEqual(formatToolRequestResult(requestResult({ dismissed: true, declined: ["c"] })), `${DENIED}\nDeclined by the user: c.`);
		assert.strictEqual(formatToolRequestResult(requestResult({ dismissed: true, enabled: ["a"] })), "Enabled: a. They are available from your next request.");
		assert.strictEqual(formatToolRequestResult(requestResult()), "No tools to enable.");
	});

	test("formatToolRequestResult waits for the next user message when the provider cannot grow its catalog", () => {
		assert.strictEqual(formatToolRequestResult(requestResult({ enabled: ["a", "b"], availableFrom: "nextMessage" })),
			"Enabled: a, b. This model keeps its tool list for the current answer, so they become available with the user's next message; finish what you can now and say which step needs them.");
		assert.strictEqual(formatToolRequestResult(requestResult({
			enabled: ["a"],
			declined: ["c"],
			availableFrom: "nextMessage",
		})), [
			"Enabled: a. This model keeps its tool list for the current answer, so they become available with the user's next message; finish what you can now and say which step needs them.",
			"Declined by the user: c.",
		].join("\n"));
		assert.strictEqual(formatToolRequestResult(requestResult({ enabled: ["a"], availableFrom: "nextRequest" })),
			"Enabled: a. They are available from your next request.");
	});

	test("toolsArriveMidTurn is false only for providers with a session-fixed tool list", () => {
		for (const provider of ["Codex", "DeepSeek", "Local", "Other", "Some HTTP source"]) {
			assert.strictEqual(toolsArriveMidTurn(provider), true, provider);
		}
		for (const provider of ["Claude", "Coco", "Cursor"]) {
			assert.strictEqual(toolsArriveMidTurn(provider), false, provider);
		}
	});

	test("request_tools validates the names and the reason", async () => {
		const request = (input: unknown) => tool(REQUEST_TOOLS_TOOL_NAME).invoke(input, token(), {
			requestTools: async () => requestResult(),
		});
		await assert.rejects(request({ names: [], reason: "r" }), /1 to 30/);
		await assert.rejects(request({ names: Array.from({ length: 31 }, (_, index) => `t${index}`), reason: "r" }), /1 to 30/);
		await assert.rejects(request({ names: ["ok", "  "], reason: "r" }), /non-empty/);
		await assert.rejects(request({ names: ["ok"] }), /reason must not be empty/);
		await assert.rejects(request({ names: ["ok"], reason: "   " }), /reason must not be empty/);
		await assert.rejects(request({ names: ["ok"], reason: "x".repeat(501) }), /at most 500/);
	});

	test("request_tools trims and dedupes names before asking", async () => {
		const asked: string[][] = [];
		const text = await tool(REQUEST_TOOLS_TOOL_NAME).invoke({ names: [" a ", "a", "b"], reason: "  why  " }, token(), {
			requestTools: async names => {
				asked.push(names);
				return requestResult({ enabled: names });
			},
		});
		assert.deepStrictEqual(asked, [["a", "b"]]);
		assert.strictEqual(text, "Enabled: a, b. They are available from your next request.");
	});

	test("request_tools needs the main chat agent and honours cancellation", async () => {
		const request = tool(REQUEST_TOOLS_TOOL_NAME);
		await assert.rejects(request.invoke({ names: ["a"], reason: "r" }, token()), /only available to the main chat agent/);

		const source = new vscode.CancellationTokenSource();
		tokens.push(source);
		await assert.rejects(request.invoke({ names: ["a"], reason: "r" }, source.token, {
			requestTools: async () => {
				source.cancel();
				return requestResult();
			},
		}), vscode.CancellationError);
	});

	test("list_tools needs the main chat agent and passes query and onlyDisabled through", async () => {
		const list = tool(LIST_TOOLS_TOOL_NAME);
		await assert.rejects(list.invoke({}, token()), /only available to the main chat agent/);
		const text = await list.invoke({ query: "mcp", onlyDisabled: true }, token(), { listTools: () => GROUPS });
		assert.strictEqual(text, [
			HEADER,
			"## MCP servers (0/1 enabled) — Run through VS Code.",
			"- mcp_probe [off]: Probes things.",
		].join("\n"));
	});
});
