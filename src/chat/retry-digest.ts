import type { ChatMessage } from "./shared/protocol";
import { latestTodoList } from "./shared/todo";

/** Most tool calls the Retry digest lists; it keeps the latest ones. */
const DIGEST_MAX_CALLS = 40;
const DIGEST_MAX_FILES = 30;
const DIGEST_RESULT_MAX_CHARS = 120;
const DIGEST_TEXT_TAIL_CHARS = 600;
const DIGEST_MAX_CHARS = 6_000;
const DIGEST_ARGUMENT_MAX_CHARS = 200;
const DIGEST_FILES_MAX_CHARS = 1_500;
const DIGEST_PLAN_MAX_CHARS = 1_500;

function digestString(value: unknown): string | undefined {
	if (typeof value !== "string") {
		return undefined;
	}
	const flat = value.replace(/\s+/g, " ").trim();
	return flat ? flat.slice(0, DIGEST_ARGUMENT_MAX_CHARS) : undefined;
}

/** Files a successful edit call wrote, with "new" or "deleted" where the call says so. */
function editedFiles(name: string, input: unknown): Array<{ path: string; status?: "new" | "deleted" }> {
	if (!input || typeof input !== "object" || Array.isArray(input)) {
		return [];
	}
	const fields = input as Record<string, unknown>;
	const path = digestString(fields.filePath) ?? digestString(fields.path);
	switch (name) {
		case "create_file":
			return path ? [{ path, status: "new" }] : [];
		case "delete_file":
			return path ? [{ path, status: "deleted" }] : [];
		case "replace_string_in_file":
		case "edit_notebook_file":
		case "write_file":
			return path ? [{ path }] : [];
		case "multi_replace_string_in_file": {
			const replacements = Array.isArray(fields.replacements) ? fields.replacements as unknown[] : [];
			const paths = replacements.map(item => item && typeof item === "object" ? digestString((item as Record<string, unknown>).filePath) : undefined);
			return [...new Set(paths.filter((candidate): candidate is string => candidate !== undefined))].map(candidate => ({ path: candidate }));
		}
		case "apply_patch": {
			const patch = [fields.input, fields.patch].find(candidate => typeof candidate === "string");
			const headers = typeof patch === "string" ? [...patch.matchAll(/^\*\*\* (Add|Update|Delete) File: (.+)$/gm)] : [];
			return headers.map(header => ({ path: header[2].trim(), ...(header[1] === "Add" ? { status: "new" as const } : header[1] === "Delete" ? { status: "deleted" as const } : {}) }));
		}
		default:
			return [];
	}
}

/** The argument that names what a tool call worked on: a path, a query, a command; else its first short string. */
function keyArgument(name: string, input: unknown): string {
	if (!input || typeof input !== "object" || Array.isArray(input)) {
		return "";
	}
	const fields = input as Record<string, unknown>;
	if (name === "multi_replace_string_in_file" || name === "apply_patch") {
		return editedFiles(name, input).map(file => file.path).join(", ").slice(0, DIGEST_ARGUMENT_MAX_CHARS);
	}
	if (name === "run_in_terminal") {
		const command = digestString(fields.command);
		return command ? `\`${command}\`` : "";
	}
	const keys = name.includes("subagent") ? ["description"] : ["filePath", "path", "query", "command", "url", "pattern", "terminalId"];
	const value = keys.map(key => digestString(fields[key])).find(candidate => candidate !== undefined)
		?? Object.values(fields).find((candidate): candidate is string => typeof candidate === "string" && candidate.trim() !== "" && candidate.length <= DIGEST_ARGUMENT_MAX_CHARS);
	if (value === undefined) {
		return "";
	}
	const lines = typeof fields.startLine === "number" && typeof fields.endLine === "number" ? ` (lines ${fields.startLine}-${fields.endLine})` : "";
	return `${digestString(value) ?? ""}${lines}`;
}

/**
 * What a failed or interrupted answer did, from its parts in the chat log. Retry puts it into the continuation
 * request, because a provider may resume its native session before that answer (Claude resumes at its last
 * completed turn) and then the model would not know which steps already ran.
 */
export function interruptedAnswerDigest(message: ChatMessage): string | undefined {
	const results = new Map<string, { text: string; isError?: boolean }>();
	for (const part of message.parts) {
		if (part.kind === "toolResult") {
			results.set(part.callId, part);
		}
	}
	const entries: string[] = [];
	const files = new Map<string, "new" | "deleted" | undefined>();
	for (const part of message.parts) {
		if (part.kind === "subagent") {
			entries.push(`subagent "${digestString(part.description) ?? ""}" → ${part.status}`);
			continue;
		}
		if (part.kind !== "toolCall") {
			continue;
		}
		const result = results.get(part.callId);
		const firstLine = result?.text.split(/\r?\n/).find(line => line.trim() !== "")?.trim().slice(0, DIGEST_RESULT_MAX_CHARS) ?? "";
		const outcome = !result ? "(no result: interrupted)" : result.isError ? `error: ${firstLine}` : firstLine || "ok";
		const argument = keyArgument(part.name, part.input);
		entries.push(`${part.name}${argument ? ` ${argument}` : ""} → ${outcome}`);
		if (result && !result.isError) {
			for (const file of editedFiles(part.name, part.input)) {
				files.set(file.path, files.get(file.path) ?? file.status);
			}
		}
	}
	const lastText = message.parts.findLast(part => part.kind === "text" && part.text.trim() !== "");
	if (!entries.length && lastText?.kind !== "text") {
		return undefined;
	}
	const tail: string[] = [];
	if (files.size) {
		const listed = [...files].slice(0, DIGEST_MAX_FILES).map(([path, status]) => status ? `${path} (${status})` : path);
		const more = files.size > DIGEST_MAX_FILES ? ` and ${files.size - DIGEST_MAX_FILES} more` : "";
		tail.push(`Files changed: ${listed.join(", ")}${more}`.slice(0, DIGEST_FILES_MAX_CHARS));
	}
	const plan = latestTodoList([message]);
	if (plan?.length) {
		const marks = { "completed": "x", "in-progress": "~", "not-started": " " } as const;
		tail.push(`Plan: ${plan.map(item => `[${marks[item.status]}] ${item.title}`).join("; ")}`.slice(0, DIGEST_PLAN_MAX_CHARS));
	}
	if (lastText?.kind === "text") {
		tail.push(`Last text: ${lastText.text.trimEnd().slice(-DIGEST_TEXT_TAIL_CHARS)}`);
	}
	const render = (kept: number): string => {
		const omitted = entries.length - kept;
		const tools = entries.length
			? ["Tools:", ...(omitted ? [`${omitted} earlier calls omitted`] : []), ...entries.slice(omitted).map((entry, index) => `${omitted + index + 1}. ${entry}`)]
			: [];
		return ["What the interrupted answer already did (from the chat log):", ...tools, ...tail].join("\n");
	};
	// The oldest calls go first when the digest is too long; the plan and the last text matter more.
	let kept = Math.min(entries.length, DIGEST_MAX_CALLS);
	let digest = render(kept);
	while (digest.length > DIGEST_MAX_CHARS && kept > 1) {
		kept -= 1;
		digest = render(kept);
	}
	return digest.slice(0, DIGEST_MAX_CHARS);
}
