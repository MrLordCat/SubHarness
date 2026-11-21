/**
 * Logs a failure that repeats on every poll only when it starts, when its
 * message changes, and at most once per interval while it lasts.
 */
export class RepeatedFailureLog {
	private readonly failures = new Map<string, { message: string; loggedAt: number; skipped: number }>();

	constructor(private readonly intervalMs = 10 * 60_000, private readonly now: () => number = Date.now) {}

	/**
	 * Returns how many identical failures were skipped since the last logged
	 * one (0 for a new failure), or undefined when this one should not be logged.
	 */
	report(key: string, error: unknown): number | undefined {
		const message = error instanceof Error ? error.message : String(error);
		const now = this.now();
		const failure = this.failures.get(key);
		if (!failure || failure.message !== message) {
			this.failures.set(key, { message, loggedAt: now, skipped: 0 });
			return 0;
		}
		if (now - failure.loggedAt >= this.intervalMs) {
			const skipped = failure.skipped;
			failure.loggedAt = now;
			failure.skipped = 0;
			return skipped;
		}
		failure.skipped++;
		return undefined;
	}

	/** Forgets the failure for key; true when one was tracked, so the caller may log the recovery. */
	clear(key: string): boolean {
		return this.failures.delete(key);
	}
}
