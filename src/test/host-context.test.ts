import * as assert from "node:assert";
import * as vscode from "vscode";
import { hostContextSnapshot, updatedInstructionsMessage } from "../providers/host-context";

const system = (value: string) => new vscode.LanguageModelChatMessage(3 as vscode.LanguageModelChatMessageRole, [new vscode.LanguageModelTextPart(value)]);
const text = (message: vscode.LanguageModelChatMessage) => message.content.filter(part => part instanceof vscode.LanguageModelTextPart).map(part => (part as vscode.LanguageModelTextPart).value).join("");

suite("Host context snapshot", () => {
	test("a system message keeps its instructions without the volatile host blocks", () => {
		const snapshot = hostContextSnapshot(system("BASE rules\n\n<environment_info>\nOS A\n</environment_info>\n\n<workspace_info>\nfolder\n</workspace_info>\n\nAGENTS text"));
		assert.strictEqual(snapshot.instructions, "BASE rules\n\nAGENTS text");
		assert.deepStrictEqual([...snapshot.blocks.keys()], ["environment_info", "workspace_info"]);
		assert.match(snapshot.instructionsDigest ?? "", /^[a-f0-9]{64}$/);
	});
	test("only a change outside the host blocks changes the digest", () => {
		const first = hostContextSnapshot(system("BASE <environment_info>OS A</environment_info>"));
		const environment = hostContextSnapshot(system("BASE <environment_info>OS B</environment_info>"));
		const base = hostContextSnapshot(system("BASE v2 <environment_info>OS A</environment_info>"));
		assert.strictEqual(environment.instructionsDigest, first.instructionsDigest);
		assert.notStrictEqual(base.instructionsDigest, first.instructionsDigest);
	});
	test("joins split text parts before matching host blocks", () => {
		const message = new vscode.LanguageModelChatMessage(3 as vscode.LanguageModelChatMessageRole, [new vscode.LanguageModelTextPart("BASE <context>da"), new vscode.LanguageModelTextPart("te</context>")]);
		const snapshot = hostContextSnapshot(message);
		assert.strictEqual(snapshot.blocks.get("context"), "<context>date</context>");
		assert.strictEqual(snapshot.instructions, "BASE");
	});
	test("a user first message yields host blocks but no instructions", () => {
		const snapshot = hostContextSnapshot(vscode.LanguageModelChatMessage.User("RULE <context>terminal</context>"));
		assert.strictEqual(snapshot.blocks.get("context"), "<context>terminal</context>");
		assert.strictEqual(snapshot.instructions, undefined);
		assert.strictEqual(snapshot.instructionsDigest, undefined);
		assert.strictEqual(hostContextSnapshot(undefined).instructions, undefined);
		assert.strictEqual(hostContextSnapshot(system("<environment_info>only</environment_info>")).instructions, undefined);
	});
	test("labels resent instructions as a replacement", () => {
		const message = updatedInstructionsMessage("BASE v2");
		assert.strictEqual(message.role, vscode.LanguageModelChatMessageRole.User);
		assert.strictEqual(text(message), "Current VS Code instructions (updated; they replace the earlier system instructions):\nBASE v2");
	});
});
