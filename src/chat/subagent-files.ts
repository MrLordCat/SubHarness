import { promises as fs } from "node:fs";
import { TextDecoder } from "node:util";
import { lineDiff } from "./line-diff";
import { displayPath } from "./tools/workspace-paths";

type Snapshot = string | null | undefined;

async function snapshot(file: string): Promise<Snapshot> {
	try {
		const stat = await fs.stat(file);
		if (!stat.isFile() || stat.size > 2 * 1024 * 1024) { return undefined; }
		const data = await fs.readFile(file);
		if (data.length > 2 * 1024 * 1024 || data.includes(0)) { return undefined; }
		return new TextDecoder("utf-8", { fatal: true }).decode(data);
	} catch (error) {
		return (error as NodeJS.ErrnoException).code === "ENOENT" ? null : undefined;
	}
}

export class SubagentFiles {
	private readonly before = new Map<string, Promise<Snapshot>>();

	async capture(files: readonly string[]): Promise<void> {
		for (const file of files) {
			if (!this.before.has(file)) { this.before.set(file, snapshot(file)); }
		}
		await Promise.all(files.map(file => this.before.get(file)));
	}

	async report(roots: readonly string[]): Promise<string> {
		const entries: string[] = [];
		for (const [file, pending] of this.before) {
			const before = await pending, after = await snapshot(file);
			if (before !== undefined && after !== undefined && before === after) { continue; }
			const name = displayPath(file, roots);
			if (before === undefined || after === undefined) { entries.push(`- ${name} (changed)`); continue; }
			const { added, removed } = lineDiff(before ?? "", after ?? "");
			const details = [before === null ? "new" : after === null ? "deleted" : "", added ? `+${added}` : "", removed ? `−${removed}` : ""].filter(Boolean).join(", ");
			entries.push(`- ${name} (${details || "changed"})`);
		}
		if (!entries.length) { return ""; }
		return `\n\nFiles changed by this subagent:\n${entries.slice(0, 30).join("\n")}${entries.length > 30 ? `\n… and ${entries.length - 30} more` : ""}`;
	}
}
