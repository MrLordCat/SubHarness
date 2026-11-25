/**
 * Pause between background probes of a server that may be down.
 *
 * The local llama.cpp server is optional: when it is off, every catalog poll
 * and `/slots` probe would fail against a closed port. Failures grow the pause
 * 15 s -> 30 s -> 1 min -> 2 min -> 5 min and stay at 5 min. A successful
 * probe, an explicit user action, or a settings change clears it at once.
 */

/** Pause after each consecutive failure; the last value repeats. */
export const LOCAL_PROBE_BACKOFF_DELAYS_MS: readonly number[] = [
	15_000,
	30_000,
	60_000,
	120_000,
	300_000,
];

export interface ProbeBackoffChange {
	failureCount: number;
	/** Pause before the next probe; undefined when probing is allowed again. */
	delayMs?: number;
	nextProbeAt?: number;
}

export interface ProbeBackoffOptions {
	/** Overrides the default schedule. */
	delaysMs?: readonly number[];
	/** Injectable clock for tests. */
	now?: () => number;
	/** Fired when the pause changes, never for a skipped probe. */
	onChange?: (state: ProbeBackoffChange) => void;
}

export class ProbeBackoff {
	private failureCount = 0;
	private nextAt = 0;
	private reportedDelayMs: number | undefined;
	private readonly delaysMs: readonly number[];
	private readonly now: () => number;

	constructor(private readonly options: ProbeBackoffOptions = {}) {
		this.delaysMs = options.delaysMs?.length ? options.delaysMs : LOCAL_PROBE_BACKOFF_DELAYS_MS;
		this.now = options.now ?? Date.now;
	}

	/** Consecutive failures since the last success. */
	get failures(): number {
		return this.failureCount;
	}

	/** Timestamp of the next allowed probe; undefined when probing is allowed now. */
	get nextProbeAt(): number | undefined {
		return this.nextAt > 0 ? this.nextAt : undefined;
	}

	canProbe(now = this.now()): boolean {
		return now >= this.nextAt;
	}

	/** Milliseconds left in the pause; 0 when a probe is allowed. */
	remainingMs(now = this.now()): number {
		return Math.max(0, this.nextAt - now);
	}

	/**
	 * Records one failed attempt and returns the new pause. A failure inside an
	 * active pause (a concurrent probe of the same server) is ignored, so one
	 * cycle of `/v1/models` + `/slots` failures counts once.
	 */
	failed(now = this.now()): number | undefined {
		if (now < this.nextAt) {
			return undefined;
		}
		const delayMs = this.delaysMs[Math.min(this.failureCount, this.delaysMs.length - 1)];
		this.failureCount += 1;
		this.nextAt = now + delayMs;
		if (delayMs !== this.reportedDelayMs) {
			this.reportedDelayMs = delayMs;
			this.notify();
		}
		return delayMs;
	}

	/** The server answered: background probes are allowed again immediately. */
	succeeded(): void {
		this.reset();
	}

	reset(): void {
		const wasPaused = this.failureCount > 0 || this.nextAt > 0;
		this.failureCount = 0;
		this.nextAt = 0;
		if (wasPaused) {
			this.reportedDelayMs = undefined;
			this.notify();
		}
	}

	private notify(): void {
		this.options.onChange?.({
			failureCount: this.failureCount,
			delayMs: this.failureCount > 0 ? this.reportedDelayMs : undefined,
			nextProbeAt: this.nextProbeAt,
		});
	}
}
