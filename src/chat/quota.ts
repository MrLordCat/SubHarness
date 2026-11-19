import type { SubscriptionObservation, SubscriptionWindowObservation } from "../diagnostics/subscription-usage";
import type { ChatProviderQuota, ChatQuotaWindow } from "./shared/protocol";

function quotaWindow(label: string, window: SubscriptionWindowObservation | undefined): ChatQuotaWindow | undefined {
	if (!window || !Number.isFinite(window.utilization)) {
		return undefined;
	}
	const resetsAt = window.resetsAt ? Date.parse(window.resetsAt) : Number.NaN;
	return {
		label,
		percent: Math.round(Math.max(0, Math.min(100, window.utilization))),
		...(Number.isFinite(resetsAt) ? { resetsAt } : {}),
	};
}

/** Codex and Claude report the same 5-hour and weekly windows. */
export function subscriptionQuota(provider: string, observation: SubscriptionObservation | undefined): ChatProviderQuota | undefined {
	const windows = [quotaWindow("5h", observation?.fiveHour), quotaWindow("Week", observation?.weekly)]
		.filter((window): window is ChatQuotaWindow => window !== undefined);
	if (windows.length === 0) {
		return undefined;
	}
	return { provider, windows, ...(observation?.plan ? { plan: observation.plan } : {}) };
}

export function balanceQuota(provider: string, balance: string | undefined): ChatProviderQuota | undefined {
	const text = balance?.trim();
	return text ? { provider, windows: [], balance: text } : undefined;
}
