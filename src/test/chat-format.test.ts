import * as assert from "node:assert";
import type { ChatMessage, ChatProviderQuota, ChatUsageTotals } from "../chat/shared/protocol";
import { describeToolCall, exhaustedWindow, formatAge, formatCacheHit, formatQuotaExhausted, formatQuotaSummary, formatReset, modelCacheStats, parseUriList, sessionGroup } from "../chat/webview/format";

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

suite("Chat webview quota formatting", () => {
	function quota(provider: string, windows: ChatProviderQuota["windows"], balance?: string): ChatProviderQuota {
		return { provider, windows, ...(balance === undefined ? {} : { balance }) };
	}

	test("summarizes every window in order and appends the balance", () => {
		const windows = [{ label: "5h", percent: 42 }, { label: "Week", percent: 17.6 }];
		assert.strictEqual(formatQuotaSummary(quota("Codex", windows)), "5h 42% · Week 18%");
		assert.strictEqual(formatQuotaSummary(quota("DeepSeek", [], "$12.30")), "$12.30");
		assert.strictEqual(formatQuotaSummary(quota("Codex", windows, "$3.10")), "5h 42% · Week 18% · $3.10");
		assert.strictEqual(formatQuotaSummary(quota("Local", [])), "");
	});

	test("picks the exhausted window that resets last", () => {
		assert.strictEqual(exhaustedWindow(quota("Codex", [{ label: "5h", percent: 99 }])), undefined);
		const fiveHour = { label: "5h", percent: 100, resetsAt: 1_000 };
		assert.deepStrictEqual(exhaustedWindow(quota("Codex", [fiveHour, { label: "Week", percent: 40 }])), fiveHour);
		const week = { label: "Week", percent: 100, resetsAt: 2_000 };
		assert.deepStrictEqual(exhaustedWindow(quota("Codex", [{ label: "5h", percent: 100, resetsAt: 1_000 }, week])), week);
		assert.deepStrictEqual(exhaustedWindow(quota("Codex", [{ label: "5h", percent: 100, resetsAt: 3_000 }, week]), 2_500), { label: "5h", percent: 100, resetsAt: 3_000 });
		assert.strictEqual(exhaustedWindow(quota("Codex", [week]), 2_000), undefined);
	});

	test("describes the exhausted limit with and without a reset", () => {
		const now = new Date(2026, 10, 18, 9, 0).getTime();
		const resetsAt = new Date(2026, 10, 18, 14, 30).getTime();
		const text = formatQuotaExhausted(quota("Codex", [{ label: "Week", percent: 100, resetsAt }]), now);
		assert.strictEqual(text, `Codex: the Week limit is used up; it resets ${formatReset(resetsAt, now)}.`);
		assert.ok(text?.includes("the Week limit is used up"));
		assert.ok(text?.endsWith(`it resets ${formatReset(resetsAt, now)}.`));
		assert.strictEqual(formatQuotaExhausted(quota("Codex", [{ label: "5h", percent: 100 }]), now), "Codex: the 5h limit is used up.");
		assert.strictEqual(formatQuotaExhausted(quota("Codex", [{ label: "5h", percent: 20 }]), now), undefined);
	});
});

