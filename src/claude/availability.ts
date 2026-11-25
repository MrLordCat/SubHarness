import type {
	ClaudeRateLimitInfo,
	ClaudeSubscriptionUsageSnapshot,
} from "./app-server-client";

export type ClaudeModelAvailabilityState = "available" | "unavailable" | "unknown";

export interface ClaudeModelAvailability {
	state: ClaudeModelAvailabilityState;
	reason: string;
	checkedAt?: number;
	unavailableUntil?: string;
}

const CLAUDE_AVAILABILITY_MAX_AGE_MS = 2 * 60_000;

interface AvailabilityWindow {
	label: string;
	utilization: number;
	resetsAt?: string;
}

function normalizeBucket(value: string): string {
	return value.toLowerCase().replace(/[^a-z0-9]/g, "");
}

function familyForModel(modelId: string): string | undefined {
	return modelId.toLowerCase().includes("opus") ? "opus" : undefined;
}

function parseReset(value: string | null | undefined): number | undefined {
	if (!value) {
		return undefined;
	}
	const timestamp = Date.parse(value);
	return Number.isFinite(timestamp) ? timestamp : undefined;
}

/** The chat's names for Claude's rate-limit windows; the model-scoped weekly ones count as weekly. */
const RATE_LIMIT_WINDOWS: Readonly<Record<string, string>> = {
	five_hour: "5-hour",
	seven_day: "weekly",
	seven_day_opus: "weekly",
	seven_day_sonnet: "weekly",
	seven_day_overage_included: "weekly",
};

/** How long Claude's usage report stays good enough to name the window that refused a request. */
const CLAUDE_LIMIT_SNAPSHOT_MAX_AGE_MS = 10 * 60_000;

/**
 * Claude's own word on the window that refused a request, which beats the error text: the error's
 * bare clock or month-day date says nothing about which window it is. First a rejected rate-limit
 * event of this turn, then the used-up window of a fresh usage report that resets last.
 */
export function claudeReportedLimit(
	modelId: string,
	rateLimit: ClaudeRateLimitInfo | undefined,
	rateLimitAt: number | undefined,
	snapshot: ClaudeSubscriptionUsageSnapshot | undefined,
	snapshotAt: number | undefined,
	now = Date.now()
): { window?: string; resetAt?: Date } | undefined {
	if (rateLimit?.status === "rejected" && rateLimitAt !== undefined && now - rateLimitAt <= CLAUDE_AVAILABILITY_MAX_AGE_MS) {
		const resetMs = rateLimit.resetsAt === undefined ? undefined : rateLimit.resetsAt > 1e12 ? rateLimit.resetsAt : rateLimit.resetsAt * 1000;
		const window = rateLimit.rateLimitType ? RATE_LIMIT_WINDOWS[rateLimit.rateLimitType] : undefined;
		if ((resetMs !== undefined && resetMs > now) || window) {
			return {
				...(window ? { window } : {}),
				...(resetMs !== undefined && resetMs > now ? { resetAt: new Date(resetMs) } : {}),
			};
		}
	}
	const limits = snapshot?.rate_limits;
	if (!snapshot?.rate_limits_available || !limits || snapshotAt === undefined || now - snapshotAt > CLAUDE_LIMIT_SNAPSHOT_MAX_AGE_MS) {
		return undefined;
	}
	let found: { window: string; resetAt: Date } | undefined;
	const consider = (window: string, value: { utilization: number | null; resets_at: string | null } | null | undefined): void => {
		const reset = parseReset(value?.resets_at);
		if (typeof value?.utilization !== "number" || value.utilization < 100 || reset === undefined || reset <= now) {
			return;
		}
		if (!found || reset > found.resetAt.getTime()) {
			found = { window, resetAt: new Date(reset) };
		}
	};
	consider("5-hour", limits.five_hour);
	consider("weekly", limits.seven_day);
	// A used-up window of another model family did not refuse this request.
	const family = familyForModel(modelId);
	if (family) {
		if (family === "opus") {
			consider("weekly", limits.seven_day_opus);
		}
		for (const scoped of limits.model_scoped ?? []) {
			const bucket = normalizeBucket(scoped.display_name);
			if (bucket === family || bucket.startsWith(family)) {
				consider("weekly", scoped);
			}
		}
	}
	return found;
}

