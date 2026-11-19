import type { ChatModelEntry, ChatModelGroup, ChatThinkingOptions } from "./protocol";

export interface ModelInfoLike { id: string; name: string; maxInputTokens: number; detail?: string; configurationSchema?: unknown }

function record(value: unknown): Record<string, unknown> | undefined {
	return typeof value === "object" && value !== null ? value as Record<string, unknown> : undefined;
}

/** The reasoningEffort property every bridge provider puts into configurationSchema. */
export function thinkingOptions(model: ModelInfoLike): ChatThinkingOptions | undefined {
	const property = record(record(record(model.configurationSchema)?.properties)?.reasoningEffort);
	const values = Array.isArray(property?.enum) ? property.enum.filter((value): value is string => typeof value === "string") : [];
	if (!property || values.length === 0) {
		return undefined;
	}
	const labels = Array.isArray(property.enumItemLabels) ? property.enumItemLabels : [];
	const descriptions = Array.isArray(property.enumDescriptions) ? property.enumDescriptions : [];
	const levels = values.map((value, index) => ({
		value,
		label: typeof labels[index] === "string" ? labels[index] as string : value.charAt(0).toUpperCase() + value.slice(1),
		...(typeof descriptions[index] === "string" ? { description: descriptions[index] as string } : {}),
	}));
	const fallback = typeof property.default === "string" && values.includes(property.default) ? property.default : undefined;
	return { levels, ...(fallback ? { default: fallback } : {}) };
}

const GROUP_ORDER = ["Codex", "Claude", "Coco", "Cursor", "DeepSeek", "Local"];
const PROVIDER_ALIASES: Record<string, string> = {
	codex: "Codex",
	claude: "Claude",
	coco: "Coco",
	deepseek: "DeepSeek",
	local: "Local",
	primary: "Local",
};
const NAME_SUFFIX = /^(.*) \(([^()]+)\)$/;

interface DerivedModel {
	model: ModelInfoLike;
	entryName: string;
}

function identify(model: ModelInfoLike): { provider: string; name: string } {
	const suffixed = NAME_SUFFIX.exec(model.name);
	if (suffixed) {
		return { provider: suffixed[2], name: suffixed[1] };
	}
	const separator = model.id.indexOf("::");
	if (separator > 0) {
		const prefix = model.id.slice(0, separator);
		const alias = PROVIDER_ALIASES[prefix.toLowerCase()];
		return { provider: alias ?? prefix.charAt(0).toUpperCase() + prefix.slice(1), name: model.name };
	}
	return { provider: "Other", name: model.name };
}

function compareProviders(a: string, b: string): number {
	const ai = GROUP_ORDER.indexOf(a);
	const bi = GROUP_ORDER.indexOf(b);
	if (ai !== -1 || bi !== -1) {
		if (ai === -1) {
			return 1;
		}
		if (bi === -1) {
			return -1;
		}
		return ai - bi;
	}
	return a.localeCompare(b);
}

export function groupModels(models: readonly ModelInfoLike[]): ChatModelGroup[] {
	const groups = new Map<string, DerivedModel[]>();
	for (const model of models) {
		const { provider, name } = identify(model);
		const group = groups.get(provider) ?? [];
		group.push({ model, entryName: name });
		groups.set(provider, group);
	}
	return [...groups.keys()].sort(compareProviders).map(provider => {
		const items = groups.get(provider) ?? [];
		const counts = new Map<string, number>();
		for (const item of items) {
			counts.set(item.entryName, (counts.get(item.entryName) ?? 0) + 1);
		}
		const entries = items.map(item => {
			const entry: ChatModelEntry = {
				id: item.model.id,
				name: counts.get(item.entryName) === 1 ? item.entryName : item.model.name,
				maxInputTokens: item.model.maxInputTokens,
			};
			if (item.model.detail !== undefined) {
				entry.detail = item.model.detail;
			}
			const thinking = thinkingOptions(item.model);
			if (thinking) {
				entry.thinking = thinking;
			}
			return entry;
		});
		entries.sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));
		return { provider, models: entries };
	});
}
