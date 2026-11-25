import { execFile } from "node:child_process";
import * as vscode from "vscode";

/** What `claude auth status` says; the account email and organisation are left out on purpose. */
export interface ClaudeAuthStatus {
	loggedIn: boolean;
	/** "claude.ai" for a subscription; other values mean API billing. */
	authMethod?: string;
	/** "pro", "max" and so on for a subscription. */
	subscriptionType?: string;
	apiProvider?: string;
}

const AUTH_TIMEOUT_MS = 30_000;
/** The browser step can take a while; after this the sign-in stops waiting. */
const SIGN_IN_TIMEOUT_MS = 15 * 60_000;
const EXIT_POLL_MS = 1_000;

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

function text(value: unknown): string | undefined {
	return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

/** Reads the JSON `claude auth status` prints, also when a warning line comes before it. */
export function parseClaudeAuthStatus(output: string): ClaudeAuthStatus | undefined {
	const start = output.indexOf("{");
	const end = output.lastIndexOf("}");
	if (start < 0 || end < start) {
		return undefined;
	}
	let parsed: unknown;
	try {
		parsed = JSON.parse(output.slice(start, end + 1));
	} catch {
		return undefined;
	}
	if (!isRecord(parsed) || typeof parsed.loggedIn !== "boolean") {
		return undefined;
	}
	const authMethod = text(parsed.authMethod);
	const subscriptionType = text(parsed.subscriptionType);
	const apiProvider = text(parsed.apiProvider);
	return {
		loggedIn: parsed.loggedIn,
		...(authMethod ? { authMethod } : {}),
		...(subscriptionType ? { subscriptionType } : {}),
		...(apiProvider ? { apiProvider } : {}),
	};
}

/** "Claude subscription (Pro)", "Anthropic Console (API billing)" or "not signed in". */
export function describeClaudeAuth(status: ClaudeAuthStatus | undefined): string {
	if (!status) {
		return "status unknown";
	}
	if (!status.loggedIn) {
		return "not signed in";
	}
	if (status.authMethod === "claude.ai") {
		const plan = status.subscriptionType ? ` (${status.subscriptionType.charAt(0).toUpperCase()}${status.subscriptionType.slice(1)})` : "";
		return `Claude subscription${plan}`;
	}
	return `${status.authMethod ?? "unknown method"} (not a Claude subscription)`;
}

export interface ClaudeAuthCommandResult {
	code: number;
	stdout: string;
	stderr: string;
}

/** `env` adds to the process environment, e.g. CLAUDE_CONFIG_DIR of a second account. */
export type ClaudeAuthRunner = (executable: string, args: readonly string[], env?: Readonly<Record<string, string>>) => Promise<ClaudeAuthCommandResult>;

/** Runs `claude auth …` without a window; a non-zero exit is a result, not an error. */
export const runClaudeAuth: ClaudeAuthRunner = (executable, args, env) => new Promise(resolve => {
	execFile(executable, ["auth", ...args], { timeout: AUTH_TIMEOUT_MS, windowsHide: true, maxBuffer: 1024 * 1024, ...(env ? { env: { ...process.env, ...env } } : {}) }, (error, stdout, stderr) => {
		const code = error ? (typeof (error as { code?: unknown }).code === "number" ? (error as { code: number }).code : 1) : 0;
		resolve({ code, stdout: String(stdout ?? ""), stderr: String(stderr ?? "") });
	});
});

export async function readClaudeAuthStatus(executable: string, run: ClaudeAuthRunner = runClaudeAuth, env?: Readonly<Record<string, string>>): Promise<ClaudeAuthStatus | undefined> {
	const result = await run(executable, ["status"], env);
	return parseClaudeAuthStatus(result.stdout);
}

/**
 * Signs Claude Code out. Without `env` that is the built-in account on this computer, the Claude
 * Code extension included; with a CLAUDE_CONFIG_DIR only that account.
 */
export async function signOutClaudeCli(executable: string, run: ClaudeAuthRunner = runClaudeAuth, env?: Readonly<Record<string, string>>): Promise<void> {
	const result = await run(executable, ["logout"], env);
	if (result.code !== 0) {
		const detail = (result.stderr || result.stdout).trim().split(/\r?\n/).at(-1);
		throw new Error(detail ? `claude auth logout failed: ${detail}` : `claude auth logout exited with code ${result.code}`);
	}
}

/**
 * Runs `claude auth login --claudeai` in a terminal: it opens the browser and may ask
 * for a code there. Resolves with the status read after the command ends, the
 * terminal is closed or the wait times out.
 */
export function signInWithClaudeCli(
	executable: string,
	run: ClaudeAuthRunner = runClaudeAuth,
	env?: Readonly<Record<string, string>>,
	name = "Claude sign-in"
): Promise<ClaudeAuthStatus | undefined> {
	const terminal = vscode.window.createTerminal({
		name,
		shellPath: executable,
		shellArgs: ["auth", "login", "--claudeai"],
		...(env ? { env: { ...env } } : {}),
		iconPath: new vscode.ThemeIcon("account"),
		isTransient: true,
	});
	terminal.show();
	return new Promise(resolve => {
		let settled = false;
		const finish = (): void => {
			if (settled) {
				return;
			}
			settled = true;
			clearInterval(poll);
			clearTimeout(timeout);
			closed.dispose();
			void readClaudeAuthStatus(executable, run, env).then(resolve, () => resolve(undefined));
		};
		const closed = vscode.window.onDidCloseTerminal(candidate => {
			if (candidate === terminal) {
				finish();
			}
		});
		// The terminal stays open after the command ends, so its exit status is polled.
		const poll = setInterval(() => {
			if (terminal.exitStatus !== undefined) {
				finish();
			}
		}, EXIT_POLL_MS);
		const timeout = setTimeout(finish, SIGN_IN_TIMEOUT_MS);
	});
}
