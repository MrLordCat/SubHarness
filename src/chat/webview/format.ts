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
