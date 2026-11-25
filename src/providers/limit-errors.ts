/**
 * Subscription limit errors arrive as long provider text ("You've hit your
 * 5-hour limit · resets 4pm (Europe/Tallinn)"). They are not failures to retry:
 * the provider will reject every attempt until the window resets. This module
 * turns such an error into one short English notice and remembers the reset so
 * retries fail instantly instead of starting a new provider turn each time.
 */

export type LimitProvider = "claude" | "codex";

export interface LimitMatch {
	provider: LimitProvider;
	/** Window wording from the provider, e.g. "5-hour" or "weekly". */
	window?: string;
	resetAt?: Date;
	/** IANA zone the provider named with the reset time, e.g. "Europe/Tallinn". */
	timeZone?: string;
	/** Short provider-neutral cause, e.g. "usage limit". */
	reason: string;
	/**
	 * True when the limit was read from an error message rather than from the
	 * provider's own window report. A message can be old, and its bare clock time
	 * resolves to the next occurrence, so such a block needs verification.
	 */
	provisional?: boolean;
}

const CLAUDE_PATTERNS: readonly RegExp[] = [
	/hit your .{0,40}limit/i,
	/claude api error:.*(?:usage|rate|weekly|5-hour).{0,24}limit/i,
	/usage limit reached/i,
	/rate[_ ]?limit[_ ]?(?:error|exceeded)|rate limit (?:exceeded|reached)/i,
	/\b429\b|too many requests/i,
];
const CODEX_PATTERNS: readonly RegExp[] = [
	/hit your .{0,40}limit/i,
	/purchase more credits/i,
	/usage limit reached/i,
	/rate limit (?:exceeded|reached)/i,
	/at capacity|too many requests/i,
	/\b429\b/,
];
/** Context and payload limits are not subscription windows; retrying or waiting does not help. */
const NOT_A_SUBSCRIPTION_LIMIT = /context (?:length|window)|maximum length|too many tokens|input exceeds|tool (?:call|output) limit|message too long/i;

const HOUR_WINDOW_PATTERN = /\b(\d+-hour)\b/i;
const PERIOD_WINDOW_PATTERN = /\b(weekly|daily|monthly)\b/i;
/** "session limit" is Claude's name for the 5-hour window; the others are 7-day windows. */
const NAMED_WINDOW_PATTERN = /\b(session|weekly|opus|sonnet|fable\s*5)\s+limit\b/i;

/** Reads the window from provider text; an explicit "N-hour" wins over everything else. */
function detectWindow(text: string): string | undefined {
	const hours = HOUR_WINDOW_PATTERN.exec(text)?.[1];
	if (hours) {
		return hours.toLowerCase();
	}
	const period = PERIOD_WINDOW_PATTERN.exec(text)?.[1];
	if (period) {
		return period.toLowerCase();
	}
	const named = NAMED_WINDOW_PATTERN.exec(text)?.[1]?.toLowerCase();
	if (!named) {
		return undefined;
	}
	return named === "session" ? "5-hour" : "weekly";
}

export function detectLimitError(error: unknown, provider?: LimitProvider, now = new Date()): LimitMatch | undefined {
	const text = error instanceof Error ? `${error.message} ${String((error as { cause?: unknown }).cause ?? "")}` : String(error);
	if (!text || NOT_A_SUBSCRIPTION_LIMIT.test(text)) {
		return undefined;
	}
	const candidate: LimitProvider | undefined = provider
		?? (/claude/i.test(text) ? "claude"
			: /codex|chatgpt|purchase more credits/i.test(text) ? "codex"
				: /\b\d+-hour\b|\b(?:weekly|session|opus|sonnet)\b|\bfable\s*5\b|\([A-Za-z]+\/[A-Za-z_+-]+\)/i.test(text) ? "claude"
					: undefined);
	if (!candidate) {
		return undefined;
	}
	const patterns = candidate === "claude" ? CLAUDE_PATTERNS : CODEX_PATTERNS;
	if (!patterns.some(pattern => pattern.test(text))) {
		return undefined;
	}
	const window = detectWindow(text);
	const reset = parseResetTime(text, now);
	return {
		provider: candidate,
		...(window ? { window } : {}),
		...(reset ? { resetAt: reset.at, ...(reset.timeZone ? { timeZone: reset.timeZone } : {}) } : {}),
		reason: /\b429\b|too many requests/i.test(text) && !/hit your/i.test(text) ? "rate limit" : "usage limit",
		provisional: true,
	};
}

