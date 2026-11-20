import * as vscode from "vscode";

/** Machine-readable prompt-cache counters reported by a provider after a native prompt. */
export const PROMPT_CACHE_MIME = "application/vnd.aab.prompt-cache+json";
/** modelOptions flag of a request that wants prompt-cache parts; the composite drops them for every other caller. */
export const PROMPT_CACHE_OPTION = "_aabPromptCache";

export interface PromptCacheSignal {
	/** Total input, including cache reads and writes. */
	promptTokens: number;
	cachedTokens?: number;
	cacheWriteTokens?: number;
	completionTokens: number;
	/** Model calls behind the counters; 1 when the provider reports one aggregate. */
	requests: number;
}

export function promptCacheSignalPart(signal: PromptCacheSignal): vscode.LanguageModelDataPart {
	return new vscode.LanguageModelDataPart(new TextEncoder().encode(JSON.stringify(signal)), PROMPT_CACHE_MIME);
}

export function isPromptCacheSignalPart(part: unknown): part is vscode.LanguageModelDataPart {
	return part instanceof vscode.LanguageModelDataPart && part.mimeType === PROMPT_CACHE_MIME;
}

export function parsePromptCacheSignal(part: unknown): PromptCacheSignal | undefined {
	if (!isPromptCacheSignalPart(part)) {
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
	const token = (name: string): number | undefined => {
		const entry = record[name];
		return typeof entry === "number" && Number.isSafeInteger(entry) && entry >= 0 ? entry : undefined;
	};
	const promptTokens = token("promptTokens"), completionTokens = token("completionTokens"), requests = token("requests");
	if (promptTokens === undefined || completionTokens === undefined || requests === undefined || requests < 1) {
		return undefined;
	}
	const cachedTokens = record.cachedTokens === undefined ? undefined : token("cachedTokens");
	const cacheWriteTokens = record.cacheWriteTokens === undefined ? undefined : token("cacheWriteTokens");
	if (cachedTokens === undefined && record.cachedTokens !== undefined || cacheWriteTokens === undefined && record.cacheWriteTokens !== undefined) {
		return undefined;
	}
	return {
		promptTokens,
		completionTokens,
		requests,
		...(cachedTokens !== undefined ? { cachedTokens } : {}),
		...(cacheWriteTokens !== undefined ? { cacheWriteTokens } : {}),
	};
}
