import * as assert from "node:assert";
import * as vscode from "vscode";

import { requestFixedTokens } from "../chat/chat-controller";
import { estimateTextTokens } from "../chat/compaction";
import { convertToolResult } from "../claude/app-server-client";
import { convertCodexToolResult, findCodexToolContinuations, serializeCodexConversation } from "../codex/message-adapter";
import { isWholeResultTool, toolResultCharLimit, WHOLE_RESULT_MAX_CHARS } from "../tools/tool-result-limits";

function report(chars: number): string {
	return `REPORT-HEAD\n${"r".repeat(chars)}\nREPORT-TAIL`;
}

function resultText(result: { content: Array<{ type: string; text?: string }> }): string {
	return result.content.filter(item => item.type === "text").map(item => item.text ?? "").join("\n");
}

suite("Tool result limits", () => {
	test("subagent reports get the whole-result limit, other tools keep the provider's", () => {
		assert.strictEqual(toolResultCharLimit("subagent", 16_000), WHOLE_RESULT_MAX_CHARS);
		assert.strictEqual(toolResultCharLimit("wait_subagents", 12_000), WHOLE_RESULT_MAX_CHARS);
		assert.strictEqual(toolResultCharLimit("mcp__vscode__subagent", 16_000), WHOLE_RESULT_MAX_CHARS);
		assert.strictEqual(toolResultCharLimit("read_file", 16_000), 16_000);
		assert.strictEqual(toolResultCharLimit(undefined, 24_000), 24_000);
		// A higher provider limit and "no limit" stay as they are.
		assert.strictEqual(toolResultCharLimit("subagent", 100_000), 100_000);
		assert.strictEqual(toolResultCharLimit("subagent", 0), 0);
		assert.ok(isWholeResultTool("wait_subagents"));
		assert.ok(!isWholeResultTool("close_subagent"));
	});

	test("Claude passes a long subagent report whole and still cuts a long file read", () => {
		const long = report(30_000);
		const forSubagent = resultText(convertToolResult(new vscode.LanguageModelToolResultPart("a", [new vscode.LanguageModelTextPart(long)]), "subagent"));
		assert.strictEqual(forSubagent, long);
		const forRead = resultText(convertToolResult(new vscode.LanguageModelToolResultPart("b", [new vscode.LanguageModelTextPart(long)]), "read_file"));
		assert.ok(forRead.length < 17_000);
		assert.match(forRead, /\[tool result truncated\]/);
		const huge = resultText(convertToolResult(new vscode.LanguageModelToolResultPart("c", [new vscode.LanguageModelTextPart(report(90_000))]), "wait_subagents"));
		assert.ok(huge.length <= WHOLE_RESULT_MAX_CHARS + 40);
		assert.ok(huge.startsWith("REPORT-HEAD") && huge.endsWith("REPORT-TAIL"));
	});

	test("Codex passes a subagent report whole in a continuation and in the serialized history", () => {
		const long = report(30_000);
		const messages = [
			vscode.LanguageModelChatMessage.User("Delegate it"),
			vscode.LanguageModelChatMessage.Assistant([new vscode.LanguageModelToolCallPart("sub-1", "subagent", { prompt: "audit" })]),
			vscode.LanguageModelChatMessage.User([new vscode.LanguageModelToolResultPart("sub-1", [new vscode.LanguageModelTextPart(long)])]),
		];
		const [match] = findCodexToolContinuations(messages, new Set(["sub-1"]));
		assert.strictEqual(match.name, "subagent");
		const converted = convertCodexToolResult(match.result, 12_000, match.name);
		assert.strictEqual(converted.contentItems[0].type === "inputText" ? converted.contentItems[0].text : "", long);
		const cut = convertCodexToolResult(match.result, 12_000, "read_file");
		assert.ok((cut.contentItems[0].type === "inputText" ? cut.contentItems[0].text : "").length <= 12_000);

		const serialized = serializeCodexConversation(messages, { maxToolResultChars: 12_000 });
		assert.strictEqual(serialized.truncatedToolResultCount, 0);
		// The conversation is sent as JSON, so the report appears with its line breaks escaped.
		assert.ok(serialized.text.includes(JSON.stringify(long).slice(1, -1)));
	});

	test("the fixed part of a request counts the tool schemas", () => {
		const tools: vscode.LanguageModelChatTool[] = [{
			name: "read_file",
			description: "Reads a text file from the workspace.",
			inputSchema: { type: "object", properties: { filePath: { type: "string", description: "Path of the file." } } },
		}];
		const system = "You are a helpful agent.";
		assert.ok(requestFixedTokens(system, tools) > estimateTextTokens(system));
		assert.strictEqual(requestFixedTokens(system, []), estimateTextTokens(system));
		assert.strictEqual(requestFixedTokens(undefined, []), 0);
	});
});
