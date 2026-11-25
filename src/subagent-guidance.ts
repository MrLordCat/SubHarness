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

/** One provider scope, a Codex account for example; scopes with a lower priority are tried first. */
interface ScopedCatalog {
	priority: number;
	profiles: SubagentModelProfile[];
}

const catalogs = new Map<SubagentProvider, Map<string, ScopedCatalog>>();

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
 * without a scope the call replaces every scope of the provider. Accounts list
 * the same models under the same labels, and the priority decides which
 * account a subagent tries first.
 */
export function setSubagentModelProfiles(
	provider: SubagentProvider,
	profiles: readonly SubagentModelProfile[],
	scope?: string,
	priority = 0
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
			catalogs.set(provider, new Map([["", { priority, profiles: sorted }]]));
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
	scopes.set(scope, { priority, profiles: sorted });
}

export function getSubagentModelProfiles(): SubagentModelProfile[] {
	// A subagent is selected by label, so each label is listed once. API catalogs can expose the
	// same display name twice (two Cursor ids named "Auto"): the first one stays. Codex accounts
	// share the labels of their models: the account tried first stays unless its limit is used up
	// and a later account's is not, so a second subscription stands in for the first.
	const indexByLabel = new Map<string, number>();
	const profiles: SubagentModelProfile[] = [];
	for (const provider of SUBAGENT_PROVIDER_ORDER) {
		const scopes = [...(catalogs.get(provider)?.entries() ?? [])].sort(([left, a], [right, b]) => {
			if (a.priority !== b.priority) { return a.priority - b.priority; }
			if (left === "") { return right === "" ? 0 : -1; }
			if (right === "") { return 1; }
			return left.localeCompare(right);
		});
		for (const [, catalog] of scopes) {
			for (const profile of catalog.profiles) {
				const index = indexByLabel.get(profile.label);
				if (index === undefined) {
					indexByLabel.set(profile.label, profiles.length);
					profiles.push(profile);
				} else if (profiles[index].availability === "unavailable" && profile.availability !== "unavailable") {
					profiles[index] = profile;
				}
			}
		}
	}
	return profiles;
}

/** Profiles a subagent may start with now; exhausted subscriptions are left out. */
export function availableSubagentModelProfiles(): SubagentModelProfile[] {
	return getSubagentModelProfiles().filter(profile => profile.availability !== "unavailable");
}

/** Listed models whose limit is used up on every account that offers them; a call to one is answered at once. */
export function unavailableSubagentModelProfiles(): SubagentModelProfile[] {
	return getSubagentModelProfiles().filter(profile => profile.availability === "unavailable");
}

/** The profile of an open subagent's model when its limit is used up and no other account can take it over. */
export function blockedSubagentModel(modelId: string): SubagentModelProfile | undefined {
	const own = [...catalogs.values()]
		.flatMap(scopes => [...scopes.values()].flatMap(catalog => catalog.profiles))
		.find(profile => profile.id === modelId);
	return own?.availability === "unavailable" && !subagentStandIn(modelId) ? own : undefined;
}

/**
 * The model an open subagent moves to when the subscription of its own model is used up or
 * gone: the available model listed under the same label, that is the same Codex model of
 * another account. Undefined while the own model is available or nothing can stand in.
 */
export function subagentStandIn(modelId: string): string | undefined {
	const own = [...catalogs.values()]
		.flatMap(scopes => [...scopes.values()].flatMap(catalog => catalog.profiles))
		.find(profile => profile.id === modelId);
	const slug = bareModelId(modelId);
	if (own) {
		return own.availability === "unavailable"
			? availableSubagentModelProfiles().find(profile => profile.id !== modelId && (own.provider === "claude"
				? profile.provider === "claude" && bareModelId(profile.id) === slug
				: profile.label === own.label))?.id
			: undefined;
	}
	// The account dropped its catalog: find the same model on another account.
	if (modelId.startsWith("claude::")) {
		return availableSubagentModelProfiles().find(profile => profile.provider === "claude" && bareModelId(profile.id) === slug)?.id;
	}
	return modelId.startsWith("codex::") && codexSubagentRole(slug)
		? availableSubagentModelProfiles().find(profile => profile.provider === "codex" && bareModelId(profile.id) === slug)?.id
		: undefined;
}



