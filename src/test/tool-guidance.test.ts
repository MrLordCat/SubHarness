import * as assert from "node:assert";
import * as fs from "node:fs";
import * as path from "node:path";
import { BASE_CHAT_INSTRUCTIONS } from "../chat/prompt/instructions";
import { SUBAGENT_INSTRUCTIONS } from "../chat/subagent-runner";
import { createCoreTools } from "../chat/tools/core-tools";
import { createAskQuestionsTool, createTodoTool } from "../chat/tools/interaction-tools";
import { createCloseSubagentTool, createSubagentTool, createWaitSubagentsTool } from "../chat/tools/subagent-tool";
import { createSymbolTools } from "../chat/tools/symbol-tools";
import { createChatTerminalTools } from "../chat/tools/terminal-tools";
import { createCheckTool } from "../chat/tools/check-tools";
import { createChangesDiffTool } from "../chat/tools/changes-tools";
import { createToolAccessTools } from "../chat/tools/tool-access-tools";
import type { ChatTool } from "../chat/tools/types";
import { createWebTools } from "../chat/tools/web-tools";
import { COCO_CHAT_TOOL_POLICY } from "../coco/tool-policy";
import { COCO_TOOL_DESCRIPTION_LIMIT } from "../coco/turn-bridge";
import type { SharedMemoryService } from "../memory/shared-memory-service";
import { createMemoryTools } from "../memory/tools";

suite("Tool descriptions and guidance", () => {
	const unusedRun = async (): Promise<never> => {
		throw new Error("The terminal manager is not used by this test.");
	};
	const unusedSync = (): never => {
		throw new Error("The terminal manager is not used by this test.");
	};

	function bridgeTools(): ChatTool[] {
		return [
			...createCoreTools(),
			...createWebTools(),
			...createSymbolTools(),
			createTodoTool(),
			createChangesDiffTool(),
			createAskQuestionsTool(),
			...createToolAccessTools(),
			...createChatTerminalTools({
				manager: { run: unusedRun, read: unusedRun, send: unusedSync, kill: unusedSync },
				rules: () => [],
			}),
			createCheckTool({ logDir: "unused-by-this-test", rules: () => [] }),
			createSubagentTool({ models: () => [] }),
			createWaitSubagentsTool({ models: () => [] }),
			createCloseSubagentTool({ models: () => [] }),
			// The memory tools only use the service when they run.
			...createMemoryTools({} as SharedMemoryService),
		];
	}

	function length(description: string): number {
		return description.replace(/\s+/g, " ").trim().length;
	}

	/** Arguments of a schema that lack a description, nested object items included. */
	function undocumentedArguments(schema: unknown, path = ""): string[] {
		if (typeof schema !== "object" || schema === null) {
			return [];
		}
		const missing: string[] = [];
		const properties = (schema as { properties?: unknown }).properties;
		if (typeof properties === "object" && properties !== null && !Array.isArray(properties)) {
			for (const [name, property] of Object.entries(properties as Record<string, unknown>)) {
				const description = typeof property === "object" && property !== null
					? (property as { description?: unknown }).description
					: undefined;
				if (typeof description !== "string" || description.trim() === "") {
					missing.push(`${path}${name}`);
				}
				missing.push(...undocumentedArguments(property, `${path}${name}.`));
			}
		}
		const items = (schema as { items?: unknown }).items;
		if (typeof items === "object" && items !== null) {
			missing.push(...undocumentedArguments(items, `${path}[].`));
		}
		return missing;
	}

	test("every built-in tool argument has a description", () => {
		for (const tool of bridgeTools()) {
			assert.deepStrictEqual(undocumentedArguments(tool.inputSchema), [], `${tool.name} has arguments without a description`);
		}
	});

	test("every bridge chat tool description is present and fits the Coco CLI budget", () => {
		for (const tool of bridgeTools()) {
			assert.ok(tool.description.trim().length > 0, `${tool.name} has no description`);
			const size = length(tool.description);
			assert.ok(size <= COCO_TOOL_DESCRIPTION_LIMIT, `${tool.name}: ${size} characters, limit ${COCO_TOOL_DESCRIPTION_LIMIT}`);
		}
	});

	test("the extension contributes no VS Code language model tools; the chat owns its tools", () => {
		const manifest = JSON.parse(fs.readFileSync(path.resolve(__dirname, "../../package.json"), "utf8")) as {
			contributes: { languageModelTools?: unknown; languageModelChatProviders?: unknown };
		};
		assert.strictEqual(manifest.contributes.languageModelTools, undefined);
		assert.strictEqual(manifest.contributes.languageModelChatProviders, undefined);
	});

	test("the prompts send the model to list_tools and request_tools", () => {
		assert.ok(BASE_CHAT_INSTRUCTIONS.includes("list_tools"), "BASE_CHAT_INSTRUCTIONS lacks list_tools");
		assert.ok(BASE_CHAT_INSTRUCTIONS.includes("request_tools"), "BASE_CHAT_INSTRUCTIONS lacks request_tools");
		assert.ok(COCO_CHAT_TOOL_POLICY.includes("list_tools"), "COCO_CHAT_TOOL_POLICY lacks list_tools");
		assert.ok(COCO_CHAT_TOOL_POLICY.includes("request_tools"), "COCO_CHAT_TOOL_POLICY lacks request_tools");
		assert.ok(SUBAGENT_INSTRUCTIONS.includes("cannot turn on more tools"), "SUBAGENT_INSTRUCTIONS lacks the tool limitation note");
	});
});
