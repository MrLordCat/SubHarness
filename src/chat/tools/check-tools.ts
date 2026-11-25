import * as fs from "node:fs";
import * as path from "node:path";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import * as vscode from "vscode";
import { commandKind } from "../approvals";
import { findDangerousCommands, type DangerousCommandRule } from "./danger";
import { CHAT_TOOL_GROUPS, type ChatTool } from "./types";
import { vscodeWorkspaceRoots } from "./workspace-paths";

interface Check {
	name: string;
	command: string;
	timeoutMs?: number;
}
const DEFAULT_TIMEOUT = 600_000;
const MIN_TIMEOUT = 10_000;
const MAX_TIMEOUT = 1_800_000;

function timeout(value: unknown, minTimeoutMs = MIN_TIMEOUT): number | undefined {
	if (value === undefined) {
		return undefined;
	}
	if (typeof value !== "number" || !Number.isFinite(value) || value < minTimeoutMs || value > MAX_TIMEOUT) {
		throw new Error(`timeoutMs must be between ${minTimeoutMs} and ${MAX_TIMEOUT}.`);
	}
	return value;
}

export function resolveChecks(root: string, minTimeoutMs = MIN_TIMEOUT): Check[] {
	const config = path.join(root, ".subharness", "checks.json");
	if (fs.existsSync(config)) {
		const data: unknown = JSON.parse(fs.readFileSync(config, "utf8"));
		const checks = (data as { checks?: unknown })?.checks;
		if (!Array.isArray(checks) || checks.length > 10) {
			throw new Error("checks.json must contain a checks array with at most 10 entries.");
		}
		const names = new Set<string>();
		return checks.map((item: unknown) => {
			const entry = item as Partial<Check> | null;
			if (
				!entry ||
				typeof entry.name !== "string" ||
				!/^[a-z0-9][a-z0-9_-]{0,31}$/i.test(entry.name) ||
				names.has(entry.name) ||
				typeof entry.command !== "string" ||
				!entry.command.trim()
			) {
				throw new Error(
					"Invalid or duplicate check in checks.json: names must be unique and valid and commands non-empty."
				);
			}
			names.add(entry.name);
			return { name: entry.name, command: entry.command, timeoutMs: timeout(entry.timeoutMs, minTimeoutMs) };
		});
	}
	const pkg = path.join(root, "package.json");
	if (!fs.existsSync(pkg)) {
		return [];
	}
	const scripts = (JSON.parse(fs.readFileSync(pkg, "utf8")) as { scripts?: Record<string, unknown> }).scripts ?? {};
	const result: Check[] = [];
	const compile =
		typeof scripts.compile === "string" ? "compile" : typeof scripts.build === "string" ? "build" : undefined;
	if (compile) {
		result.push({ name: "compile", command: `npm run ${compile}` });
	}
	for (const name of ["lint", "test"]) {
		if (typeof scripts[name] === "string") {
			result.push({ name, command: `npm run ${name}` });
		}
	}
	return result;
}

