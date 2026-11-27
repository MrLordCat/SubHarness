import * as vscode from "vscode";
import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import * as path from "node:path";
import { inspect } from "node:util";

import { EXTENSION_ID } from "./constants";

type LogLevel = "debug" | "info" | "warn" | "error";

interface LogRecord {
	ts: string;
	sessionId: string;
	level: LogLevel;
	event: string;
	data?: unknown;
}

export interface LlamaLogSink {
	log(event: string, data?: unknown, level?: LogLevel): void;
	logError(event: string, error: unknown, data?: unknown): void;
	shouldLogStreamChunks(): boolean;
}

/** A single window keeps one file per 16 MB; the folder as a whole stays under 60 MB. */
export const MAX_LOG_FILE_BYTES = 16 * 1024 * 1024;
export const MAX_LOG_TOTAL_BYTES = 60 * 1024 * 1024;

/** Limits are injectable for tests; the extension uses the constants above. */
export interface LlamaLogOptions {
	maxFileBytes?: number;
	maxTotalBytes?: number;
}

export class LlamaLogService implements vscode.Disposable, LlamaLogSink {
	private readonly output = vscode.window.createOutputChannel("Llama.cpp Provider");
	private readonly sessionId = randomUUID();
	private readonly logDirPath: string;
	private readonly maxFileBytes: number;
	private readonly maxTotalBytes: number;

	private currentLogPath: string | undefined;
	private currentLogBytes = 0;
	private logFileSequence = 0;
	private initPromise: Promise<void> | undefined;
	private writeQueue: Promise<void> = Promise.resolve();
	private disposed = false;

	constructor(context: vscode.ExtensionContext, options: LlamaLogOptions = {}) {
		this.logDirPath = path.join(context.globalStorageUri.fsPath, "logs");
		this.maxFileBytes = Math.max(1024, Math.floor(options.maxFileBytes ?? MAX_LOG_FILE_BYTES));
		this.maxTotalBytes = Math.max(this.maxFileBytes, Math.floor(options.maxTotalBytes ?? MAX_LOG_TOTAL_BYTES));
	}

	async initialize(): Promise<void> {
		if (!this.isEnabled()) {
			return;
		}

		await this.ensureReady();
		this.log("session.start", {
			vscodeVersion: vscode.version,
			extensionVersion: vscode.extensions.getExtension(EXTENSION_ID)?.packageJSON?.version,
			logFile: this.currentLogPath,
		});
	}

	dispose(): void {
		this.disposed = true;
		this.output.dispose();
	}

	log(event: string, data?: unknown, level: LogLevel = "info"): void {
		if (!this.isEnabled() || this.disposed) {
			return;
		}

		const payload: LogRecord = {
			ts: new Date().toISOString(),
			sessionId: this.sessionId,
			level,
			event,
		};
		if (data !== undefined) {
			payload.data = this.toSerializable(data);
		}

		const line = `${this.safeStringify(payload)}\n`;
		const bytes = Buffer.byteLength(line, "utf8");
		this.enqueueWrite(async () => {
			await this.ensureReady();
			if (!this.currentLogPath) {
				return;
			}
			// Rotate before the line that would cross the limit. A single huge line is
			// written whole and rotation happens before the next one.
			if (this.currentLogBytes > 0 && this.currentLogBytes + bytes > this.maxFileBytes) {
				await this.rotateLog();
				if (!this.currentLogPath) {
					return;
				}
			}
			await fs.appendFile(this.currentLogPath, line, "utf8");
			this.currentLogBytes += bytes;
		});
	}

	/** Waits until queued log writes (including a rotation) reach disk. */
	async flush(): Promise<void> {
		await this.writeQueue;
	}

	logError(event: string, error: unknown, data?: unknown): void {
		const serializedError = this.serializeError(error);
		const payload: Record<string, unknown> = {
			error: serializedError,
		};
		if (data !== undefined) {
			payload.context = this.toSerializable(data);
		}

		this.log(event, payload, "error");
		this.output.appendLine(`[${event}] ${serializedError.message}`);
	}

	shouldLogStreamChunks(): boolean {
		if (!this.isEnabled()) {
			return false;
		}
		return vscode.workspace.getConfiguration("llamacpp").get<boolean>("logStreamChunks", false) === true;
	}

	async openLogsFolder(): Promise<void> {
		await fs.mkdir(this.logDirPath, { recursive: true });
		const uri = vscode.Uri.file(this.logDirPath);
		try {
			await vscode.commands.executeCommand("revealFileInOS", uri);
		} catch {
			await vscode.env.openExternal(uri);
		}
	}

	async openLatestLogFile(): Promise<string | undefined> {
		const filePath = await this.findLatestLogPath();
		if (!filePath) {
			vscode.window.showWarningMessage("No Llama.cpp logs found yet.");
			return undefined;
		}

		const uri = vscode.Uri.file(filePath);
		const doc = await vscode.workspace.openTextDocument(uri);
		await vscode.window.showTextDocument(doc, { preview: false });
		return filePath;
	}

	async copyLatestLogPath(): Promise<string | undefined> {
		const filePath = await this.findLatestLogPath();
		if (!filePath) {
			vscode.window.showWarningMessage("No Llama.cpp logs found yet.");
			return undefined;
		}

		await vscode.env.clipboard.writeText(filePath);
		vscode.window.showInformationMessage(`Llama.cpp log path copied: ${filePath}`);
		return filePath;
	}

