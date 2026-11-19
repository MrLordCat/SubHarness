import type { ChatProviderQuota } from "../shared/protocol";

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

function formatScaled(value: number): string {
	const text = value >= 100 ? `${Math.round(value)}` : value.toFixed(1);
	return text.endsWith(".0") ? text.slice(0, -2) : text;
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