interface ParsedReset {
	at: Date;
	timeZone?: string;
}

const ZONE_PATTERN = /\(([A-Za-z]+(?:\/[A-Za-z_+-]+)+)\)/;
const CLOCK_PATTERN = /(?:resets?|reset|try again|available again|until)\s*(?:at|on|by)?\s*(\d{1,2})(?::(\d{2}))?\s*(am|pm)?/i;
const ISO_PATTERN = /(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,3})?)?(?:Z|[+-]\d{2}:?\d{2})?)/;
/**
 * Claude writes a reset more than a day away as "resets Nov 28, 4pm" or
 * "resets Jan 2, 2027, 4pm"; Codex writes "try again at Nov 28th, 2026 4:12 PM".
 * The date must be read here, before the bare clock, or "Nov 28, 4pm" would
 * resolve to the next 04:00 today.
 */
const DATED_CLOCK_PATTERN = /(?:resets?|reset|try again|available again|until)\s*(?:at|on|by)?\s*([A-Za-z]{3,9})\.?\s+(\d{1,2})(?:st|nd|rd|th)?,?\s*(?:(\d{4})\s*,?\s*)?(\d{1,2})(?::(\d{2}))?\s*(am|pm)/i;
const MONTH_NUMBERS: Readonly<Record<string, number>> = {
	jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6,
	jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12,
};

/** Reads "resets 4pm (Europe/Tallinn)", "resets Nov 28, 4pm", "try again at Nov 28th, 2026 4:12 PM" or an ISO timestamp. */
export function parseResetTime(text: string, now = new Date()): ParsedReset | undefined {
	const iso = ISO_PATTERN.exec(text);
	if (iso) {
		const parsed = new Date(iso[1]);
		if (!Number.isNaN(parsed.getTime())) {
			return { at: parsed };
		}
	}
	const timeZone = ZONE_PATTERN.exec(text)?.[1];
	const dated = DATED_CLOCK_PATTERN.exec(text);
	if (dated) {
		const parsed = parseDatedReset(dated, timeZone, now);
		if (parsed) {
			return { at: parsed, ...(timeZone ? { timeZone } : {}) };
		}
	}
	const clock = CLOCK_PATTERN.exec(text);
	if (!clock) {
		return undefined;
	}
	let hour = Number(clock[1]);
	const minute = clock[2] ? Number(clock[2]) : 0;
	const meridiem = clock[3]?.toLowerCase();
	if (!Number.isFinite(hour) || hour > 23 || minute > 59) {
		return undefined;
	}
	if (meridiem === "pm" && hour < 12) {
		hour += 12;
	} else if (meridiem === "am" && hour === 12) {
		hour = 0;
	}
	const at = nextOccurrence(hour, minute, timeZone, now);
	return at ? { at, ...(timeZone ? { timeZone } : {}) } : undefined;
}

/** Resolves "Nov 28, 4pm" against `now`; without a year, a date over a day past means next year. */
function parseDatedReset(match: RegExpExecArray, timeZone: string | undefined, now: Date): Date | undefined {
	const month = MONTH_NUMBERS[match[1].slice(0, 3).toLowerCase()];
	const day = Number(match[2]);
	let hour = Number(match[4]);
	const minute = match[5] ? Number(match[5]) : 0;
	if (!month || !Number.isFinite(day) || day < 1 || day > 31 || !Number.isFinite(hour) || hour < 1 || hour > 12 || minute > 59) {
		return undefined;
	}
	if (match[6].toLowerCase() === "pm" && hour < 12) {
		hour += 12;
	} else if (match[6].toLowerCase() === "am" && hour === 12) {
		hour = 0;
	}
	const wallTime = (year: number): Date | undefined => timeZone
		? zonedTimeToUtc(year, month, day, hour, minute, timeZone)
		: new Date(year, month - 1, day, hour, minute, 0, 0);
	const explicitYear = match[3] ? Number(match[3]) : undefined;
	if (explicitYear) {
		return wallTime(explicitYear);
	}
	const baseYear = (timeZone ? zonedParts(now, timeZone, 0)?.year : now.getFullYear()) ?? now.getFullYear();
	const candidate = wallTime(baseYear);
	if (!candidate) {
		return undefined;
	}
	return candidate.getTime() < now.getTime() - 24 * 3_600_000 ? wallTime(baseYear + 1) : candidate;
}

