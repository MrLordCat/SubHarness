import {
	WEBVIEW_TOOL_RESULT_PREVIEW_CHARS,
	type ChatChangedFile,
	type ChatChangeSet,
	type ChatMessage,
	type ChatModelGroup,
	type ChatPart,
	type ChatSessionMeta,
	type ChatSubagentRun,
	type ChatSubagentStep,
	type ChatToolGroup,
	type HostMessage,
	type WebviewMessage,
} from "../shared/protocol";

interface HarnessVsCodeApi {
	postMessage(message: WebviewMessage): void;
	getState(): unknown;
	setState(state: unknown): void;
}

interface HarnessStats {
	readonly messageCount: number;
	readonly lastStreamMs: number;
}

declare global {
	interface Window {
		acquireVsCodeApi?: () => HarnessVsCodeApi;
		__harness?: HarnessStats;
	}
}

const MODEL_GROUPS: ChatModelGroup[] = [
	{
		provider: "Codex",
		models: [
			{ id: "gpt-5.5-codex", name: "GPT-5.5", maxInputTokens: 400_000 },
			{ id: "gpt-5.5-mini-codex", name: "GPT-5.5 mini", maxInputTokens: 200_000 },
			{ id: "gpt-5-codex", name: "GPT-5", maxInputTokens: 400_000 },
			{ id: "gpt-5.1-codex-max", name: "GPT-5.1 Codex Max", maxInputTokens: 1_000_000 },
		],
	},
	{
		provider: "Copilot",
		models: [
			{ id: "gpt-5.5-copilot", name: "GPT-5.5", maxInputTokens: 128_000 },
			{ id: "claude-sonnet-4.6-copilot", name: "Claude Sonnet 4.6", maxInputTokens: 200_000 },
			{ id: "gemini-3-pro-copilot", name: "Gemini 3 Pro", maxInputTokens: 1_000_000 },
		],
	},
	{
		provider: "Claude",
		models: [
			{ id: "claude-opus-4.6", name: "Opus 4.6", maxInputTokens: 1_000_000 },
			{ id: "claude-sonnet-4.6", name: "Sonnet 4.6", maxInputTokens: 1_000_000 },
			{ id: "claude-haiku-4.5", name: "Haiku 4.5", maxInputTokens: 200_000 },
		],
	},
	{
		provider: "DeepSeek",
		models: [
			{ id: "deepseek-flash", name: "DeepSeek Flash", maxInputTokens: 128_000 },
			{ id: "deepseek-pro", name: "DeepSeek Pro", maxInputTokens: 128_000 },
			{ id: "deepseek-coder", name: "DeepSeek Coder", maxInputTokens: 64_000 },
		],
	},
];

const TOOL_GROUPS: ChatToolGroup[] = [
	{
		id: "files",
		label: "Files",
		tools: [
			{ name: "read_file", description: "Read a file from the workspace.", enabled: true },
			{ name: "grep_search", description: "Search file contents with a regular expression.", enabled: true },
			{ name: "file_search", description: "Find files by glob pattern.", enabled: true },
			{ name: "list_dir", description: "List the entries of a directory.", enabled: true },
		],
	},
	{
		id: "terminal",
		label: "Terminal",
		tools: [
			{ name: "run_in_terminal", description: "Run a shell command in a terminal.", enabled: true },
			{ name: "get_terminal_output", description: "Read the output of a command already running.", enabled: true },
			{ name: "kill_terminal", description: "Stop a command running in a terminal.", enabled: true },
			{ name: "terminal_last_command", description: "Show the last command run in the active terminal.", enabled: false },
		],
	},
	{
		id: "copilot",
		label: "Copilot",
		note: "VS Code may ask for confirmation before these tools run.",
		tools: [
			{ name: "copilot_apply_patch", description: "Apply a patch to workspace files.", enabled: false },
			{ name: "copilot_insert_edit", description: "Insert code at a location in a file.", enabled: false },
			{ name: "copilot_replace_string", description: "Replace an exact string in a file.", enabled: false },
			{ name: "copilot_run_task", description: "Run a VS Code task.", enabled: false },
			{ name: "copilot_get_errors", description: "Collect compile and lint errors.", enabled: false },
			{ name: "copilot_list_code_usages", description: "Find usages of a symbol across the workspace.", enabled: false },
		],
	},
];

