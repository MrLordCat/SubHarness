import * as assert from "node:assert";
import { formatReset } from "../chat/webview/format";

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
