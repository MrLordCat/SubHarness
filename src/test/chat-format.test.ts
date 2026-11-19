import * as assert from "node:assert";
import { describeToolCall, formatAge, formatReset, parseUriList, sessionGroup } from "../chat/webview/format";

function time(date: Date): string {
	return date.toLocaleString([], { hour: "2-digit", minute: "2-digit" });
}

function dateTime(date: Date): string {
	return date.toLocaleString([], { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
}

suite("Chat webview formatting", () => {
	test("shows time only for a reset later today", () => {
		const now = new Date(2026, 10, 18, 9, 0).getTime();
		const reset = new Date(2026, 10, 18, 14, 30);
		assert.strictEqual(formatReset(reset.getTime(), now), `${time(reset)} (in 5 h 30 min)`);
	});

	test("shows the date when the reset falls on another day", () => {
		const now = new Date(2026, 10, 18, 9, 0).getTime();
		const reset = new Date(2026, 10, 19, 8, 0);
		assert.strictEqual(formatReset(reset.getTime(), now), `${dateTime(reset)} (in 23 h)`);
	});

	test("uses minutes below an hour and drops a zero minute remainder", () => {
		const now = new Date(2026, 10, 18, 9, 0).getTime();
		const soon = new Date(2026, 10, 18, 9, 12);
		assert.strictEqual(formatReset(soon.getTime(), now), `${time(soon)} (in 12 min)`);
		const whole = new Date(2026, 10, 18, 11, 0);
		assert.strictEqual(formatReset(whole.getTime(), now), `${time(whole)} (in 2 h)`);
		const mixed = new Date(2026, 10, 18, 11, 5);
		assert.strictEqual(formatReset(mixed.getTime(), now), `${time(mixed)} (in 2 h 5 min)`);
	});

	test("a reset already in the past reads as now", () => {
		const now = new Date(2026, 10, 18, 9, 0).getTime();
		const past = new Date(2026, 10, 18, 8, 0);
		assert.strictEqual(formatReset(past.getTime(), now), `${time(past)} (now)`);
	});
});

suite("Chat webview session formatting", () => {
	const now = new Date(2026, 10, 19, 12, 0).getTime();

	test("groups sessions by local calendar day", () => {
		assert.strictEqual(sessionGroup(new Date(2026, 10, 19, 0, 5).getTime(), now), "Today");
		assert.strictEqual(sessionGroup(new Date(2026, 10, 18, 23, 59).getTime(), now), "Yesterday");
		assert.strictEqual(sessionGroup(new Date(2026, 10, 17, 23, 59).getTime(), now), "Last 7 days");
		assert.strictEqual(sessionGroup(new Date(2026, 10, 13, 0, 0).getTime(), now), "Last 7 days");
		assert.strictEqual(sessionGroup(new Date(2026, 10, 12, 23, 59).getTime(), now), "Older");
	});

	test("treats a future timestamp as today", () => {
		assert.strictEqual(sessionGroup(new Date(2026, 10, 20, 9, 0).getTime(), now), "Today");
	});

	test("formats recent ages in minutes, hours and days", () => {
		assert.strictEqual(formatAge(now - 30_000, now), "now");
		assert.strictEqual(formatAge(now - 5 * 60_000, now), "5 min");
		assert.strictEqual(formatAge(now - 59 * 60_000, now), "59 min");
		assert.strictEqual(formatAge(now - 3 * 3_600_000, now), "3 h");
		assert.strictEqual(formatAge(now - 23 * 3_600_000, now), "23 h");
		assert.strictEqual(formatAge(now - 3 * 86_400_000, now), "3 d");
		assert.strictEqual(formatAge(now - 6 * 86_400_000, now), "6 d");
	});

	test("shows a date for older sessions", () => {
		const text = formatAge(new Date(2026, 9, 5, 9, 0).getTime(), now);
		assert.ok(text.length > 0);
		assert.ok(!text.endsWith(" d"));
	});
});

suite("Chat webview drag and drop", () => {
	test("splits a uri list on CR, LF and CRLF and trims the entries", () => {
		assert.deepStrictEqual(
			parseUriList("file:///a.ts\r\nfile:///b.ts\rfile:///c.ts\n  file:///d.ts  \n"),
			["file:///a.ts", "file:///b.ts", "file:///c.ts", "file:///d.ts"],
		);
	});

	test("drops blank lines and comments", () => {
		assert.deepStrictEqual(parseUriList("\n# a comment\n\nfile:///a.ts\n  # indented comment\n"), ["file:///a.ts"]);
	});

	test("keeps the first occurrence of a duplicate in order", () => {
		assert.deepStrictEqual(parseUriList("file:///b.ts\nfile:///a.ts\nfile:///b.ts\n"), ["file:///b.ts", "file:///a.ts"]);
	});

	test("returns an empty list for empty input", () => {
		assert.deepStrictEqual(parseUriList(""), []);
		assert.deepStrictEqual(parseUriList(" \r\n\t\n"), []);
	});
});

suite("Chat webview tool call descriptions", () => {
	test("describes a read with its line range", () => {
		assert.deepStrictEqual(
			describeToolCall("read_file", { filePath: "src/chat/webview/message.tsx", startLine: 10, endLine: 20 }),
			{ title: "Read message.tsx", detail: "lines 10–20" },
		);
		assert.deepStrictEqual(describeToolCall("read_file", { filePath: "C:\\work\\a\\store.ts" }), { title: "Read store.ts" });
	});

	test("describes directory and file searches", () => {
		assert.deepStrictEqual(describeToolCall("list_dir", { path: "src/chat" }), { title: "Listed src/chat" });
		assert.deepStrictEqual(describeToolCall("list_dir", {}), { title: "Listed workspace" });
		assert.deepStrictEqual(describeToolCall("file_search", { query: "**/*.ts" }), { title: "Searched files for **/*.ts" });
		assert.deepStrictEqual(
			describeToolCall("grep_search", { query: "tool-row", includePattern: "src/**/*.css" }),
			{ title: "Searched for \"tool-row\"", detail: "src/**/*.css" },
		);
		assert.deepStrictEqual(describeToolCall("grep_search", { query: "x" }), { title: "Searched for \"x\"" });
	});

	test("describes writes, problems and terminal tools", () => {
		assert.deepStrictEqual(describeToolCall("create_file", { filePath: "src/new.ts" }), { title: "Created new.ts" });
		assert.deepStrictEqual(describeToolCall("replace_string_in_file", { filePath: "a\\b\\message.tsx" }), { title: "Edited message.tsx" });
		assert.deepStrictEqual(
			describeToolCall("get_errors", { filePaths: ["src/a.ts", "src/b.tsx"] }),
			{ title: "Checked problems", detail: "a.ts, b.tsx" },
		);
		assert.deepStrictEqual(describeToolCall("get_errors", {}), { title: "Checked problems" });
		assert.deepStrictEqual(describeToolCall("run_in_terminal", { command: "npm test\n&& echo done" }), { title: "Ran npm test" });
		assert.deepStrictEqual(describeToolCall("read_terminal", { terminalId: "1" }), { title: "Read terminal output" });
		assert.deepStrictEqual(describeToolCall("send_to_terminal", { terminalId: "1", text: "y" }), { title: "Sent input to the terminal" });
		assert.deepStrictEqual(describeToolCall("kill_terminal", { terminalId: "1" }), { title: "Closed a terminal" });
	});

	test("cuts a long command at 120 characters", () => {
		const command = `node ${"x".repeat(200)}`;
		assert.deepStrictEqual(describeToolCall("run_in_terminal", { command }), { title: `Ran ${command.slice(0, 119)}…` });
	});

	test("falls back to the tool name and a one-line input summary", () => {
		assert.deepStrictEqual(describeToolCall("mystery_tool", { a: 1 }), { title: "mystery_tool", detail: "{\"a\":1}" });
	});

	test("survives malformed input", () => {
		const circular: Record<string, unknown> = {};
		circular.self = circular;
		assert.deepStrictEqual(describeToolCall("read_file", null), { title: "read_file", detail: "null" });
		assert.deepStrictEqual(describeToolCall("file_search", { query: 42 }), { title: "file_search", detail: "{\"query\":42}" });
		assert.deepStrictEqual(describeToolCall("get_errors", { filePaths: "src/a.ts" }), { title: "Checked problems" });
		assert.doesNotThrow(() => describeToolCall("mystery_tool", circular));
		assert.strictEqual(describeToolCall("mystery_tool", circular).title, "mystery_tool");
	});
});
