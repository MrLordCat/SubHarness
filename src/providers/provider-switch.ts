/**
 * Set by the composite provider when a different model served the chat last. The
 * receiving provider must start from the shared transcript: its own live or saved
 * session predates the other model's work and any compaction it did.
 */
export const PROVIDER_SWITCH_OPTION = "_aabProviderSwitched";

/**
 * Set by the chat on the first request after it compacted or cleaned its history. A native session still
 * holds the history from before, so the provider starts from the chat's history, as after a switch.
 */
export const HISTORY_RESET_OPTION = "_aabHistoryReset";

/** The provider must start from the chat's history: another model served the chat last, or the chat rewrote it. */
export function isProviderSwitch(modelOptions: Readonly<Record<string, unknown>> | undefined): boolean {
	return typeof modelOptions?.[PROVIDER_SWITCH_OPTION] === "string" || isHistoryReset(modelOptions);
}

export function isHistoryReset(modelOptions: Readonly<Record<string, unknown>> | undefined): boolean {
	return modelOptions?.[HISTORY_RESET_OPTION] === true;
}
