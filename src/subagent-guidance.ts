import { PROVIDER_VENDOR } from "./constants";
import { isDeepSeekVisionModel, isLoopbackServerUrl, type ChatModelSource } from "./model-sources/source-routing";
import { isDeepSeekEndpoint } from "./transport/openai-http";

/**
 * VS Code resolves runSubagent.model with `matchesQualifiedName`: only the
 * `copilot` vendor may be named bare, every other model needs "Name (vendor)".
 */
export function subagentModelReference(label: string): string {
	return `${label} (${PROVIDER_VENDOR})`;
}

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

function isSubagentToolName(name: string): boolean {
	const normalized = name.toLowerCase().replace(/[^a-z0-9]/g, "");
	return normalized === "runsubagent"
		|| normalized === "executionsubagent"
		|| normalized === "exploresubagent";
}

interface ToolWithInputSchema {
	name: string;
	inputSchema?: object;
}

const modelLabels = new Set<string>();

function refreshModelLabels(): void {
	const labels = new Set(getSubagentModelProfiles().map(profile => subagentModelReference(profile.label)));
	modelLabels.clear();
	for (const label of labels) {
		modelLabels.add(label);
	}
}

/**
 * Makes subagent model routing explicit at schema level. Description-only guidance
 * is not reliable enough for local and subscription models, which may otherwise
 * omit `model` and silently inherit the expensive parent model. The injected
 * enum of advertised catalog labels makes `model="Auto"` or any unknown value
 * fail schema validation instead of silently falling back to the parent model.
 */
export function withRequiredSubagentModel<T extends ToolWithInputSchema>(definition: T): T {
	if (!isSubagentToolName(definition.name)) {
		return definition;
	}
	refreshModelLabels();
	const sourceSchema = definition.inputSchema && typeof definition.inputSchema === "object"
		? definition.inputSchema as Record<string, unknown>
		: {};
	const sourceProperties = sourceSchema.properties && typeof sourceSchema.properties === "object"
		? sourceSchema.properties as Record<string, unknown>
		: {};
	const sourceModel = sourceProperties.model && typeof sourceProperties.model === "object"
		? sourceProperties.model as Record<string, unknown>
		: {};
	const hasExplicitEnum = Array.isArray(sourceModel.enum) && sourceModel.enum.length > 0;
	const modelSchema = hasExplicitEnum
		? sourceModel
		: {
			type: "string",
			description: "Exact model-picker label from the advertised subagent catalog. "
				+ "\"Auto\" and unknown labels are rejected; pick one of the quoted model= values in the tool description.",
			...(modelLabels.size > 0 ? { enum: [...modelLabels].sort() } : {}),
		};
	const required = Array.isArray(sourceSchema.required)
		? sourceSchema.required.filter((value): value is string => typeof value === "string")
		: [];

	return {
		...definition,
		inputSchema: {
			...sourceSchema,
			type: "object",
			properties: { ...sourceProperties, model: modelSchema },
			required: [...new Set([...required, "model"])],
		},
	} as T;
}

function buildBudgetRoutingPolicy(profiles: readonly SubagentModelProfile[]): string {
	const has = (provider: SubagentProvider): boolean => profiles.some(profile => profile.provider === provider);
	const tiers: string[] = [];
	if (has("local")) {
		tiers.push("cheapest — local models (e.g. Qwen 3.6 27B) for narrow, mechanical, independently verifiable subtasks (workspace search, single-file reads, grep triage, format/lint checks, visual inspection, and verifying another model's output). Local models have no token or rate limits — prefer them for any task they can handle reliably");
	}
	if (has("deepseek")) {
		// DeepSeek's /models endpoint exposes no capability metadata, so vision is
		// derived from the model id: the Flash family accepts images, V4 Pro not.
		const deepSeekVisionCapable = profiles.some(profile => {
			if (profile.provider !== "deepseek") {
				return false;
			}
			const modelId = profile.id.toLowerCase().split("::").at(-1) ?? profile.id.toLowerCase();
			return isDeepSeekVisionModel(modelId);
		});
		const visionNote = deepSeekVisionCapable
			? "DeepSeek Flash accepts image input, but DeepSeek V4 Pro does not, so route vision subtasks to a Flash or another vision-capable model"
			: "DeepSeek cannot process image input: when the subtask needs vision, skip DeepSeek and use a local vision-capable model or Codex";
		tiers.push(`mid — DeepSeek (e.g. DeepSeek V4 Pro) for focused multi-step reasoning a local model cannot complete reliably, code analysis across files, and architecture decisions. ${visionNote}`);
	}
	if (has("codex")) {
		tiers.push("subscription — Codex Luna (fast and affordable) for small, well-defined steps: an edit in one or two files, a code search, a routine check, a test run; Codex Terra for larger multi-step steps: a change across several files with its tests, a refactoring, a feature step. Both take the same kind of steps as DeepSeek Flash and use the ChatGPT subscription quota; Sol is excluded from subagent use to conserve that quota");
	}
	if (has("claude")) {
		tiers.push("premium — Claude Opus 5 (highest capability): only for cross-file or high-stakes reasoning the cheaper tiers cannot satisfy");
	}
	if (has("api")) {
		// Paid API profiles (Cursor and other gateways) bill every request, so
		// they must never look like another cheap default tier.
		tiers.push("paid API — models from API profiles (for example Cursor) are billed per use: route there only when the user names the model or no tier above can run the task");
	}
	if (tiers.length <= 1) {
		return "";
	}
	const preferredOrder = [
		"local (cheapest, unlimited)",
		"DeepSeek (non-vision reasoning)",
		"Codex Luna (small steps)",
		"Codex Terra (larger steps)",
		"Claude Opus 5 (last resort)",
		...(has("api") ? ["paid API profiles (only on request)"] : []),
	].join(" → ");
	return `Budget routing policy — pick the cheapest capable tier and escalate only when it is genuinely insufficient: ${tiers.join("; ")}. Preferred subagent order: ${preferredOrder}.`;
}

