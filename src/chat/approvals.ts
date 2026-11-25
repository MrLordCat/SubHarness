import * as vscode from "vscode";
import type { ChatApprovalKind } from "./shared/protocol";
import { DEFAULT_DANGEROUS_COMMAND_NAMES } from "./tools/danger";

/** `llamacpp.chat.alwaysAllow`: kinds of actions the chat runs without an approval card. */
export const ALWAYS_ALLOW_SETTING = "chat.alwaysAllow";

/** Creating, editing, renaming in and deleting files outside the open workspace folders. */
export const WRITE_OUTSIDE_WORKSPACE: ChatApprovalKind = {
	key: "write-outside-workspace",
	label: "Create, edit and delete files outside the workspace",
};

/** delete_file with recursive on a folder. */
export const DELETE_FOLDER: ChatApprovalKind = { key: "delete-folder", label: "Delete whole folders" };

const COMMAND_PREFIX = "command:";
const DEFAULT_COMMAND_LABELS = new Map(DEFAULT_DANGEROUS_COMMAND_NAMES.map(name => [name.id, name.label]));

/** The kind of a matched dangerous-command rule: every command that rule holds, whatever its arguments. */
export function commandKind(match: { id: string; label: string }): ChatApprovalKind {
	return { key: `${COMMAND_PREFIX}${match.id}`, label: match.label };
}

/** Name of a stored key; the setting keeps only keys so it stays readable and editable by hand. */
export function approvalKindLabel(key: string): string {
	if (key === WRITE_OUTSIDE_WORKSPACE.key) {
		return WRITE_OUTSIDE_WORKSPACE.label;
	}
	if (key === DELETE_FOLDER.key) {
		return DELETE_FOLDER.label;
	}
	if (key.startsWith(COMMAND_PREFIX)) {
		const rule = key.slice(COMMAND_PREFIX.length);
		return DEFAULT_COMMAND_LABELS.get(rule) ?? `Commands matching ${rule}`;
	}
	return key;
}

/** True when the call may run without asking: it names its kinds and every one of them is allowed. */
export function isAlwaysAllowed(kinds: readonly ChatApprovalKind[] | undefined, allowed: ReadonlySet<string>): boolean {
	return kinds !== undefined && kinds.length > 0 && kinds.every(kind => allowed.has(kind.key));
}

export interface AlwaysAllowStore {
	/** Allowed keys in the order they were added. */
	keys(): string[];
	add(keys: readonly string[]): Promise<void>;
	remove(key: string): Promise<void>;
	onDidChange?: vscode.Event<void>;
}

function normalizeKeys(value: unknown): string[] {
	if (!Array.isArray(value)) {
		return [];
	}
	const keys: string[] = [];
	for (const entry of value) {
		if (typeof entry === "string" && entry.trim() && !keys.includes(entry.trim())) {
			keys.push(entry.trim());
		}
	}
	return keys;
}

/**
 * Reads and writes the user's global value only. A workspace's .vscode/settings.json could otherwise
 * allow itself to write outside the workspace or run commands the user keeps behind a card.
 */
export function createAlwaysAllowStore(): AlwaysAllowStore & vscode.Disposable {
	const changes = new vscode.EventEmitter<void>();
	const config = (): vscode.WorkspaceConfiguration => vscode.workspace.getConfiguration("llamacpp");
	const keys = (): string[] => normalizeKeys(config().inspect<unknown>(ALWAYS_ALLOW_SETTING)?.globalValue);
	const write = (next: readonly string[]): Thenable<void> =>
		config().update(ALWAYS_ALLOW_SETTING, next.length > 0 ? [...next] : undefined, vscode.ConfigurationTarget.Global);
	const listener = vscode.workspace.onDidChangeConfiguration(event => {
		if (event.affectsConfiguration(`llamacpp.${ALWAYS_ALLOW_SETTING}`)) {
			changes.fire();
		}
	});
	// Each change reads the value the previous one wrote, so two quick choices keep both keys.
	let queue: Promise<void> = Promise.resolve();
	const serialize = (change: (current: string[]) => string[] | undefined): Promise<void> => {
		const run = queue.then(async () => {
			const next = change(keys());
			if (next) {
				await write(next);
			}
		});
		queue = run.catch(() => undefined);
		return run;
	};
	return {
		keys,
		add: added => serialize(current => {
			const next = [...current, ...added.filter(key => !current.includes(key))];
			return next.length !== current.length ? next : undefined;
		}),
		remove: key => serialize(current => current.includes(key) ? current.filter(entry => entry !== key) : undefined),
		onDidChange: changes.event,
		dispose: () => {
			listener.dispose();
			changes.dispose();
		},
	};
}
