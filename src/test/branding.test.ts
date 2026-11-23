import * as assert from "node:assert";
import * as fs from "node:fs";
import * as path from "node:path";

suite("SubHarness branding", () => {
	const root = path.resolve(__dirname, "..", "..");
	const manifest = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8")) as {
		name: string;
		publisher: string;
		displayName: string;
		version: string;
		repository: { url: string };
		contributes: {
				viewsContainers: { activitybar: Array<{ title: string }>; secondarySidebar: Array<{ id: string; title: string }> };
			views: Record<string, Array<{ id: string; type?: string }>>;
			configuration: {
				title: string;
				properties: Record<
					string,
					{
						default?: unknown;
						minimum?: number;
						description?: string;
					}
				>;
			};
			commands: Array<{ title: string; category?: string }>;
		};
	};

	test("uses the new product name while preserving compatibility ids", () => {
		assert.strictEqual(manifest.displayName, "SubHarness");
		assert.strictEqual(manifest.name, "llama-vscode-chat");
		assert.strictEqual(manifest.publisher, "mrlordcat");
		assert.strictEqual(manifest.contributes.viewsContainers.activitybar[0].title, "SubHarness");
		const chatContainer = manifest.contributes.viewsContainers.secondarySidebar[0];
		assert.strictEqual(chatContainer.title, "SubHarness");
		assert.deepStrictEqual(manifest.contributes.views[chatContainer.id].map(view => [view.id, view.type]), [["llamacpp.chat", "webview"]],
			"the chat keeps its view id and lives in the secondary side bar");
		assert.ok(!Object.entries(manifest.contributes.views).some(([container, views]) => container !== chatContainer.id && views.some(view => view.id === "llamacpp.chat")));
		assert.strictEqual(manifest.contributes.configuration.title, "SubHarness");
		assert.strictEqual(manifest.repository.url, "https://github.com/MrLordCat/SubHarness.git");
	});

	test("brands every contributed command consistently", () => {
		for (const command of manifest.contributes.commands) {
			assert.match(command.title, /^SubHarness:/);
			if (command.category) {
				assert.strictEqual(command.category, "SubHarness");
			}
		}
	});

	test("keeps Claude model segments uncapped by default", () => {
		const setting = manifest.contributes.configuration.properties["llamacpp.claudeMaxAgentTurns"];
		assert.ok(setting);
		assert.strictEqual(setting.default, 0);
		assert.strictEqual(setting.minimum, 0);
		assert.match(setting.description ?? "", /0 to disable/i);
	});

	test("keeps the main README release and development facts current", () => {
		const readme = fs.readFileSync(path.join(root, "README.md"), "utf8");
		assert.match(readme, /^# SubHarness for VS Code/m);
		// Local dev builds have no release tag; the development install command
		// must name the current package version.
		assert.ok(
			readme.includes(`llama-vscode-chat-${manifest.version}.vsix`),
			"the development install example names the current version"
		);
		assert.ok(
			readme.includes(`Current build: ${manifest.version}.`),
			"the development block names the shipping version"
		);
		assert.match(
			readme,
			new RegExp(`${manifest.version} build`),
			"the test command in the development block names this build"
		);
		assert.match(readme, /\d+ extension-host tests/, "the README names the extension-host test count");
		assert.doesNotMatch(readme, /Copilot|\bpatch(es)?\b/i, "the README presents the SubHarness chat, not Copilot or its patches");
		assert.ok(!readme.includes("github.com/MrLordCat/ai-agent-bridge"), "the README links the renamed repository");
		assert.doesNotMatch(
			readme,
			/Local LLM Chat Provider|Local LLM:|Stable release: 1.9.0|283 extension-host tests|Patch v16/
		);
	});
});
