/** Short, redacted Coco discovery failure text and its coarse cause. */

export type CocoDiscoveryFailureKind = "timeout" | "cancelled" | "cli_missing" | "auth" | "other";

const MAX_DIAGNOSTIC_CHARS = 300;
const REDACTED = "[redacted]";
const AUTH_PATTERN = /oauth|authenticat|sign[\s-]?in|log[\s-]?in|expired|\b401\b|\b403\b/i;
const CLI_MISSING_PATTERN = /cannot start coco cli|enoent|no such file or directory|executable file not found|eacces/i;

/** Keeps at most 300 characters and replaces credential-looking runs. */
export function redactCocoDiagnostic(value: unknown): string {
	const text = (typeof value === "string" ? value : value instanceof Error ? value.message : String(value ?? ""))
		.replace(/\bBearer\s+[^\s,;]+/gi, `Bearer ${REDACTED}`)
		.replace(/\btoken\s*=\s*[^\s,;&]+/gi, `token=${REDACTED}`)
		.replace(/\beyJ[\w-]{10,}\.[\w-]+\.[\w-]+/g, REDACTED)
		.replace(/\b[A-Za-z0-9+/_-]{24,}={0,2}\b/g, REDACTED)
		.replace(/\s+/g, " ")
		.trim();
	return text.length <= MAX_DIAGNOSTIC_CHARS ? text : `${text.slice(0, MAX_DIAGNOSTIC_CHARS - 1)}…`;
}

export function classifyCocoDiscoveryError(error: unknown, stderr = ""): CocoDiscoveryFailureKind {
	const message = error instanceof Error ? error.message : String(error ?? "");
	if (/timed out|timeout/i.test(message)) { return "timeout"; }
	if (/cancelled|canceled/i.test(message)) { return "cancelled"; }
	const text = `${message}\n${stderr}`;
	if (CLI_MISSING_PATTERN.test(text)) { return "cli_missing"; }
	if (AUTH_PATTERN.test(text)) { return "auth"; }
	return "other";
}

export function cocoDiscoveryFailureSummary(kind: CocoDiscoveryFailureKind, timeoutSeconds?: number): string {
	const retry = "SubHarness: Show Coco Connection Status";
	switch (kind) {
		case "timeout": return `Connection check timed out${timeoutSeconds === undefined ? "" : ` after ${timeoutSeconds}s`} — run ${retry} to retry`;
		case "cancelled": return `Connection check cancelled — run ${retry} to retry`;
		case "auth": return `Snowflake sign-in required — run ${retry} to retry`;
		case "cli_missing": return `Coco CLI not found — install Snowflake or set llamacpp.cocoCliPath, then run ${retry}`;
		default: return `Connection failed — run ${retry} to retry`;
	}
}
