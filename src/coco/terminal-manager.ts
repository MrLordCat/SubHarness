import { randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { stripVTControlCharacters } from "node:util";
import * as vscode from "vscode";

export interface CocoTerminalHost {
	createTerminal(options: vscode.TerminalOptions): vscode.Terminal;
	onDidChangeTerminalShellIntegration: vscode.Event<vscode.TerminalShellIntegrationChangeEvent>;
	onDidStartTerminalShellExecution: vscode.Event<vscode.TerminalShellExecutionStartEvent>;
	onDidEndTerminalShellExecution: vscode.Event<vscode.TerminalShellExecutionEndEvent>;
	onDidCloseTerminal: vscode.Event<vscode.Terminal>;
}

interface Command {
	text: string;
	mode: "sync" | "async";
	startedAt: number;
	lastOutputAt?: number;
	promptSuppressed?: boolean;
	/** The sync wait ended while the command still ran; with no output for a while the terminal counts as hung. */
	waitExpired?: boolean;
	execution: vscode.TerminalShellExecution;
	output: string;
	truncated: boolean;
	state: "running" | "completed" | "closed";
	exitCode?: number;
	done: Promise<void>;
	finish: () => void;
	drain: Promise<void>;
	outputError?: string;
}

interface Session {
	/** The chat or subagent run whose runs reuse this terminal. */
	owner?: string;
	id: string;
	terminal: vscode.Terminal;
	closed: boolean;
	starting: boolean;
	busy?: vscode.TerminalShellExecution;
	command?: Command;
	/** Directory the terminal was created in; used until shell integration reports one. */
	createdCwd?: string;
	/** Directory reported by the last shell execution. */
	lastCwd?: string;
}

export interface CocoTerminalRunInput {
	/** Owner whose idle terminals may be reused. */
	owner?: string;
	/** Label used for newly created terminals. */
	ownerLabel?: string;
	command: string;
	terminalId?: string;
	newTerminal?: boolean;
	cwd?: string;
	mode?: "sync" | "async";
	timeoutMs?: number;
	maxChars?: number;
}

export interface CocoTerminalSnapshot {
	terminalId: string;
	terminalName: string;
	state: "ready" | "running" | "waiting for input" | "completed" | "closed";
	exitCode?: number;
	output: string;
	truncated: boolean;
	outputError?: string;
}

const OUTPUT_LIMIT = 128_000;

/** Detect common interactive prompts without treating ordinary log labels as questions. */
export function looksLikeInputPrompt(line: string): boolean {
	return /(?:\[(?:y\/n|yes\/no)\]|\((?:y\/n|yes\/no|y)\)|password:|passphrase[^:]*:|press (?:enter|any key)|continue\?|are you sure\??)\s*$/i.test(line)
		|| /^\s*\?\s+\S.*$/.test(line)
		|| /^\s*enter\s+.+:\s*$/i.test(line);
}

/** Reduce terminal redraws and repeated consecutive lines for model output. */
export function collapseProgress(text: string): string {
	const sourceLines = text.split("\n");
	const lines = sourceLines.map((line, index) => {
		const crlf = index < sourceLines.length - 1 && line.endsWith("\r");
		const parts = (crlf ? line.slice(0, -1) : line).split("\r");
		const last = parts[parts.length - 1] || [...parts].reverse().find(part => part.length > 0) || "";
		return last + (crlf ? "\r" : "");
	});
	const result: string[] = [];
	for (let i = 0; i < lines.length;) {
		let end = i + 1;
		while (end < lines.length && lines[end] === lines[i]) { end++; }
		const count = end - i;
		if (count >= 3) {
			result.push(lines[i], `… (repeated ${count} times)${lines[i].endsWith("\r") ? "\r" : ""}`);
		} else {
			result.push(...lines.slice(i, end));
		}
		i = end;
	}
	return result.join("\n");
}

/**
 * The model-supplied cwd becomes a `cd` the user never approved, so it must be
 * an existing directory: a newline would start a second command in cmd, and
 * quotes, `$`, backticks or `%` would be expanded by one of the shells.
 */
export function directoryForCd(cwd: string, workspaceRoot?: string): string | undefined {
	if (/["`$%]/.test(cwd) || [...cwd].some(character => character.charCodeAt(0) < 0x20)) { return undefined; }
	const resolved = path.isAbsolute(cwd) ? cwd : workspaceRoot ? path.resolve(workspaceRoot, cwd) : undefined;
	if (!resolved) { return undefined; }
	try {
		if (!fs.statSync(resolved).isDirectory()) { return undefined; }
	} catch {
		return undefined;
	}
	// In bash `cd "D:\"` escapes the closing quote and leaves the prompt waiting.
	return /[\\/]$/.test(resolved) ? resolved + "." : resolved;
}
const bounded = (value: number | undefined, fallback: number, max: number): number =>
	Math.min(max, Math.max(0, Number.isFinite(value) ? Math.round(value!) : fallback));

/** Owns real integrated terminals. Closing the tab closes its shell and settles the tool. */
export class CocoTerminalManager implements vscode.Disposable {
	private readonly sessions = new Map<string, Session>();
	private readonly closedIds = new Map<string, { owner?: string; reason: string }>();
	private readonly subscriptions: vscode.Disposable[];
	private disposed = false;
	private sequence = 0;

	constructor(
		private readonly host: CocoTerminalHost = vscode.window,
		private readonly integrationTimeoutMs = 20_000,
		private readonly onLog?: (event: string, data: Record<string, unknown>) => void,
		private readonly terminalName = "Coco",
		/** hungQuietMs: silence after a sync timeout that makes a terminal hung (60 s); maxPerOwner: open terminals per owner (4). */
		private readonly options: { hungQuietMs?: number; maxPerOwner?: number; now?: () => number; promptQuietMs?: number } = {},
	) {
		this.subscriptions = [
			host.onDidStartTerminalShellExecution(event => {
				const session = this.find(event.terminal);
				if (session) {
					session.busy = event.execution;
					if (event.execution.cwd) { session.lastCwd = event.execution.cwd.fsPath; }
				}
			}),
			host.onDidEndTerminalShellExecution(event => {
				const session = this.find(event.terminal);
				if (!session) { return; }
				if (session.busy === event.execution) { session.busy = undefined; }
				const command = session.command;
				if (command?.execution !== event.execution || command.state !== "running") { return; }
				command.state = "completed";
				command.exitCode = event.exitCode;
				// The end event can precede the last output chunk.
				void this.waitFor(command.drain, 200).then(command.finish);
			}),
			host.onDidCloseTerminal(terminal => {
				const session = this.find(terminal);
				if (session) { this.markClosed(session); }
			}),
		];
	}

	async run(input: CocoTerminalRunInput, token: vscode.CancellationToken): Promise<CocoTerminalSnapshot> {
		if (this.disposed) { throw new Error("Coco terminal service is closed."); }
		if (typeof input.command !== "string" || !input.command.trim()) { throw new Error("A non-empty command is required."); }
		if (token.isCancellationRequested) { throw new vscode.CancellationError(); }
		if (input.terminalId && input.newTerminal) { throw new Error("Use either terminalId or newTerminal, not both."); }
		const selection = this.select(input);
		const session = selection.session;
		this.onLog?.("coco.terminal.run", {
			command: input.command.slice(0, 160),
			owner: input.owner,
			cwd: input.cwd,
			requestedId: input.terminalId,
			newTerminal: input.newTerminal === true,
			action: selection.created ? "create" : "reuse",
			reason: selection.reason,
			terminalId: session.id,
			terminalName: (session.terminal as { name?: string }).name,
			idleCount: [...this.sessions.values()].filter(candidate => this.isIdle(candidate)).length,
			sessionCwd: this.knownCwd(session),
		});
		if (session.closed) { throw new Error("This terminal was closed. Omit terminalId to select another terminal."); }
		if (session.starting || session.busy || session.command?.state === "running") {
			throw new Error("This terminal is busy. Read its output, or use a new terminal; do not interrupt the user's command.");
		}
		if (input.terminalId && input.cwd && !this.matchesCwd(session, input.cwd)) {
			throw new Error("cwd does not match this terminal's reported directory. Omit cwd to preserve shell state, or omit terminalId to select a terminal in that directory.");
		}
		session.starting = true;
		// Keep selection ordered by last use, including explicitly selected terminals.
		this.sessions.delete(session.id);
		this.sessions.set(session.id, session);
		session.terminal.show(true);
		const cancellation = token.onCancellationRequested(() => this.close(session));
		try {
			const integration = await this.waitForIntegration(session, token);
			if (token.isCancellationRequested) { throw new vscode.CancellationError(); }
			if (session.closed || session.busy) { throw new Error("The terminal was closed or became busy before execution. No command was sent."); }
			// Reusing a terminal that sits in another directory: enter the requested
			// directory first instead of leaving an extra terminal behind.
			if (!input.terminalId && input.cwd && !this.matchesCwd(session, input.cwd)) {
				const entered = await this.enterDirectory(session, integration, input.cwd, token).catch(() => false);
				if (!entered) {
					// The shell refused the change; a terminal created there is the honest option.
					const replacement = this.createForRun(input);
					this.onLog?.("coco.terminal.run", {
						command: input.command.slice(0, 160), cwd: input.cwd, owner: input.owner,
						action: "create", reason: "directory-change-failed",
						terminalId: replacement.id, idleCount: [...this.sessions.values()].filter(candidate => this.isIdle(candidate)).length,
					});
					// A parallel run must not pick the replacement while it is still starting.
					replacement.starting = true;
					try {
						await this.prepareSession(replacement, token);
						const replacementIntegration = replacement.terminal.shellIntegration
							?? await this.waitForIntegration(replacement, token);
						return await this.executeIn(replacement, input, token, replacementIntegration);
					} finally {
						replacement.starting = false;
					}
				}
			}
			return await this.executeIn(session, input, token, integration);
		} catch (error) {
			// If initialization failed, leave no empty terminal behind. Never replay a command.
			if (!session.command) { this.close(session); }
			if (token.isCancellationRequested) { throw new vscode.CancellationError(); }
			throw error;
		} finally {
			session.starting = false;
			cancellation.dispose();
		}
	}

	/** Shows the terminal and waits until shell integration can execute commands. */
	private async prepareSession(session: Session, token: vscode.CancellationToken): Promise<vscode.TerminalShellIntegration> {
		this.sessions.delete(session.id);
		this.sessions.set(session.id, session);
		session.terminal.show(true);
		return this.waitForIntegration(session, token);
	}

	private async executeIn(
		session: Session,
		input: CocoTerminalRunInput,
		token: vscode.CancellationToken,
		integration: vscode.TerminalShellIntegration,
	): Promise<CocoTerminalSnapshot> {
		if (token.isCancellationRequested) { throw new vscode.CancellationError(); }
		if (session.closed || session.busy) { throw new Error("The terminal was closed or became busy before execution. No command was sent."); }
		const execution = integration.executeCommand(input.command);
		let finish!: () => void;
		const command: Command = {
			execution, text: input.command, mode: input.mode ?? "sync", startedAt: this.now(), output: "", truncated: false, state: "running",
			done: new Promise<void>(resolve => { finish = resolve; }), finish: () => finish(), drain: Promise.resolve(),
		};
		session.command = command;
		// Subscribe immediately: read() does not replay earlier terminal output.
		command.drain = this.capture(execution.read(), command);
		const waitMs = input.mode === "async" ? 1_000 : bounded(input.timeoutMs, 120_000, 3_600_000);
		let waiting = false;
		if (input.mode === "async") {
			await this.waitFor(command.done, waitMs, token);
		} else {
			waiting = await this.waitForPrompt(command, waitMs, token);
		}
		if (!waiting && command.state === "running" && command.mode === "sync") {
			command.waitExpired = true;
		}
		if (token.isCancellationRequested) { throw new vscode.CancellationError(); }
		return this.snapshot(session, bounded(input.maxChars, 12_000, OUTPUT_LIMIT), waiting);
	}

	/** Runs `cd` in the reused terminal; false when the shell could not enter the directory. */
	private async enterDirectory(
		session: Session,
		integration: vscode.TerminalShellIntegration,
		cwd: string,
		token: vscode.CancellationToken,
	): Promise<boolean> {
		// A double-quoted path works in PowerShell, bash and cmd; anything else
		// falls back to a new terminal opened in that directory.
		const directory = directoryForCd(cwd, vscode.workspace.workspaceFolders?.[0]?.uri.fsPath);
		if (!directory) { return false; }
		const command = `cd "${directory}"`;
		let finish!: () => void;
		const directoryChange: Command = {
			execution: integration.executeCommand(command), text: command, mode: "sync", startedAt: this.now(), output: "", truncated: false, state: "running",
			done: new Promise<void>(resolve => { finish = resolve; }), finish: () => finish(), drain: Promise.resolve(),
		};
		session.command = directoryChange;
		directoryChange.drain = this.capture(directoryChange.execution.read(), directoryChange);
		await this.waitFor(directoryChange.done, 10_000, token);
		const entered = directoryChange.state === "completed" && directoryChange.exitCode === 0;
		this.onLog?.("coco.terminal.change_directory", {
			terminalId: session.id, cwd, exitCode: directoryChange.exitCode, state: directoryChange.state, entered,
		});
		return entered && !token.isCancellationRequested;
	}

	async read(terminalId: string, waitMs = 0, maxChars = 12_000, token?: vscode.CancellationToken, ownerId?: string): Promise<CocoTerminalSnapshot> {
		const session = this.get(terminalId, ownerId);
		if (token?.isCancellationRequested) { throw new vscode.CancellationError(); }
		let waiting = false;
		if (session.command) {
			if (session.command.state === "running") {
				waiting = await this.waitForPrompt(session.command, bounded(waitMs, 0, 60_000), token);
			} else {
				await this.waitFor(session.command.done, 200, token);
			}
		}
		return this.snapshot(session, bounded(maxChars, 12_000, OUTPUT_LIMIT), waiting);
	}

	send(terminalId: string, text: string, addNewLine = true, ownerId?: string): CocoTerminalSnapshot {
		const session = this.get(terminalId, ownerId);
		if (session.closed) { throw new Error("This terminal was closed."); }
		if (!session.command || session.command.state !== "running") {
			throw new Error("Use the run tool for a new command. Input is only accepted while a command is running.");
		}
		session.terminal.show(true);
		session.terminal.sendText(text, addNewLine);
		session.command.promptSuppressed = true;
		return this.snapshot(session);
	}

	kill(terminalId: string, ownerId?: string): CocoTerminalSnapshot {
		const session = this.get(terminalId, ownerId);
		this.close(session, "closed by kill_terminal");
		return this.snapshot(session);
	}

	dispose(): void {
		this.disposed = true;
		for (const session of this.sessions.values()) { this.close(session); }
		for (const subscription of this.subscriptions) { subscription.dispose(); }
		this.sessions.clear();
	}

	private now(): number {
		return (this.options.now ?? Date.now)();
	}

	private quietMs(session: Session): number | undefined {
		const command = session.command;
		if (session.closed || !command || command.state !== "running" || command.mode !== "sync" || !command.waitExpired) {
			return undefined;
		}
		return this.now() - (command.lastOutputAt ?? command.startedAt);
	}

	private isHung(session: Session): boolean {
		const quiet = this.quietMs(session);
		return quiet !== undefined && quiet >= (this.options.hungQuietMs ?? 60_000);
	}

	/** Closes idle or hung terminals belonging to an owner. */
	closeOwner(owner: string): number {
		let count = 0;
		for (const session of this.sessions.values()) {
			if (session.owner === owner && (this.isIdle(session) || this.isHung(session))) {
				this.close(session, "closed because its owner ended");
				count++;
			}
		}
		this.onLog?.("coco.terminal.close_owner", { owner, count });
		return count;
	}

	private createForRun(input: CocoTerminalRunInput): Session {
		const owned = [...this.sessions.values()].filter(session => !session.closed && !session.terminal.exitStatus && session.owner === input.owner);
		const hung = owned.filter(session => this.isHung(session)).sort((a, b) => this.quietMs(b)! - this.quietMs(a)!)[0];
		if (hung) {
			this.onLog?.("coco.terminal.replace_hung", { terminalId: hung.id, owner: input.owner, command: hung.command?.text.slice(0, 160), quietMs: this.quietMs(hung) });
			this.close(hung, "replaced after timeout");
		} else if (owned.length >= (this.options.maxPerOwner ?? 4)) {
			this.onLog?.("coco.terminal.owner_limit", { owner: input.owner, count: owned.length });
			const listing = owned.map(session => {
				const state = session.starting || session.busy || session.command?.state === "running" ? "running" : "idle";
				return `- ${session.id}: ${(session.command?.text ?? "").slice(0, 80)} (${state})`;
			}).join("\n");
			throw new Error(`All ${owned.length} ${input.ownerLabel ?? this.terminalName} terminals are busy:\n${listing}\n`
				+ "Read one with read_terminal, stop it with send_to_terminal interrupt, or close it with kill_terminal before starting another.");
		}
		return this.create(input.cwd, input.owner, input.ownerLabel);
	}

	private create(cwd?: string, owner?: string, ownerLabel?: string): Session {
		if (this.sessions.size >= 64) {
			for (const [id, session] of this.sessions) {
				if (session.closed) { this.sessions.delete(id); }
				if (this.sessions.size < 64) { break; }
			}
		}
		if ([...this.sessions.values()].filter(session => !session.closed).length >= 32) {
			throw new Error(`Close an unused ${this.terminalName} terminal before creating another.`);
		}
		const session: Session = {
			id: randomUUID(), owner, closed: false, starting: false,
			createdCwd: cwd,
			terminal: this.host.createTerminal({
				name: `${ownerLabel ?? this.terminalName} ${++this.sequence}`, cwd: cwd || vscode.workspace.workspaceFolders?.[0]?.uri,
				location: vscode.TerminalLocation.Panel,
				// Git otherwise opens a pager in the panel and waits for "q".
				env: { GIT_PAGER: "cat", PAGER: "cat" },
			}),
		};
		this.sessions.set(session.id, session);
		return session;
	}

	/**
	 * Picks the terminal for a run. A cwd only forces a new terminal when no idle
	 * one is in that directory: models pass cwd on most calls, and creating a tab
	 * per command left the panel full of terminals.
	 */
	private select(input: CocoTerminalRunInput): { session: Session; created: boolean; reason: string } {
		if (input.terminalId) {
			return { session: this.get(input.terminalId, input.owner), created: false, reason: "explicit-terminal-id" };
		}
		const idle = [...this.sessions.values()].reverse().filter(candidate => candidate.owner === input.owner && this.isIdle(candidate));
		if (input.newTerminal) {
			return { session: this.createForRun(input), created: true, reason: "new-terminal-requested" };
		}
		if (!input.cwd) {
			const session = idle[0];
			return session
				? { session, created: false, reason: "idle-terminal" }
				: { session: this.createForRun(input), created: true, reason: "no-idle-terminal" };
		}
		const matching = idle.find(candidate => this.matchesCwd(candidate, input.cwd!));
		if (matching) {
			return { session: matching, created: false, reason: "idle-terminal-in-cwd" };
		}
		const reusable = idle[0];
		if (reusable) {
			return { session: reusable, created: false, reason: "idle-terminal-other-cwd" };
		}
		return { session: this.createForRun(input), created: true, reason: "no-idle-terminal" };
	}

	/** Shell-reported directory, then the last execution's, then the creation directory. */
	private knownCwd(session: Session): string | undefined {
		return session.terminal.shellIntegration?.cwd?.fsPath ?? session.lastCwd ?? session.createdCwd;
	}

	private isIdle(session: Session): boolean {
		return !session.closed && !session.terminal.exitStatus && !session.starting && !session.busy
			&& session.command?.state !== "running";
	}

	private matchesCwd(session: Session, cwd: string): boolean {
		const actual = this.knownCwd(session);
		if (!actual) { return false; }
		const normalize = (directory: string) => {
			const resolved = path.resolve(directory);
			return process.platform === "win32" ? resolved.toLowerCase() : resolved;
		};
		return normalize(actual) === normalize(cwd);
	}

	private get(id: string, ownerId?: string): Session {
		const session = this.sessions.get(id);
		if (session) { return session; }
		const closed = this.closedIds.get(id);
		const reason = closed
			? `It was ${closed.reason}.`
			: "It was closed (kill_terminal, the user, or idle replacement) or the window was reloaded — terminals do not survive a reload.";
		const live = [...this.sessions.values()].filter(candidate => !candidate.closed && !candidate.terminal.exitStatus && (ownerId === undefined || candidate.owner === ownerId));
		const listing = live.map(candidate => {
			const running = candidate.starting || candidate.busy || candidate.command?.state === "running";
			return `${candidate.id} "${candidate.terminal.name}" (${running ? `running: ${(candidate.command?.text ?? "").slice(0, 80)}` : "idle"})`;
		}).join(", ");
		throw new Error(`Unknown terminal ID ${id}. ${reason} ${listing ? `Live terminals of this chat: ${listing}.` : "No terminals are open; run_in_terminal opens one."}`);
	}

	private find(terminal: vscode.Terminal): Session | undefined {
		return [...this.sessions.values()].find(session => session.terminal === terminal);
	}

	private close(session: Session, reason = "closed"): void {
		if (session.closed) { return; }
		this.markClosed(session, reason);
		session.terminal.dispose();
	}

	private markClosed(session: Session, reason = "closed by the user"): void {
		if (session.closed) { return; }
		this.closedIds.set(session.id, { owner: session.owner, reason });
		if (this.closedIds.size > 50) { this.closedIds.delete(this.closedIds.keys().next().value!); }
		session.closed = true;
		session.busy = undefined;
		if (session.command?.state === "running") { session.command.state = "closed"; session.command.finish(); }
	}

	private snapshot(session: Session, maxChars = 12_000, waiting = false): CocoTerminalSnapshot {
		const command = session.command;
		const output = collapseProgress(command?.output ?? "");
		return {
			terminalId: session.id, terminalName: session.terminal.name,
			state: session.closed ? "closed" : waiting && command?.state === "running" ? "waiting for input" : command?.state ?? "ready",
			exitCode: command?.exitCode, output: maxChars > 0 ? output.slice(-maxChars) : "",
			truncated: Boolean(command?.truncated || output.length > maxChars),
			...(command?.outputError ? { outputError: command.outputError } : {}),
		};
	}

	private async capture(stream: AsyncIterable<string>, command: Command): Promise<void> {
		try {
			for await (const chunk of stream) {
				command.lastOutputAt = this.now();
				command.promptSuppressed = false;
				command.output += stripVTControlCharacters(chunk);
				if (command.output.length > OUTPUT_LIMIT) {
					command.output = collapseProgress(command.output);
					if (command.output.length > OUTPUT_LIMIT) {
						command.output = command.output.slice(-OUTPUT_LIMIT);
						command.truncated = true;
					}
				}
			}
		} catch {
			command.outputError = "VS Code stopped providing terminal output. Inspect the terminal panel; do not run the command again automatically.";
		}
	}

	private waitForIntegration(session: Session, token: vscode.CancellationToken): Promise<vscode.TerminalShellIntegration> {
		if (session.terminal.shellIntegration) { return Promise.resolve(session.terminal.shellIntegration); }
		return new Promise((resolve, reject) => {
			const subscriptions: vscode.Disposable[] = [];
			const settle = (integration?: vscode.TerminalShellIntegration, error?: Error) => {
				clearTimeout(timer);
				for (const subscription of subscriptions) { subscription.dispose(); }
				if (integration) { resolve(integration); } else { reject(error); }
			};
			const timer = setTimeout(() => settle(undefined, new Error(
				"Terminal shell integration did not activate. Enable terminal.integrated.shellIntegration.enabled and select a supported shell (PowerShell 7, bash or zsh). No command was sent."
			)), this.integrationTimeoutMs);
			subscriptions.push(
				this.host.onDidChangeTerminalShellIntegration(event => {
					if (event.terminal === session.terminal) { settle(event.shellIntegration); }
				}),
				this.host.onDidCloseTerminal(terminal => {
					if (terminal === session.terminal) { settle(undefined, new Error("Terminal closed before execution. No command was sent.")); }
				}),
				token.onCancellationRequested(() => settle(undefined, new vscode.CancellationError())),
			);
			if (token.isCancellationRequested) { settle(undefined, new vscode.CancellationError()); }
		});
	}

	private waitForPrompt(command: Command, ms: number, token?: vscode.CancellationToken): Promise<boolean> {
		const deadline = Date.now() + ms;
		const quietMs = Math.max(1, this.options.promptQuietMs ?? 2_000);
		return new Promise((resolve, reject) => {
			let timer: ReturnType<typeof setTimeout> | undefined;
			let settled = false;
			const settle = (waiting: boolean, cancelled = false) => {
				if (settled) { return; }
				settled = true;
				if (timer) { clearTimeout(timer); }
				cancellation?.dispose();
				if (cancelled) { reject(new vscode.CancellationError()); } else { resolve(waiting); }
			};
			const check = () => {
				if (command.state === "running" && !command.promptSuppressed && command.lastOutputAt !== undefined
					&& this.now() - command.lastOutputAt >= quietMs) {
					const lastLine = collapseProgress(command.output).split(/\r?\n/).reverse().find(line => line.trim().length > 0);
					if (lastLine && looksLikeInputPrompt(lastLine)) { settle(true); return; }
				}
				const remaining = deadline - Date.now();
				if (remaining <= 0) { settle(false); return; }
				timer = setTimeout(check, Math.min(remaining, Math.min(quietMs, 100)));
			};
			const cancellation = token?.onCancellationRequested(() => settle(false, true));
			void command.done.then(() => settle(false));
			if (token?.isCancellationRequested) { settle(false, true); } else { check(); }
		});
	}

	private waitFor(done: Promise<void>, ms: number, token?: vscode.CancellationToken): Promise<void> {
		return new Promise((resolve, reject) => {
			const settle = (cancelled = false) => {
				clearTimeout(timer); cancellation?.dispose();
				if (cancelled) { reject(new vscode.CancellationError()); } else { resolve(); }
			};
			const timer = setTimeout(() => settle(), ms);
			const cancellation = token?.onCancellationRequested(() => settle(true));
			void done.then(() => settle());
			if (token?.isCancellationRequested) { settle(true); }
		});
	}
}