export function parseCheckOutput(output: string, failed: boolean): string {
	// ANSI escape sequences are control characters by definition.
	// eslint-disable-next-line no-control-regex
	const clean = output.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "");
	const details: string[] = [];
	const counts = [...clean.matchAll(/\b\d+ (?:passing|pending|failing)\b/g)].map((match) => match[0]);
	if (counts.length) {
		details.push(counts.join(", "));
	}
	const failingSummary = /^\s*\d+ failing\b[^\n]*$/m.exec(clean);
	const failureText = failingSummary ? clean.slice(failingSummary.index + failingSummary[0].length) : "";
	const failures = [...failureText.matchAll(/^[ \t]*\d+\) ([^\n]+)\n([\s\S]*?)(?=^[ \t]*\d+\) |$(?![\s\S]))/gm)].slice(
		0,
		10
	);
	for (const failure of failures) {
		const lines = failure[2].trim().split(/\r?\n/);
		const errorStart = lines.findIndex((line) => /^\s*(?:\w*Error|AssertionError):/.test(line));
		const title = errorStart < 0 ? lines : lines.slice(0, errorStart);
		const error = errorStart < 0 ? [] : lines.slice(errorStart, errorStart + 6);
		details.push([failure[1], ...title, ...error].join("\n"));
	}
	const ts = clean
		.split(/\r?\n/)
		.filter((line) => /(?:\(\d+,\d+\)|:\d+:\d+ -)\s*:\s*error TS\d+|:\d+:\d+ - error TS\d+/.test(line));
	if (ts.length) {
		details.push(`TypeScript errors: ${ts.length}\n${ts.slice(0, 10).join("\n")}`);
	}
	const summary = clean.match(/✖\s+\d+ problems? \(\d+ errors?, \d+ warnings?\)/);
	if (summary) {
		const errors: string[] = [];
		let file = "";
		for (const line of clean.split(/\r?\n/)) {
			if (line && !/^\s/.test(line) && !line.startsWith("✖")) {
				file = line;
			}
			if (/^\s*\d+:\d+\s+error\s+/.test(line)) {
				errors.push(`${file}: ${line.trim()}`);
			}
		}
		details.push([summary[0], ...errors.slice(0, 10)].join("\n"));
	}
	if (!details.length && failed) {
		details.push(clean.split(/\r?\n/).slice(-30).join("\n"));
	}
	return details.join("\n");
}

const OUTPUT_LIMIT = 20 * 1024 * 1024;

function killTree(child: ReturnType<typeof spawn>): void {
	if (!child.pid) {
		return;
	}
	try {
		if (process.platform === "win32") {
			const killer = spawn("taskkill", ["/PID", String(child.pid), "/T", "/F"], { windowsHide: true });
			killer.on("error", () => child.kill());
		} else {
			process.kill(-child.pid, "SIGKILL");
		}
	} catch {
		child.kill();
	}
}

async function runCheck(
	check: Check,
	root: string,
	timeoutMs: number,
	token: vscode.CancellationToken
): Promise<{ status: string; output: string }> {
	if (token.isCancellationRequested) {
		return { status: "CANCELLED", output: "" };
	}
	return new Promise((resolve) => {
		const child = spawn(check.command, {
			shell: true,
			cwd: root,
			env: process.env,
			windowsHide: true,
			detached: process.platform !== "win32",
		});
		let stopped: string | undefined;
		let output = "";
		let truncated = false;
		const append = (chunk: string): void => {
			output += chunk;
			if (output.length > OUTPUT_LIMIT) {
				output = output.slice(-OUTPUT_LIMIT);
				truncated = true;
			}
		};
		const stop = (reason: string): void => {
			if (!stopped) {
				stopped = reason;
				killTree(child);
			}
		};
		const timer = setTimeout(() => stop("TIMED OUT"), timeoutMs);
		const subscription = token.onCancellationRequested(() => stop("CANCELLED"));
		child.stdout?.setEncoding("utf8");
		child.stderr?.setEncoding("utf8");
		child.stdout?.on("data", append);
		child.stderr?.on("data", append);
		child.on("error", (error) => append(error.message));
		child.on("close", (code) => {
			clearTimeout(timer);
			subscription.dispose();
			const status = stopped ?? (code === 0 ? "PASSED" : `FAILED (exit ${code ?? "unknown"})`);
			resolve({ status, output: truncated ? "[Earlier output truncated]\n" + output : output });
		});
		if (token.isCancellationRequested) {
			stop("CANCELLED");
		}
	});
}

async function pruneLogs(dir: string, keep: number): Promise<void> {
	const names = (await fs.promises.readdir(dir)).filter((name) => name.endsWith(".log"));
	const logs = await Promise.all(
		names.map(async (name) => ({
			name,
			stat: await fs.promises.stat(path.join(dir, name)),
		}))
	);
	logs.sort((a, b) => b.stat.mtimeMs - a.stat.mtimeMs);
	await Promise.all(logs.slice(keep).map((log) => fs.promises.unlink(path.join(dir, log.name))));
}

