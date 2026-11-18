import { mkdir, writeFile } from "node:fs/promises";
import { build, context } from "esbuild";

const args = new Set(process.argv.slice(2));
const dev = args.has("--dev");
const watch = args.has("--watch");
const harness = args.has("--harness");

/** @type {import("esbuild").BuildOptions} */
const shared = {
	bundle: true,
	format: "iife",
	platform: "browser",
	target: "es2022",
	jsx: "automatic",
	jsxImportSource: "preact",
	logLevel: "warning",
	minify: !dev,
	...(dev ? { sourcemap: "inline" } : {}),
};

/** @type {import("esbuild").BuildOptions} */
const options = {
	...shared,
	entryPoints: ["src/chat/webview/main.tsx"],
	outfile: "out/webview/chat.js",
};

/** @type {import("esbuild").BuildOptions | undefined} */
const harnessOptions = harness ? {
	...shared,
	entryPoints: {
		harness: "src/chat/webview/harness.ts",
		chat: "src/chat/webview/main.tsx",
	},
	outdir: "artifacts/chat-harness",
} : undefined;

const harnessHtml = `<!DOCTYPE html>
<html lang="en">
<head>
	<meta charset="UTF-8">
	<meta name="viewport" content="width=device-width, initial-scale=1.0">
	<title>AI Agent Bridge chat harness</title>
	<style>
		/* Default Dark Modern values; VS Code injects the real ones into the webview. */
		:root {
			--vscode-font-family: "Segoe UI", system-ui, sans-serif;
			--vscode-font-size: 13px;
			--vscode-editor-font-family: Consolas, "Courier New", monospace;
			--vscode-foreground: #cccccc;
			--vscode-descriptionForeground: #9d9d9d;
			--vscode-errorForeground: #f85149;
			--vscode-editorWarning-foreground: #cca700;
			--vscode-focusBorder: #0078d4;
			--vscode-widget-border: #313131;
			--vscode-textLink-foreground: #4daafc;
			--vscode-editor-background: #1f1f1f;
			--vscode-sideBar-background: #181818;
			--vscode-input-background: #313131;
			--vscode-input-foreground: #cccccc;
			--vscode-input-border: #3c3c3c;
			--vscode-button-background: #0078d4;
			--vscode-button-foreground: #ffffff;
			--vscode-textCodeBlock-background: #2b2b2b;
		}
		html, body { margin: 0; height: 100%; background: #181818; }
	</style>
	<link rel="stylesheet" href="chat.css">
</head>
<body>
	<div id="root"></div>
	<script src="harness.js"></script>
	<script src="chat.js"></script>
</body>
</html>
`;

async function buildHarnessPage() {
	await mkdir("artifacts/chat-harness", { recursive: true });
	await writeFile("artifacts/chat-harness/index.html", harnessHtml, "utf8");
}

try {
	if (watch) {
		const ctx = await context(options);
		await ctx.watch();
		if (harnessOptions) {
			await buildHarnessPage();
			const harnessCtx = await context(harnessOptions);
			await harnessCtx.watch();
		}
		console.log("webview: watching src/chat/webview");
	} else {
		await build(options);
		if (harnessOptions) {
			await build(harnessOptions);
			await buildHarnessPage();
		}
		console.log(`webview: built out/webview/chat.js${dev ? " (dev)" : ""}`);
		if (harnessOptions) {
			console.log("webview: built artifacts/chat-harness/harness.js and chat.js");
		}
	}
} catch (error) {
	console.error(error instanceof Error ? error.message : error);
	process.exitCode = 1;
}
