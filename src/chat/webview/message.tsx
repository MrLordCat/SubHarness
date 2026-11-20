import { Component, type ComponentChildren } from "preact";
import { useEffect, useState } from "preact/hooks";
import { attachmentLabel, attachmentTitle } from "../shared/attachment-label";
import type { ChatLimitInfo, ChatMessage, ChatPart, ChatSubagentRun, ChatSubagentStep } from "../shared/protocol";
import { SUBAGENT_TOOL_NAME } from "../tools/subagent-tool";
import { postMessage } from "./api";
import { EditComposer } from "./edit-composer";
import { OPEN_MODEL_PICKER_EVENT } from "./events";
import { describeToolCall, formatBytes, formatReset, formatTokens, summarizeInput, toolCommand } from "./format";
import { Markdown } from "./markdown";
import type { ChatStore } from "./store";

type ToolResultPart = Extract<ChatPart, { kind: "toolResult" }>;
type ToolCallPart = Extract<ChatPart, { kind: "toolCall" }>;
type ThinkingPart = Extract<ChatPart, { kind: "thinking" }>;
type CompactionPart = Extract<ChatPart, { kind: "compaction" }>;
type ToolRowState = "ok" | "error" | "pending";
type SubagentStatus = ChatSubagentRun["status"] | "pending";

export interface MessageItemProps {
	message: ChatMessage;
	version: number;
	running: boolean;
	editing: boolean;
	/** The latest compaction keeps this message, so the summarized divider sits above it. */
	compactionBoundary: boolean;
	/** Retry and other end-of-answer actions only belong to the newest message. */
	isLast: boolean;
	/** Files the agent changed at or after this message's turn; used when editing. */
	changedFilesSinceTurn: number;
	/** The same context indicator the main composer shows. */
	context: string | undefined;
	store: ChatStore;
	onEdit: (messageId: string) => void;
	/** Live state of a running subagent; the finished run is a "subagent" part of the message. */
	liveSubagentRun: (callId: string) => ChatSubagentRun | undefined;
}

/** Only a changed version reaches the render below; the list around it stays put. */
class MessageItemMemo extends Component<MessageItemProps> {
	shouldComponentUpdate(next: MessageItemProps): boolean {
		return next.version !== this.props.version
			|| next.message !== this.props.message
			|| next.running !== this.props.running
			|| next.editing !== this.props.editing
			|| next.compactionBoundary !== this.props.compactionBoundary
			|| next.isLast !== this.props.isLast
			|| next.store !== this.props.store
			|| (next.editing && (next.changedFilesSinceTurn !== this.props.changedFilesSinceTurn || next.context !== this.props.context));
	}

	render(props: MessageItemProps) {
		return <MessageView {...props} />;
	}
}

export const MessageItem = MessageItemMemo;

