#!/usr/bin/env node
// Runs vscode-test and then gives the vscode:// protocol back to the installed VS Code.
//
// On Windows every VS Code start registers itself as the handler of its URL scheme. The test
// build in .vscode-test uses the same "vscode" scheme, so after a test run a click on a chat
// notification started that build, which opened an empty window instead of focusing the chat.
//
//   node scripts/run-vscode-test.mjs [vscode-test args...]   e.g. --grep "quick access"
//   node scripts/run-vscode-test.mjs --restore-only          repairs the handler, runs nothing
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const KEY = "HKCU\\Software\\Classes\\vscode\\shell\\open\\command";

/** The command Windows runs for vscode:// links, or undefined when there is none. */
function readHandler() {
	try {
		const output = execFileSync("reg", ["query", KEY, "/ve"], { encoding: "utf8", windowsHide: true, stdio: ["ignore", "pipe", "ignore"] });
		return /REG_(?:EXPAND_)?SZ\s+(.+)$/m.exec(output)?.[1].trim() || undefined;
	} catch {
		return undefined;
	}
}

function isTestBuild(command) {
	return /[\\/]\.vscode-test[\\/]/i.test(command ?? "");
}

/** The handler of an installed VS Code (user setup first, then system setup), in VS Code's own format. */
function installedHandler() {
	const candidates = [
		process.env.LOCALAPPDATA && path.join(process.env.LOCALAPPDATA, "Programs", "Microsoft VS Code", "Code.exe"),
		process.env.ProgramFiles && path.join(process.env.ProgramFiles, "Microsoft VS Code", "Code.exe"),
	].filter(Boolean);
	const executable = candidates.find(candidate => existsSync(candidate));
	return executable ? `"${executable}" --open-url -- "%1"` : undefined;
}

/** Puts the handler back when a test build took it; never fails the test run. */
function restoreHandler(before) {
	try {
		const current = readHandler();
		if (!isTestBuild(current)) {
			return;
		}
		const target = before && !isTestBuild(before) ? before : installedHandler();
		if (!target) {
			console.warn(`[vscode-test] vscode:// links open the test build (${current}); no installed VS Code was found to give them back to.`);
			return;
		}
		execFileSync("reg", ["add", KEY, "/ve", "/t", "REG_SZ", "/d", target, "/f"], { windowsHide: true, stdio: "ignore" });
		console.log(`[vscode-test] vscode:// links open ${target} again.`);
	} catch (error) {
		console.warn(`[vscode-test] Could not restore the vscode:// handler: ${error instanceof Error ? error.message : String(error)}`);
	}
}

const windows = process.platform === "win32";
const args = process.argv.slice(2);
if (args[0] === "--restore-only") {
	if (windows) {
		restoreHandler(undefined);
	}
	process.exit(0);
}

const before = windows ? readHandler() : undefined;
// The package exports no package.json, so its bin is taken from node_modules beside this script.
const cli = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "node_modules", "@vscode", "test-cli", "out", "bin.mjs");
const result = spawnSync(process.execPath, [cli, ...args], { stdio: "inherit" });
if (windows) {
	restoreHandler(before);
}
if (result.error) {
	console.error(result.error);
}
process.exit(result.status ?? 1);
