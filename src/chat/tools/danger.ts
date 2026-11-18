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

export interface DangerousCommandRule {
	source: string;
	pattern: RegExp;
}

export interface DangerousCommandMatch {
	rule: string;
	/** The part of the command that matched, for the confirmation card. */
	text: string;
}

/** Invalid entries are skipped and reported, so one typo does not disable the whole list. */
export function compileDangerousCommandRules(patterns: readonly unknown[], onInvalid?: (pattern: string, error: string) => void): DangerousCommandRule[] {
	const rules: DangerousCommandRule[] = [];
	for (const entry of patterns) {
		if (typeof entry !== "string" || !entry.trim()) {
			continue;
		}
		try {
			rules.push({ source: entry, pattern: new RegExp(entry, "i") });
		} catch (error) {
			onInvalid?.(entry, error instanceof Error ? error.message : String(error));
		}
	}
	return rules;
}

export function findDangerousCommand(command: string, rules: readonly DangerousCommandRule[]): DangerousCommandMatch | undefined {
	for (const rule of rules) {
		const match = rule.pattern.exec(command);
		if (match) {
			return { rule: rule.source, text: match[0].trim().slice(0, 200) };
		}
	}
	return undefined;
}

/** Reads `llamacpp.chat.dangerousCommands`; a missing or non-array value falls back to the defaults. */
export function configuredDangerousCommandRules(onInvalid?: (pattern: string, error: string) => void): DangerousCommandRule[] {
	const configured = vscode.workspace.getConfiguration("llamacpp").get<unknown>(DANGEROUS_COMMANDS_SETTING);
	return compileDangerousCommandRules(Array.isArray(configured) ? configured : DEFAULT_DANGEROUS_COMMANDS, onInvalid);
}