const requestedCount = Number.parseInt(new URLSearchParams(window.location.search).get("count") ?? "", 10);
const initialCount = Number.isFinite(requestedCount) && requestedCount >= 0 ? requestedCount : 5000;

const FINISHED_SUBAGENT_CALL_ID = "call-subagent-finished";
const LIVE_SUBAGENT_CALL_ID = "call-subagent-live";
const LIVE_SUBAGENT_STARTED_AT = Date.now() - 12_000;
const LIVE_SUBAGENT_STEPS: ChatSubagentStep[] = [
	{ kind: "text", text: "Reading the store and the message list." },
	{ kind: "tool", name: "read_file", summary: "{\"path\":\"src/chat/webview/store.ts\"}" },
	{ kind: "tool", name: "grep_search", summary: "{\"query\":\"subagent\"}" },
	{ kind: "tool", name: "get_errors", summary: "{\"filePaths\":[\"src/chat/webview/message.tsx\"]}" },
];
let liveSubagentMessageId: string | undefined;
let liveSubagentStarted = false;
let liveSubagentTimer: number | undefined;

const messages = createMessages(initialCount);
const SESSION_ID = "harness-session";
const SESSION_CREATED_AT = Date.now() - messages.length * 1000;
let sessionTitle = `Harness session — ${messages.length} messages`;
let selectedModelId = "gpt-5.5-codex";
let nextId = 0;
let turn = Math.ceil(messages.length / 2);
let streamTimer: number | undefined;
let streamStarted = 0;
let lastStreamMs = 0;
let approvalSeq = 0;
let pendingApproval: { id: string; assistantId: string; callId: string } | undefined;

const HARNESS_CHANGED_FILES: ChatChangedFile[] = [
	{ id: "change-added", path: "src/chat/webview/changes-panel.tsx", status: "added", additions: 128 },
	{ id: "change-store", path: "src/chat/webview/store.ts", status: "modified", additions: 14, deletions: 2 },
	{ id: "change-protocol", path: "src/chat/shared/protocol.ts", status: "modified" },
	{ id: "change-deleted", path: "src/chat/webview/old-panel.tsx", status: "deleted", deletions: 96 },
];

let currentChanges: ChatChangeSet = {
	files: HARNESS_CHANGED_FILES.map(file => ({ ...file })),
	sinceTurn: [
		{ turn: Math.max(1, turn - 3), files: 2 },
		{ turn: Math.max(1, turn - 2), files: 3 },
		{ turn: Math.max(1, turn - 1), files: 4 },
		{ turn, files: 4 },
	],
};

window.__harness = {
	get messageCount(): number {
		return messages.length;
	},
	get lastStreamMs(): number {
		return lastStreamMs;
	},
};

window.acquireVsCodeApi = () => ({
	postMessage: handleWebviewMessage,
	getState: () => undefined,
	setState: () => undefined,
});

function emit(message: HostMessage): void {
	window.postMessage(message, "*");
}

function handleWebviewMessage(message: WebviewMessage): void {
	switch (message.type) {
		case "ready":
			emitInit();
			break;
		case "send":
			handleSend(message.text);
			break;
		case "stop":
			if (streamTimer !== undefined) {
				stopStream();
				lastStreamMs = Math.round(performance.now() - streamStarted);
			}
			emit({ type: "run", run: { running: false } });
			break;
		case "selectModel":
			selectedModelId = message.modelId;
			emit({ type: "models", models: MODEL_GROUPS, selectedModelId });
			break;
		case "setToolsEnabled":
			applyToolsEnabled(message.names, message.enabled);
			emit({ type: "tools", tools: TOOL_GROUPS });
			break;
		case "editMessage":
			handleEdit(message.messageId, message.text, message.undoChanges);
			break;
		case "keepChanges":
			handleKeepChanges(message.ids);
			break;
		case "undoChanges":
			handleUndoChanges(message.ids);
			break;
		case "openChange":
			console.log(`harness: open change ${message.id}`);
			break;
		case "approve":
			handleApprove(message.id, message.allow);
			break;
		case "loadToolResult":
			handleLoadToolResult(message.messageId, message.callId);
			break;
		case "newChat":
			break;
	}
}

function emitInit(): void {
	emit({
		type: "init",
		session: sessionMeta(),
		messages,
		models: MODEL_GROUPS,
		selectedModelId,
		run: { running: false },
		tools: TOOL_GROUPS,
		approvals: [],
		changes: currentChanges,
	});
	startLiveSubagent();
}