/** Resolves a wall-clock time in `timeZone` to the next moment it occurs. */
function nextOccurrence(hour: number, minute: number, timeZone: string | undefined, now: Date): Date | undefined {
	if (!timeZone) {
		const candidate = new Date(now);
		candidate.setHours(hour, minute, 0, 0);
		if (candidate.getTime() <= now.getTime()) {
			candidate.setDate(candidate.getDate() + 1);
		}
		return candidate;
	}
	try {
		for (let dayOffset = 0; dayOffset <= 2; dayOffset++) {
			const parts = zonedParts(now, timeZone, dayOffset);
			if (!parts) {
				return undefined;
			}
			const candidate = zonedTimeToUtc(parts.year, parts.month, parts.day, hour, minute, timeZone);
			if (candidate && candidate.getTime() > now.getTime()) {
				return candidate;
			}
		}
	} catch {
		return undefined;
	}
	return undefined;
}

function zonedParts(date: Date, timeZone: string, dayOffset: number): { year: number; month: number; day: number } | undefined {
	try {
		const formatted = new Intl.DateTimeFormat("en-CA", {
			timeZone,
			year: "numeric",
			month: "2-digit",
			day: "2-digit",
		}).format(date);
		const [year, month, day] = formatted.split("-").map(Number);
		if (!year || !month || !day) {
			return undefined;
		}
		const shifted = new Date(Date.UTC(year, month - 1, day + dayOffset));
		return { year: shifted.getUTCFullYear(), month: shifted.getUTCMonth() + 1, day: shifted.getUTCDate() };
	} catch {
		return undefined;
	}
}

function zonedTimeToUtc(
	year: number,
	month: number,
	day: number,
	hour: number,
	minute: number,
	timeZone: string
): Date | undefined {
	try {
		const guess = Date.UTC(year, month - 1, day, hour, minute);
		const formatter = new Intl.DateTimeFormat("en-CA", {
			timeZone,
			hourCycle: "h23",
			year: "numeric",
			month: "2-digit",
			day: "2-digit",
			hour: "2-digit",
			minute: "2-digit",
		});
		const parts = formatter.formatToParts(new Date(guess));
		const read = (type: string) => Number(parts.find(part => part.type === type)?.value);
		const observed = Date.UTC(read("year"), read("month") - 1, read("day"), read("hour"), read("minute"));
		if (!Number.isFinite(observed)) {
			return undefined;
		}
		// The zone offset is the difference between what UTC looked like and the wall clock.
		return new Date(guess - (observed - guess));
	} catch {
		return undefined;
	}
}

export function formatWait(until: Date, now = new Date()): string {
	const ms = until.getTime() - now.getTime();
	if (ms <= 0) {
		return "now";
	}
	const minutes = Math.round(ms / 60_000);
	if (minutes >= 24 * 60) {
		const days = Math.floor(minutes / (24 * 60));
		const hours = Math.floor((minutes % (24 * 60)) / 60);
		return hours ? `${days} d ${hours} h` : `${days} d`;
	}
	if (minutes < 60) {
		return `${minutes} min`;
	}
	const hours = Math.floor(minutes / 60), rest = minutes % 60;
	return rest ? `${hours} h ${rest} min` : `${hours} h`;
}