let _cachedGuidance: string | undefined;
let _cachedProfileIds: string | undefined;

export function buildSubagentToolGuidance(): string {
	const profiles = getSubagentModelProfiles();
	const profileIds = profiles.map(p => `${p.id}=${p.label}`).join(",");
	if (_cachedGuidance !== undefined && _cachedProfileIds === profileIds) {
		return _cachedGuidance;
	}
	_cachedProfileIds = profileIds;
	const hasLocal = profiles.some(profile => profile.provider === "local");
	const profileText = profiles.length > 0
		? profiles.map(profile => {
			const effort = profile.defaultEffort ? `, ${profile.defaultEffort} thinking` : "";
			return `model="${subagentModelReference(profile.label)}"${effort}: ${profile.useWhen}.`;
		}).join(" ")
		: `model="${subagentModelReference("Qwen 3.6 27B (Local)")}": narrow economical tasks, visual inspection, unlimited tokens. model="${subagentModelReference("DeepSeek V4 Pro (DeepSeek)")}", high thinking: focused complex multi-step reasoning. model="${subagentModelReference("GPT-6-Luna (Codex)")}", high thinking: small, well-defined steps. model="${subagentModelReference("GPT-6.1 Terra (Codex)")}", high thinking: larger multi-step steps (Sol excluded from subagents to conserve premium quota). model="${subagentModelReference("Opus 5 (Claude)")}", high thinking: highest-capability complex analysis.`;
	const example = subagentModelReference(profiles[0]?.label ?? "GPT-6-Luna (Codex)");
	const budgetPolicy = buildBudgetRoutingPolicy(profiles);
	const visionDelegation = hasLocal
		? "Vision delegation: when you need visual inspection (screenshots, UI layouts, images, Unity scene captures) that you cannot see directly, delegate to a local-model subagent. The subagent has access to view_image and terminal tools — it can capture screenshots, inspect images, and report what it sees. Use agentName 'Explore' or any available agent type with a local model — the agent type does not limit which tools the subagent can use."
		: "";
	const guidance = [
		"Subagent model routing (use model= value exactly as shown):",
		profileText,
		...(budgetPolicy ? [budgetPolicy] : []),
		...(visionDelegation ? [visionDelegation] : []),
		`Mandatory: set runSubagent.model to one of the quoted model= strings listed above, e.g. \`"${example}"\`, including the trailing "(${PROVIDER_VENDOR})". Copy the exact string inside the quotes — do NOT guess or paraphrase. Never omit runSubagent.model and never pass "Auto": the schema only accepts the advertised labels, so "Auto" is rejected.`,
		"Availability is enforced when the subagent starts; if the selected model is rejected, route to another available model from this catalog.",
		...(hasLocal ? ["The local model runs with unlimited tokens and no rate limits — prefer it for any subagent task it can handle, especially large-output operations like log analysis, full-file reads, and exhaustive search."] : []),
		"agentName selects behaviour/custom instructions independently of model.",
		"Require one bounded, independently verifiable task, explicit allowed files, and expected output.",
	].join(" ");
	_cachedGuidance = guidance;
	return guidance;
}

export function enhanceSubagentToolDescription(name: string, description: string): string {
	if (!isSubagentToolName(name)) {
		return description;
	}
	return `${description}\n\n${buildSubagentToolGuidance()}`;
}