function startLiveSubagent(): void {
	if (liveSubagentStarted || liveSubagentMessageId === undefined) {
		return;
	}
	liveSubagentStarted = true;
	const messageId = liveSubagentMessageId;
	const publish = (index: number): void => {
		const run: ChatSubagentRun = {
			callId: LIVE_SUBAGENT_CALL_ID,
			description: "Map the subagent flow",
			modelId: "deepseek-flash",
			modelName: "DeepSeek Flash",
			status: "running",
			steps: LIVE_SUBAGENT_STEPS.slice(0, index),
			startedAt: LIVE_SUBAGENT_STARTED_AT,
		};
		emit({ type: "subagent", messageId, run });
	};
	let shown = 1;
	publish(shown);
	liveSubagentTimer = window.setInterval(() => {
		shown += 1;
		publish(Math.min(shown, LIVE_SUBAGENT_STEPS.length));
		if (shown >= LIVE_SUBAGENT_STEPS.length && liveSubagentTimer !== undefined) {
			window.clearInterval(liveSubagentTimer);
			liveSubagentTimer = undefined;
		}
	}, 1_200);
}

function sessionMeta(): ChatSessionMeta {
	return {
		id: SESSION_ID,
		title: sessionTitle,
		createdAt: SESSION_CREATED_AT,
		updatedAt: Date.now(),
		modelId: selectedModelId,
		messageCount: messages.length,
	};
}

function handleSend(text: string): void {
	stopStream();
	turn += 1;
	const userId = `sent-user-${nextId++}`;
	const assistantId = `sent-assistant-${nextId++}`;
	const now = Date.now();
	const user: ChatMessage = { id: userId, role: "user", turn, createdAt: now, parts: [{ kind: "text", text }] };
	const assistant: ChatMessage = { id: assistantId, role: "assistant", turn, createdAt: now, modelId: selectedModelId, parts: [] };
	messages.push(user, assistant);
	emit({ type: "messageAdded", message: user });
	emit({ type: "run", run: { running: true, detail: "Streaming reply…" } });
	emit({ type: "messageAdded", message: assistant });

	if (/\bdanger\b/i.test(text)) {
		startApproval(assistant);
		return;
	}
	startStream(assistantId);
}

function startStream(assistantId: string): void {
	const chunks = splitText(streamText(), 300).filter(chunk => chunk.length > 0);
	let index = 0;
	streamStarted = performance.now();
	streamTimer = window.setInterval(() => {
		if (index >= chunks.length) {
			stopStream();
			lastStreamMs = Math.round(performance.now() - streamStarted);
			emit({ type: "usage", messageId: assistantId, usage: { promptTokens: 12_345, completionTokens: 3000, totalTokens: 15_345 } });
			emit({ type: "run", run: { running: false } });
			return;
		}
		emit({ type: "textDelta", messageId: assistantId, kind: "text", text: chunks[index] });
		index += 1;
	}, 16);
}

function startApproval(assistant: ChatMessage): void {
	const id = `harness-approval-${approvalSeq++}`;
	const callId = `call-approval-${id}`;
	const part: ChatPart = { kind: "toolCall", callId, name: "run_in_terminal", input: { command: "git push --force origin main" } };
	assistant.parts.push(part);
	emit({ type: "partAdded", messageId: assistant.id, part });
	pendingApproval = { id, assistantId: assistant.id, callId };
	emit({
		type: "approval",
		request: {
			id,
			messageId: assistant.id,
			callId,
			toolName: "run_in_terminal",
			title: "Run a dangerous command",
			detail: "git push --force origin main",
			reason: "Matches the dangerous-command rule: git push --force",
		},
	});
	emit({ type: "run", run: { running: true, detail: "Waiting for approval…" } });
}

function handleApprove(id: string, allow: boolean): void {
	const pending = pendingApproval;
	if (!pending || pending.id !== id) {
		return;
	}
	pendingApproval = undefined;
	emit({ type: "approvalResolved", id, allowed: allow });
	const result: ChatPart = {
		kind: "toolResult",
		callId: pending.callId,
		text: allow ? "Approved by the user." : "Denied by the user.",
		isError: !allow,
	};
	const message = messages.find(candidate => candidate.id === pending.assistantId);
	if (message) {
		message.parts.push(result);
	}
	emit({ type: "partAdded", messageId: pending.assistantId, part: result });
	const text = allow ? "Allowed: the dangerous command would run now." : "Denied: the dangerous command was not run.";
	emit({ type: "textDelta", messageId: pending.assistantId, kind: "text", text });
	emit({ type: "run", run: { running: false } });
}