/** Year of `date` in `timeZone`, or locally when no zone is known. */
function yearIn(date: Date, timeZone: string | undefined): number | undefined {
	try {
		const year = Number(new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric" }).format(date));
		return Number.isFinite(year) ? year : undefined;
	} catch {
		return undefined;
	}
}

/** Clock time of the reset; a reset over a day away also gets its date ("28 Nov, 16:00 EET"). */
export function formatResetClock(reset: Pick<LimitMatch, "resetAt" | "timeZone">, now = new Date()): string | undefined {
	if (!reset.resetAt) {
		return undefined;
	}
	const farAway = reset.resetAt.getTime() - now.getTime() > 24 * 3_600_000;
	try {
		const sameYear = yearIn(reset.resetAt, reset.timeZone) === yearIn(now, reset.timeZone);
		return new Intl.DateTimeFormat("en-GB", {
			...(farAway ? { day: "numeric", month: "short" } : {}),
			...(farAway && !sameYear ? { year: "numeric" } : {}),
			hour: "2-digit",
			minute: "2-digit",
			hourCycle: "h23",
			...(reset.timeZone ? { timeZone: reset.timeZone } : {}),
			...(reset.timeZone ? { timeZoneName: "short" } : {}),
		}).format(reset.resetAt);
	} catch {
		return reset.resetAt.toISOString();
	}
}

export function formatLimitNotice(provider: LimitProvider, match: LimitMatch | undefined, now = new Date()): string {	const owner = provider === "claude" ? "Claude" : "Codex";
	const window = match?.window ? ` ${match.window}` : "";
	const clock = formatResetClock(match ?? {}, now);
	if (!match?.resetAt || !clock) {
		return `${owner}${window} limit reached. Wait for the limit to reset, then send the message again. No retry was made.`;
	}
	return `${owner}${window} limit reached. It resets at ${clock} (in ${formatWait(match.resetAt, now)}). `
		+ "Wait for the reset, then send the message again. No retry was made.";
}

/**
 * A text-derived block may not outlive the window it talks about. A bare clock
 * time in a day-old message resolves to the next occurrence, which would hold
 * the chat for up to a whole day after the real reset.
 */
export function limitBlockCeilingMs(match: Pick<LimitMatch, "window">): number {
	const hours = /(\d+)-hour/i.exec(match.window ?? "")?.[1];
	if (hours) {
		return (Number(hours) + 1) * 3_600_000;
	}
	if (/week/i.test(match.window ?? "")) {
		return 7.5 * 24 * 3_600_000;
	}
	if (/day/i.test(match.window ?? "")) {
		return 26 * 3_600_000;
	}
	// Unknown window: the shortest subscription window in use is five hours.
	return 6 * 3_600_000;
}

/** Short error shown in chat instead of the raw provider text. */
export class SubscriptionLimitError extends Error {
	constructor(
		readonly provider: LimitProvider,
		readonly match: LimitMatch | undefined,
		now = new Date()
	) {
		super(formatLimitNotice(provider, match, now));
		this.name = "SubscriptionLimitError";
	}

	/** Whether a provider turn should be attempted again without user action. */
	readonly retryable = false;
}

/** Fails fast after a limit error until the provider window resets. */
export class LimitGate {
	private readonly blockedUntil = new Map<LimitProvider, { until: number; armedAt: number; match?: LimitMatch; notice: string }>();

	/** Records a hit; without a reset time the provider is blocked until the next successful turn. */
	note(provider: LimitProvider, match: LimitMatch | undefined, now = Date.now()): void {
		const ceiling = match?.provisional ? now + limitBlockCeilingMs(match) : Number.POSITIVE_INFINITY;
		const until = match?.resetAt
			? Math.min(Math.max(match.resetAt.getTime(), now + 60_000), ceiling)
			: ceiling;
		this.blockedUntil.set(provider, { until, armedAt: now, match, notice: formatLimitNotice(provider, match, new Date(now)) });
	}

	/**
	 * True when the block came from provider text, or is old enough that the
	 * provider's own report should be read again before a request is refused.
	 */
	shouldRecheck(provider: LimitProvider, now = Date.now(), recheckAfterMs = 2 * 60_000): boolean {
		const entry = this.blockedUntil.get(provider);
		if (!entry) {
			return false;
		}
		if (Number.isFinite(entry.until) && now >= entry.until) {
			return false;
		}
		return entry.match?.provisional === true || now - entry.armedAt >= recheckAfterMs;
	}

	/** Returns the short notice when the provider is still limited, otherwise undefined. */
	blocked(provider: LimitProvider, now = Date.now()): string | undefined {
		const entry = this.blockedUntil.get(provider);
		if (!entry) {
			return undefined;
		}
		if (Number.isFinite(entry.until) && now >= entry.until) {
			this.blockedUntil.delete(provider);
			return undefined;
		}
		const match = entry.match;
		if (!match?.resetAt) {
			return entry.notice;
		}
		return formatLimitNotice(provider, match, new Date(now));
	}

	/** Clears the block after a successful turn or a provider report below 100%. */
	clear(provider: LimitProvider): void {
		this.blockedUntil.delete(provider);
	}

	get(provider: LimitProvider): LimitMatch | undefined {
		return this.blockedUntil.get(provider)?.match;
	}
}