export function buildClaudeModelAvailability(
	modelId: string,
	snapshot: ClaudeSubscriptionUsageSnapshot | undefined,
	checkedAt: number | undefined,
	rateLimit: ClaudeRateLimitInfo | undefined,
	rateLimitCheckedAt: number | undefined,
	now = Date.now()
): ClaudeModelAvailability {
	if (
		rateLimit
		&& rateLimit.status === "rejected"
		&& rateLimitCheckedAt !== undefined
		&& now - rateLimitCheckedAt <= CLAUDE_AVAILABILITY_MAX_AGE_MS
	) {
		const resetMs = rateLimit.resetsAt === undefined
			? undefined
			: rateLimit.resetsAt > 1e12
				? rateLimit.resetsAt
				: rateLimit.resetsAt * 1000;
		if (resetMs === undefined || resetMs > now) {
			return {
				state: "unavailable",
				reason: `Claude runtime reports ${rateLimit.status}`,
				checkedAt,
				...(resetMs ? { unavailableUntil: new Date(resetMs).toISOString() } : {}),
			};
		}
	}

	const limits = snapshot?.rate_limits;
	if (!snapshot?.rate_limits_available || !limits || !checkedAt) {
		return {
			state: "unknown",
			reason: "Live Claude subscription usage has not been reported yet",
			checkedAt,
		};
	}
	if (now - checkedAt > CLAUDE_AVAILABILITY_MAX_AGE_MS) {
		return {
			state: "unknown",
			reason: "Claude subscription usage snapshot is stale",
			checkedAt,
		};
	}

	const windows: AvailabilityWindow[] = [];
	const commonWindows: AvailabilityWindow[] = [];
	const addWindow = (
		label: string,
		window: { utilization: number | null; resets_at: string | null } | null | undefined,
		common = false
	): void => {
		if (window?.utilization === null || window?.utilization === undefined || !Number.isFinite(window.utilization)) {
			return;
		}
		const item = {
			label,
			utilization: Math.max(0, Math.min(100, window.utilization)),
			...(window.resets_at ? { resetsAt: window.resets_at } : {}),
		};
		windows.push(item);
		if (common) {
			commonWindows.push(item);
		}
	};

	addWindow("5-hour", limits.five_hour, true);
	addWindow("weekly", limits.seven_day, true);

	const family = familyForModel(modelId);
	if (family === "opus") {
		addWindow("weekly Opus", limits.seven_day_opus);
	}

	if (family) {
		for (const scoped of limits.model_scoped ?? []) {
			const bucket = normalizeBucket(scoped.display_name);
			if (bucket === family || bucket.startsWith(family)) {
				addWindow(`weekly ${scoped.display_name}`, scoped);
			}
		}
	}

	if (commonWindows.length === 0) {
		return {
			state: "unknown",
			reason: "Claude did not report a common 5-hour or weekly usage window",
			checkedAt,
		};
	}

	const blockers = windows.filter(window => {
		if (window.utilization < 100) {
			return false;
		}
		const reset = parseReset(window.resetsAt);
		return reset === undefined || reset > now;
	});
	if (blockers.length > 0) {
		const extraUsage = limits.extra_usage;
		const extraUsageAvailable = extraUsage?.is_enabled === true
			&& (extraUsage.utilization === null
				|| extraUsage.utilization === undefined
				|| extraUsage.utilization < 100);
		if (extraUsageAvailable) {
			return {
				state: "available",
				reason: `${blockers.map(window => `${window.label} limit ${Math.round(window.utilization)}%`).join("; ")}; paid extra usage is enabled`,
				checkedAt,
			};
		}
		const resetTimes = blockers
			.map(window => parseReset(window.resetsAt))
			.filter((value): value is number => value !== undefined);
		const unavailableUntil = resetTimes.length > 0
			? new Date(Math.max(...resetTimes)).toISOString()
			: undefined;
		return {
			state: "unavailable",
			reason: blockers.map(window => `${window.label} limit ${Math.round(window.utilization)}%`).join("; "),
			checkedAt,
			...(unavailableUntil ? { unavailableUntil } : {}),
		};
	}

	const expiredFullWindow = windows.some(window =>
		window.utilization >= 100
		&& parseReset(window.resetsAt) !== undefined
		&& (parseReset(window.resetsAt) as number) <= now
	);
	if (expiredFullWindow) {
		return {
			state: "unknown",
			reason: "A full Claude usage window has expired; waiting for a refreshed snapshot",
			checkedAt,
		};
	}

	return {
		state: "available",
		reason: windows.map(window => `${window.label} ${Math.round(window.utilization)}%`).join("; "),
		checkedAt,
	};
}