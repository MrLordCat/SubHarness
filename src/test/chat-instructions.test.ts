import * as assert from "node:assert";
import * as fsp from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import {
	BASE_CHAT_INSTRUCTIONS,
	ChatPromptSource,
	type ActiveEditorInfo,
	type PromptEnvironmentInfo,
	type PromptFolder,
} from "../chat/prompt/instructions";

suite("Chat prompt instructions", () => {
	let tmpRoot: string;
	const environment: PromptEnvironmentInfo = {
		os: "Windows 11 Enterprise 10.0.26300",
		platform: "win32",
		shell: "pwsh",
		appName: "Visual Studio Code",
	};
	const fixedNow = () => new Date(2026, 10, 18, 23, 59);

	setup(async () => {
		tmpRoot = await fsp.realpath(await fsp.mkdtemp(path.join(os.tmpdir(), "chat-instructions-")));
	});

	teardown(async () => {
		await fsp.rm(tmpRoot, { recursive: true, force: true });
	});

	async function makeFolder(name: string): Promise<PromptFolder> {
		const fsPath = path.join(tmpRoot, name);
		await fsp.mkdir(fsPath, { recursive: true });
		return { name, fsPath };
	}

	function source(folders: readonly PromptFolder[], editor?: ActiveEditorInfo, now: () => Date = fixedNow): ChatPromptSource {
		return new ChatPromptSource({
			folders: () => folders,
			environment: () => environment,
			activeEditor: () => editor,
			now,
		});
	}

	test("starts with the base instructions and exact environment and workspace blocks", async () => {
		const prompt = await source([]).systemPrompt();
		const expectedEnvironment = [
			"<environment_info>",
			`The user's current OS is: ${environment.os} (${environment.platform})`,
			`The user's default shell is: "${environment.shell}"`,
			`The editor is: ${environment.appName}`,
			"</environment_info>",
		].join("\n");
		const expectedWorkspace = "<workspace_info>\nNo workspace folder is open.\n</workspace_info>";

		assert.strictEqual(prompt, [BASE_CHAT_INSTRUCTIONS, expectedEnvironment, expectedWorkspace].join("\n\n"));
		assert.ok(prompt.startsWith("You are an expert AI programming assistant"));
		const bullets = BASE_CHAT_INSTRUCTIONS.split("\n").slice(1);
		assert.ok(bullets.length >= 7 && bullets.every(line => line.startsWith("- ")));
		assert.ok(BASE_CHAT_INSTRUCTIONS.includes("<userRequest>"));
	});

	test("lists workspace folders and omits the shell line when it is unknown", async () => {
		const folder = await makeFolder("repo");
		const prompt = await source([folder]).systemPrompt();
		assert.ok(prompt.includes(`<workspace_info>\nThe workspace has these folders:\n- repo: ${folder.fsPath}\n</workspace_info>`));

		const withoutShell = new ChatPromptSource({
			folders: () => [],
			environment: () => ({ ...environment, shell: undefined }),
			now: fixedNow,
		});
		assert.ok(!(await withoutShell.systemPrompt()).includes("default shell"));
	});

	test("has no instructions block when no instruction file exists", async () => {
		const folder = await makeFolder("empty");
		const prompt = await source([folder]).systemPrompt();
		assert.ok(!prompt.includes("<instructions>"));
	});

	test("includes instruction files in folder and file order with BOM and CRLF normalization", async () => {
		const first = await makeFolder("first");
		const second = await makeFolder("second");
		await fsp.mkdir(path.join(second.fsPath, ".github"), { recursive: true });
		await fsp.writeFile(path.join(first.fsPath, "AGENTS.md"), "\uFEFFAgents one\r\nSecond line\r\n\r\n");
		await fsp.writeFile(path.join(second.fsPath, "AGENTS.md"), "Agents two");
		await fsp.writeFile(path.join(second.fsPath, ".github", "copilot-instructions.md"), "Copilot two");
		const prompt = await source([first, second]).systemPrompt();

		const agentsOne = prompt.indexOf('<instruction file="first/AGENTS.md">');
		const agentsTwo = prompt.indexOf('<instruction file="second/AGENTS.md">');
		const copilotTwo = prompt.indexOf('<instruction file="second/.github/copilot-instructions.md">');
		assert.ok(agentsOne >= 0 && agentsTwo > agentsOne && copilotTwo > agentsTwo);
		assert.ok(prompt.includes('<instruction file="first/AGENTS.md">\nAgents one\nSecond line\n</instruction>'));
		assert.ok(prompt.includes('<instruction file="second/.github/copilot-instructions.md">\nCopilot two\n</instruction>'));
		assert.ok(!prompt.includes("\r"));
		assert.ok(!prompt.includes("\uFEFF"));
	});

	test("truncates an instruction file at 60000 characters", async () => {
		const folder = await makeFolder("large");
		await fsp.writeFile(path.join(folder.fsPath, "AGENTS.md"), "x".repeat(60_001));
		const prompt = await source([folder]).systemPrompt();

		assert.ok(prompt.includes("x".repeat(60_000) + "\n[… truncated: the file is longer than 60000 characters]"));
		assert.ok(!prompt.includes("x".repeat(60_001)));
	});

	test("skips further instruction files once the total limit would be exceeded", async () => {
		const folder = await makeFolder("capped");
		await fsp.mkdir(path.join(folder.fsPath, ".github"), { recursive: true });
		await fsp.writeFile(path.join(folder.fsPath, "AGENTS.md"), "a".repeat(60_000));
		await fsp.writeFile(path.join(folder.fsPath, "CLAUDE.md"), "b".repeat(60_000));
		await fsp.writeFile(path.join(folder.fsPath, ".github", "copilot-instructions.md"), "c".repeat(60_000));
		const prompt = await source([folder]).systemPrompt();

		assert.ok(prompt.includes("a".repeat(60_000)));
		assert.ok(prompt.includes("b".repeat(60_000)));
		assert.ok(!prompt.includes("c".repeat(100)));
		assert.ok(prompt.includes(`[Further instruction files were skipped to keep the prompt small.]\n</instructions>`));
	});

	test("re-reads an instruction file only when its size or mtime changed", async () => {
		const folder = await makeFolder("cache");
		const file = path.join(folder.fsPath, "AGENTS.md");
		await fsp.writeFile(file, "First version.");
		const promptSource = source([folder]);
		const first = await promptSource.systemPrompt();
		assert.deepStrictEqual(await promptSource.systemPrompt(), first);

		const later = new Date(Date.now() + 60_000);
		await fsp.writeFile(file, "Second version.");
		await fsp.utimes(file, later, later);
		const changed = await promptSource.systemPrompt();
		assert.ok(changed.includes("Second version."));
		assert.ok(!changed.includes("First version."));
	});

	test("drops an instruction file that was removed", async () => {
		const folder = await makeFolder("removed");
		const file = path.join(folder.fsPath, "AGENTS.md");
		await fsp.writeFile(file, "Temporary instructions.");
		const promptSource = source([folder]);
		assert.ok((await promptSource.systemPrompt()).includes("Temporary instructions."));

		await fsp.rm(file);
		const prompt = await promptSource.systemPrompt();
		assert.ok(!prompt.includes("Temporary instructions."));
		assert.ok(!prompt.includes("<instructions>"));
	});

	test("turnContext has only the date when no editor is active", () => {
		assert.strictEqual(source([]).turnContext(), "<context>\nThe current date is 2026-11-18.\n</context>");
	});

	test("turnContext uses a workspace-relative path and a selection range", () => {
		const folder: PromptFolder = { name: "repo", fsPath: path.join(tmpRoot, "repo") };
		const filePath = path.join(folder.fsPath, "src", "file.ts");
		const promptSource = source([folder], { filePath, selection: { startLine: 3, endLine: 7 } });
		const expected = [
			"<context>",
			"The current date is 2026-11-18.",
			"The user's current file is src/file.ts.",
			"The current selection is lines 3-7.",
			"</context>",
		].join("\n");

		assert.deepStrictEqual(promptSource.turnContext(), expected);
		assert.deepStrictEqual(promptSource.turnContext(), expected);
	});

	test("turnContext keeps an absolute path for files outside the workspace", () => {
		const folder: PromptFolder = { name: "repo", fsPath: path.join(tmpRoot, "repo") };
		const filePath = path.join(tmpRoot, "outside.ts");
		const context = source([folder], { filePath }).turnContext();

		assert.ok(context.includes(`The user's current file is ${filePath}.`));
		assert.ok(!context.includes("The current selection"));
	});

	test("turnContext formats a single-line selection and pads the date", () => {
		const folder: PromptFolder = { name: "repo", fsPath: path.join(tmpRoot, "repo") };
		const filePath = path.join(folder.fsPath, "src", "file.ts");
		const single = source([folder], { filePath, selection: { startLine: 4, endLine: 4 } }).turnContext();
		assert.ok(single.includes("The current selection is line 4."));

		const padded = source([], undefined, () => new Date(2026, 0, 2, 0, 5)).turnContext();
		assert.ok(padded.includes("The current date is 2026-01-02."));
	});
});
