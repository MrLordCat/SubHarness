import { randomUUID } from "node:crypto";
import * as vscode from "vscode";

interface BackgroundRun {
	id: string;
	description: string;
	status: "running" | "ok" | "error" | "cancelled";
	report: string;
	delivered: boolean;
	noted: boolean;
	promise: Promise<void>;
}

function formatReport(run: BackgroundRun): string {
	return `## ${run.id} — ${run.description} (${run.status})\n${run.report}`;
}

export class BackgroundSubagents {
	private readonly runs = new Map<string, BackgroundRun>();

	start(prepare: () => { id?: string; description: string; run: () => Promise<string> }, token: vscode.CancellationToken): string {
		const active = [...this.runs.values()].filter(run => run.status === "running");
		if (active.length >= 3) {
			throw new Error(`Three background subagents are already running: ${active.map(run => `${run.id} (${run.description})`).join(", ")}.`);
		}
		const task = prepare();
		let id = task.id ?? `bg-${randomUUID().slice(0, 8)}`;
		while (this.runs.has(id) && !this.runs.get(id)?.delivered) {
			if (task.id) {
				throw new Error(`Collect the previous report for ${id} before starting another background task.`);
			}
			id = `bg-${randomUUID().slice(0, 8)}`;
		}
		const entry: BackgroundRun = { id, description: task.description, status: "running", report: "", delivered: false, noted: false, promise: Promise.resolve() };
		this.runs.set(id, entry);
		entry.promise = task.run().then(report => {
			entry.report = report;
			entry.status = "ok";
		}, error => {
			entry.report = error instanceof Error ? error.message : String(error);
			entry.status = token.isCancellationRequested || error instanceof vscode.CancellationError ? "cancelled" : "error";
		});
		return `Started background subagent ${id}: ${entry.description}. Continue your own work; call wait_subagents to collect its report.`;
	}

	async wait(ids: string[] | undefined, timeoutMs: number, token: vscode.CancellationToken): Promise<string> {
		const entries = ids ? ids.map(id => {
			const entry = this.runs.get(id);
			if (!entry) {
				throw new Error(`Unknown background subagent ${id}.`);
			}
			return entry;
		}) : [...this.runs.values()].filter(entry => !entry.delivered);
		if (!entries.length) {
			return "No background subagent reports to collect.";
		}
		let timer: ReturnType<typeof setTimeout> | undefined;
		let subscription: vscode.Disposable | undefined;
		try {
			await Promise.race([
				Promise.all(entries.map(entry => entry.promise)),
				new Promise<void>(resolve => { timer = setTimeout(resolve, timeoutMs); }),
				new Promise<void>((_resolve, reject) => {
					if (token.isCancellationRequested) {
						reject(new vscode.CancellationError());
					} else {
						subscription = token.onCancellationRequested(() => reject(new vscode.CancellationError()));
					}
				}),
			]);
		} finally {
			if (timer) {
				clearTimeout(timer);
			}
			subscription?.dispose();
		}
		const finished = entries.filter(entry => entry.status !== "running" && !entry.delivered);
		for (const entry of finished) {
			entry.delivered = true;
		}
		const pending = entries.filter(entry => entry.status === "running");
		const lines = finished.map(formatReport);
		if (pending.length) {
			lines.push(`Still running: ${pending.map(entry => `${entry.id} (${entry.description})`).join(", ")}.`);
		}
		return lines.join("\n\n") || "No background subagent reports to collect.";
	}

	takeFinishedNotes(): string {
		const finished = [...this.runs.values()].filter(entry => entry.status !== "running" && !entry.delivered && !entry.noted);
		for (const entry of finished) {
			entry.noted = true;
		}
		return finished.map(entry => `[Background subagent ${entry.id} finished; collect its report with wait_subagents.]`).join("\n");
	}

	async settled(): Promise<void> {
		await Promise.all([...this.runs.values()].map(entry => entry.promise));
	}

	undelivered(): string {
		const reports = [...this.runs.values()].filter(entry => !entry.delivered);
		for (const entry of reports) {
			entry.delivered = true;
		}
		return reports.map(formatReport).join("\n\n");
	}
}