function handleEdit(messageId: string, text: string, undoChanges: boolean | undefined): void {
	const index = messages.findIndex(candidate => candidate.id === messageId);
	const target = index >= 0 ? messages[index] : undefined;
	const editsFirstUser = target?.role === "user" && messages.find(candidate => candidate.role === "user")?.id === messageId;
	stopStream();
	pendingApproval = undefined;
	emit({ type: "truncated", messageId });
	if (index >= 0) {
		messages.splice(index);
	}
	if (undoChanges && target) {
		const count = filesChangedSince(target.turn);
		if (count > 0) {
			currentChanges = { files: [], sinceTurn: [], notice: `Undid ${pluralFiles(count)}.` };
			emit({ type: "changes", changes: currentChanges });
		}
	}
	handleSend(text);
	if (editsFirstUser) {
		sessionTitle = titleFromText(text);
		emit({ type: "session", session: sessionMeta() });
	}
}

function handleKeepChanges(ids?: string[]): void {
	if (!ids && currentChanges.files.length === 0) {
		return;
	}
	const targets = ids ? new Set(ids) : undefined;
	const remaining = targets ? currentChanges.files.filter(file => !targets.has(file.id)) : [];
	const kept = currentChanges.files.length - remaining.length;
	if (kept === 0) {
		return;
	}
	currentChanges = { ...currentChanges, files: remaining, notice: `Kept ${pluralFiles(kept)}.` };
	emit({ type: "changes", changes: currentChanges });
}

function handleUndoChanges(ids?: string[]): void {
	if (!ids && currentChanges.files.length === 0) {
		return;
	}
	const targets = ids ? new Set(ids) : undefined;
	const remaining = targets ? currentChanges.files.filter(file => !targets.has(file.id)) : [];
	const undone = currentChanges.files.length - remaining.length;
	if (undone === 0) {
		return;
	}
	currentChanges = { ...currentChanges, files: remaining, notice: `Undid ${pluralFiles(undone)}.` };
	emit({ type: "changes", changes: currentChanges });
}

function filesChangedSince(targetTurn: number): number {
	let result = 0;
	let nearest = Number.POSITIVE_INFINITY;
	for (const entry of currentChanges.sinceTurn) {
		if (entry.turn === targetTurn) {
			return entry.files;
		}
		if (entry.turn > targetTurn && entry.turn < nearest) {
			nearest = entry.turn;
			result = entry.files;
		}
	}
	return result;
}

function pluralFiles(count: number): string {
	return count === 1 ? "1 file" : `${count} files`;
}

function titleFromText(text: string): string {
	const singleLine = text.replace(/\s+/g, " ").trim();
	return singleLine.length > 60 ? `${singleLine.slice(0, 59)}…` : singleLine;
}

function applyToolsEnabled(names: string[], enabled: boolean): void {
	const targets = new Set(names);
	for (const group of TOOL_GROUPS) {
		for (const tool of group.tools) {
			if (targets.has(tool.name)) {
				tool.enabled = enabled;
			}
		}
	}
}

function stopStream(): void {
	if (streamTimer !== undefined) {
		window.clearInterval(streamTimer);
		streamTimer = undefined;
	}
}

function handleLoadToolResult(messageId: string, callId: string): void {
	const text = longToolResult(callId);
	const message = messages.find(candidate => candidate.id === messageId);
	const part = message?.parts.find(candidate => candidate.kind === "toolResult" && candidate.callId === callId);
	if (part && part.kind === "toolResult") {
		part.text = text;
		part.preview = false;
	}
	emit({ type: "toolResultFull", messageId, callId, text });
}

