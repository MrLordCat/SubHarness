import type { ChatMessage, ChatModelGroup, ChatProviderQuota, ChatUsage } from "../shared/protocol";

/** 312000 → "312k", 1_200_000 → "1.2M"; used wherever token counts are shown. */
export function formatTokens(value: number): string {
	if (value >= 1_000_000) {
		return `${formatScaled(value / 1_000_000)}M`;
	}
	if (value >= 1_000) {
		return `${formatScaled(value / 1_000)}k`;
	}
	return `${Math.round(value)}`;
}

/** Prompt tokens of the last reply over the selected model's window; absent until both are known. */
export function contextIndicator(latestUsage: ChatUsage | undefined, models: ChatModelGroup[], selectedModelId: string | undefined): string | undefined {
	const promptTokens = latestUsage?.promptTokens;
	if (promptTokens === undefined) {
		return undefined;
	}
	const model = models.flatMap(group => group.models).find(candidate => candidate.id === selectedModelId);
	if (!model || model.maxInputTokens <= 0) {
		return undefined;
	}
	return `${formatTokens(promptTokens)} / ${formatTokens(model.maxInputTokens)}`;
}

export interface ModelCacheStats {
	modelId: string;
	requests: number;
	promptTokens: number;
	cachedTokens: number;
	cacheReported: number;
	lastHitPercent?: number;
}

/** Cache hits of the selected model over its turns in this chat, newest streak only. */
export function modelCacheStats(messages: readonly ChatMessage[], modelId: string | undefined): ModelCacheStats | undefined {
	if (modelId === undefined) {
		return undefined;
	}
	const stats: ModelCacheStats = { modelId, requests: 0, promptTokens: 0, cachedTokens: 0, cacheReported: 0 };
	let included = 0;
	for (let index = messages.length - 1; index >= 0; index -= 1) {
		const message = messages[index];
		if (message.role !== "assistant") {
			continue;
		}
		if (message.modelId !== undefined && message.modelId !== modelId) {
			break;
		}
		if (message.modelId !== modelId) {
			continue;
		}
		const usage = message.usage;
		if (included === 0 && usage?.promptTokens !== undefined && usage.promptTokens > 0 && usage.cachedTokens !== undefined) {
			stats.lastHitPercent = Math.round(usage.cachedTokens / usage.promptTokens * 100);
		}
		included += 1;
		if (message.usageTotals) {
			stats.requests += message.usageTotals.requests;
			stats.promptTokens += message.usageTotals.promptTokens;
			stats.cachedTokens += message.usageTotals.cachedTokens;
			stats.cacheReported += message.usageTotals.cacheReported;
		} else if (usage?.promptTokens !== undefined) {
			stats.requests += 1;
			stats.promptTokens += usage.promptTokens;
			stats.cachedTokens += usage.cachedTokens ?? 0;
			if (usage.cachedTokens !== undefined) {
				stats.cacheReported += 1;
			}
		}
	}
	if (included === 0 || stats.promptTokens === 0) {
		return undefined;
	}
	return stats;
}

export interface CacheHitLabel {
	text: string;
	title: string;
	level: "normal" | "low";
}

export function formatCacheHit(stats: ModelCacheStats): CacheHitLabel {
	if (stats.cacheReported === 0) {
		return {
			text: "cache n/a",
			title: "The provider does not report cached tokens for this model.",
			level: "normal",
		};
	}
	const percent = Math.round(stats.cachedTokens / stats.promptTokens * 100);
	const last = stats.lastHitPercent === undefined ? "" : ` Last request: ${stats.lastHitPercent}%.`;
	return {
		text: `cache ${percent}%`,
		title: `Prompt cache hits for this model since it took over this chat: ${percent}% (${formatTokens(stats.cachedTokens)} of ${formatTokens(stats.promptTokens)} prompt tokens, ${stats.requests} ${stats.requests === 1 ? "request" : "requests"}).${last}`,
		level: percent < 30 && stats.requests >= 3 ? "low" : "normal",
	};
}

function formatScaled(value: number): string {
	const text = value >= 100 ? `${Math.round(value)}` : value.toFixed(1);
	return text.endsWith(".0") ? text.slice(0, -2) : text;
}