function MessageView({ message, running, editing, compactionBoundary, isLast, changedFilesSinceTurn, context, store, onEdit, liveSubagentRun }: Omit<MessageItemProps, "version">) {
	const divider = compactionBoundary
		? <div class="compaction-divider">Earlier messages are summarized for the model</div>
		: null;
	if (message.role === "user") {
		const text = message.parts
			.flatMap(part => part.kind === "text" ? [part.text] : [])
			.join("\n\n");
		if (editing) {
			return (
				<>
					{divider}
					<div class="msg msg-user msg-editing">
						<EditComposer
							store={store}
							message={message}
							changedFilesSinceTurn={changedFilesSinceTurn}
							context={context}
						/>
					</div>
				</>
			);
		}
		const editable = !running;
		const preview = text.length > 60 ? `${text.slice(0, 60)}…` : text;
		const startEdit = () => {
			if (!editable || window.getSelection()?.toString()) {
				return;
			}
			onEdit(message.id);
		};
		const onBubbleKeyDown = (event: KeyboardEvent) => {
			if (event.key !== "Enter" && event.key !== " ") {
				return;
			}
			event.preventDefault();
			startEdit();
		};
		return (
			<>
				{divider}
				<div class="msg msg-user">
					<div class="user-body">
						<div
							class="user-bubble"
							role={editable ? "button" : undefined}
							tabIndex={editable ? 0 : undefined}
							title={editable ? "Click to edit" : undefined}
							aria-label={editable ? `Edit message: ${preview}` : undefined}
							onClick={startEdit}
							onKeyDown={onBubbleKeyDown}
						>
							{editable ? <span class="user-edit-glyph" aria-hidden="true">✎</span> : null}
							{text}
						</div>
						{message.attachments && message.attachments.length > 0 ? (
							<div class="message-attachments">
								{message.attachments.map(attachment => (
									<span class="attachment-chip" key={attachment.id}>
										<button
											type="button"
											class="attachment-chip-open"
											title={attachmentTitle(attachment)}
											onClick={event => {
												event.stopPropagation();
												postMessage({ type: "openAttachment", attachment });
											}}
										>
											{attachment.kind === "selection" ? "✂" : "📄"}
											<span class="attachment-chip-label">{attachmentLabel(attachment)}</span>
										</button>
									</span>
								))}
							</div>
						) : null}
					</div>
				</div>
			</>
		);
	}

	const calls = new Set<string>();
	const results = new Map<string, ToolResultPart>();
	const subagentRuns = new Map<string, ChatSubagentRun>();
	for (const part of message.parts) {
		if (part.kind === "toolCall") {
			calls.add(part.callId);
		} else if (part.kind === "toolResult") {
			results.set(part.callId, part);
		} else if (part.kind === "subagent") {
			subagentRuns.set(part.callId, part);
		}
	}

	return (
		<>
			{divider}
			<div class="msg msg-assistant">
				{groupParts(message.parts).map(unit => {
					if (unit.kind === "tools") {
						const rows = unit.parts.map(part => (
							<ToolCallCard
								key={part.callId}
								name={part.name}
								input={part.input}
								result={results.get(part.callId)}
								running={running}
								messageId={message.id}
								store={store}
							/>
						));
						return unit.parts.length > 1
							? <div class="tool-group" key={`group-${unit.index}`}>{rows}</div>
							: rows[0] ?? null;
					}
					const part = unit.part;
					const index = unit.index;
					switch (part.kind) {
						case "text":
							return <Markdown key={index} text={part.text} />;
						case "thinking":
							return <ThinkingBlock key={index} part={part} index={index} messageId={message.id} store={store} />;
						case "toolCall":
							return (
								<SubagentCard
									key={part.callId}
									input={part.input}
									result={results.get(part.callId)}
									part={subagentRuns.get(part.callId)}
									liveRun={liveSubagentRun(part.callId)}
									running={running}
									messageId={message.id}
									store={store}
								/>
							);
						case "toolResult":
							return calls.has(part.callId)
								? null
								: <ToolResultCard key={index} part={part} messageId={message.id} store={store} />;
						case "subagent":
							return null;
						case "notice":
							if (part.limit) {
								return <LimitCard key={index} level={part.level} text={part.text} limit={part.limit} />;
							}
							return (
								<div key={index} class={`msg-notice notice-${part.level}`}>
									{part.text}
									{part.retryable && isLast && !running ? (
										<button
											type="button"
											class="msg-notice-retry"
											onClick={() => postMessage({ type: "retryTurn", messageId: message.id })}
										>
											Retry
										</button>
									) : null}
								</div>
							);
						case "compaction":
							return <CompactionCard key={index} part={part} />;
					}
				})}
			</div>
		</>
	);
}

type PartUnit =
	| { kind: "part"; index: number; part: ChatPart }
	| { kind: "tools"; index: number; parts: ToolCallPart[] };

/** Consecutive tool calls share one list; the subagent card stays a card of its own. */
function groupParts(parts: ChatPart[]): PartUnit[] {
	const units: PartUnit[] = [];
	let group: ToolCallPart[] | undefined;
	for (let index = 0; index < parts.length; index += 1) {
		const part = parts[index];
		if (part.kind === "toolCall" && part.name !== SUBAGENT_TOOL_NAME) {
			group ??= [];
			group.push(part);
			continue;
		}
		if (group) {
			units.push({ kind: "tools", index: index - group.length, parts: group });
			group = undefined;
		}
		units.push({ kind: "part", index, part });
	}
	if (group) {
		units.push({ kind: "tools", index: parts.length - group.length, parts: group });
	}
	return units;
}

