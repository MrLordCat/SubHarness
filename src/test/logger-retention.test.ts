import * as assert from "node:assert";
import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as vscode from "vscode";
import { LlamaLogService } from "../logger";

function contextFor(root: string): vscode.ExtensionContext {
	return { globalStorageUri: vscode.Uri.file(root) } as vscode.ExtensionContext;
}

function logsDir(root: string): string {
	return path.join(root, "logs");
}

async function logFiles(root: string): Promise<string[]> {
	return (await fs.readdir(logsDir(root)).catch(() => [] as string[])).filter(name => name.endsWith(".jsonl"));
}

async function setAge(file: string, ageMs: number): Promise<void> {
	const when = new Date(Date.now() - ageMs);
	await fs.utimes(file, when, when);
}

suite("File logger retention", () => {
	let root = "";
	let service: LlamaLogService | undefined;

	setup(async () => {
		root = await fs.mkdtemp(path.join(os.tmpdir(), "llama-logger-"));
	});

	teardown(async () => {
		service?.dispose();
		service = undefined;
		await fs.rm(root, { recursive: true, force: true });
	});

	test("rotates a busy log into new files and keeps the session id", async () => {
		service = new LlamaLogService(contextFor(root), { maxFileBytes: 2_048, maxTotalBytes: 8 * 1_024 * 1_024 });
		await service.initialize();
		for (let index = 0; index < 30; index++) {
			service.log("test.event", { index, text: "x".repeat(300) });
		}
		await service.flush();

		const files = await logFiles(root);
		assert.ok(files.length > 1, `expected a rotation, got ${files.length} file(s)`);
		const sessions = new Set<string>();
		for (const name of files) {
			const file = path.join(logsDir(root), name);
			const stat = await fs.stat(file);
			assert.ok(stat.size <= 2_048, `${name} grew to ${stat.size} bytes`);
			for (const line of (await fs.readFile(file, "utf8")).split("\n")) {
				if (!line.trim()) {
					continue;
				}
				sessions.add(JSON.parse(line).sessionId as string);
			}
		}
		assert.strictEqual(sessions.size, 1, "rotated files must share the session id");
	});

	test("deletes the oldest files when the folder exceeds its total size", async () => {
		await fs.mkdir(logsDir(root), { recursive: true });
		for (let index = 0; index < 5; index++) {
			const file = path.join(logsDir(root), `llamacpp-2026-01-0${index + 1}-00-00-00-000Z-1.jsonl`);
			await fs.writeFile(file, "x".repeat(1_000), "utf8");
			await setAge(file, (5 - index) * 60_000);
		}

		service = new LlamaLogService(contextFor(root), { maxFileBytes: 512, maxTotalBytes: 2_500 });
		await service.initialize();
		await service.flush();

		const files = await logFiles(root);
		assert.ok(files.length <= 3, `old logs were not trimmed: ${files.join(", ")}`);
		let total = 0;
		for (const name of files) {
			total += (await fs.stat(path.join(logsDir(root), name))).size;
		}
		assert.ok(total <= 2_500 + 4_096, `log folder still holds ${total} bytes`);
		assert.ok(files.some(name => name.includes("2026-01-05")), "the newest old log should survive");
	});
});