/** A compact one-line rendering of a tool input, used for titles and unknown shapes. */
export function summarizeInput(input: unknown): string {
	let text: string;
	try {
		text = typeof input === "string" ? input : JSON.stringify(input) ?? String(input);
	} catch {
		text = String(input);
	}
	const singleLine = text.replace(/\s+/g, " ").trim();
	return singleLine.length > 160 ? `${singleLine.slice(0, 159)}…` : singleLine;
}

export interface ToolCallDescription {
	title: string;
	detail?: string;
}

/** First line of a terminal command, cut at 120 characters. */
export function toolCommand(input: unknown): string | undefined {
	const command = textField(inputRecord(input), "command");
	if (command === undefined) {
		return undefined;
	}
	const line = command.split(/\r\n|\r|\n/)[0].trim();
	return line.length > 120 ? `${line.slice(0, 119)}…` : line;
}

/** Readable one-line description of a tool call; unknown shapes fall back to the raw summary. */
export function describeToolCall(name: string, input: unknown): ToolCallDescription {
	try {
		const record = inputRecord(input);
		switch (name) {
			case "read_file": {
				const file = textField(record, "filePath");
				if (file === undefined) {
					return fallbackDescription(name, input);
				}
				const start = numberField(record, "startLine");
				const end = numberField(record, "endLine");
				const detail = start !== undefined && end !== undefined ? `lines ${start}–${end}` : undefined;
				return detail === undefined ? { title: `Read ${baseName(file)}` } : { title: `Read ${baseName(file)}`, detail };
			}
			case "list_dir": {
				const path = textField(record, "path");
				return { title: `Listed ${path ?? "workspace"}` };
			}
			case "file_search": {
				const query = textField(record, "query");
				return query === undefined ? fallbackDescription(name, input) : { title: `Searched files for ${query}` };
			}
			case "grep_search": {
				const query = textField(record, "query");
				if (query === undefined) {
					return fallbackDescription(name, input);
				}
				const include = textField(record, "includePattern");
				return include === undefined
					? { title: `Searched for "${query}"` }
					: { title: `Searched for "${query}"`, detail: include };
			}
			case "create_file": {
				const file = textField(record, "filePath");
				return file === undefined ? fallbackDescription(name, input) : { title: `Created ${baseName(file)}` };
			}
			case "replace_string_in_file": {
				const file = textField(record, "filePath");
				return file === undefined ? fallbackDescription(name, input) : { title: `Edited ${baseName(file)}` };
			}
			case "get_errors": {
				const files = record.filePaths;
				if (!Array.isArray(files) || files.length === 0) {
					return { title: "Checked problems" };
				}
				const names = files.filter((file): file is string => typeof file === "string" && file.length > 0).map(baseName);
				return names.length > 0 ? { title: "Checked problems", detail: names.join(", ") } : { title: "Checked problems" };
			}
			case "run_in_terminal": {
				const command = toolCommand(input);
				return command === undefined ? fallbackDescription(name, input) : { title: `Ran ${command}` };
			}
			case "read_terminal":
				return { title: "Read terminal output" };
			case "send_to_terminal":
				return { title: "Sent input to the terminal" };
			case "kill_terminal":
				return { title: "Closed a terminal" };
			default:
				return { title: name, detail: summarizeInput(input) };
		}
	} catch {
		return { title: name };
	}
}

function fallbackDescription(name: string, input: unknown): ToolCallDescription {
	return { title: name, detail: summarizeInput(input) };
}

function inputRecord(input: unknown): Record<string, unknown> {
	return typeof input === "object" && input !== null && !Array.isArray(input) ? input as Record<string, unknown> : {};
}

function textField(record: Record<string, unknown>, key: string): string | undefined {
	const value = record[key];
	return typeof value === "string" && value.length > 0 ? value : undefined;
}