	private isEnabled(): boolean {
		return vscode.workspace.getConfiguration("llamacpp").get<boolean>("enableFileLogging", true) !== false;
	}

	private enqueueWrite(task: () => Promise<void>): void {
		this.writeQueue = this.writeQueue.then(task).catch(err => {
			const message = err instanceof Error ? err.message : String(err);
			this.output.appendLine(`[logging-error] ${message}`);
		});
	}

	private async ensureReady(): Promise<void> {
		if (this.initPromise) {
			await this.initPromise;
			return;
		}

		this.initPromise = (async () => {
			await fs.mkdir(this.logDirPath, { recursive: true });
			if (!this.currentLogPath) {
				this.currentLogPath = this.nextLogPath();
				const stat = await fs.stat(this.currentLogPath).catch(() => undefined);
				this.currentLogBytes = stat?.size ?? 0;
			}
			await this.pruneOldLogs(this.getMaxLogFiles());
			await this.pruneTotalSize();
		})().catch(error => {
			this.initPromise = undefined;
			throw error;
		});

		await this.initPromise;
	}

	/** The session id stays the same across rotated files, so log readers can join them. */
	private nextLogPath(): string {
		const stamp = new Date().toISOString().replace(/[.:]/g, "-");
		const sequence = this.logFileSequence++;
		return path.join(this.logDirPath, `llamacpp-${stamp}-${process.pid}${sequence === 0 ? "" : `-${sequence}`}.jsonl`);
	}

	private async rotateLog(): Promise<void> {
		this.currentLogPath = this.nextLogPath();
		this.currentLogBytes = 0;
		await this.pruneOldLogs(this.getMaxLogFiles());
		await this.pruneTotalSize();
	}

	private getMaxLogFiles(): number {
		const raw = vscode.workspace.getConfiguration("llamacpp").get<number>("maxLogFiles", 20);
		if (!Number.isFinite(raw)) {
			return 20;
		}
		return Math.max(1, Math.min(200, Math.floor(raw)));
	}

	private async listLogFiles(): Promise<Array<{ filePath: string; mtimeMs: number; size: number }>> {
		const entries = await fs.readdir(this.logDirPath, { withFileTypes: true });
		const files = entries.filter(entry => entry.isFile() && entry.name.endsWith(".jsonl"));
		const withStats: Array<{ filePath: string; mtimeMs: number; size: number }> = [];
		for (const entry of files) {
			const filePath = path.join(this.logDirPath, entry.name);
			const stat = await fs.stat(filePath).catch(() => undefined);
			if (stat?.isFile()) {
				withStats.push({ filePath, mtimeMs: stat.mtimeMs, size: stat.size });
			}
		}
		return withStats;
	}

	private async pruneOldLogs(maxFiles: number): Promise<void> {
		const files = await this.listLogFiles();
		if (files.length <= maxFiles) {
			return;
		}

		files.sort((a, b) => b.mtimeMs - a.mtimeMs);
		for (const stale of files.slice(maxFiles)) {
			if (stale.filePath === this.currentLogPath) {
				continue;
			}
			await fs.unlink(stale.filePath).catch(() => undefined);
		}
	}

	/** Oldest logs go first; room for one full current file is reserved so the folder stays under the limit. */
	private async pruneTotalSize(): Promise<void> {
		const files = await this.listLogFiles();
		const target = Math.max(0, this.maxTotalBytes - this.maxFileBytes);
		let total = files.reduce((sum, file) => sum + file.size, 0);
		if (total <= target) {
			return;
		}

		files.sort((a, b) => a.mtimeMs - b.mtimeMs);
		for (const stale of files) {
			if (total <= target) {
				break;
			}
			if (stale.filePath === this.currentLogPath) {
				continue;
			}
			try {
				await fs.unlink(stale.filePath);
				total -= stale.size;
			} catch {
				// Another window or the user already removed it.
			}
		}
	}

	private async findLatestLogPath(): Promise<string | undefined> {
		if (this.currentLogPath) {
			return this.currentLogPath;
		}

		await fs.mkdir(this.logDirPath, { recursive: true });
		const files = await this.listLogFiles();
		if (files.length === 0) {
			return undefined;
		}

		files.sort((a, b) => b.mtimeMs - a.mtimeMs);
		return files[0]?.filePath;
	}

	private serializeError(error: unknown): { name: string; message: string; stack?: string } {
		if (error instanceof Error) {
			return {
				name: error.name,
				message: error.message,
				stack: error.stack,
			};
		}
		return {
			name: "Error",
			message: String(error),
		};
	}

	private toSerializable(value: unknown): unknown {
		try {
			JSON.stringify(value);
			return value;
		} catch {
			return {
				type: "non-serializable",
				preview: inspect(value, { depth: 4, maxArrayLength: 80, breakLength: 140 }),
			};
		}
	}

	private safeStringify(value: unknown): string {
		try {
			return JSON.stringify(value);
		} catch {
			return JSON.stringify({
				ts: new Date().toISOString(),
				sessionId: this.sessionId,
				level: "error",
				event: "logging.serialize_failure",
				data: {
					type: "non-serializable",
					preview: inspect(value, { depth: 2, maxArrayLength: 40, breakLength: 120 }),
				},
			});
		}
	}
}
