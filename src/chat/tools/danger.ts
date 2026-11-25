import * as vscode from "vscode";

export const DANGEROUS_COMMANDS_SETTING = "chat.dangerousCommands";

/**
 * Case-insensitive regular expressions. A terminal command that matches one is held until the user allows it.
 * `[^\n;&|]*` keeps a rule inside one command of a chain. package.json repeats this list as the setting default.
 */
export const DEFAULT_DANGEROUS_COMMANDS: readonly string[] = [
	"\\bgit\\b[^\\n;&|]*\\bpush\\b[^\\n;&|]*\\s(?:--force(?:-with-lease|-if-includes)?|--mirror|--delete|--prune|-[a-z]*[fd])\\b",
	"\\bgit\\b[^\\n;&|]*\\bpush\\b[^\\n;&|]*\\s[+:][^\\s]",
	"\\bgit\\b[^\\n;&|]*\\breset\\b[^\\n;&|]*\\s--(?:hard|merge|keep)\\b",
	"\\bgit\\b[^\\n;&|]*\\bclean\\b[^\\n;&|]*\\s-[a-z]*f",
	"\\bgit\\b[^\\n;&|]*\\bcheckout\\b[^\\n;&|]*(?:\\s--(?=\\s|$)|\\s\\.(?=\\s|$)|\\s-f\\b|\\s--force\\b)",
	"\\bgit\\b[^\\n;&|]*\\brestore\\b",
	"\\bgit\\b[^\\n;&|]*\\bbranch\\b[^\\n;&|]*\\s(?:-[a-z]*d|--delete)\\b",
	"\\bgit\\b[^\\n;&|]*\\btag\\b[^\\n;&|]*\\s(?:-d|--delete)\\b",
	"\\bgit\\b[^\\n;&|]*\\bstash\\s+(?:drop|clear)\\b",
	"\\bgit\\b[^\\n;&|]*\\b(?:filter-branch|filter-repo|update-ref\\s+-d|reflog\\s+expire)\\b",
	"\\brm\\b[^\\n;&|]*\\s(?:-[a-z]*r|--recursive\\b)",
	"\\b(?:Remove-Item|ri|rmdir|rd|del|erase)\\b[^\\n;&|]*\\s-r[a-z]*\\b",
	"\\b(?:rmdir|rd|del|erase)\\b[^\\n&|]*\\s/s\\b",
	"\\b(?:format(?:\\.com)?\\s+[a-z]:|(?:mkfs(?:\\.\\w+)?|diskpart|Format-Volume|Clear-Disk|Initialize-Disk|Remove-Partition)\\b)",
	"\\bdd\\b[^\\n;&|]*\\bof=",
	"\\b(?:shutdown|reboot|poweroff|halt|Stop-Computer|Restart-Computer)\\b",
	"\\b(?:chmod|chown)\\b[^\\n;&|]*\\s-[a-z]*R",
	"\\b(?:curl|wget|iwr|irm|Invoke-WebRequest|Invoke-RestMethod)\\b[^\\n]*\\|\\s*(?:sh|bash|zsh|iex|Invoke-Expression|pwsh|powershell)\\b",
	"\\b(?:reg\\s+delete|Remove-ItemProperty)\\b",
	"\\b(?:npm|pnpm|yarn)\\s+(?:publish|unpublish|deprecate)\\b",
	"\\b(?:vsce|ovsx)\\s+(?:publish|unpublish)\\b",
	"\\bgh\\s+(?:release\\s+(?:create|delete|upload|edit)|repo\\s+(?:delete|archive|rename)|pr\\s+merge)\\b",
	"\\bdocker\\s+(?:(?:system|volume|image|container|network)\\s+prune|(?:rm|rmi)\\b[^\\n;&|]*\\s-[a-z]*f)\\b",
	"\\b(?:kubectl\\s+delete|terraform\\s+(?:apply|destroy))\\b",
	"\\b(?:drop\\s+(?:table|database|schema)|truncate\\s+table)\\b",
	"\\b(?:taskkill|Stop-Process|pkill|killall)\\b[^\\n;&|]*\\bcode(?:\\.exe)?\\b",
];

/**
 * Names of the default rules, in the same order. The id is what an "Always allow" choice stores, so it
 * must not change; the label tells the user which commands that choice covers.
 */
