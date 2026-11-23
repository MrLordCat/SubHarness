import * as vscode from "vscode";

export interface EditDiagnosticsSource {
	getDiagnostics(uri: vscode.Uri): readonly vscode.Diagnostic[];
	onDidChangeDiagnostics: vscode.Event<vscode.DiagnosticChangeEvent>;
	openDocument(uri: vscode.Uri): Thenable<{ languageId: string }>;
	settleMs?: number;
	maxWaitMs?: number;
}

export const defaultEditDiagnosticsSource: EditDiagnosticsSource = {
	getDiagnostics: uri => vscode.languages.getDiagnostics(uri),
	onDidChangeDiagnostics: vscode.languages.onDidChangeDiagnostics,
	openDocument: uri =>
		Promise.resolve(vscode.workspace.textDocuments.find(doc => doc.uri.toString() === uri.toString()) ?? vscode.workspace.openTextDocument(uri)),
};

const key = (d: vscode.Diagnostic): string => JSON.stringify([d.message, typeof d.code === "object" ? d.code.value : d.code, d.source]);

export function snapshotDiagnostics(uri: vscode.Uri, source: EditDiagnosticsSource): readonly vscode.Diagnostic[] {
	return [...source.getDiagnostics(uri)];
}

const uncheckedLanguages = new Set(["plaintext", "markdown", "log", "csv", "tsv", "ignore", "properties", "diff", "git-commit", "git-rebase"]);

export async function reportEditErrors(
	files: Map<string, readonly vscode.Diagnostic[]>,
	source: EditDiagnosticsSource,
	token: vscode.CancellationToken,
	show: (file: string) => string
): Promise<string> {
	try {
		if (token.isCancellationRequested || files.size === 0) {
			return "";
		}
		const uris = [...files.keys()].map(file => vscode.Uri.file(file));
		const watched = new Set(uris.map(uri => uri.toString()));
		let finish!: () => void;
		let timer: ReturnType<typeof setTimeout> | undefined;
		const settled = new Promise<void>(resolve => {
			finish = resolve;
		});
		const deadline = setTimeout(() => finish(), source.maxWaitMs ?? 1500);
		const listener = source.onDidChangeDiagnostics(event => {
			if (event.uris.some(uri => watched.has(uri.toString()))) {
				if (timer) {
					clearTimeout(timer);
				}
				timer = setTimeout(() => finish(), source.settleMs ?? 300);
			}
		});
		const cancel = token.onCancellationRequested(() => finish());
		try {
			const documents = await Promise.race([Promise.all(uris.map(uri => source.openDocument(uri))), settled.then(() => undefined)]);
			if (documents) {
				// Same order as uris; Uri.fsPath lowercases the drive letter, so it is no lookup key.
				const before = [...files.values()];
				for (let index = 0; index < uris.length; index++) {
					const uri = uris[index];
					if (uncheckedLanguages.has(documents[index].languageId) && before[index].length === 0) {
						watched.delete(uri.toString());
					}
				}
				if (watched.size === 0) {
					return "";
				}
			}
			await settled;
		} finally {
			clearTimeout(deadline);
			if (timer) {
				clearTimeout(timer);
			}
			listener.dispose();
			cancel.dispose();
		}
		if (token.isCancellationRequested) {
			return "";
		}
		const lines: string[] = [];
		for (const [file, before] of files) {
			if (!watched.has(vscode.Uri.file(file).toString())) {
				continue;
			}
			const counts = new Map<string, number>();
			for (const d of before.filter(d => d.severity === vscode.DiagnosticSeverity.Error)) {
				const k = key(d);
				counts.set(k, (counts.get(k) ?? 0) + 1);
			}
			for (const d of snapshotDiagnostics(vscode.Uri.file(file), source).filter(d => d.severity === vscode.DiagnosticSeverity.Error)) {
				const k = key(d);
				const count = counts.get(k) ?? 0;
				if (count) {
					counts.set(k, count - 1);
					continue;
				}
				const code = typeof d.code === "object" ? d.code.value : d.code;
				const label = code === undefined ? "" : ` ${d.source?.toLowerCase() === "ts" ? "TS" : ""}${code}:`;
				lines.push(`${show(file)}:${d.range.start.line + 1}:${d.range.start.character + 1} error${label} ${d.message.replace(/\r?\n/g, " ")}`);
			}
		}
		if (!lines.length) {
			return "";
		}
		return `\n\nNew errors in edited files (${lines.length}):\n${lines.slice(0, 10).join("\n")}${lines.length > 10 ? `\n… and ${lines.length - 10} more` : ""}`;
	} catch {
		return "";
	}
}