function firstTextLine(text: string): string {
	const lines = text.split(/\r\n|\r|\n/);
	return lines.length > 0 ? lines[0].trim() : "";
}

function lastTextLine(text: string): string {
	const lines = text.split(/\r\n|\r|\n/).map(line => line.trim()).filter(line => line.length > 0);
	return lines.length > 0 ? lines[lines.length - 1] : "";
}

function ThinkingBlock({ part, index, messageId, store }: { part: ThinkingPart; index: number; messageId: string; store: ChatStore }) {
	const [open, setOpen] = useState(false);
	const [loading, setLoading] = useState(() => part.preview === true && store.partTextPending(messageId, index));
	useEffect(() => {
		if (!open || !part.preview) {
			setLoading(false);
			return;
		}
		store.loadPartText(messageId, index);
		setLoading(true);
	}, [open, part.preview, messageId, index, store]);
	const progress = lastTextLine(part.text);
	return (
		<details class="msg-thinking" open={open} onToggle={event => setOpen((event.currentTarget as HTMLDetailsElement).open)}>
			<summary>
				<span class="thinking-label">Thinking</span>
				{progress ? <span class="thinking-progress" title={progress}>{progress}</span> : null}
			</summary>
			<pre>{part.text}</pre>
			{loading && part.preview ? <div class="part-loading">Loading…</div> : null}
		</details>
	);
}

