import * as vscode from "vscode";
import { formatBalanceNotice, type BalanceFailure } from "./balance-errors";
import { formatLimitNotice, type LimitMatch, type LimitProvider } from "./limit-errors";

/** Machine-readable twin of a limit or balance notice, reported right before the notice text. */
export const LIMIT_SIGNAL_MIME = "application/vnd.aab.limit-signal+json";
/** modelOptions flag of a request that wants limit signals; the composite drops them for every other caller. */
export const LIMIT_SIGNAL_OPTION = "_aabLimitSignals";

export interface LimitSignal {
	kind: "limit" | "balance";
	/** Provider name shown to the user, e.g. "Codex" or "DeepSeek". */
	provider: string;
	/** The notice text that follows the signal. */
	text: string;
	/** Window wording such as "5-hour" or "weekly". */
	window?: string;
	/** Reset time in epoch milliseconds. */
	resetAt?: number;
}

type ResponseProgress = vscode.Progress<vscode.LanguageModelResponsePart>;

export function limitSignalPart(signal: LimitSignal): vscode.LanguageModelDataPart {
	return new vscode.LanguageModelDataPart(new TextEncoder().encode(JSON.stringify(signal)), LIMIT_SIGNAL_MIME);
}

export function isLimitSignalPart(part: unknown): part is vscode.LanguageModelDataPart {
	return part instanceof vscode.LanguageModelDataPart && part.mimeType === LIMIT_SIGNAL_MIME;
}

export function parseLimitSignal(part: unknown): LimitSignal | undefined {
	if (!isLimitSignalPart(part)) {
		return undefined;
	}
	let value: unknown;
	try {
		value = JSON.parse(new TextDecoder().decode(part.data));
	} catch {
		return undefined;
	}
	if (typeof value !== "object" || value === null) {
		return undefined;
	}
	const record = value as Record<string, unknown>;
	if ((record.kind !== "limit" && record.kind !== "balance") || typeof record.provider !== "string" || typeof record.text !== "string") {
		return undefined;
	}
	return {
		kind: record.kind,
		provider: record.provider,
		text: record.text,
		...(typeof record.window === "string" ? { window: record.window } : {}),
		...(typeof record.resetAt === "number" && Number.isFinite(record.resetAt) ? { resetAt: record.resetAt } : {}),
	};
}

export function limitSignal(provider: LimitProvider, match: LimitMatch | undefined, text: string): LimitSignal {
	return {
		kind: "limit",
		provider: provider === "claude" ? "Claude" : "Codex",
		text,
		...(match?.window ? { window: match.window } : {}),
		...(match?.resetAt ? { resetAt: match.resetAt.getTime() } : {}),
	};
}

export function balanceSignal(failure: BalanceFailure, text: string): LimitSignal {
	return { kind: "balance", provider: failure.providerLabel, text };
}

/** Reports a subscription limit as a signal plus the usual short notice. */
export function reportLimitNotice(progress: ResponseProgress, provider: LimitProvider, match: LimitMatch | undefined, text = formatLimitNotice(provider, match)): void {
	progress.report(limitSignalPart(limitSignal(provider, match, text)));
	progress.report(new vscode.LanguageModelTextPart(text));
}

/** Reports an empty balance as a signal plus the usual short notice. */
export function reportBalanceNotice(progress: ResponseProgress, failure: BalanceFailure): void {
	const text = formatBalanceNotice(failure);
	progress.report(limitSignalPart(balanceSignal(failure, text)));
	progress.report(new vscode.LanguageModelTextPart(text));
}
