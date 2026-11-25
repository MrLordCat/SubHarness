import { readFileSync, statSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

/**
 * Claude Code keeps the login, its state and the sessions of one account under one config
 * directory: ~/.claude with ~/.claude.json by default, CLAUDE_CONFIG_DIR otherwise. A second
 * Claude subscription therefore needs a directory of its own, and every CLI process of that
 * account (chat sessions, usage probes, `claude auth …`) runs with CLAUDE_CONFIG_DIR pointing
 * there. The built-in account keeps the historical model ids (`claude::<model>`), so saved
 * chats and settings keep working; extra accounts use `claude::<account>::<model>`.
 */
export const CLAUDE_DEFAULT_ACCOUNT_ID = "";
export const CLAUDE_ACCOUNT_MODEL_PREFIX = "claude::";
/** Separates the account from the model in the id of a named account's model. */
const ACCOUNT_SEGMENT = "::";
const ACCOUNT_ID_PATTERN = /^[a-z0-9][a-z0-9_-]{0,31}$/;

export interface ClaudeAccountIdentity {
	/** Empty string for the built-in account. */
	id: string;
	label: string;
	/** "Claude" with one account; "Claude 1", "Claude 2" … with several. */
	providerLabel?: string;
	/** Position in the account list: 0 for the built-in account, then the order of `llamacpp.claudeAccounts`. */
	order?: number;
	/** CLAUDE_CONFIG_DIR of this account; undefined for the built-in account, which uses ~/.claude. */
	configDir?: string;
}

export const CLAUDE_DEFAULT_ACCOUNT: ClaudeAccountIdentity = { id: CLAUDE_DEFAULT_ACCOUNT_ID, label: "Default" };

export function normalizeClaudeAccountId(value: unknown): string | undefined {
	if (typeof value !== "string") {
		return undefined;
	}
	const normalized = value.trim().toLowerCase();
	return ACCOUNT_ID_PATTERN.test(normalized) ? normalized : undefined;
}

function expandHome(value: string, homeDir: string): string {
	const trimmed = value.trim();
	if (trimmed === "~") {
		return homeDir;
	}
	if (trimmed.startsWith("~/") || trimmed.startsWith("~\\")) {
		return path.join(homeDir, trimmed.slice(2));
	}
	return path.resolve(trimmed);
}

/** Extra config directories live beside ~/.claude, like the extra Codex homes beside ~/.codex. */
export function defaultClaudeAccountConfigDir(accountId: string, homeDir = os.homedir()): string {
	return path.join(homeDir, `.claude-${accountId}`);
}

/**
 * Normalizes the `llamacpp.claudeAccounts` setting. Invalid and repeated ids are dropped instead
 * of being mapped to the built-in account, and the built-in account is always first.
 */
export function resolveClaudeAccounts(raw: unknown, homeDir = os.homedir()): ClaudeAccountIdentity[] {
	const accounts: ClaudeAccountIdentity[] = [{ ...CLAUDE_DEFAULT_ACCOUNT }];
	const seen = new Set<string>([CLAUDE_DEFAULT_ACCOUNT_ID]);
	for (const entry of Array.isArray(raw) ? raw : []) {
		if (!entry || typeof entry !== "object") {
			continue;
		}
		const record = entry as Record<string, unknown>;
		const id = normalizeClaudeAccountId(record.id);
		if (!id || seen.has(id)) {
			continue;
		}
		seen.add(id);
		const label = typeof record.label === "string" && record.label.trim() ? record.label.trim().slice(0, 40) : id;
		const dirValue = typeof record.configDir === "string" ? record.configDir.trim() : "";
		accounts.push({ id, label, configDir: dirValue ? expandHome(dirValue, homeDir) : defaultClaudeAccountConfigDir(id, homeDir) });
	}
	return accounts.map((account, index) => ({
		...account,
		order: index,
		providerLabel: accounts.length === 1 ? "Claude" : `Claude ${index + 1}`,
	}));
}

export function resolveActiveClaudeAccountId(accounts: readonly ClaudeAccountIdentity[], stored: unknown): string {
	const candidate = normalizeClaudeAccountId(stored);
	return candidate !== undefined && accounts.some(account => account.id === candidate) ? candidate : CLAUDE_DEFAULT_ACCOUNT_ID;
}

/** Reads `llamacpp.claudeActiveAccount`; an unknown value falls back to the built-in account. */
export function resolveActiveClaudeAccountSetting(config: { get(key: string, defaultValue?: unknown): unknown }): string {
	return normalizeClaudeAccountId(config.get("claudeActiveAccount", "")) ?? CLAUDE_DEFAULT_ACCOUNT_ID;
}

/** Takes an id or a `{ accountId }` command argument; empty means the built-in account. */
export function findClaudeAccount(accounts: readonly ClaudeAccountIdentity[], accountId: unknown): ClaudeAccountIdentity | undefined {
	const requested = accountId && typeof accountId === "object" ? (accountId as { accountId?: unknown }).accountId : accountId;
	if (requested === undefined || requested === null || requested === "") {
		return accounts.find(account => account.id === CLAUDE_DEFAULT_ACCOUNT_ID);
	}
	const normalized = normalizeClaudeAccountId(requested);
	return normalized === undefined ? undefined : accounts.find(account => account.id === normalized);
}

/** `claude::` for the built-in account, `claude::<id>::` otherwise. */
export function claudeAccountModelPrefix(accountId: string): string {
	return accountId ? `${CLAUDE_ACCOUNT_MODEL_PREFIX}${accountId}${ACCOUNT_SEGMENT}` : CLAUDE_ACCOUNT_MODEL_PREFIX;
}

export function encodeClaudeAccountModelId(accountId: string, modelId: string): string {
	return `${claudeAccountModelPrefix(accountId)}${modelId}`;
}

/**
 * The Claude model id for this account, or undefined when the id belongs to another account,
 * so `claude::work::claude-opus-5` never resolves as the built-in model `work::claude-opus-5`.
 */
export function decodeClaudeAccountModelId(modelId: string, accountId: string): string | undefined {
	if (!modelId.startsWith(CLAUDE_ACCOUNT_MODEL_PREFIX)) {
		return undefined;
	}
	const rest = modelId.slice(CLAUDE_ACCOUNT_MODEL_PREFIX.length);
	if (accountId) {
		const prefix = `${accountId}${ACCOUNT_SEGMENT}`;
		return rest.startsWith(prefix) && rest.length > prefix.length ? rest.slice(prefix.length) : undefined;
	}
	return rest.length > 0 && !rest.includes(ACCOUNT_SEGMENT) ? rest : undefined;
}

/** Durable state keys must not be shared between accounts; the built-in account keeps the old keys. */
export function claudeAccountStateKey(baseKey: string, accountId: string): string {
	return accountId ? `${baseKey}.account.${accountId}` : baseKey;
}

export function claudeProviderLabel(account: ClaudeAccountIdentity): string {
	return account.providerLabel ?? "Claude";
}

/** Environment for every CLI process of the account; the built-in account adds nothing. */
export function claudeAccountEnv(account: Pick<ClaudeAccountIdentity, "configDir">): Record<string, string> {
	return account.configDir ? { CLAUDE_CONFIG_DIR: account.configDir } : {};
}

/**
 * Whether this account has a Claude login on disk. The bundled claude.exe always exists, so the
 * binary alone must not count as signed in. Evidence: `.credentials.json` in the config
 * directory, or `.claude.json` with an `oauthAccount.accountUuid` (beside ~/.claude for the
 * built-in account, inside CLAUDE_CONFIG_DIR for the others).
 */
export function hasClaudeLogin(account: Pick<ClaudeAccountIdentity, "configDir">, homeDir = os.homedir()): boolean {
	const configDir = account.configDir ?? path.join(homeDir, ".claude");
	try {
		const stat = statSync(path.join(configDir, ".credentials.json"));
		if (stat.isFile() && stat.size > 2) {
			return true;
		}
	} catch {
		// No credentials file.
	}
	try {
		const statePath = account.configDir ? path.join(account.configDir, ".claude.json") : path.join(homeDir, ".claude.json");
		const parsed = JSON.parse(readFileSync(statePath, "utf8")) as { oauthAccount?: unknown };
		const oauthAccount = parsed?.oauthAccount as Record<string, unknown> | undefined;
		return typeof oauthAccount?.accountUuid === "string" && oauthAccount.accountUuid !== "";
	} catch {
		// No Claude Code state file, or it cannot be parsed.
		return false;
	}
}