function createMessages(count: number): ChatMessage[] {
	const random = makeRandom(42);
	const result: ChatMessage[] = [];
	let currentTurn = 0;
	for (let index = 0; index < count; index += 1) {
		const user = index % 2 === 0;
		if (user) {
			currentTurn += 1;
			result.push({
				id: `message-${index}`,
				role: "user",
				turn: currentTurn,
				createdAt: 1_700_000_000_000 + index * 1000,
				parts: [{ kind: "text", text: userText(index, random) }],
			});
			continue;
		}
		result.push({
			id: `message-${index}`,
			role: "assistant",
			turn: currentTurn,
			createdAt: 1_700_000_000_000 + index * 1000,
			modelId: MODEL_GROUPS[index % 2].models[0].id,
			parts: assistantParts(index, random),
			usage: { promptTokens: 12_000 + (index % 40) * 250, completionTokens: 400 + (index % 17) * 30, totalTokens: 16_000 + index },
		});
	}
	const compacted = result[3];
	const kept = result[6];
	if (compacted?.role === "assistant" && kept) {
		compacted.parts.unshift(createCompactionPart(kept.id));
	}
	const limited = result[1];
	if (limited?.role === "assistant") {
		limited.parts.push(createLimitPart());
	}
	const finished = result[9];
	if (finished?.role === "assistant") {
		addFinishedSubagent(finished);
	}
	const live = result[13];
	if (live?.role === "assistant") {
		liveSubagentMessageId = live.id;
		live.parts.push({
			kind: "toolCall",
			callId: LIVE_SUBAGENT_CALL_ID,
			name: "subagent",
			input: { description: "Map the subagent flow", prompt: "Trace every place that mentions subagent and report the call chain.", model: "DeepSeek Flash" },
		});
	}
	return result;
}

/** A finished run: the subagent part sits right before the tool result, as the host sends them. */
function addFinishedSubagent(message: ChatMessage): void {
	message.parts.push(
		{
			kind: "toolCall",
			callId: FINISHED_SUBAGENT_CALL_ID,
			name: "subagent",
			input: { description: "Audit the subagent UI", prompt: "Check how the store keeps live runs and whether the card shows steps and the report.", model: "DeepSeek Flash" },
		},
		{
			kind: "subagent",
			callId: FINISHED_SUBAGENT_CALL_ID,
			description: "Audit the subagent UI",
			modelId: "deepseek-flash",
			modelName: "DeepSeek Flash",
			status: "done",
			steps: [
				{ kind: "text", text: "Checking how the store keeps live runs." },
				{ kind: "tool", name: "read_file", summary: "{\"path\":\"src/chat/webview/store.ts\"}" },
				{ kind: "tool", name: "grep_search", summary: "{\"query\":\"subagent\"}" },
				{ kind: "tool", name: "run_in_terminal", summary: "{\"command\":\"npm run compile\"}", isError: true },
				{ kind: "text", text: "The store drops a live run when its `subagent` part arrives." },
				{ kind: "notice", level: "info", text: "Finished in 5 s." },
			],
			startedAt: Date.now() - 5_200,
			durationMs: 5_200,
			usage: { promptTokens: 9_800, completionTokens: 640, totalTokens: 10_440 },
		},
		{
			kind: "toolResult",
			callId: FINISHED_SUBAGENT_CALL_ID,
			text: [
				"**Report**",
				"",
				"- `store.ts` keeps live runs in a map and drops each one when its finished part arrives.",
				"- The tool call renders as a `Subagent` card with the model, the description and its steps.",
				"- The report reuses the tool result preview and full-load behaviour.",
				"",
				"Nothing else changed.",
			].join("\n"),
		},
	);
}

function createLimitPart(): ChatPart {
	return {
		kind: "notice",
		level: "warning",
		text: "You hit your 5-hour limit. Wait for the reset, then send the message again. No retry was made.",
		limit: {
			kind: "limit",
			provider: "Codex",
			window: "5-hour",
			resetAt: Date.now() + 2 * 3_600_000 + 5 * 60_000,
		},
	};
}

/** The host sends a compaction part as the first part of an assistant message. */
function createCompactionPart(keepFromMessageId: string): ChatPart {
	return {
		kind: "compaction",
		summary: [
			"## Objective",
			"",
			"Keep the chat list responsive with thousands of messages and finish the compaction UI.",
			"",
			"## Completed",
			"",
			"- Virtual layout with a measured height per message.",
			"- One `ResizeObserver` for the scroller and every visible message.",
			"- Markdown rendering without raw HTML injection.",
			"",
			"## Open",
			"",
			"- Show the summary card and the divider above the kept messages.",
		].join("\n"),
		keepFromMessageId,
		summarizedMessages: 5,
		tokensBefore: 312_000,
		tokensAfter: 104_000,
		method: "deepseek",
	};
}