function markdownFirstLine(text: string | undefined): string {
	if (!text) {
		return "";
	}
	return firstTextLine(text).replace(/^[#*\-`>\s]+/, "").replace(/[*`#\s]+$/, "").trim();
}

function CompactionCard({ part }: { part: CompactionPart }) {
	const method = part.method === "deepseek" ? "DeepSeek summary" : "extractive summary";
	return (
		<div class="compaction-card">
			<div class="compaction-line">
				<span class="compaction-label">Context compacted:</span>
				{` ${part.summarizedMessages} earlier messages summarized · ${formatTokens(part.tokensBefore)} → ${formatTokens(part.tokensAfter)} tokens`}
				<span class="compaction-method">{` (${method})`}</span>
			</div>
			<details class="compaction-summary">
				<summary>Summary</summary>
				<Markdown text={part.summary} />
			</details>
		</div>
	);
}

interface LimitCardProps {
	level: "info" | "warning" | "error";
	text: string;
	limit: ChatLimitInfo;
}

function LimitCard({ level, text, limit }: LimitCardProps) {
	const heading = limit.kind === "balance"
		? `${limit.provider} balance is empty`
		: `${limit.provider} usage limit reached`;
	return (
		<div class={`limit-card notice-${level}`}>
			<div class="limit-heading">{heading}</div>
			<div class="limit-text">{text}</div>
			{limit.resetAt !== undefined ? (
				<div class="limit-reset">{`Resets at ${formatReset(limit.resetAt, Date.now())}`}</div>
			) : null}
			<button
				type="button"
				class="limit-model-button"
				onClick={() => window.dispatchEvent(new CustomEvent(OPEN_MODEL_PICKER_EVENT))}
			>
				Choose another model
			</button>
		</div>
	);
}

interface ToolCallProps {
	name: string;
	input: unknown;
	result: ToolResultPart | undefined;
	running: boolean;
	messageId: string;
	store: ChatStore;
}

interface ToolResultProps {
	part: ToolResultPart;
	messageId: string;
	store: ChatStore;
}

interface ToolRowProps {
	state: ToolRowState;
	running: boolean;
	title: ComponentChildren;
	detail?: string;
	summary: string;
	children: ComponentChildren;
}

function ToolRow({ state, running, title, detail, summary, children }: ToolRowProps) {
	const [open, setOpen] = useState(false);
	return (
		<div class={`tool-row tool-row-${state}`}>
			<button
				type="button"
				class="tool-row-toggle"
				aria-expanded={open}
				title={summary}
				onClick={() => setOpen(value => !value)}
			>
				<span class="tool-row-glyph" aria-hidden="true">{toolGlyph(state, running)}</span>
				<span class="tool-row-title">{title}</span>
				{detail ? <span class="tool-row-detail">{detail}</span> : null}
				<span class="tool-row-chevron" aria-hidden="true">{open ? "▾" : "▸"}</span>
			</button>
			{open ? <div class="tool-row-body">{children}</div> : null}
		</div>
	);
}

function toolGlyph(state: ToolRowState, running: boolean): ComponentChildren {
	if (state === "ok") {
		return "✓";
	}
	if (state === "error") {
		return "✗";
	}
	return running ? <span class="tool-spinner" /> : "–";
}

function prettyInput(input: unknown): string {
	try {
		return typeof input === "string" ? input : JSON.stringify(input, null, 2) ?? String(input);
	} catch {
		return String(input);
	}
}

function ToolCallCard({ name, input, result, running, messageId, store }: ToolCallProps) {
	const described = describeToolCall(name, input);
	const state: ToolRowState = result ? (result.isError ? "error" : "ok") : "pending";
	const detail = state === "error" ? firstTextLine(result?.text ?? "") : described.detail;
	const command = name === "run_in_terminal" ? toolCommand(input) : undefined;
	const title = command === undefined
		? described.title
		: <span>Ran <span class="tool-row-command">{command}</span></span>;
	return (
		<ToolRow state={state} running={running} title={title} detail={detail || undefined} summary={summarizeInput(input)}>
			<div class="tool-row-label">Input</div>
			<pre class="tool-input">{prettyInput(input)}</pre>
			{result ? <ToolResultDetails part={result} messageId={messageId} store={store} openByDefault /> : null}
		</ToolRow>
	);
}

function ToolResultCard({ part, messageId, store }: ToolResultProps) {
	const first = firstTextLine(part.text);
	return (
		<ToolRow
			state={part.isError ? "error" : "ok"}
			running={false}
			title="Tool output"
			detail={part.isError ? first : undefined}
			summary={first || "Tool output"}
		>
			<ToolResultDetails part={part} messageId={messageId} store={store} openByDefault />
		</ToolRow>
	);
}

function toolResultLabel(part: ToolResultPart, markdown: boolean): string {
	const label = part.isError ? "Error output" : markdown ? "Report" : "Output";
	if (!part.preview) {
		return label;
	}
	const shown = part.text.length.toLocaleString("en-US");
	return part.fullLength === undefined
		? `${label} (preview, ${shown} characters)`
		: `${label} (preview, ${shown} of ${part.fullLength.toLocaleString("en-US")} characters)`;
}

function ToolResultDetails({ part, messageId, store, report, openByDefault }: ToolResultProps & { report?: boolean; openByDefault?: boolean }) {
	const markdown = report === true && !part.isError;
	const [open, setOpen] = useState(markdown || openByDefault === true);
	const [loading, setLoading] = useState(() => part.preview === true && store.toolResultPending(part.callId));
	useEffect(() => {
		if (!open || !part.preview) {
			setLoading(false);
			return;
		}
		store.loadToolResult(messageId, part.callId);
		setLoading(true);
	}, [open, part.preview, messageId, part.callId, store]);
	return (
		<details
			class={`tool-result${part.isError ? " tool-result-error" : ""}`}
			open={open}
			onToggle={event => setOpen((event.currentTarget as HTMLDetailsElement).open)}
		>
			<summary>{toolResultLabel(part, markdown)}</summary>
			{markdown ? <div class="tool-report"><Markdown text={part.text} /></div> : <pre class="tool-output">{part.text}</pre>}
			{part.images?.map((image, index) => (
				<div class="tool-result-image" key={`${index}-${image.name ?? image.mimeType}`}>🖼 {image.name ?? image.mimeType} · {formatBytes(image.byteLength)}</div>
			))}
			{loading && part.preview ? <div class="part-loading">Loading full output…</div> : null}
		</details>
	);
}

interface SubagentInput {
	description: string;
	model: string;
	prompt: string;
}

function readSubagentInput(input: unknown): SubagentInput {
	const record = typeof input === "object" && input !== null ? input as Record<string, unknown> : {};
	return {
		description: typeof record.description === "string" ? record.description : "",
		model: typeof record.model === "string" ? record.model : "",
		prompt: typeof record.prompt === "string" ? record.prompt : "",
	};
}

function formatDuration(ms: number): string {
	if (ms < 1_000) {
		return `${Math.max(0, Math.round(ms))} ms`;
	}
	const totalSeconds = Math.round(ms / 1_000);
	if (totalSeconds < 60) {
		return `${totalSeconds} s`;
	}
	const minutes = Math.floor(totalSeconds / 60);
	const seconds = totalSeconds % 60;
	return seconds > 0 ? `${minutes} min ${seconds} s` : `${minutes} min`;
}

/** Repaints the running duration once a second while the card is active. */
function useNow(active: boolean): number {
	const [now, setNow] = useState(() => Date.now());
	useEffect(() => {
		if (!active) {
			return undefined;
		}
		setNow(Date.now());
		const timer = window.setInterval(() => setNow(Date.now()), 1_000);
		return () => window.clearInterval(timer);
	}, [active]);
	return now;
}

function parseJsonObject(text: string): unknown {
	try {
		const value: unknown = JSON.parse(text);
		return typeof value === "object" && value !== null ? value : undefined;
	} catch {
		return undefined;
	}
}

function stepToolText(step: Extract<ChatSubagentStep, { kind: "tool" }>): string {
	const input = parseJsonObject(step.input ?? step.summary);
	if (input !== undefined) {
		const described = describeToolCall(step.name, input);
		return described.detail ? `${described.title} · ${described.detail}` : described.title;
	}
	return `${step.name}: ${step.summary}`;
}

function subagentFailureText(run: ChatSubagentRun, result: ToolResultPart | undefined): string {
	if (result?.isError) {
		return firstTextLine(result.text);
	}
	for (let index = run.steps.length - 1; index >= 0; index -= 1) {
		const step = run.steps[index];
		if (step.kind === "notice") {
			return firstTextLine(step.text);
		}
	}
	return result ? firstTextLine(result.text) : "";
}

/** The always-visible second line: what the subagent is doing or how it ended. */
function subagentProgress(run: ChatSubagentRun | undefined, result: ToolResultPart | undefined): string {
	if (!run) {
		return result?.isError ? firstTextLine(result.text) || "Failed" : "Starting…";
	}
	if (run.status === "running") {
		const step = run.steps[run.steps.length - 1];
		if (!step) {
			return "Starting…";
		}
		return step.kind === "tool" ? stepToolText(step) : firstTextLine(step.text) || "Working…";
	}
	if (run.status === "done") {
		return markdownFirstLine(result?.text) || "Done";
	}
	if (run.status === "failed") {
		return subagentFailureText(run, result) || "Failed";
	}
	return "Stopped";
}

function SubagentToolStep({ step }: { step: Extract<ChatSubagentStep, { kind: "tool" }> }) {
	const [open, setOpen] = useState(false);
	const input = parseJsonObject(step.input ?? step.summary);
	const described = input === undefined ? undefined : describeToolCall(step.name, input);
	const title = described?.title ?? step.name;
	const detail = described ? described.detail ?? "" : step.summary;
	const expandable = step.input !== undefined || step.output !== undefined;
	return (
		<div class={`subagent-step subagent-step-tool${step.isError ? " tool-error" : ""}${expandable ? " subagent-step-expandable" : ""}`} title={step.summary}>
			{expandable ? (
				<button type="button" class="subagent-step-toggle" aria-expanded={open} onClick={() => setOpen(value => !value)}>
					<span class="subagent-step-name">{title}</span>
					<span class="subagent-step-summary">{detail}</span>
					<span class="subagent-step-chevron" aria-hidden="true">{open ? "▾" : "▸"}</span>
				</button>
			) : (
				<>
					<span class="subagent-step-name">{title}</span>
					<span class="subagent-step-summary">{detail}</span>
				</>
			)}
			{expandable && open ? (
				<div class="subagent-step-body">
					<div class="tool-row-label">Input</div>
					<pre class="tool-input">{step.input ?? step.summary}</pre>
					{step.output !== undefined ? (
						<>
							<div class="tool-row-label">Output</div>
							<pre class="tool-output">{step.output}</pre>
							{step.outputChars !== undefined && step.outputChars > step.output.length ? (
								<div class="subagent-step-note">
									First {step.output.length.toLocaleString("en-US")} of {step.outputChars.toLocaleString("en-US")} characters.
								</div>
							) : null}
						</>
					) : null}
				</div>
			) : null}
		</div>
	);
}

function SubagentStepView({ step }: { step: ChatSubagentStep }) {
	switch (step.kind) {
		case "tool":
			return <SubagentToolStep step={step} />;
		case "text":
			return (
				<div class="subagent-step subagent-step-text">
					<Markdown text={step.text} />
				</div>
			);
		case "notice":
			return <div class={`subagent-step subagent-step-notice notice-${step.level}`}>{step.text}</div>;
	}
}

function subagentStatus(run: ChatSubagentRun | undefined, result: ToolResultPart | undefined): SubagentStatus {
	if (run) {
		return run.status;
	}
	if (result) {
		return result.isError ? "failed" : "done";
	}
	return "pending";
}

function subagentGlyph(status: SubagentStatus): ComponentChildren {
	switch (status) {
		case "running": return <span class="tool-spinner" />;
		case "done": return "✓";
		case "failed": return "✗";
		case "stopped": return "■";
		default: return "–";
	}
}

interface SubagentCardProps {
	input: unknown;
	result: ToolResultPart | undefined;
	/** The finished run, from the message's "subagent" part. */
	part: ChatSubagentRun | undefined;
	liveRun: ChatSubagentRun | undefined;
	running: boolean;
	messageId: string;
	store: ChatStore;
}

function SubagentCard({ input, result, part, liveRun, running, messageId, store }: SubagentCardProps) {
	const [open, setOpen] = useState(false);
	const parsed = readSubagentInput(input);
	const run = part ?? liveRun;
	const status = subagentStatus(run, result);
	const now = useNow(status === "running");
	const description = run?.description || parsed.description;
	const model = run?.modelName || parsed.model;
	const elapsed = run ? run.durationMs ?? Math.max(0, now - run.startedAt) : 0;
	const steps = run ? `${run.steps.length} ${run.steps.length === 1 ? "step" : "steps"}` : "0 steps";
	const meta = run ? `${steps} · ${formatDuration(elapsed)}` : running ? "Starting…" : "No run yet";
	const progress = subagentProgress(run, result);
	return (
		<div class={`subagent-card subagent-${status}`}>
			<button type="button" class="subagent-toggle" aria-expanded={open} onClick={() => setOpen(value => !value)}>
				<span class="subagent-glyph" aria-hidden="true">{subagentGlyph(status)}</span>
				<span class="subagent-label">Subagent</span>
				{model ? <span class="subagent-model">{model}</span> : null}
				{description ? <span class="subagent-desc" title={description}>{description}</span> : null}
				<span class="subagent-meta">{meta}</span>
				<span class="subagent-chevron" aria-hidden="true">{open ? "▾" : "▸"}</span>
			</button>
			<div class="subagent-sub" title={progress}>{progress}</div>
			{open ? (
				<div class="subagent-body">
					{parsed.prompt ? (
						<div class="subagent-section">
							<div class="subagent-section-title">Prompt</div>
							<div class="subagent-prompt"><Markdown text={parsed.prompt} /></div>
						</div>
					) : null}
					<div class="subagent-section">
						<div class="subagent-section-title">Steps</div>
						{run && run.steps.length > 0 ? (
							<div class="subagent-step-list">
								{run.steps.map((step, index) => <SubagentStepView key={index} step={step} />)}
							</div>
						) : <div class="subagent-empty">No steps yet</div>}
					</div>
					<div class="subagent-section">
						<div class="subagent-section-title">Report</div>
						{result
							? <ToolResultDetails part={result} messageId={messageId} store={store} report />
							: <div class="subagent-empty">No report yet</div>}
					</div>
				</div>
			) : null}
		</div>
	);
}