suite("Chat webview cache stats", () => {
	let seq = 0;

	function message(role: ChatMessage["role"], modelId?: string, usage?: ChatMessage["usage"], totals?: ChatUsageTotals): ChatMessage {
		seq += 1;
		return {
			id: `m${seq}`,
			role,
			turn: 1,
			createdAt: 0,
			parts: [],
			...(modelId !== undefined ? { modelId } : {}),
			...(usage ? { usage } : {}),
			...(totals ? { usageTotals: totals } : {}),
		};
	}

	function totals(requests: number, promptTokens: number, cachedTokens: number, cacheReported: number): ChatUsageTotals {
		return { requests, promptTokens, cachedTokens, completionTokens: 0, cacheReported };
	}

	test("counts the newest streak of the model, skipping user messages and stopping at another model", () => {
		const stats = modelCacheStats([
			message("assistant", "m1", { promptTokens: 500, cachedTokens: 400 }, totals(2, 1000, 800, 2)),
			message("user"),
			message("assistant", "m2", { promptTokens: 300 }, totals(1, 300, 0, 0)),
			message("user"),
			message("assistant", "m1", { promptTokens: 1000, cachedTokens: 920 }, totals(2, 2000, 1700, 2)),
		], "m1");
		assert.deepStrictEqual(stats, {
			modelId: "m1",
			requests: 2,
			promptTokens: 2000,
			cachedTokens: 1700,
			cacheReported: 2,
			lastHitPercent: 92,
		});
	});

	test("skips an assistant message without a model but does not stop there", () => {
		const stats = modelCacheStats([
			message("assistant", "m1", { promptTokens: 100, cachedTokens: 80 }, totals(1, 100, 80, 1)),
			message("assistant", undefined, { promptTokens: 900, cachedTokens: 100 }, totals(1, 900, 100, 1)),
		], "m1");
		assert.deepStrictEqual(stats, {
			modelId: "m1",
			requests: 1,
			promptTokens: 100,
			cachedTokens: 80,
			cacheReported: 1,
			lastHitPercent: 80,
		});
	});

	test("falls back to usage as one request when totals are missing", () => {
		const stats = modelCacheStats([
			message("assistant", "m1", { promptTokens: 1000, cachedTokens: 850 }),
		], "m1");
		assert.deepStrictEqual(stats, {
			modelId: "m1",
			requests: 1,
			promptTokens: 1000,
			cachedTokens: 850,
			cacheReported: 1,
			lastHitPercent: 85,
		});
	});

	test("returns undefined without a model, without a matching message or without prompt tokens", () => {
		assert.strictEqual(modelCacheStats([message("assistant", "m1", { promptTokens: 10 }, totals(1, 10, 0, 0))], undefined), undefined);
		assert.strictEqual(modelCacheStats([], "m1"), undefined);
		assert.strictEqual(modelCacheStats([message("assistant", "m2", { promptTokens: 10 }, totals(1, 10, 0, 0))], "m1"), undefined);
		assert.strictEqual(modelCacheStats([message("assistant", "m1")], "m2"), undefined);
		assert.strictEqual(modelCacheStats([message("user")], "m1"), undefined);
	});

	test("formats the rounded percent, the title in tokens and the last request", () => {
		const label = formatCacheHit({
			modelId: "m1",
			requests: 34,
			promptTokens: 1_400_000,
			cachedTokens: 1_218_000,
			cacheReported: 34,
			lastHitPercent: 92,
		});
		assert.strictEqual(label.text, "cache 87%");
		assert.strictEqual(label.level, "normal");
		assert.strictEqual(
			label.title,
			"Prompt cache hits for this model since it took over this chat: 87% (1.2M of 1.4M prompt tokens, 34 requests). Last request: 92%.",
		);
	});

	test("says n/a when the provider reports no cached tokens", () => {
		const label = formatCacheHit({
			modelId: "m1",
			requests: 2,
			promptTokens: 1000,
			cachedTokens: 0,
			cacheReported: 0,
		});
		assert.strictEqual(label.text, "cache n/a");
		assert.strictEqual(label.title, "The provider does not report cached tokens for this model.");
		assert.strictEqual(label.level, "normal");
	});

	test("omits the last request when unknown and marks a low hit rate", () => {
		const label = formatCacheHit({
			modelId: "m1",
			requests: 3,
			promptTokens: 1000,
			cachedTokens: 250,
			cacheReported: 3,
		});
		assert.strictEqual(label.text, "cache 25%");
		assert.strictEqual(label.level, "low");
		assert.strictEqual(
			label.title,
			"Prompt cache hits for this model since it took over this chat: 25% (250 of 1k prompt tokens, 3 requests).",
		);
		assert.strictEqual(formatCacheHit({
			modelId: "m1",
			requests: 2,
			promptTokens: 1000,
			cachedTokens: 100,
			cacheReported: 2,
		}).level, "normal");
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
		assert.deepStrictEqual(describeToolCall("view_image", { filePath: "docs/screens/shot.png" }), { title: "Viewed shot.png" });
		assert.deepStrictEqual(describeToolCall("view_image", {}), { title: "view_image", detail: "{}" });
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

	test("describes symbol searches and renames", () => {
		assert.deepStrictEqual(
			describeToolCall("list_code_usages", { symbol: "parseArgs", filePath: "src/cli.ts" }),
			{ title: "Usages of parseArgs" },
		);
		assert.deepStrictEqual(
			describeToolCall("rename_symbol", { symbol: "parseArgs", filePath: "src/cli.ts", newName: "readArgs" }),
			{ title: "Renamed parseArgs to readArgs" },
		);
		assert.deepStrictEqual(describeToolCall("workspace_symbols", { query: "parse" }), { title: "Symbols matching \"parse\"" });
		assert.deepStrictEqual(describeToolCall("list_code_usages", {}), { title: "list_code_usages", detail: "{}" });
		assert.deepStrictEqual(
			describeToolCall("rename_symbol", { symbol: "parseArgs" }),
			{ title: "rename_symbol", detail: "{\"symbol\":\"parseArgs\"}" },
		);
		assert.deepStrictEqual(
			describeToolCall("workspace_symbols", { query: 42 }),
			{ title: "workspace_symbols", detail: "{\"query\":42}" },
		);
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

	test("describes multi-file edits and web fetches", () => {
		const replacements = [
			{ filePath: "src/a/message.tsx", oldString: "a", newString: "b" },
			{ filePath: "src/a/message.tsx", oldString: "c", newString: "d" },
		];
		assert.deepStrictEqual(describeToolCall("multi_replace_string_in_file", { replacements }), { title: "Edited message.tsx" });
		assert.deepStrictEqual(
			describeToolCall("multi_replace_string_in_file", { replacements: [...replacements, { filePath: "src/b/store.ts", oldString: "e", newString: "f" }] }),
			{ title: "Edited 2 files" }
		);
		assert.deepStrictEqual(describeToolCall("multi_replace_string_in_file", {}), { title: "Edited files" });
		assert.deepStrictEqual(describeToolCall("multi_replace_string_in_file", { replacements: "x" }), { title: "Edited files" });
		assert.deepStrictEqual(describeToolCall("fetch_webpage", { urls: ["https://example.com/docs"] }), { title: "Fetched example.com" });
		assert.deepStrictEqual(describeToolCall("fetch_webpage", { urls: ["not a url"] }), { title: "Fetched not a url" });
		assert.deepStrictEqual(describeToolCall("fetch_webpage", { urls: ["https://a.test", "https://b.test"] }), { title: "Fetched 2 pages" });
		assert.deepStrictEqual(describeToolCall("fetch_webpage", {}), { title: "fetch_webpage", detail: "{}" });
	});

	test("falls back to the tool name and a one-line input summary", () => {
		assert.deepStrictEqual(describeToolCall("mystery_tool", { a: 1 }), { title: "mystery_tool", detail: "{\"a\":1}" });
	});

	test("describes the todo list and the questions", () => {
		const todoList = [
			{ id: 1, title: "Read the code", status: "completed" },
			{ id: 2, title: "Write the code", status: "in-progress" },
		];
		assert.deepStrictEqual(describeToolCall("manage_todo_list", { todoList }), { title: "Updated todos (1/2 done)" });
		assert.deepStrictEqual(describeToolCall("manage_todo_list", { todoList: [] }), { title: "Cleared todos" });
		assert.deepStrictEqual(describeToolCall("manage_todo_list", {}), { title: "manage_todo_list", detail: "{}" });
		assert.deepStrictEqual(describeToolCall("ask_questions", { questions: [{ header: "A", question: "Q?" }] }), { title: "Asked 1 question" });
		assert.deepStrictEqual(
			describeToolCall("ask_questions", { questions: [{ header: "A", question: "Q?" }, { header: "B", question: "R?" }] }),
			{ title: "Asked 2 questions" },
		);
		assert.deepStrictEqual(describeToolCall("ask_questions", { questions: [] }), { title: "ask_questions", detail: "{\"questions\":[]}" });
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
