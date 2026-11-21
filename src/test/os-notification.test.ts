import * as assert from "node:assert";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { createOsNotifier, osNotificationCommand, vscodeToastAppId } from "../os-notification";

suite("os notification", () => {
	test("builds a safely escaped Windows toast", () => {
		const command = osNotificationCommand("win32", `<&"'`, "body > &", "id'quoted");
		assert.ok(command);
		assert.strictEqual(command.command, "powershell.exe");
		const script = Buffer.from(command.args[command.args.indexOf("-EncodedCommand") + 1], "base64").toString("utf16le");
		assert.ok(script.includes("&lt;&amp;&quot;&apos;"));
		assert.ok(script.includes("body &gt; &amp;"));
		assert.ok(script.includes("'id''quoted'"));
	});

	test("builds macOS and Linux commands and rejects unsupported platforms", () => {
		assert.deepStrictEqual(osNotificationCommand("darwin", 'a"b', "c\\d"), { command: "osascript", args: ["-e", 'display notification "c\\\\d" with title "a\\"b"'] });
		assert.deepStrictEqual(osNotificationCommand("linux", "title", "body"), { command: "notify-send", args: ["--app-name=Visual Studio Code", "title", "body"] });
		assert.strictEqual(osNotificationCommand("unknown" as NodeJS.Platform, "", ""), undefined);
	});

	test("reads the VS Code app id", () => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "toast-test-"));
		try {
			assert.strictEqual(vscodeToastAppId(dir), undefined);
			fs.writeFileSync(path.join(dir, "product.json"), JSON.stringify({ win32AppUserModelId: "test.id" }));
			assert.strictEqual(vscodeToastAppId(dir), "test.id");
		} finally {
			fs.rmSync(dir, { recursive: true, force: true });
		}
	});

	test("suppresses duplicates and logs runner failures", async () => {
		let now = 0;
		let calls = 0;
		const events: string[] = [];
		const notify = createOsNotifier({ platform: "linux", now: () => now, run: async () => { calls++; throw new Error("failed"); }, log: event => events.push(event) });
		notify("title", "body");
		notify("title", "body");
		await new Promise(resolve => setImmediate(resolve));
		assert.strictEqual(calls, 1);
		assert.deepStrictEqual(events, ["chat.os_notification.failed"]);
		now = 5000;
		notify("title", "body");
		await new Promise(resolve => setImmediate(resolve));
		assert.strictEqual(calls, 2);
	});
});
