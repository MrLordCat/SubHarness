/**
 * How much content one tool result may carry. A provider cuts a longer result itself, dropping its middle
 * (Claude at 16k characters, Codex 12k, HTTP 24k by default), so a tool that pages its output stops early
 * instead and says how to continue.
 */

/** Room kept for a result's header and its continuation note. */
export const RESULT_NOTE_RESERVE = 600;
/** A tiny configured limit still leaves a readable page. */
const MIN_RESULT_BUDGET = 1_000;

/** The tool's own cap, or less when the model's provider forwards fewer characters (`resultChars`). */
export function resultBudget(own: number, resultChars: number | undefined): number {
	if (!(typeof resultChars === "number" && Number.isFinite(resultChars) && resultChars > 0)) {
		return own;
	}
	return Math.min(own, Math.max(MIN_RESULT_BUDGET, Math.floor(resultChars) - RESULT_NOTE_RESERVE));
}
