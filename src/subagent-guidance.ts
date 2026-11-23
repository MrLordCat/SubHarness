import { isLoopbackServerUrl, type ChatModelSource } from "./model-sources/source-routing";
import { isDeepSeekEndpoint } from "./transport/openai-http";

export type SubagentProvider = "local" | "deepseek" | "codex" | "claude" | "api";

/** Advertised catalog order, cheapest first; paid API profiles come last. */
const SUBAGENT_PROVIDER_ORDER: readonly SubagentProvider[] = ["local", "deepseek", "codex", "claude", "api"];

export interface SubagentModelProfile {
	id: string;
	label: string;
	provider: SubagentProvider;
	defaultEffort?: string;
	useWhen: string;
	availability?: "available" | "unavailable" | "unknown";
	availabilityReason?: string;
	availabilityCheckedAt?: number;
	unavailableUntil?: string;
}

/** Subagent group of an HTTP model source: self-hosted llama.cpp servers are local, DeepSeek is its own tier, other API profiles (Cursor, gateways) are paid per use. */
export function subagentProviderForSource(source: Pick<ChatModelSource, "protocol" | "serverUrl" | "llamaCppCompat">): "local" | "deepseek" | "api" {
	if (source.protocol === "deepseek" || isDeepSeekEndpoint(source.serverUrl)) {
		return "deepseek";
	}
	if (source.protocol === "llamacpp" || source.llamaCppCompat === true || isLoopbackServerUrl(source.serverUrl)) {
		return "local";
	}
	return "api";
}

const catalogs = new Map<SubagentProvider, Map<string, SubagentModelProfile[]>>();

/** Codex subagent roles: Luna, the fast affordable model, takes small steps; Terra takes larger ones. */
export type CodexSubagentRole = "luna" | "terra";

/** Only the Codex 6.x family is used; 5.x models are never subagents. */
const CODEX_SUBAGENT_MODEL = /^gpt-(6(?:\.\d+)*)-(luna|terra)$/i;

function bareModelId(id: string): string {
	return (id.split("::").at(-1) ?? id).toLowerCase();
}

/** The subagent role of a 6.x Codex model; Sol, 5.x and every other Codex model have none and are never subagents. */
export function codexSubagentRole(modelId: string): CodexSubagentRole | undefined {
	return CODEX_SUBAGENT_MODEL.exec(bareModelId(modelId))?.[2].toLowerCase() as CodexSubagentRole | undefined;
}

/** "gpt-6.1-terra" → [6, 1]; compared part by part, so 6.1 is newer than 6. */
function codexModelVersion(modelId: string): number[] {
	return (CODEX_SUBAGENT_MODEL.exec(bareModelId(modelId))?.[1] ?? "0").split(".").map(Number);
}

function compareVersions(left: readonly number[], right: readonly number[]): number {
	for (let index = 0; index < Math.max(left.length, right.length); index++) {
		const diff = (left[index] ?? 0) - (right[index] ?? 0);
		if (diff !== 0) {
			return diff;
		}
	}
	return 0;
}

/** What the subagent list says a Codex model is for. */
export function codexSubagentUseWhen(modelId: string): string {
	switch (codexSubagentRole(modelId)) {
		case "luna":
			return "Fast and affordable: small, well-defined steps such as an edit in one or two files, a code search, a routine check or a test run";
		case "terra":
			return "Larger multi-step steps: a change across several files with its tests, a refactoring or a feature step";
		default:
			return "Use for repository-wide, multi-step coding or high-confidence verification";
	}
}

/**
 * Codex offers subagents only its newest 6.x Luna and newest 6.x Terra; older versions, 5.x, Sol and the other
 * models stay out. An account without a 6.x Luna or Terra offers none.
 */
function newestCodexSubagents(profiles: readonly SubagentModelProfile[]): SubagentModelProfile[] {
	const newest = new Map<CodexSubagentRole, SubagentModelProfile>();
	for (const profile of profiles) {
		const role = codexSubagentRole(profile.id);
		const current = role ? newest.get(role) : undefined;
		if (role && (!current || compareVersions(codexModelVersion(profile.id), codexModelVersion(current.id)) > 0)) {
			newest.set(role, profile);
		}
	}
	return [...newest.values()];
}

/**
 * Codex passes its account id so two ChatGPT accounts keep their own subagents;
 * without a scope the call replaces every scope of the provider.
 */
export function setSubagentModelProfiles(
	provider: SubagentProvider,
	profiles: readonly SubagentModelProfile[],
	scope?: string
): void {
	const eligible = provider === "codex" ? newestCodexSubagents(profiles) : profiles;
	const unique = new Map(eligible.map(profile => [profile.id, profile]));
	const sorted = [...unique.values()].sort((left, right) => {
		if (provider === "codex") {
			// Luna, the cheaper model for small steps, comes before Terra.
			const tier = (id: string): number => codexSubagentRole(id) === "luna" ? 0 : 1;
			const tierDiff = tier(left.id) - tier(right.id);
			if (tierDiff !== 0) { return tierDiff; }
		}
		return left.label.localeCompare(right.label);
	});

	if (scope === undefined) {
		if (sorted.length === 0) {
			catalogs.delete(provider);
		} else {
			catalogs.set(provider, new Map([["", sorted]]));
		}
		return;
	}

	let scopes = catalogs.get(provider);
	if (sorted.length === 0) {
		scopes?.delete(scope);
		if (scopes?.size === 0) {
			catalogs.delete(provider);
		}
		return;
	}
	if (!scopes) {
		scopes = new Map();
		catalogs.set(provider, scopes);
	}
	scopes.set(scope, sorted);
}

export function getSubagentModelProfiles(): SubagentModelProfile[] {
	// API catalogs can expose the same display name more than once (for example
	// two Cursor ids named "Auto"); a subagent is selected by label, so keep the
	// first one instead of advertising a duplicate that can never be chosen.
	const seenLabels = new Set<string>();
	const profiles: SubagentModelProfile[] = [];
	for (const provider of SUBAGENT_PROVIDER_ORDER) {
		const scopes = catalogs.get(provider);
		const orderedScopes = scopes
			? [...scopes.keys()].sort((left, right) => {
				if (left === "") { return right === "" ? 0 : -1; }
				if (right === "") { return 1; }
				return left.localeCompare(right);
			})
			: [];
		for (const scope of orderedScopes) {
			for (const profile of scopes!.get(scope) ?? []) {
				if (seenLabels.has(profile.label)) {
					continue;
				}
				seenLabels.add(profile.label);
				profiles.push(profile);
			}
		}
	}
	return profiles;
}

/** Profiles a subagent may start with now; exhausted subscriptions are left out. */
export function availableSubagentModelProfiles(): SubagentModelProfile[] {
	return getSubagentModelProfiles().filter(profile => profile.availability !== "unavailable");
}