export const DEFAULT_DANGEROUS_COMMAND_NAMES: ReadonlyArray<{ id: string; label: string }> = [
	{ id: "git-push-force", label: "git push --force, --delete, --mirror or --prune" },
	{ id: "git-push-refspec", label: "git push of a forced (+) or deleting (:) refspec" },
	{ id: "git-reset-hard", label: "git reset --hard, --merge or --keep" },
	{ id: "git-clean", label: "git clean -f" },
	{ id: "git-checkout-discard", label: "git checkout that discards changes (--, ., -f)" },
	{ id: "git-restore", label: "git restore" },
	{ id: "git-branch-delete", label: "git branch --delete" },
	{ id: "git-tag-delete", label: "git tag --delete" },
	{ id: "git-stash-drop", label: "git stash drop or clear" },
	{ id: "git-history-rewrite", label: "Rewriting git history (filter-branch, filter-repo, update-ref -d, reflog expire)" },
	{ id: "rm-recursive", label: "rm -r (recursive delete)" },
	{ id: "remove-item-recursive", label: "Remove-Item -Recurse, rmdir -r, del -r" },
	{ id: "rmdir-s", label: "rmdir /s, del /s" },
	{ id: "disk-format", label: "Formatting or partitioning disks" },
	{ id: "dd-write", label: "dd writing with of=" },
	{ id: "shutdown", label: "Shutting down or restarting the computer" },
	{ id: "chmod-recursive", label: "chmod -R, chown -R" },
	{ id: "download-to-shell", label: "Piping a download into a shell" },
	{ id: "registry-delete", label: "Deleting registry keys or values" },
	{ id: "npm-publish", label: "npm, pnpm or yarn publish, unpublish, deprecate" },
	{ id: "extension-publish", label: "vsce or ovsx publish, unpublish" },
	{ id: "gh-release-repo", label: "gh release create/delete/upload/edit, gh repo delete/archive/rename, gh pr merge" },
	{ id: "docker-prune", label: "docker prune, docker rm -f, docker rmi -f" },
	{ id: "kubectl-terraform", label: "kubectl delete, terraform apply or destroy" },
	{ id: "sql-drop", label: "SQL DROP TABLE/DATABASE/SCHEMA, TRUNCATE TABLE" },
	{ id: "kill-vscode", label: "Killing VS Code processes" },
];

const DEFAULT_NAME_BY_SOURCE = new Map(DEFAULT_DANGEROUS_COMMANDS.map((source, index) => [source, DEFAULT_DANGEROUS_COMMAND_NAMES[index]]));

export interface DangerousCommandRule {
	source: string;
	pattern: RegExp;
	/** Stable id: the default rule's name, or the pattern itself for a rule the user added. */
	id: string;
	/** Which commands an "Always allow" choice for this rule covers. */
	label: string;
}

export interface DangerousCommandMatch {
	rule: string;
	/** The part of the command that matched, for the confirmation card. */
	text: string;
	id: string;
	label: string;
}

/** Invalid entries are skipped and reported, so one typo does not disable the whole list. */
export function compileDangerousCommandRules(patterns: readonly unknown[], onInvalid?: (pattern: string, error: string) => void): DangerousCommandRule[] {
	const rules: DangerousCommandRule[] = [];
	for (const entry of patterns) {
		if (typeof entry !== "string" || !entry.trim()) {
			continue;
		}
		try {
			const name = DEFAULT_NAME_BY_SOURCE.get(entry);
			rules.push({ source: entry, pattern: new RegExp(entry, "i"), id: name?.id ?? entry, label: name?.label ?? `Commands matching ${entry}` });
		} catch (error) {
			onInvalid?.(entry, error instanceof Error ? error.message : String(error));
		}
	}
	return rules;
}

export function findDangerousCommand(command: string, rules: readonly DangerousCommandRule[]): DangerousCommandMatch | undefined {
	return findDangerousCommands(command, rules)[0];
}

/**
 * Every rule the command matches, in rule order. A chain such as `git restore x; rm -rf y` matches two
 * rules, and allowing one of them for good must not let the other through.
 */
export function findDangerousCommands(command: string, rules: readonly DangerousCommandRule[]): DangerousCommandMatch[] {
	const matches: DangerousCommandMatch[] = [];
	for (const rule of rules) {
		const match = rule.pattern.exec(command);
		if (match && !matches.some(entry => entry.id === rule.id)) {
			matches.push({ rule: rule.source, text: match[0].trim().slice(0, 200), id: rule.id, label: rule.label });
		}
	}
	return matches;
}

/** Reads `llamacpp.chat.dangerousCommands`; a missing or non-array value falls back to the defaults. */
export function configuredDangerousCommandRules(onInvalid?: (pattern: string, error: string) => void): DangerousCommandRule[] {
	const configured = vscode.workspace.getConfiguration("llamacpp").get<unknown>(DANGEROUS_COMMANDS_SETTING);
	return compileDangerousCommandRules(Array.isArray(configured) ? configured : DEFAULT_DANGEROUS_COMMANDS, onInvalid);
}