export function createCheckTool(options: {
	logDir: string;
	rules: () => readonly DangerousCommandRule[];
	roots?: () => readonly string[];
	isTrusted?: () => boolean;
	minTimeoutMs?: number;
}): ChatTool {
	const roots = options.roots ?? (() => vscodeWorkspaceRoots.roots());
	function selected(input: unknown): { root: string; checks: Check[]; override?: number } {
		const root = roots()[0];
		if (!root) {
			throw new Error("A workspace folder is required.");
		}
		const value = (input && typeof input === "object" ? input : {}) as { checks?: unknown; timeoutMs?: unknown };
		const checks = resolveChecks(root, options.minTimeoutMs);
		if (!checks.length) {
			throw new Error(
				"No checks configured. Add .subharness/checks.json with a checks array containing name and command entries."
			);
		}
		let chosen = checks;
		if (value.checks !== undefined) {
			if (!Array.isArray(value.checks) || !value.checks.every((name) => typeof name === "string")) {
				throw new Error("checks must be an array of names.");
			}
			chosen = value.checks.map((name) => {
				const check = checks.find((item) => item.name === name);
				if (!check) {
					throw new Error(`Unknown check ${name}. Available: ${checks.map((item) => item.name).join(", ")}.`);
				}
				return check;
			});
		}
		return { root, checks: chosen, override: timeout(value.timeoutMs, options.minTimeoutMs) };
	}
	return {
		name: "run_checks",
		group: CHAT_TOOL_GROUPS.terminal,
		description:
			"Run project checks without a terminal and return pass/fail counts and failures. Prefer this over running build, lint, or test commands in a terminal.",
		inputSchema: {
			type: "object",
			properties: {
				checks: { type: "array", items: { type: "string" } },
				timeoutMs: { type: "number", minimum: MIN_TIMEOUT, maximum: MAX_TIMEOUT },
			},
			additionalProperties: false,
		},
		needsConfirmation(input) {
			let checks: Check[];
			try {
				checks = selected(input).checks;
			} catch {
				return undefined;
			}
			const matches = checks
				.flatMap((check) => findDangerousCommands(check.command, options.rules()));
			const kinds = [...new Map(matches.map((match) => { const kind = commandKind(match); return [kind.key, kind]; })).values()];
			return matches.length
				? {
						title: "Run checks",
						detail: checks.map((check) => check.command).join("\n"),
						reason: matches.map((match) => `Matches the dangerous-command rule for "${match.text}".`).join("\n"),
						kinds,
					}
				: undefined;
		},
		async invoke(input, token) {
			if (!(options.isTrusted ?? (() => vscode.workspace.isTrusted))()) {
				throw new Error("Trust this workspace before running checks.");
			}
			const { root, checks, override } = selected(input);
			await fs.promises.mkdir(options.logDir, { recursive: true });
			const results: string[] = [];
			for (const check of checks) {
				const start = Date.now();
				const { output, status } = await runCheck(check, root, override ?? check.timeoutMs ?? DEFAULT_TIMEOUT, token);
				const log = path.join(options.logDir, `${Date.now()}-${randomUUID()}-${check.name}.log`);
				await fs.promises.writeFile(log, output, "utf8");
				const details = parseCheckOutput(output, status !== "PASSED");
				const budget = Math.max(
					0,
					Math.floor(7000 / Math.max(checks.length, 1)) - check.command.length - log.length - check.name.length
				);
				const excerpt = details.length > budget ? details.slice(0, budget) + "… [details truncated]" : details;
				results.push(
					`${check.name} — ${status} · ${((Date.now() - start) / 1000).toFixed(1)}s · ${check.command}\n${excerpt ? excerpt + "\n" : ""}Full log: ${log}`
				);
				if (status === "TIMED OUT" || status === "CANCELLED") {
					break;
				}
			}
			await pruneLogs(options.logDir, 50);
			const text = results.join("\n\n");
			return text.length > 8000 ? text.slice(0, 7980) + "\n[output truncated]" : text;
		},
	};
}
