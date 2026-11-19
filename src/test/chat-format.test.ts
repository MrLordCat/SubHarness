import * as assert from "node:assert";
import { formatAge, formatReset, parseUriList, sessionGroup } from "../chat/webview/format";

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