function numberField(record: Record<string, unknown>, key: string): number | undefined {
	const value = record[key];
	return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function baseName(file: string): string {
	const parts = file.replace(/\\/g, "/").split("/");
	return parts[parts.length - 1] || file;
}

/** The entries of a text/uri-list payload: comments and blank lines dropped, unique in order. */
export function parseUriList(text: string): string[] {
	const seen = new Set<string>();
	const result: string[] = [];
	for (const raw of text.split(/\r\n|\r|\n/)) {
		const line = raw.trim();
		if (line.length === 0 || line.startsWith("#") || seen.has(line)) {
			continue;
		}
		seen.add(line);
		result.push(line);
	}
	return result;
}

/** Reset time as local wall clock plus the wait, e.g. "14:30 (in 2 h 5 min)"; today shows no date. */
export function formatReset(resetAt: number, now: number): string {
	const at = new Date(resetAt);
	const current = new Date(now);
	const today = at.getFullYear() === current.getFullYear()
		&& at.getMonth() === current.getMonth()
		&& at.getDate() === current.getDate();
	const clock = today
		? at.toLocaleString([], { hour: "2-digit", minute: "2-digit" })
		: at.toLocaleString([], { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
	return `${clock} (${formatResetWait(resetAt - now)})`;
}

function formatResetWait(ms: number): string {
	if (ms <= 0) {
		return "now";
	}
	const minutes = Math.max(1, Math.round(ms / 60_000));
	if (minutes < 60) {
		return `in ${minutes} min`;
	}
	const hours = Math.floor(minutes / 60);
	const rest = minutes % 60;
	return rest > 0 ? `in ${hours} h ${rest} min` : `in ${hours} h`;
}

export type QuotaLevel = "normal" | "warning" | "error";

/** Used share in percent → severity; warning from 80, error from 100. */
export function quotaLevel(percent: number): QuotaLevel {
	if (!Number.isFinite(percent)) {
		return "normal";
	}
	if (percent >= 100) {
		return "error";
	}
	return percent >= 80 ? "warning" : "normal";
}

/** The worst window decides the colour of the chip. */
export function quotaSeverity(quota: ChatProviderQuota): QuotaLevel {
	let level: QuotaLevel = "normal";
	for (const window of quota.windows) {
		const candidate = quotaLevel(window.percent);
		if (candidate === "error") {
			return "error";
		}
		if (candidate === "warning") {
			level = "warning";
		}
	}
	return level;
}

/** The most used window ("Week 81%"), or the balance when the provider reports no windows. */
export function formatQuotaChip(quota: ChatProviderQuota): string {
	const worst = quota.windows.reduce<ChatProviderQuota["windows"][number] | undefined>(
		(best, window) => (best === undefined || window.percent > best.percent ? window : best),
		undefined,
	);
	if (worst) {
		return `${worst.label} ${Math.round(worst.percent)}%`;
	}
	return quota.balance?.trim() ?? "";
}

/** "Codex limits: 5h 42% · Week 12%" for the chip tooltip. */
export function formatQuotaTitle(quota: ChatProviderQuota): string {
	const parts = quota.windows.map(window => `${window.label} ${Math.round(window.percent)}%`);
	if (quota.balance?.trim()) {
		parts.push(quota.balance.trim());
	}
	return parts.length > 0 ? `${quota.provider} limits: ${parts.join(" · ")}` : `${quota.provider} limits`;
}

export type SessionGroup = "Today" | "Yesterday" | "Last 7 days" | "Older";

/** Groups by local calendar day; future and today's timestamps both count as today. */
export function sessionGroup(updatedAt: number, now: number): SessionGroup {
	const days = localDayNumber(now) - localDayNumber(updatedAt);
	if (days <= 0) {
		return "Today";
	}
	if (days === 1) {
		return "Yesterday";
	}
	return days < 7 ? "Last 7 days" : "Older";
}

/** "now", "5 min", "3 h", "2 d", then a short date, with the year when it differs. */
export function formatAge(timestamp: number, now: number): string {
	const elapsed = now - timestamp;
	if (elapsed < 60_000) {
		return "now";
	}
	if (elapsed < 3_600_000) {
		return `${Math.floor(elapsed / 60_000)} min`;
	}
	if (elapsed < 86_400_000) {
		return `${Math.floor(elapsed / 3_600_000)} h`;
	}
	if (elapsed < 7 * 86_400_000) {
		return `${Math.floor(elapsed / 86_400_000)} d`;
	}
	const date = new Date(timestamp);
	const options: Intl.DateTimeFormatOptions = { month: "short", day: "numeric" };
	if (date.getFullYear() !== new Date(now).getFullYear()) {
		options.year = "numeric";
	}
	return date.toLocaleDateString(undefined, options);
}

function localDayNumber(time: number): number {
	const date = new Date(time);
	return Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()) / 86_400_000;
}
