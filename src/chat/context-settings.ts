import * as vscode from "vscode";
import { CODEX_WORKING_CONTEXT_MIN } from "../codex/codex-provider";
import { CONFIG_SECTION } from "../constants";
import {
	getFollowedCodexContext,
	onDidChangeFollowedCodexContext,
	resolveManualSharedContextLimit,
	resolveProviderSwitchContextTokens,
	SHARED_CONTEXT_MAX,
	SHARED_CONTEXT_MIN,
} from "../context/provider-handoff";
import type { ChatContextSettingsSource } from "./chat-controller";

const WATCHED = ["sharedContextLength", "sharedContextFollowCodex", "codexWorkingContextTarget", "providerSwitchContextTokens"];

function clamp(value: number, minimum: number, maximum: number): number {
	return Math.floor(Math.min(maximum, Math.max(minimum, value)));
}

/**
 * The settings the Provider Context panel edits, for the chat's context popup; a change in either place shows in the other.
 * The configuration listener of the extension passes the new limits to the providers.
 */
export function createChatContextSettingsSource(): ChatContextSettingsSource & vscode.Disposable {
	const changes = new vscode.EventEmitter<void>();
	const subscriptions = [
		vscode.workspace.onDidChangeConfiguration(event => {
			if (WATCHED.some(key => event.affectsConfiguration(`${CONFIG_SECTION}.${key}`))) {
				changes.fire();
			}
		}),
		onDidChangeFollowedCodexContext(() => changes.fire()),
	];
	return {
		get: () => {
			const config = vscode.workspace.getConfiguration(CONFIG_SECTION);
			const followed = getFollowedCodexContext();
			return {
				shared: clamp(resolveManualSharedContextLimit(config), CODEX_WORKING_CONTEXT_MIN, SHARED_CONTEXT_MAX),
				sharedMin: CODEX_WORKING_CONTEXT_MIN,
				sharedMax: SHARED_CONTEXT_MAX,
				followCodex: config.get<boolean>("sharedContextFollowCodex", false) === true,
				...(followed ? { codexModel: followed.modelId, codexWindow: followed.window } : {}),
				switchTokens: resolveProviderSwitchContextTokens(config),
				switchMin: SHARED_CONTEXT_MIN,
				switchMax: SHARED_CONTEXT_MAX,
			};
		},
		update: async change => {
			const config = vscode.workspace.getConfiguration(CONFIG_SECTION);
			const global = vscode.ConfigurationTarget.Global;
			await Promise.all([
				...(change.shared === undefined ? [] : [config.update("sharedContextLength", clamp(change.shared, CODEX_WORKING_CONTEXT_MIN, SHARED_CONTEXT_MAX), global)]),
				...(change.followCodex === undefined ? [] : [config.update("sharedContextFollowCodex", change.followCodex, global)]),
				...(change.switchTokens === undefined ? [] : [config.update("providerSwitchContextTokens", clamp(change.switchTokens, SHARED_CONTEXT_MIN, SHARED_CONTEXT_MAX), global)]),
			]);
		},
		onDidChange: changes.event,
		dispose: () => {
			for (const subscription of subscriptions) {
				subscription.dispose();
			}
			changes.dispose();
		},
	};
}