function userText(index: number, random: () => number): string {
	const requests = [
		"Can you check why the chat list slows down with thousands of messages?",
		"Please add the virtual layout and make sure typing stays smooth.",
		"Show me the failing test output and fix the cause.",
		"Update the Markdown renderer so it never injects raw HTML.",
		"What does the ResizeObserver callback do when an item changes height?",
	];
	return `${requests[Math.floor(random() * requests.length)]} (#${index})`;
}

function assistantParts(index: number, random: () => number): ChatPart[] {
	const parts: ChatPart[] = [];
	const variant = index % 8;
	if (variant === 1 || variant === 6) {
		parts.push({ kind: "thinking", text: "Looking at the request, then at the rendered message heights.\nOnly the changed message should re-render." });
	}
	if (variant === 2 || variant === 5) {
		const callId = `call-${index}`;
		const preview = variant === 5;
		parts.push({
			kind: "toolCall",
			callId,
			name: preview ? "read_file" : "grep_search",
			input: { path: "src/chat/webview/message-list.tsx", query: "ResizeObserver", maxResults: 20, offset: index },
		});
		const text = preview ? previewToolResult(index) : `Found 2 matches for "ResizeObserver" in src/chat/webview/message-list.tsx.`;
		parts.push({ kind: "toolResult", callId, text, isError: preview && index % 40 === 5, preview, truncated: preview });
	}
	parts.push({ kind: "text", text: assistantMarkdown(index, random) });
	if (variant === 4) {
		parts.push({ kind: "notice", level: index % 16 === 4 ? "warning" : "info", text: "The harness generated this message for performance testing." });
	}
	if (variant === 7) {
		parts.push({ kind: "toolResult", callId: `orphan-${index}`, text: "Compiled with 0 errors.", isError: false });
	}
	return parts;
}

function assistantMarkdown(index: number, random: () => number): string {
	const samples = [
		`### Answer ${index}\n\nThe layout keeps a height per message and rebuilds prefix sums lazily.\n\n- Virtualized list\n- One ResizeObserver\n  - Heights feed \`setHeight\`\n- Sticky bottom only within 40 px\n\n\`\`\`ts\nconst layout = new VirtualLayout(80);\nlayout.setCount(5000);\n\`\`\``,
		"Here is a short summary with **strong text**, *emphasis*, `inline code` and a [safe link](https://example.com).\n\n> A blockquote line.\n\n---\n\nThat is all.",
		"| Metric | Budget |\n| --- | ---: |\n| Typing latency | 16 ms |\n| Rendered messages | ~20 |\n| Estimates | 80 px |",
		"1. First step\n2. Second step\n   - nested bullet\n   - another bullet\n3. Third step",
	];
	const sample = samples[Math.floor(index / 2) % samples.length];
	if (index % 13 === 3) {
		return `${sample}\n\nA little extra text to vary the measured height: ${"word ".repeat(Math.floor(random() * 40) + 5)}`;
	}
	return sample;
}

function previewToolResult(index: number): string {
	const line = `line ${index}: this is a generated tool output line used to measure long result rendering.\n`;
	let text = "";
	while (text.length < WEBVIEW_TOOL_RESULT_PREVIEW_CHARS) {
		text += line;
	}
	return text.slice(0, WEBVIEW_TOOL_RESULT_PREVIEW_CHARS);
}

function longToolResult(callId: string): string {
	const line = `full output for ${callId}: a much longer tool result body served on demand.\n`;
	return line.repeat(400);
}

function streamText(): string {
	const paragraph = "The streamed reply keeps **arriving** in small chunks. Each delta appends to the last text part, so the message list keeps its scroll position while the Markdown grows.\n\n";
	const list = "- one\n- two\n- three\n\n```ts\nconst chunk = 16;\n```\n\n";
	return `${paragraph}${paragraph}${list}${paragraph}${paragraph}${list}${paragraph}`;
}

function splitText(text: string, parts: number): string[] {
	const size = Math.max(1, Math.ceil(text.length / parts));
	const chunks: string[] = [];
	for (let offset = 0; offset < text.length; offset += size) {
		chunks.push(text.slice(offset, offset + size));
	}
	return chunks;
}

function makeRandom(seed: number): () => number {
	let state = seed >>> 0;
	return () => {
		state = (state * 1664525 + 1013904223) >>> 0;
		return state / 0x1_0000_0000;
	};
}
